import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getRefundState, isPayFanoutError } from "@payfanout/core";
import { deriveIdempotenceKey, parseWorldlineWebhookEvent, WorldlineServerAdapter } from "../src/index.js";
import { FakeWorldlineApi } from "./fake-worldline-api.js";

const WEBHOOK_KEY_ID = "wh-key-1";
const WEBHOOK_SECRET = "webhook-secret";

interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

/** Reshapes a JSON answer from the fake, to reach payloads the fake never produces itself. */
type Rewrite = (method: string, path: string, body: Record<string, unknown>) => Record<string, unknown>;

function makePair(rewrite?: Rewrite): { adapter: WorldlineServerAdapter; fake: FakeWorldlineApi; calls: RecordedCall[] } {
  const fake = new FakeWorldlineApi();
  const calls: RecordedCall[] = [];
  const adapter = new WorldlineServerAdapter({
    apiKeyId: "api-key-id",
    secretApiKey: "secret-api-key",
    merchantId: "mid-1",
    environment: "sandbox",
    sessionSigningKey: "session-signing-key",
    webhookKeys: [{ keyId: WEBHOOK_KEY_ID, secretKey: WEBHOOK_SECRET }],
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      const path = new URL(url).pathname;
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
        headers[key.toLowerCase()] = value;
      }
      calls.push({
        method,
        path,
        headers,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      });
      const response = await fake.fetch(input, init);
      if (!rewrite || !response.ok) return response;
      const body = rewrite(method, path, (await response.json()) as Record<string, unknown>);
      return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
    },
  });
  return { adapter, fake, calls };
}

async function openPayment(
  adapter: WorldlineServerAdapter,
  amount: number,
  currency: string,
  captureMethod: "automatic" | "manual",
): Promise<string> {
  const key = `pay-${Math.random().toString(36).slice(2)}`;
  const session = await adapter.createPaymentSession({
    amount,
    currency,
    captureMethod,
    returnUrl: "https://host.example/return",
    idempotencyKey: `${key}-session`,
  });
  const info = await adapter.completePayment({
    pspSessionId: session.pspSessionId,
    clientToken: `htp_${key}`,
    idempotencyKey: `${key}-complete`,
  });
  expect(info.status).toBe(captureMethod === "manual" ? "requires_capture" : "succeeded");
  return info.pspPaymentId;
}

const authorize = (adapter: WorldlineServerAdapter, amount: number, currency = "EUR") =>
  openPayment(adapter, amount, currency, "manual");
const pay = (adapter: WorldlineServerAdapter, amount: number) => openPayment(adapter, amount, "EUR", "automatic");

function capturePosts(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === "POST" && c.path.endsWith("/capture"));
}

describe("cancellation outcomes", () => {
  it("reports a cancellation the acquirer has not confirmed as processing, not canceled", async () => {
    const { adapter, fake } = makePair();
    const id = await authorize(adapter, 4000);
    fake.cancelPending = true;
    const info = await adapter.cancelPayment(id, "void-1");
    expect(info.status).toBe("processing");
    await expect(adapter.retrievePayment(id)).resolves.toMatchObject({ status: "processing" });
  });

  it("keeps a payment whose cancellation the acquirer rejected authorised, and cancels it on retry", async () => {
    const { adapter, fake } = makePair();
    const id = await authorize(adapter, 4000);
    fake.cancelRejected = true;
    const rejected = await adapter.cancelPayment(id, "void-1");
    expect(rejected.status).toBe("requires_capture");
    expect(rejected.amountCaptured).toBe(0);
    expect(rejected.amountCapturable).toBe(4000);

    fake.cancelRejected = false;
    await expect(adapter.cancelPayment(id, "void-2")).resolves.toMatchObject({ status: "canceled" });
  });
});

describe("capture outcomes", () => {
  it("keeps an authorisation whose capture the acquirer refused capturable, and captures it on retry", async () => {
    const { adapter, fake } = makePair();
    const id = await authorize(adapter, 4000);
    fake.captureRefused = true;
    const refused = await adapter.capturePayment(id, undefined, "cap-1");
    expect(refused.status).toBe("requires_capture");
    expect(refused.amountCaptured).toBe(0);
    expect(refused.amountCapturable).toBe(4000);
    await expect(adapter.retrievePayment(id)).resolves.toMatchObject({
      status: "requires_capture",
      amountCaptured: 0,
      amountCapturable: 4000,
    });

    fake.captureRefused = false;
    const captured = await adapter.capturePayment(id, undefined, "cap-2");
    expect(captured.status).toBe("succeeded");
    expect(captured.amountCaptured).toBe(4000); // the refused capture moved nothing
  });

  it("leaves out a refused capture whose only failure signal is its status code", async () => {
    const { adapter, fake } = makePair((method, path, body) => {
      if (method !== "GET" || !path.endsWith("/captures")) return body;
      const captures = (body["captures"] as Array<Record<string, unknown>>).map(({ status: _status, ...rest }) => rest);
      return { ...body, captures };
    });
    const id = await authorize(adapter, 4000);
    fake.captureRefused = true;
    await adapter.capturePayment(id, undefined, "cap-1");
    fake.captureRefused = false;
    const captured = await adapter.capturePayment(id, undefined, "cap-2");
    expect(captured.amountCaptured).toBe(4000);
  });
});

describe("refund outcomes", () => {
  it("keeps the payment succeeded while a refund is pending, and leaves a refused refund out of amountRefunded", async () => {
    const { adapter, fake } = makePair();
    const id = await pay(adapter, 5000);
    const settled = await adapter.refundPayment({ pspPaymentId: id, amount: 1000, idempotencyKey: "r1" });
    expect(settled.status).toBe("succeeded");

    fake.refundPending = true;
    const pending = await adapter.refundPayment({ pspPaymentId: id, amount: 1500, idempotencyKey: "r2" });
    expect(pending.status).toBe("pending");
    await expect(adapter.retrieveRefund(pending.refundId)).resolves.toMatchObject({ status: "pending", amount: 1500 });
    await expect(adapter.retrievePayment(id)).resolves.toMatchObject({ status: "succeeded" });

    fake.refuseRefund(id, (pending.raw as { id: string }).id);
    await expect(adapter.retrieveRefund(pending.refundId)).resolves.toMatchObject({ status: "failed", amount: 1500 });
    const info = await adapter.retrievePayment(id);
    expect(info.status).toBe("succeeded");
    expect(info.amountCaptured).toBe(5000);
    expect(info.amountRefunded).toBe(1000);
    expect(getRefundState(info)).toBe("partial");
  });

  it("maps a refund whose only signal is its status code", async () => {
    const { adapter, fake } = makePair();
    const cases: Array<[number, string]> = [
      [7, "succeeded"],
      [8, "succeeded"],
      [85, "succeeded"],
      [73, "failed"],
      [83, "failed"],
      [71, "pending"],
      [72, "pending"],
      [81, "pending"],
      [82, "pending"],
    ];
    for (const [statusCode, expected] of cases) {
      const seeded = fake.seedRefund("pay_codes", { id: `ref_${statusCode}` });
      delete seeded.status;
      seeded.statusOutput = { statusCode };
      await expect(adapter.retrieveRefund(`pay_codes:ref_${statusCode}`)).resolves.toMatchObject({ status: expected });
    }
  });

  it("leaves a refund refused by its status code alone out of amountRefunded", async () => {
    const { adapter, fake } = makePair();
    const id = await pay(adapter, 5000);
    const seeded = fake.seedRefund(id, { refundOutput: { amountOfMoney: { amount: 1500, currencyCode: "EUR" } } });
    delete seeded.status;
    seeded.statusOutput = { statusCode: 83 };
    await expect(adapter.retrievePayment(id)).resolves.toMatchObject({ status: "succeeded", amountRefunded: 0 });
  });
});

describe("webhooks for refused operations", () => {
  function paymentEvent(type: string, status: string, statusCode?: number): string {
    return JSON.stringify({
      id: `evt_${type}_${statusCode ?? "none"}`,
      created: "2026-09-23T10:00:00Z",
      type,
      payment: {
        id: "pay_1",
        paymentOutput: { amountOfMoney: { amount: 1099, currencyCode: "EUR" } },
        status,
        ...(statusCode !== undefined ? { statusOutput: { statusCode, statusCategory: "UNSUCCESSFUL" } } : {}),
      },
    });
  }

  it("reads a payment.rejected carrying a refused refund (83) or deletion (73) as payment.refund_failed", async () => {
    for (const statusCode of [83, 73]) {
      const event = await parseWorldlineWebhookEvent(paymentEvent("payment.rejected", "REJECTED", statusCode));
      expect(event).toMatchObject({ type: "payment.refund_failed", pspPaymentId: "pay_1" });
    }
  });

  it("reads any other payment.rejected as payment.failed", async () => {
    for (const statusCode of [2, 57, 59, undefined]) {
      const event = await parseWorldlineWebhookEvent(paymentEvent("payment.rejected", "REJECTED", statusCode));
      expect(event.type).toBe("payment.failed");
    }
  });

  it("reads payment.rejected_capture as unknown, since the authorisation still holds the funds", async () => {
    const event = await parseWorldlineWebhookEvent(paymentEvent("payment.rejected_capture", "REJECTED_CAPTURE", 93));
    expect(event.type).toBe("unknown");
  });

  it("verifies and parses a signed refused-refund delivery through the adapter", async () => {
    const { adapter } = makePair();
    const rawBody = paymentEvent("payment.rejected", "REJECTED", 83);
    const headers = {
      "x-gcs-signature": createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf8").digest("base64"),
      "x-gcs-keyid": WEBHOOK_KEY_ID,
    };
    await expect(adapter.verifyWebhookSignature(rawBody, headers)).resolves.toBe(true);
    await expect(adapter.parseWebhookEvent(rawBody)).resolves.toMatchObject({
      type: "payment.refund_failed",
      pspPaymentId: "pay_1",
    });
  });
});

describe("capture amounts", () => {
  const partials: Array<[string, number, number]> = [
    ["JPY", 5000, 2000],
    ["BHD", 5000, 2500],
  ];
  for (const [currency, authorised, partial] of partials) {
    it(`refuses a partial capture in ${currency} before any capture call`, async () => {
      const { adapter, fake, calls } = makePair();
      const id = await authorize(adapter, authorised, currency);
      const error = await adapter.capturePayment(id, partial, "cap-1").catch((err: unknown) => err);
      expect(isPayFanoutError(error)).toBe(true);
      expect(error).toMatchObject({ code: "invalid_request", retryable: false });
      expect((error as Error).message).toContain(currency);
      expect(capturePosts(calls)).toEqual([]);
      expect(fake.uniqueCaptureCreations).toBe(0);
      await expect(adapter.retrievePayment(id)).resolves.toMatchObject({
        status: "requires_capture",
        amountCapturable: authorised,
      });
    });
  }

  it("captures the full authorised JPY amount without sending an amount, under the caller's idempotency key", async () => {
    const { adapter, calls } = makePair();
    const id = await authorize(adapter, 5000, "JPY");
    const captured = await adapter.capturePayment(id, 5000, "cap-full");
    expect(captured).toMatchObject({ status: "succeeded", currency: "JPY", amountCaptured: 5000, amountCapturable: 0 });
    const posts = capturePosts(calls);
    expect(posts.map((c) => c.body)).toEqual([{ isFinal: true }]);
    expect(posts[0]?.headers["x-gcs-idempotence-key"]).toBe(await deriveIdempotenceKey("cap-full"));
  });

  it("still sends the amount for a partial capture in a two-decimal currency", async () => {
    const { adapter, calls } = makePair();
    const id = await authorize(adapter, 5000);
    const captured = await adapter.capturePayment(id, 2000, "cap-partial");
    expect(captured).toMatchObject({ status: "succeeded", amountCaptured: 2000, amountCapturable: 0 });
    expect(capturePosts(calls).map((c) => c.body)).toEqual([{ amount: 2000, isFinal: true }]);
  });

  it("sends an amountless capture as before, with no read ahead of it", async () => {
    const { adapter, calls } = makePair();
    const id = await authorize(adapter, 5000, "JPY");
    calls.length = 0;
    const captured = await adapter.capturePayment(id, undefined, "cap-bare");
    expect(captured).toMatchObject({ status: "succeeded", amountCaptured: 5000 });
    expect(calls[0]).toMatchObject({ method: "POST", body: { isFinal: true } });
    expect(calls[0]?.path).toMatch(/\/payments\/[^/]+\/capture$/);
  });

  it("refuses a partial capture when the payment reports no currency", async () => {
    let dropCurrency = false;
    const { adapter, calls } = makePair((method, path, body) => {
      if (!dropCurrency || method !== "GET" || !/\/payments\/[^/]+$/.test(path)) return body;
      const output = body["paymentOutput"] as { amountOfMoney: { amount: number } };
      return { ...body, paymentOutput: { ...output, amountOfMoney: { amount: output.amountOfMoney.amount } } };
    });
    const id = await authorize(adapter, 5000);
    dropCurrency = true;
    await expect(adapter.capturePayment(id, 2000, "cap-1")).rejects.toMatchObject({ code: "invalid_request" });
    expect(capturePosts(calls)).toEqual([]);
  });
});

describe("cancellation of a closed payment", () => {
  /** An adapter whose transport retries run without real backoff, with every cancel POST counted. */
  function makeCancelPair(answerConflict: (attempt: number) => boolean = () => false): {
    adapter: WorldlineServerAdapter;
    cancelPosts: () => number;
  } {
    const fake = new FakeWorldlineApi();
    let posts = 0;
    const adapter = new WorldlineServerAdapter({
      apiKeyId: "api-key-id",
      secretApiKey: "secret-api-key",
      merchantId: "mid-1",
      environment: "sandbox",
      sessionSigningKey: "session-signing-key",
      webhookKeys: [{ keyId: WEBHOOK_KEY_ID, secretKey: WEBHOOK_SECRET }],
      sleep: async () => {},
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (init?.method === "POST" && /\/cancel$/.test(new URL(url).pathname) && answerConflict(++posts)) {
          return new Response(
            JSON.stringify({ errorId: "dup", errors: [{ code: "1409", message: "request in progress", httpStatusCode: 409 }] }),
            { status: 409 },
          );
        }
        return fake.fetch(input, init);
      },
    });
    return { adapter, cancelPosts: () => posts };
  }

  it("refuses a captured payment's cancellation as a non-retryable invalid_request, not a retryable conflict", async () => {
    const { adapter } = makeCancelPair();
    const id = await openPayment(adapter, 3000, "EUR", "automatic");
    const failure = await adapter.cancelPayment(id, "void-closed").catch((err: unknown) => err);
    expect(isPayFanoutError(failure)).toBe(true);
    expect(failure).toMatchObject({ code: "invalid_request", retryable: false, pspName: "worldline" });
    await expect(adapter.retrievePayment(id)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("still lets a replay whose original is in flight settle on the retry", async () => {
    const { adapter, cancelPosts } = makeCancelPair((attempt) => attempt === 1);
    const id = await openPayment(adapter, 3000, "EUR", "manual");
    await expect(adapter.cancelPayment(id, "void-1")).resolves.toMatchObject({ status: "canceled" });
    expect(cancelPosts()).toBe(2);
  });

  it("answers a repeat cancellation of a cancelled payment with its canceled state", async () => {
    const { adapter } = makeCancelPair();
    const id = await openPayment(adapter, 3000, "EUR", "manual");
    await expect(adapter.cancelPayment(id, "void-1")).resolves.toMatchObject({ status: "canceled" });
    await expect(adapter.cancelPayment(id, "void-2")).resolves.toMatchObject({ status: "canceled" });
  });
});
