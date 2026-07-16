import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isPayFanoutError, type UnifiedErrorCode, type UnifiedPaymentStatus } from "@payfanout/core";
import {
  derivePayZenOrderId,
  mapPayZenDetailedStatus,
  mapPayZenError,
  parsePayZenWebhookEvent,
  PayZenServerAdapter,
  verifyPayZenWebhookSignature,
  type PayZenServerAdapterConfig,
} from "../src/index.js";

function makeAdapter(config: Partial<PayZenServerAdapterConfig> = {}): PayZenServerAdapter {
  return new PayZenServerAdapter({
    shopId: "69876357",
    password: "testpassword_UnitKey",
    environment: "sandbox",
    ...config,
  });
}

/** 200 + SUCCESS envelope around a Transaction answer — the wire shape of every read. */
function transactionResponse(tx: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ status: "SUCCESS", answer: { uuid: "a".repeat(32), amount: 100, currency: "EUR", ...tx } }),
    { status: 200 },
  );
}

describe("PayZen config validation", () => {
  it("requires shopId, password, and a valid environment", () => {
    expect(() => makeAdapter({ shopId: "" })).toThrowError(/shopId/);
    expect(() => makeAdapter({ password: [] })).toThrowError(/password/);
    expect(() => makeAdapter({ environment: "prod" as never })).toThrowError(/sandbox.*live/);
  });

  it("refuses a password family that contradicts the declared environment", () => {
    expect(() => makeAdapter({ password: "prodpassword_Oops" })).toThrowError(/production key/);
    expect(() =>
      makeAdapter({ environment: "live", password: ["prodpassword_New", "testpassword_Old"] }),
    ).toThrowError(/test key/);
    // Validation, not inference: matching families construct fine.
    expect(() => makeAdapter({ environment: "live", password: "prodpassword_Ok" })).not.toThrowError();
  });

  it("rejects nonsensical timeout/retry settings eagerly", () => {
    expect(() => makeAdapter({ requestTimeoutMs: 0 })).toThrowError(/requestTimeoutMs/);
    expect(() => makeAdapter({ maxNetworkRetries: -1 })).toThrowError(/maxNetworkRetries/);
    expect(() => makeAdapter({ maxNetworkRetries: 1.5 })).toThrowError(/maxNetworkRetries/);
  });
});

describe("derivePayZenOrderId", () => {
  it("maps charset-clean keys 1:1 (deterministic, prefixed)", async () => {
    await expect(derivePayZenOrderId("order-9_attempt.1".replace(".", "-"))).resolves.toBe("pf-order-9_attempt-1");
    expect(await derivePayZenOrderId("abc")).toBe(await derivePayZenOrderId("abc"));
  });

  it("sanitizes disallowed characters and disambiguates with a hash fragment", async () => {
    const a = await derivePayZenOrderId("key!");
    const b = await derivePayZenOrderId("key?");
    expect(a).toMatch(/^pf-key--[0-9a-f]{8}$/);
    expect(b).toMatch(/^pf-key--[0-9a-f]{8}$/);
    expect(a).not.toBe(b); // same sanitized form, different keys — never collide
  });

  it("caps at PayZen's 64-char orderId limit", async () => {
    const long = await derivePayZenOrderId("x".repeat(200));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toBe(await derivePayZenOrderId("x".repeat(200)));
    expect(long).not.toBe(await derivePayZenOrderId("x".repeat(201)));
  });
});

describe("detailedStatus mapping (complete catalog)", () => {
  const cases: Array<[string, UnifiedPaymentStatus]> = [
    ["AUTHORISED", "succeeded"],
    ["CAPTURED", "succeeded"],
    ["ACCEPTED", "succeeded"],
    ["PRE_AUTHORISED", "succeeded"],
    ["AUTHORISED_TO_VALIDATE", "requires_capture"],
    ["WAITING_AUTHORISATION_TO_VALIDATE", "requires_capture"],
    ["WAITING_AUTHORISATION", "processing"],
    ["WAITING_FOR_PAYMENT", "processing"],
    ["UNDER_VERIFICATION", "processing"],
    ["INITIAL", "processing"], // temporary — no acquirer response yet
    ["REFUND_TO_RETRY", "processing"],
    ["REFUSED", "failed"],
    ["ERROR", "failed"],
    ["CAPTURE_FAILED", "failed"],
    ["CANCELLED", "canceled"],
    ["EXPIRED", "canceled"],
    ["SOMETHING_NEW", "processing"], // future catalog additions stay in-flight, never terminal
  ];
  for (const [detailedStatus, expected] of cases) {
    it(`maps ${detailedStatus} -> ${expected}`, () => {
      expect(mapPayZenDetailedStatus(detailedStatus)).toBe(expected);
    });
  }

  it("flows through retrievePayment", async () => {
    const adapter = makeAdapter({
      fetch: async () => transactionResponse({ detailedStatus: "AUTHORISED_TO_VALIDATE" }),
    });
    const info = await adapter.retrievePayment("a".repeat(32));
    expect(info.status).toBe("requires_capture");
  });
});

describe("mapPayZenError (envelope taxonomy)", () => {
  const cases: Array<[string | undefined, string | null | undefined, UnifiedErrorCode, boolean]> = [
    ["INT_905", null, "invalid_request", false],
    ["INT_009", null, "invalid_request", false],
    ["CLIENT_100", null, "invalid_request", false],
    ["ACQ_001", "51", "insufficient_funds", false],
    ["ACQ_001", "54", "expired_card", false],
    ["ACQ_001", "33", "expired_card", false],
    ["ACQ_001", "14", "invalid_card_data", false],
    ["ACQ_001", "43", "fraud_suspected", false],
    ["ACQ_001", "59", "fraud_suspected", false],
    ["ACQ_001", "34", "fraud_suspected", false], // suspected fraud
    ["ACQ_001", "41", "fraud_suspected", false], // lost card
    ["ACQ_001", "38", "expired_card", false],
    ["ACQ_001", "1A", "authentication_required", false],
    ["ACQ_001", "05", "card_declined", false],
    ["ACQ_001", null, "card_declined", false],
    ["ACQ_999", null, "psp_unavailable", true],
    ["AUTH_149", null, "authentication_required", false],
    ["AUTH_100", null, "authentication_required", false],
    ["AUTH_999", null, "psp_unavailable", true],
    ["PSP_042", null, "insufficient_funds", false],
    ["PSP_202", null, "expired_card", false],
    ["PSP_112", null, "expired_card", false],
    ["PSP_026", null, "invalid_card_data", false],
    ["PSP_530", null, "invalid_card_data", false],
    ["PSP_539", null, "authentication_required", false],
    ["PSP_136", null, "authentication_required", false],
    ["PSP_536", null, "fraud_suspected", false],
    ["PSP_204", null, "fraud_suspected", false],
    ["PSP_099", null, "rate_limited", true], // HTTP-200 rate limit — envelope is the only signal
    ["PSP_106", null, "rate_limited", true],
    ["PSP_999", null, "psp_unavailable", true],
    ["PSP_514", null, "psp_unavailable", true],
    ["PSP_010", null, "invalid_request", false],
    ["PSP_108", null, "session_expired", false], // expired formToken — a fresh session recovers, a replay never does
    ["PSP_610", null, "invalid_request", false],
    ["PSP_075", null, "invalid_request", false],
    ["PSP_083", null, "invalid_request", false],
    ["PSP_104", null, "invalid_request", false],
    ["PSP_105", null, "invalid_request", false],
    ["PSP_510", null, "invalid_request", false],
    ["PSP_511", null, "invalid_request", false],
    ["PSP_076", null, "processing_error", true], // capture pending — genuinely a timing state
    ["PSP_101", "51", "insufficient_funds", false], // issuer-refused refund carries acquirer codes
    ["PSP_101", null, "card_declined", false],
    ["PSP_888", null, "processing_error", false], // unmapped gateway codes never cascade as retryable
    [undefined, null, "processing_error", false],
    ["WEIRD_1", null, "processing_error", false],
  ];
  for (const [errorCode, detailedErrorCode, expected, retryable] of cases) {
    it(`maps ${errorCode ?? "<none>"}${detailedErrorCode ? `/${detailedErrorCode}` : ""} -> ${expected}${retryable ? " (retryable)" : ""}`, () => {
      const envelope = { status: "ERROR", answer: { errorCode, detailedErrorCode } };
      const mapped = mapPayZenError(envelope.answer, envelope);
      expect(mapped.code).toBe(expected);
      expect(mapped.retryable).toBe(retryable);
      expect(mapped.raw).toBe(envelope); // full envelope preserved, never just the answer
      expect(mapped.pspName).toBe("payzen");
    });
  }

  it("gives INT_905 an actionable credentials message", () => {
    expect(mapPayZenError({ errorCode: "INT_905" }, {}).message).toMatch(/shopId, password/);
  });
});

describe("transport behavior", () => {
  it("maps network failures to retryable psp_unavailable with the cause on raw", async () => {
    const adapter = makeAdapter({
      maxNetworkRetries: 0,
      fetch: async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
    });
    try {
      await adapter.retrievePayment("a".repeat(32));
      expect.unreachable();
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("psp_unavailable");
        expect(err.retryable).toBe(true);
        expect(err.raw).toBeInstanceOf(TypeError);
      }
    }
  });

  it("times out hung connections as retryable psp_unavailable", async () => {
    const adapter = makeAdapter({
      maxNetworkRetries: 0,
      requestTimeoutMs: 5,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    await expect(adapter.retrievePayment("a".repeat(32))).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
      message: expect.stringMatching(/did not respond within 5ms/) as string,
    });
  });

  it("bounds the response BODY read with the timeout — headers alone do not disarm it", async () => {
    // Headers arrive immediately but the body stream never closes: without
    // the timer surviving until text(), this call would hang forever.
    const adapter = makeAdapter({
      maxNetworkRetries: 0,
      requestTimeoutMs: 5,
      fetch: async () => new Response(new ReadableStream({ start() {} })),
    });
    await expect(adapter.retrievePayment("a".repeat(32))).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
      message: expect.stringMatching(/did not respond within 5ms/) as string,
    });
  });

  it("still times out when a response lands only after the abort already fired", async () => {
    // An injected transport may ignore the signal and resolve late — the
    // body read must refuse to start on an already-aborted request.
    const adapter = makeAdapter({
      maxNetworkRetries: 0,
      requestTimeoutMs: 5,
      fetch: () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("{}")), 40)),
    });
    await expect(adapter.retrievePayment("a".repeat(32))).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
      message: expect.stringMatching(/did not respond within 5ms/) as string,
    });
  });

  it("survives non-JSON bodies from proxies (200 garbage and 502 HTML)", async () => {
    const garbage200 = makeAdapter({ maxNetworkRetries: 0, fetch: async () => new Response("<html>hi</html>", { status: 200 }) });
    await expect(garbage200.retrievePayment("a".repeat(32))).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
    });
    const html502 = makeAdapter({ maxNetworkRetries: 0, fetch: async () => new Response("<html>502</html>", { status: 502 }) });
    await expect(html502.retrievePayment("a".repeat(32))).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
    });
  });

  it("maps non-429 HTTP 4xx from infrastructure to invalid_request", async () => {
    const adapter = makeAdapter({ maxNetworkRetries: 0, fetch: async () => new Response("forbidden", { status: 403 }) });
    await expect(adapter.retrievePayment("a".repeat(32))).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
    });
  });

  it("retries transport failures on reads with backoff, then succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const adapter = makeAdapter({
      maxNetworkRetries: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async () => {
        calls++;
        if (calls < 3) return new Response("boom", { status: 503 });
        return transactionResponse({ detailedStatus: "CAPTURED" });
      },
    });
    const info = await adapter.retrievePayment("a".repeat(32));
    expect(info.status).toBe("succeeded");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([250, 500]);
  });

  it("never retries envelope-level errors — PayZen business errors ride HTTP 200", async () => {
    let calls = 0;
    const adapter = makeAdapter({
      maxNetworkRetries: 2,
      sleep: async () => {},
      fetch: async () => {
        calls++;
        return new Response(JSON.stringify({ status: "ERROR", answer: { errorCode: "PSP_099" } }), { status: 200 });
      },
    });
    await expect(adapter.retrievePayment("a".repeat(32))).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true, // flagged for the CALLER to back off — the transport must not
    });
    expect(calls).toBe(1);
  });

  it("never transport-retries refunds: a lost response may mean the credit exists", async () => {
    let calls = 0;
    const adapter = makeAdapter({
      maxNetworkRetries: 3,
      sleep: async () => {},
      fetch: async (url) => {
        calls++;
        if (String(url).endsWith("/Transaction/Get")) {
          return transactionResponse({ detailedStatus: "CAPTURED", currency: "EUR" });
        }
        return new Response("bad gateway", { status: 502 });
      },
    });
    await expect(
      adapter.refundPayment({ pspPaymentId: "a".repeat(32), amount: 50, idempotencyKey: "r" }),
    ).rejects.toMatchObject({ code: "psp_unavailable" });
    expect(calls).toBe(2); // one read (retryable path) + ONE refund attempt, no replay
  });

  it("refund transport failures surface retryable: false with re-read guidance (outcome unknown)", async () => {
    // A host wrapping refundPayment in core's withRetry replays purely on the
    // retryable flag — after a timeout PayZen actually applied, that replay
    // would stack a second credit.
    const timedOut = makeAdapter({
      requestTimeoutMs: 5,
      fetch: (url, init) => {
        if (String(url).endsWith("/Transaction/Get")) {
          return Promise.resolve(transactionResponse({ detailedStatus: "CAPTURED", currency: "EUR" }));
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    });
    try {
      await timedOut.refundPayment({ pspPaymentId: "a".repeat(32), amount: 50, idempotencyKey: "r" });
      expect.unreachable();
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("psp_unavailable");
        expect(err.retryable).toBe(false);
        expect(err.message).toMatch(/outcome of Transaction\/Refund is unknown/);
        expect(err.message).toMatch(/amountRefunded/);
      }
    }

    const badGateway = makeAdapter({
      fetch: async (url) => {
        if (String(url).endsWith("/Transaction/Get")) {
          return transactionResponse({ detailedStatus: "CAPTURED", currency: "EUR" });
        }
        return new Response("bad gateway", { status: 502 });
      },
    });
    await expect(
      badGateway.refundPayment({ pspPaymentId: "a".repeat(32), amount: 50, idempotencyKey: "r" }),
    ).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: false,
      message: expect.stringMatching(/outcome of Transaction\/Refund is unknown/) as string,
    });
  });

  it("sends Basic auth built from shopId and the FIRST password (rotation array)", async () => {
    let authHeader = "";
    const adapter = makeAdapter({
      password: ["testpassword_New", "testpassword_Old"],
      fetch: async (_url, init) => {
        authHeader = (init?.headers as Record<string, string>)["authorization"]!;
        return transactionResponse({});
      },
    });
    await adapter.retrievePayment("a".repeat(32));
    expect(authHeader).toBe(`Basic ${Buffer.from("69876357:testpassword_New").toString("base64")}`);
  });

  it("createPaymentSession rejects when the gateway omits the formToken", async () => {
    const adapter = makeAdapter({
      fetch: async () => new Response(JSON.stringify({ status: "SUCCESS", answer: {} }), { status: 200 }),
    });
    await expect(
      adapter.createPaymentSession({ amount: 100, currency: "EUR", idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "processing_error" });
  });

  it("orderId reads and mutations with no DEBIT transaction reject with the order on raw", async () => {
    const adapter = makeAdapter({
      fetch: async () =>
        new Response(
          JSON.stringify({ status: "SUCCESS", answer: { transactions: [{ uuid: "b".repeat(32), operationType: "CREDIT" }] } }),
          { status: 200 },
        ),
    });
    await expect(adapter.retrievePayment("pf-some-order")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(adapter.cancelPayment("pf-some-order", "void-x")).rejects.toMatchObject({ code: "invalid_request" });
  });
});

// ---------------------------------------------------------------------------
// Webhook/IPN verification and parsing.
// ---------------------------------------------------------------------------
const PASSWORD = "testpassword_WebhookUnit";
const HMAC_KEY = "0123456789abcdef0123456789abcdef";

function krAnswerFor(tx: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    shopId: "69876357",
    orderCycle: "CLOSED",
    orderStatus: "PAID",
    serverDate: "2026-07-07T10:00:00+00:00",
    orderDetails: { orderId: "pf-order-1", _type: "V4/OrderDetails" },
    ...(tx ? { transactions: [tx] } : {}),
    ...extra,
    _type: "V4/Payment",
  });
}

function sign(key: string, krAnswer: string): string {
  return createHmac("sha256", key).update(krAnswer, "utf8").digest("hex");
}

function headersFor(krAnswer: string, family: "password" | "sha256_hmac" = "password"): Record<string, string> {
  return {
    "kr-hash": sign(family === "password" ? PASSWORD : HMAC_KEY, krAnswer),
    "kr-hash-algorithm": "sha256_hmac",
    "kr-hash-key": family,
  };
}

function urlencodedBody(krAnswer: string, family: "password" | "sha256_hmac" = "password"): string {
  const params = new URLSearchParams();
  params.set("kr-hash", sign(family === "password" ? PASSWORD : HMAC_KEY, krAnswer));
  params.set("kr-hash-algorithm", "sha256_hmac");
  params.set("kr-hash-key", family);
  params.set("kr-answer-type", "V4/Payment");
  params.set("kr-answer", krAnswer);
  return params.toString();
}

function webhookAdapter(config: Partial<PayZenServerAdapterConfig> = {}): PayZenServerAdapter {
  return makeAdapter({ password: PASSWORD, hmacKey: HMAC_KEY, ...config });
}

describe("PayZen webhook signature verification", () => {
  const DEBIT = { uuid: "c".repeat(32), operationType: "DEBIT", detailedStatus: "AUTHORISED", amount: 990 };

  it("verifies the kr-answer-as-rawBody recipe for both key families", async () => {
    const adapter = webhookAdapter();
    const body = krAnswerFor(DEBIT);
    await expect(adapter.verifyWebhookSignature(body, headersFor(body, "password"))).resolves.toBe(true);
    await expect(adapter.verifyWebhookSignature(body, headersFor(body, "sha256_hmac"))).resolves.toBe(true);
  });

  it("verifies the full urlencoded IPN body recipe (no headers needed)", async () => {
    const adapter = webhookAdapter();
    const body = krAnswerFor(DEBIT);
    await expect(adapter.verifyWebhookSignature(urlencodedBody(body), {})).resolves.toBe(true);
  });

  it("headers win over urlencoded hash fields when both are present", async () => {
    const adapter = webhookAdapter();
    const body = krAnswerFor(DEBIT);
    // Correct form fields + a wrong header hash: the header is authoritative.
    await expect(
      adapter.verifyWebhookSignature(urlencodedBody(body), { "kr-hash": "0".repeat(64) }),
    ).resolves.toBe(false);
  });

  it("selects the key FAMILY by kr-hash-key — the right hash under the wrong family fails", async () => {
    const adapter = webhookAdapter();
    const body = krAnswerFor(DEBIT);
    const crossed = { ...headersFor(body, "sha256_hmac"), "kr-hash-key": "password" };
    await expect(adapter.verifyWebhookSignature(body, crossed)).resolves.toBe(false);
  });

  it("supports rotation arrays on both families", async () => {
    const adapter = webhookAdapter({
      password: [PASSWORD, "testpassword_Older"],
      hmacKey: ["deadbeef", HMAC_KEY],
    });
    const body = krAnswerFor(DEBIT);
    await expect(adapter.verifyWebhookSignature(body, headersFor(body, "password"))).resolves.toBe(true);
    await expect(adapter.verifyWebhookSignature(body, headersFor(body, "sha256_hmac"))).resolves.toBe(true);
  });

  it("rejects unknown hash families, foreign algorithms, and missing pieces — without throwing", async () => {
    const adapter = webhookAdapter();
    const body = krAnswerFor(DEBIT);
    await expect(adapter.verifyWebhookSignature(body, { ...headersFor(body), "kr-hash-key": "sd" })).resolves.toBe(false);
    await expect(
      adapter.verifyWebhookSignature(body, { ...headersFor(body), "kr-hash-algorithm": "sha1" }),
    ).resolves.toBe(false);
    await expect(adapter.verifyWebhookSignature(body, {})).resolves.toBe(false);
    await expect(adapter.verifyWebhookSignature("", headersFor(body))).resolves.toBe(false);
  });

  it("rejects tampered and re-serialized kr-answers (byte-exact hashing)", async () => {
    const adapter = webhookAdapter();
    const body = krAnswerFor(DEBIT);
    const headers = headersFor(body);
    await expect(adapter.verifyWebhookSignature(body.replace("990", "991"), headers)).resolves.toBe(false);
    const reserialized = JSON.stringify(JSON.parse(body), null, 2);
    await expect(adapter.verifyWebhookSignature(reserialized, headers)).resolves.toBe(false);
    // Truncated digest: length mismatch fails before any byte comparison.
    await expect(
      adapter.verifyWebhookSignature(body, { ...headers, "kr-hash": headers["kr-hash"]!.slice(0, 32) }),
    ).resolves.toBe(false);
  });
});

describe("PayZen webhook event parsing", () => {
  const adapter = webhookAdapter();
  const parse = (body: string, headers: Record<string, string> = {}): ReturnType<typeof adapter.parseWebhookEvent> =>
    adapter.parseWebhookEvent(body, headers);

  it("parses the urlencoded ingestion form identically to the raw kr-answer form", async () => {
    const body = krAnswerFor({ uuid: "d".repeat(32), operationType: "DEBIT", detailedStatus: "CAPTURED" });
    const fromRaw = await parse(body, headersFor(body));
    const fromForm = await parse(urlencodedBody(body), {});
    expect(fromForm).toEqual(fromRaw);
    expect(fromRaw.type).toBe("payment.succeeded");
    expect(fromRaw.pspPaymentId).toBe("d".repeat(32));
  });

  it("keeps the event id stable across redeliveries of the SAME state", async () => {
    const body = krAnswerFor({ uuid: "d".repeat(32), operationType: "DEBIT", detailedStatus: "AUTHORISED" });
    const first = await parse(body);
    const second = await parse(body);
    expect(first.id).toBe(`${"d".repeat(32)}:AUTHORISED`);
    expect(second.id).toBe(first.id);
  });

  it("a redelivery carrying a CHANGED detailedStatus is a NEW fact (different id, same uuid)", async () => {
    // PayZen regenerates kr-hash per delivery and may advance detailedStatus
    // between the original call and a retry — dedupe must not swallow that.
    const authorised = await parse(krAnswerFor({ uuid: "d".repeat(32), operationType: "DEBIT", detailedStatus: "AUTHORISED" }));
    const captured = await parse(krAnswerFor({ uuid: "d".repeat(32), operationType: "DEBIT", detailedStatus: "CAPTURED" }));
    expect(captured.id).not.toBe(authorised.id);
    expect(captured.pspPaymentId).toBe(authorised.pspPaymentId);
  });

  const typeCases: Array<[Record<string, unknown>, string]> = [
    [{ uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "AUTHORISED" }, "payment.succeeded"],
    [{ uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "CAPTURED" }, "payment.succeeded"],
    [{ uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "REFUSED" }, "payment.failed"],
    [{ uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "CAPTURE_FAILED" }, "payment.failed"],
    [{ uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "CANCELLED" }, "payment.canceled"],
    [{ uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "EXPIRED" }, "payment.canceled"],
    [{ uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "UNDER_VERIFICATION" }, "payment.processing"],
    [{ uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "WAITING_AUTHORISATION" }, "payment.processing"],
    [{ uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "INITIAL" }, "payment.processing"],
    // Awaiting a MERCHANT validation — payment.requires_action would misdirect.
    [{ uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "AUTHORISED_TO_VALIDATE" }, "unknown"],
    [{ uuid: "1".repeat(32), operationType: "CREDIT", detailedStatus: "CAPTURED" }, "payment.refunded"],
    [{ uuid: "1".repeat(32), operationType: "CREDIT", detailedStatus: "AUTHORISED" }, "payment.refunded"],
    [{ uuid: "1".repeat(32), operationType: "CREDIT", detailedStatus: "REFUSED" }, "payment.refund_failed"],
    [{ uuid: "1".repeat(32), operationType: "CREDIT", detailedStatus: "CANCELLED" }, "payment.refund_failed"],
    [{ uuid: "1".repeat(32), operationType: "CREDIT", detailedStatus: "REFUND_TO_RETRY" }, "unknown"],
    [{ uuid: "1".repeat(32), operationType: "VERIFICATION", detailedStatus: "ACCEPTED" }, "unknown"],
    [{ uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "BRAND_NEW_STATE" }, "unknown"],
  ];
  for (const [tx, expected] of typeCases) {
    it(`maps ${String(tx["operationType"])}/${String(tx["detailedStatus"])} -> ${expected}`, async () => {
      expect((await parse(krAnswerFor(tx))).type).toBe(expected);
    });
  }

  it("refund events point pspPaymentId at the PARENT payment", async () => {
    const event = await parse(
      krAnswerFor({
        uuid: "e".repeat(32),
        operationType: "CREDIT",
        detailedStatus: "CAPTURED",
        transactionDetails: { parentTransactionUuid: "f".repeat(32) },
      }),
    );
    expect(event.type).toBe("payment.refunded");
    expect(event.pspPaymentId).toBe("f".repeat(32));
    expect(event.id).toBe(`${"e".repeat(32)}:CAPTURED`); // the credit's own identity
    expect(event.refundId).toBe("e".repeat(32)); // pollable via retrieveRefund
  });

  it("carries the payload's money facts so hosts need no retrievePayment round-trip", async () => {
    const refunded = await parse(
      krAnswerFor({
        uuid: "e".repeat(32),
        operationType: "CREDIT",
        detailedStatus: "CAPTURED",
        amount: 750,
        currency: "EUR",
        transactionDetails: { parentTransactionUuid: "f".repeat(32) },
      }),
    );
    expect(refunded.amount).toBe(750); // the credit's amount IS the refunded amount
    expect(refunded.currency).toBe("EUR");

    const paid = await parse(
      krAnswerFor({ uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "AUTHORISED", amount: 990, currency: "eur" }),
    );
    expect(paid.amount).toBe(990);
    expect(paid.currency).toBe("EUR"); // normalized to ISO 4217 uppercase
    expect(paid.refundId).toBeUndefined(); // refund-shaped events only

    // Facts the payload does not carry stay absent — never fabricated.
    const bare = await parse(krAnswerFor({ uuid: "2".repeat(32), operationType: "DEBIT", detailedStatus: "AUTHORISED" }));
    expect(bare.amount).toBeUndefined();
    expect(bare.currency).toBeUndefined();
  });

  it("uses the NEWEST transaction when the snapshot carries several attempts", async () => {
    const body = krAnswerFor(undefined, {
      transactions: [
        { uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "REFUSED", creationDate: "2026-07-07T09:00:00+00:00" },
        { uuid: "2".repeat(32), operationType: "DEBIT", detailedStatus: "AUTHORISED", creationDate: "2026-07-07T09:05:00+00:00" },
      ],
    });
    const event = await parse(body);
    expect(event.type).toBe("payment.succeeded");
    expect(event.pspPaymentId).toBe("2".repeat(32));
  });

  it("falls back to a raw-bytes hash id and unknown type when no transaction exists", async () => {
    const body = krAnswerFor(undefined);
    const event = await parse(body);
    expect(event.type).toBe("unknown");
    expect(event.id).toMatch(/^payzen_[0-9a-f]{64}$/);
    expect(event.pspPaymentId).toBeUndefined();
    expect((await parse(body)).id).toBe(event.id); // still a stable dedupe key
  });

  it("takes occurredAt from the payload, with deterministic fallbacks", async () => {
    const event = await parse(krAnswerFor({ uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "AUTHORISED" }));
    expect(event.occurredAt).toBe("2026-07-07T10:00:00.000Z"); // serverDate, normalized
    const noDates = await parse(
      JSON.stringify({ transactions: [{ uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "AUTHORISED" }] }),
    );
    expect(noDates.occurredAt).toBe("1970-01-01T00:00:00.000Z");
    const txDate = await parse(
      JSON.stringify({
        transactions: [
          { uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "AUTHORISED", creationDate: "2026-02-03T04:05:06+00:00" },
        ],
      }),
    );
    expect(txDate.occurredAt).toBe("2026-02-03T04:05:06.000Z");
  });

  it("throws invalid_request on unparseable payloads and non-object kr-answers", async () => {
    for (const bad of ["this is not json", "", "null", '"just a string"']) {
      try {
        await parse(bad);
        expect.unreachable(`expected rejection for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(isPayFanoutError(err)).toBe(true);
        if (isPayFanoutError(err)) expect(err.code).toBe("invalid_request");
      }
    }
  });

  it("preserves the parsed kr-answer on raw", async () => {
    const body = krAnswerFor({ uuid: "1".repeat(32), operationType: "DEBIT", detailedStatus: "AUTHORISED" });
    const event = await parse(body);
    expect((event.raw as { shopId?: string }).shopId).toBe("69876357");
  });
});

describe("edge-runtime compatibility", () => {
  it("the adapter's runtime sources use no Node-only builtins (WebCrypto only)", async () => {
    // Static guard: node:crypto/Buffer sneaking back in would silently break
    // Cloudflare Workers / Next.js edge deployments.
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const offenders: string[] = [];
    for (const file of await readdir(srcDir)) {
      const content = await readFile(join(srcDir, file), "utf8");
      if (/from "node:|require\("node:|Buffer\./.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("WebCrypto signature verification matches node:crypto output", async () => {
    const body = krAnswerFor({ uuid: "9".repeat(32), operationType: "DEBIT", detailedStatus: "AUTHORISED" });
    await expect(
      verifyPayZenWebhookSignature(body, headersFor(body, "password"), { passwords: [PASSWORD], hmacKeys: [] }),
    ).resolves.toBe(true);
    const event = await parsePayZenWebhookEvent(body, {});
    expect(event.pspName).toBe("payzen");
  });
});
