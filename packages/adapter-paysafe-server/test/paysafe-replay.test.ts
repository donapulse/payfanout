import { describe, expect, it, vi } from "vitest";
import {
  isPayFanoutError,
  utf8ToBase64Url,
  type CreatePaymentSessionInput,
  type PayFanoutError,
} from "@payfanout/core";
import { PaysafeServerAdapter, type PaysafeServerAdapterConfig } from "../src/index.js";
import { FakePaysafeApi, SEEDED_MULTI_USE_TOKEN, type RequestMatcher } from "./fake-paysafe-api.js";

/**
 * Replay safety as Paysafe documents it: a reused merchantRefNum is REJECTED
 * (409/5031 under dupCheck), a payments call spends a single-use handle
 * (5283 afterwards), and the originals are read back through the
 * GET ?merchantRefNum= lookups. The fake takes the dangerous reading wherever
 * Paysafe documents nothing, so a blind re-send shows up as a second charge,
 * a second handle, or a spurious rejection.
 */

const SIGNING_KEY = "session-signing-key";
const PAYMENTS = "/paymenthub/v1/payments";
const HANDLES = "/paymenthub/v1/paymenthandles";
const VERIFICATIONS = "/paymenthub/v1/verifications";
const CREATE_PAYMENT: RequestMatcher = { method: "POST", path: PAYMENTS };
const CREATE_HANDLE: RequestMatcher = { method: "POST", path: HANDLES };
const SETTLE: RequestMatcher = { method: "POST", path: /^\/paymenthub\/v1\/payments\/[^/]+\/settlements$/ };
const VOID: RequestMatcher = { method: "POST", path: /^\/paymenthub\/v1\/payments\/[^/]+\/voidauths$/ };
const REFUND: RequestMatcher = { method: "POST", path: /^\/paymenthub\/v1\/settlements\/[^/]+\/refunds$/ };

function makePair(config: Partial<PaysafeServerAdapterConfig> = {}): {
  adapter: PaysafeServerAdapter;
  fake: FakePaysafeApi;
  sleeps: number[];
} {
  const fake = new FakePaysafeApi();
  const sleeps: number[] = [];
  const adapter = new PaysafeServerAdapter({
    username: "api_user",
    password: "api_pass",
    environment: "sandbox",
    merchantAccountResolver: (currency) => `acct-${currency}`,
    sessionSigningKey: SIGNING_KEY,
    webhookHmacKey: "webhook-hmac-key",
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...config,
  });
  return { adapter, fake, sleeps };
}

/** The attempts a call made against one endpoint. */
function sent(fake: FakePaysafeApi, matcher: RequestMatcher): FakePaysafeApi["requests"] {
  return fake.requests.filter(
    (r) =>
      r.method === matcher.method &&
      (typeof matcher.path === "string" ? r.path === matcher.path : matcher.path.test(r.path)),
  );
}

/** The ?merchantRefNum= lookups of one collection for one reference. */
function lookups(fake: FakePaysafeApi, collectionPath: string, merchantRefNum: string): FakePaysafeApi["requests"] {
  return fake.requests.filter(
    (r) =>
      r.method === "GET" &&
      r.path === `/paymenthub/v1/${collectionPath}` &&
      new URLSearchParams(r.search).get("merchantRefNum") === merchantRefNum,
  );
}

async function cardSession(
  adapter: PaysafeServerAdapter,
  overrides: Partial<CreatePaymentSessionInput> = {},
): Promise<string> {
  const session = await adapter.createPaymentSession({
    amount: 2000,
    currency: "USD",
    country: "US",
    idempotencyKey: "k-session",
    ...overrides,
  });
  return session.pspSessionId;
}

async function rejection(promise: Promise<unknown>): Promise<PayFanoutError> {
  try {
    await promise;
  } catch (err) {
    if (isPayFanoutError(err)) return err;
    throw err;
  }
  throw new Error("expected the call to reject");
}

const EFT_DETAILS = {
  v: 1,
  paymentType: "EFT",
  accountHolderName: "Jean Tremblay",
  institutionId: "001", // Paysafe's documented EFT simulation values
  transitNumber: "22446",
  accountNumber: "897543213",
};
const eftEnvelope = `paysafe-bank.${utf8ToBase64Url(JSON.stringify(EFT_DETAILS))}`;
const eftSession = (amount = 12_50): Partial<CreatePaymentSessionInput> => ({
  amount,
  currency: "CAD",
  country: "CA",
  paymentMethodTypes: ["pad"],
});

describe("Paysafe card completion replays", () => {
  it("answers a completion whose answer was lost with the payment Paysafe made, without re-sending it", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter);
    fake.loseAnswer(CREATE_PAYMENT);
    const info = await adapter.completePayment({ pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" });
    expect(info).toMatchObject({ status: "succeeded", amount: 2000, currency: "USD" });
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(1);
    expect(lookups(fake, "payments", "k-complete")).toHaveLength(1);
  });

  it("re-sends only after finding nothing, and reads the spent handle's 5283 back as this payment", async () => {
    const { adapter, fake, sleeps } = makePair();
    const pspSessionId = await cardSession(adapter);
    fake.loseAnswer(CREATE_PAYMENT);
    fake.hideFromLookups("payments", "k-complete", 1); // the index trails the write
    const info = await adapter.completePayment({ pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" });
    expect(info.status).toBe("succeeded");
    expect(fake.uniquePaymentCreations).toBe(1);
    const attempts = sent(fake, CREATE_PAYMENT);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.body?.["dupCheck"] === true)).toBe(true);
    expect(sleeps).toEqual([250]);
  });

  it("reads a 5031 back the same way when Paysafe checks the merchantRefNum before the handle", async () => {
    const { adapter, fake } = makePair();
    fake.duplicateCheckFirst = true;
    const pspSessionId = await cardSession(adapter);
    fake.loseAnswer(CREATE_PAYMENT);
    fake.hideFromLookups("payments", "k-complete", 1);
    const info = await adapter.completePayment({ pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" });
    expect(info.status).toBe("succeeded");
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(2);
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("recovers a completion that timed out after Paysafe processed it (JPY)", async () => {
    const { adapter, fake } = makePair({ requestTimeoutMs: 20 });
    const pspSessionId = await cardSession(adapter, { amount: 500, currency: "JPY", country: "JP" });
    fake.loseAnswer(CREATE_PAYMENT, "hang");
    const info = await adapter.completePayment({ pspSessionId, clientToken: "tok_jpy", idempotencyKey: "k-jpy" });
    expect(info).toMatchObject({ status: "succeeded", amount: 500, currency: "JPY" });
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(1);
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("treats a 5xx as an unknown outcome: the processed payment is read back, not charged again", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter);
    fake.loseAnswer(CREATE_PAYMENT, 503);
    const info = await adapter.completePayment({ pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" });
    expect(info.status).toBe("succeeded");
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(1);
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("reads a decline whose answer was lost back as that decline, never as a pending payment", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter);
    fake.loseAnswer(CREATE_PAYMENT);
    const err = await rejection(
      adapter.completePayment({ pspSessionId, clientToken: "tok_declined", idempotencyKey: "k-declined" }),
    );
    expect(err).toMatchObject({ code: "insufficient_funds", retryable: false, pspName: "paysafe" });
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(1);
  });

  it("does not mistake a handle another completion spent for a replay: Paysafe's 5283 stands", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter);
    await adapter.completePayment({ pspSessionId, clientToken: "tok_once", idempotencyKey: "k-first" });
    const err = await rejection(
      adapter.completePayment({ pspSessionId, clientToken: "tok_once", idempotencyKey: "k-second" }),
    );
    expect(err).toMatchObject({ code: "invalid_request", raw: { error: { code: "5283" } } });
    expect(fake.uniquePaymentCreations).toBe(1);
    // Looked for a k-second payment a bounded number of times before giving Paysafe's answer back.
    expect(lookups(fake, "payments", "k-second")).toHaveLength(3);
  });

  it("refuses to pass another payment off as the replay when a key is reused for a different amount (BHD)", async () => {
    const { adapter, fake } = makePair();
    const first = await cardSession(adapter, { amount: 1234, currency: "BHD", country: "BH" });
    await adapter.completePayment({ pspSessionId: first, clientToken: "tok_a", idempotencyKey: "order-7" });
    const second = await cardSession(adapter, { amount: 1235, currency: "BHD", country: "BH" });
    const err = await rejection(
      adapter.completePayment({ pspSessionId: second, clientToken: "tok_b", idempotencyKey: "order-7" }),
    );
    expect(err).toMatchObject({ code: "invalid_request", retryable: false });
    expect(err.message).toContain('merchantRefNum "order-7"');
    expect(err.raw).toMatchObject({ expected: { amount: 1235, currency: "BHD" }, found: [{ amount: 1234 }] });
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("treats the same amount in another currency as another payment", async () => {
    const { adapter } = makePair();
    const usd = await cardSession(adapter);
    await adapter.completePayment({ pspSessionId: usd, clientToken: "tok_usd", idempotencyKey: "order-8" });
    const cad = await cardSession(adapter, { currency: "CAD", country: "CA" });
    const err = await rejection(adapter.completePayment({ pspSessionId: cad, clientToken: "tok_cad", idempotencyKey: "order-8" }));
    expect(err).toMatchObject({ code: "invalid_request", raw: { expected: { currency: "CAD" }, found: [{ currencyCode: "USD" }] } });
  });

  it("only counts lookup records filed under this very reference", async () => {
    let posts = 0;
    const scripted: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        posts += 1;
        throw new TypeError("connection reset after the request was sent");
      }
      return new Response(
        JSON.stringify({
          payments: [
            { id: "pay_other", merchantRefNum: "someone-else", amount: 2000, currencyCode: "USD", status: "COMPLETED" },
            // A record that omits its reference is taken at the lookup's word.
            { id: "pay_9", amount: 2000, currencyCode: "USD", status: "COMPLETED", settleWithAuth: true },
          ],
        }),
      );
    };
    const { adapter } = makePair({ fetch: scripted });
    const pspSessionId = await cardSession(adapter);
    const info = await adapter.completePayment({ pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" });
    expect(info.pspPaymentId).toBe("pay_9");
    expect(posts).toBe(1);
  });
});

describe("Paysafe saved-method charge replays", () => {
  const charge = (adapter: PaysafeServerAdapter, idempotencyKey: string, amount = 1500) =>
    adapter.chargeSavedPaymentMethod({
      pspCustomerId: "cust_1",
      savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
      amount,
      currency: "USD",
      idempotencyKey,
    });

  it("never charges a saved card twice: the re-sent charge is rejected as a duplicate and read back", async () => {
    const { adapter, fake } = makePair();
    fake.loseAnswer(CREATE_PAYMENT);
    fake.hideFromLookups("payments", "k-renewal", 1);
    const info = await charge(adapter, "k-renewal");
    expect(info).toMatchObject({ status: "succeeded", amount: 1500 });
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(2);
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("answers a replayed renewal with the charge it already made", async () => {
    const { adapter, fake } = makePair();
    const first = await charge(adapter, "payfanout-sub-1-2026-08-01-a0");
    const again = await charge(adapter, "payfanout-sub-1-2026-08-01-a0");
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("fails closed when Paysafe reports a duplicate it cannot show: a non-retryable processing_error", async () => {
    const { adapter, fake, sleeps } = makePair();
    await charge(adapter, "k-lost");
    fake.hideFromLookups("payments", "k-lost");
    const err = await rejection(charge(adapter, "k-lost"));
    expect(err).toMatchObject({ code: "processing_error", retryable: false, pspName: "paysafe" });
    expect(err.message).toContain('merchantRefNum "k-lost"');
    expect(err.raw).toMatchObject({ merchantRefNum: "k-lost", cause: { error: { code: "5031" } } });
    expect(lookups(fake, "payments", "k-lost")).toHaveLength(3);
    expect(sleeps).toEqual([250, 500]);
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("will not pick one of several payments filed under the same reference", async () => {
    const { adapter, fake } = makePair();
    // An integration that sent no dupCheck could file two charges under one reference.
    for (let i = 0; i < 2; i += 1) {
      await fake.fetch(`https://api.test.paysafe.com${PAYMENTS}`, {
        method: "POST",
        headers: { authorization: "Basic legacy" },
        body: JSON.stringify({
          merchantRefNum: "legacy-7",
          amount: 900,
          currencyCode: "USD",
          paymentHandleToken: SEEDED_MULTI_USE_TOKEN,
          settleWithAuth: true,
        }),
      });
    }
    const err = await rejection(charge(adapter, "legacy-7", 900));
    expect(err).toMatchObject({ code: "processing_error", retryable: false });
    expect(err.message).toContain("2 payments");
    expect(fake.uniquePaymentCreations).toBe(2);
  });
});

describe("Paysafe write transport", () => {
  it("re-sends a rate-limited write after backoff, without a lookup: Paysafe refused it unprocessed", async () => {
    // No sleep seam: the real backoff timer runs once (250ms).
    const { adapter, fake } = makePair({ sleep: undefined });
    const pspSessionId = await cardSession(adapter);
    fake.refuse(CREATE_PAYMENT, 429);
    const info = await adapter.completePayment({ pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" });
    expect(info.status).toBe("succeeded");
    const attempts = sent(fake, CREATE_PAYMENT);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.body).toMatchObject({ merchantRefNum: "k-complete", dupCheck: true });
    expect(lookups(fake, "payments", "k-complete")).toHaveLength(0);
  });

  it("surfaces rate limiting once the retry budget is spent", async () => {
    const { adapter, fake } = makePair({ maxNetworkRetries: 1 });
    const pspSessionId = await cardSession(adapter);
    fake.refuse(CREATE_PAYMENT, 429, 5);
    const err = await rejection(
      adapter.completePayment({ pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" }),
    );
    expect(err).toMatchObject({ code: "rate_limited", retryable: true });
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(2);
    expect(lookups(fake, "payments", "k-complete")).toHaveLength(0);
  });

  it("re-sends a write that failed with a 5xx before processing, once the lookup shows nothing", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter);
    fake.refuse(CREATE_PAYMENT, 503);
    const info = await adapter.completePayment({ pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" });
    expect(info.status).toBe("succeeded");
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(2);
    expect(lookups(fake, "payments", "k-complete")).toHaveLength(1);
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("gives up after maxNetworkRetries, looking up after every unknown outcome", async () => {
    const { adapter, fake } = makePair({ maxNetworkRetries: 1 });
    const pspSessionId = await cardSession(adapter);
    fake.refuse(CREATE_PAYMENT, 503, 5);
    const err = await rejection(
      adapter.completePayment({ pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" }),
    );
    expect(err).toMatchObject({ code: "psp_unavailable", retryable: true });
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(2);
    expect(lookups(fake, "payments", "k-complete")).toHaveLength(2);
    expect(fake.uniquePaymentCreations).toBe(0);
  });

  it("stops when the lookup itself fails, and a later replay under the same key recovers the payment", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter);
    const input = { pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" };
    fake.loseAnswer(CREATE_PAYMENT);
    fake.refuse({ method: "GET", path: PAYMENTS }, 429); // the read-back is refused too
    const err = await rejection(adapter.completePayment(input));
    expect(err).toMatchObject({ code: "psp_unavailable", retryable: true });
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(1); // outcome unknown: never re-sent blind
    const replay = await adapter.completePayment(input);
    expect(replay.status).toBe("succeeded");
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("reads back even with maxNetworkRetries: 0 — a lookup is not a re-send", async () => {
    const { adapter, fake } = makePair({ maxNetworkRetries: 0 });
    const pspSessionId = await cardSession(adapter);
    fake.loseAnswer(CREATE_PAYMENT);
    const info = await adapter.completePayment({ pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" });
    expect(info.status).toBe("succeeded");
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(1);
  });

  it("reads an 'entity not found' lookup as nothing found, then re-sends", async () => {
    let posts = 0;
    const reads: string[] = [];
    const scripted: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "POST") {
        posts += 1;
        if (posts === 1) throw new TypeError("connection reset");
        return new Response(
          JSON.stringify({ id: "pay_9", status: "COMPLETED", amount: 2000, currencyCode: "USD", settleWithAuth: true }),
        );
      }
      reads.push(url);
      return new Response(JSON.stringify({ error: { code: "5269", message: "Entity not found" } }), { status: 404 });
    };
    const { adapter } = makePair({ fetch: scripted });
    const pspSessionId = await cardSession(adapter);
    const info = await adapter.completePayment({ pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" });
    expect(info.pspPaymentId).toBe("pay_9");
    expect(posts).toBe(2);
    expect(reads).toEqual([`https://api.test.paysafe.com${PAYMENTS}?merchantRefNum=k-complete`]);
  });

  it("keeps replaying reads on transport trouble, as Paysafe's own SDKs do", async () => {
    const { adapter, fake, sleeps } = makePair();
    const pspSessionId = await cardSession(adapter);
    const paid = await adapter.completePayment({ pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" });
    const read = `${PAYMENTS}/${paid.pspPaymentId}`;
    fake.refuse({ method: "GET", path: read }, 503, 2);
    const info = await adapter.retrievePayment(paid.pspPaymentId);
    expect(info.status).toBe("succeeded");
    expect(fake.requestsTo("GET", read)).toHaveLength(3);
    expect(sleeps).toEqual([250, 500]);
  });

  it("waits 60 seconds, the response timeout of Paysafe's own SDKs, before calling an exchange hung", async () => {
    vi.useFakeTimers();
    try {
      const hanging: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      const { adapter } = makePair({ fetch: hanging, maxNetworkRetries: 0 });
      const settled = vi.fn();
      const outcome = adapter.retrievePayment("pay_1").catch((err: unknown) => {
        settled();
        return err;
      });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toMatchObject({
        code: "psp_unavailable",
        message: "Paysafe did not respond within 60000ms.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends dupCheck exactly where Paysafe documents it: never on /paymenthandles or /voidauths", async () => {
    const { adapter, fake } = makePair();
    const paid = await adapter.completePayment({
      pspSessionId: await cardSession(adapter),
      clientToken: "tok_card",
      idempotencyKey: "k-card",
    });
    await adapter.refundPayment({ pspPaymentId: paid.pspPaymentId, amount: 100, idempotencyKey: "k-refund" });
    const authorized = await adapter.completePayment({
      pspSessionId: await cardSession(adapter, { captureMethod: "manual" }),
      clientToken: "tok_auth",
      idempotencyKey: "k-auth",
    });
    await adapter.capturePayment(authorized.pspPaymentId, 500, "k-capture");
    await adapter.cancelPayment(authorized.pspPaymentId, "k-void");
    await adapter.verifyPaymentMethod({
      pspSessionId: await cardSession(adapter, { amount: 0 }),
      clientToken: "tok_verify",
      idempotencyKey: "k-verify",
    });
    await adapter.chargeSavedPaymentMethod({
      pspCustomerId: "cust_1",
      savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
      amount: 700,
      currency: "USD",
      idempotencyKey: "k-saved",
    });
    await adapter.completePayment({
      pspSessionId: await cardSession(adapter, eftSession()),
      clientToken: eftEnvelope,
      idempotencyKey: "k-eft",
    });
    for (const endpoint of [CREATE_PAYMENT, SETTLE, REFUND, { method: "POST", path: VERIFICATIONS } as const]) {
      const bodies = sent(fake, endpoint).map((r) => r.body);
      expect(bodies.length, String(endpoint.path)).toBeGreaterThan(0);
      for (const body of bodies) expect(body?.["dupCheck"], String(endpoint.path)).toBe(true);
    }
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(4);
    for (const endpoint of [CREATE_HANDLE, VOID]) {
      const bodies = sent(fake, endpoint).map((r) => r.body);
      expect(bodies.length, String(endpoint.path)).toBeGreaterThan(0);
      for (const body of bodies) expect(body, String(endpoint.path)).not.toHaveProperty("dupCheck");
    }
  });
});

describe("Paysafe modification replays", () => {
  const authorize = async (adapter: PaysafeServerAdapter): Promise<string> =>
    (
      await adapter.completePayment({
        pspSessionId: await cardSession(adapter, { captureMethod: "manual" }),
        clientToken: "tok_auth",
        idempotencyKey: "k-auth",
      })
    ).pspPaymentId;

  const settle = async (adapter: PaysafeServerAdapter): Promise<string> =>
    (
      await adapter.completePayment({
        pspSessionId: await cardSession(adapter),
        clientToken: "tok_paid",
        idempotencyKey: "k-paid",
      })
    ).pspPaymentId;

  it("recovers a capture whose answer was lost: one settlement, the captured payment returned", async () => {
    const { adapter, fake } = makePair();
    const id = await authorize(adapter);
    fake.loseAnswer(SETTLE);
    const captured = await adapter.capturePayment(id, 2000, "k-capture");
    expect(captured).toMatchObject({ status: "succeeded", amountCaptured: 2000, amountCapturable: 0 });
    const attempts = sent(fake, SETTLE);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.body).toMatchObject({ merchantRefNum: "k-capture", dupCheck: true, amount: 2000 });
    expect(lookups(fake, "settlements", "k-capture")).toHaveLength(1);
  });

  it("answers a replayed capture from its settlement, whichever check Paysafe runs first", async () => {
    for (const stateCheckFirst of [false, true]) {
      const { adapter, fake } = makePair();
      fake.stateCheckFirst = stateCheckFirst;
      const id = await authorize(adapter);
      await adapter.capturePayment(id, 2000, "k-capture");
      const again = await adapter.capturePayment(id, 2000, "k-capture");
      expect(again.amountCaptured, `stateCheckFirst ${stateCheckFirst}`).toBe(2000);
      expect(sent(fake, SETTLE)).toHaveLength(2);
    }
  });

  it("recovers a void whose answer was lost by lookup alone — voidauths take no dupCheck", async () => {
    const { adapter, fake } = makePair();
    const id = await authorize(adapter);
    fake.loseAnswer(VOID);
    const canceled = await adapter.cancelPayment(id, "k-void");
    expect(canceled.status).toBe("canceled");
    const attempts = sent(fake, VOID);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.body).not.toHaveProperty("dupCheck");
    expect(lookups(fake, "voidauths", "k-void")).toHaveLength(1);
  });

  it("falls back to the voided remainder when the void answer omits its amount", async () => {
    const fake = new FakePaysafeApi();
    const { adapter } = makePair({
      fetch: async (input, init) => {
        const response = await fake.fetch(input, init);
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (init?.method !== "POST" || !url.endsWith("/voidauths")) return response;
        const { amount: _omitted, ...rest } = (await response.json()) as Record<string, unknown>;
        return new Response(JSON.stringify(rest), { status: response.status });
      },
    });
    const id = await authorize(adapter);
    await adapter.capturePayment(id, 700, "k-capture");
    const released = await adapter.cancelPayment(id, "k-void");
    expect(released).toMatchObject({ status: "succeeded", amount: 700, amountCaptured: 700 });
  });

  it("answers a replayed cancel with the void it already made, keeping the settled split", async () => {
    const { adapter, fake } = makePair();
    const id = await authorize(adapter);
    await adapter.capturePayment(id, 700, "k-capture");
    const first = await adapter.cancelPayment(id, "k-void");
    const again = await adapter.cancelPayment(id, "k-void");
    expect(first).toMatchObject({ status: "succeeded", amount: 700, amountCaptured: 700 });
    expect(again).toMatchObject({ status: "succeeded", amount: 700, amountCaptured: 700 });
    expect(sent(fake, VOID)).toHaveLength(1);
  });

  it("recovers a refund whose answer was lost: one refund", async () => {
    const { adapter, fake } = makePair();
    const id = await settle(adapter);
    fake.loseAnswer(REFUND);
    const refund = await adapter.refundPayment({ pspPaymentId: id, amount: 500, idempotencyKey: "k-refund" });
    expect(refund).toMatchObject({ status: "succeeded", amount: 500 });
    expect(fake.uniqueRefundCreations).toBe(1);
    const attempts = sent(fake, REFUND);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.body).toMatchObject({ merchantRefNum: "k-refund", dupCheck: true, amount: 500 });
  });

  it("answers a replayed partial refund with that refund, whichever check Paysafe runs first", async () => {
    for (const stateCheckFirst of [false, true]) {
      const { adapter, fake } = makePair();
      fake.stateCheckFirst = stateCheckFirst;
      const id = await settle(adapter);
      const first = await adapter.refundPayment({ pspPaymentId: id, amount: 1500, idempotencyKey: "k-refund" });
      const again = await adapter.refundPayment({ pspPaymentId: id, amount: 1500, idempotencyKey: "k-refund" });
      expect(again.refundId, `stateCheckFirst ${stateCheckFirst}`).toBe(first.refundId);
      expect(fake.uniqueRefundCreations).toBe(1);
    }
  });

  it("answers a replayed full refund with that refund, not with 'no refundable settlement'", async () => {
    const { adapter, fake } = makePair();
    const id = await settle(adapter);
    const first = await adapter.refundPayment({ pspPaymentId: id, idempotencyKey: "k-refund-all" });
    const again = await adapter.refundPayment({ pspPaymentId: id, idempotencyKey: "k-refund-all" });
    expect(again).toMatchObject({ refundId: first.refundId, status: "succeeded", amount: 2000 });
    expect(fake.uniqueRefundCreations).toBe(1);
    expect(sent(fake, REFUND)).toHaveLength(1);
  });

  it("recovers a verification whose answer was lost, and answers its replay with the same verification", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter, { amount: 0 });
    const input = { pspSessionId, clientToken: "tok_verify", idempotencyKey: "k-verify" };
    fake.loseAnswer({ method: "POST", path: VERIFICATIONS });
    const first = await adapter.verifyPaymentMethod(input);
    const again = await adapter.verifyPaymentMethod(input);
    expect(first.status).toBe("succeeded");
    expect(again.pspPaymentId).toBe(first.pspPaymentId);
    const attempts = sent(fake, { method: "POST", path: VERIFICATIONS });
    expect(attempts).toHaveLength(2); // the lost one, then the replay Paysafe rejected as a duplicate
    expect(attempts.every((a) => a.body?.["dupCheck"] === true)).toBe(true);
  });
});

describe("Paysafe payment-handle replays", () => {
  const interacInput: CreatePaymentSessionInput = {
    amount: 5_44,
    currency: "CAD",
    country: "CA",
    paymentMethodTypes: ["interac_etransfer"],
    returnUrl: "https://shop.example/return",
    receiptEmail: "payer@example.com",
    idempotencyKey: "k-interac",
  };

  it("reuses the Interac handle a lost answer hid instead of minting a second redirect", async () => {
    const { adapter, fake } = makePair();
    fake.loseAnswer(CREATE_HANDLE);
    const session = await adapter.createPaymentSession(interacInput);
    expect(session.status).toBe("requires_action");
    expect(fake.uniqueHandleCreations).toBe(1);
    expect(sent(fake, CREATE_HANDLE)).toHaveLength(1);
  });

  it("recovers a bank debit whose payment answer was lost: one handle, one payment", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter, eftSession());
    fake.loseAnswer(CREATE_PAYMENT);
    const info = await adapter.completePayment({ pspSessionId, clientToken: eftEnvelope, idempotencyKey: "k-eft" });
    expect(info).toMatchObject({ status: "processing", paymentMethodType: "pad", amount: 12_50, currency: "CAD" });
    expect(fake.uniqueHandleCreations).toBe(1);
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("recovers a bank debit whose handle answer was lost, charging that very handle", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter, eftSession());
    fake.loseAnswer(CREATE_HANDLE);
    const info = await adapter.completePayment({ pspSessionId, clientToken: eftEnvelope, idempotencyKey: "k-eft" });
    expect(info.status).toBe("processing");
    expect(fake.uniqueHandleCreations).toBe(1);
    expect(sent(fake, CREATE_HANDLE)).toHaveLength(1);
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("answers a replayed bank completion from the handle it minted, reading the payment back patiently", async () => {
    const { adapter, fake, sleeps } = makePair();
    const pspSessionId = await cardSession(adapter, eftSession());
    const input = { pspSessionId, clientToken: eftEnvelope, idempotencyKey: "k-eft" };
    const first = await adapter.completePayment(input);
    fake.hideFromLookups("payments", "k-eft", 1);
    const again = await adapter.completePayment(input);
    expect(again.pspPaymentId).toBe(first.pspPaymentId);
    expect(fake.uniqueHandleCreations).toBe(1);
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sent(fake, CREATE_HANDLE)).toHaveLength(1);
    expect(sleeps).toEqual([250]);
  });

  it("rejects a bank completion whose key already minted a handle for another amount", async () => {
    const { adapter, fake } = makePair();
    await adapter.completePayment({
      pspSessionId: await cardSession(adapter, eftSession(12_50)),
      clientToken: eftEnvelope,
      idempotencyKey: "k-eft",
    });
    const err = await rejection(
      adapter.completePayment({
        pspSessionId: await cardSession(adapter, eftSession(13_00)),
        clientToken: eftEnvelope,
        idempotencyKey: "k-eft",
      }),
    );
    expect(err).toMatchObject({ code: "invalid_request" });
    expect(err.message).toContain("payment handle");
    expect(fake.uniqueHandleCreations).toBe(1);
    expect(fake.uniquePaymentCreations).toBe(1);
  });
});

describe("Paysafe vault and scheduler writes", () => {
  it("reads a customer profile a lost answer hid back by its merchantCustomerId, without re-sending", async () => {
    const { adapter, fake } = makePair();
    fake.loseAnswer({ method: "POST", path: "/paymenthub/v1/customers" });
    const customer = await adapter.createCustomer({ id: "user-1", idempotencyKey: "k-cust" });
    expect(customer.pspCustomerId).toMatch(/^cust_/);
    expect(fake.uniqueCustomerCreations).toBe(1);
    expect(fake.requestsTo("POST", "/paymenthub/v1/customers")).toHaveLength(1);
  });

  it("does not look a customer up after a rejection that proves nothing was created", async () => {
    const { adapter, fake } = makePair({ maxNetworkRetries: 0 });
    fake.refuse({ method: "POST", path: "/paymenthub/v1/customers" }, 429);
    const err = await rejection(adapter.createCustomer({ id: "user-1", idempotencyKey: "k-cust" }));
    expect(err).toMatchObject({ code: "rate_limited" });
    expect(fake.requestsTo("GET", "/paymenthub/v1/customers")).toHaveLength(0);
  });

  it("surfaces the transport error when the profile cannot be read back either", async () => {
    const { adapter, fake } = makePair();
    fake.loseAnswer({ method: "POST", path: "/paymenthub/v1/customers" });
    fake.refuse({ method: "GET", path: "/paymenthub/v1/customers" }, 503);
    const err = await rejection(adapter.createCustomer({ id: "user-1", idempotencyKey: "k-cust" }));
    expect(err).toMatchObject({ code: "psp_unavailable", retryable: true });
  });

  it("reads a vaulted card a lost answer hid back from the customer's handles", async () => {
    const { adapter, fake } = makePair();
    const { pspCustomerId } = await adapter.createCustomer({ idempotencyKey: "k-cust" });
    const convert = `/paymenthub/v1/customers/${pspCustomerId}/paymenthandles`;
    fake.loseAnswer({ method: "POST", path: convert });
    const saved = await adapter.savePaymentMethod({ pspCustomerId, clientToken: "tok_single_vault", idempotencyKey: "k-save" });
    expect(saved.token).toMatch(/^MU/);
    expect(await adapter.listSavedPaymentMethods(pspCustomerId)).toHaveLength(1);
    expect(fake.requestsTo("POST", convert)).toHaveLength(1);
  });

  it("surfaces the transport error when a lost save cannot be read back", async () => {
    const { adapter, fake } = makePair();
    const { pspCustomerId } = await adapter.createCustomer({ idempotencyKey: "k-cust" });
    fake.loseAnswer({ method: "POST", path: `/paymenthub/v1/customers/${pspCustomerId}/paymenthandles` });
    fake.refuse({ method: "GET", path: `/paymenthub/v1/customers/${pspCustomerId}` }, 503);
    const err = await rejection(
      adapter.savePaymentMethod({ pspCustomerId, clientToken: "tok_single_vault", idempotencyKey: "k-save" }),
    );
    expect(err).toMatchObject({ code: "psp_unavailable" });
  });

  it("treats a delete whose answer was lost as done once the token is gone from the vault", async () => {
    const { adapter, fake } = makePair();
    const { pspCustomerId } = await adapter.createCustomer({ idempotencyKey: "k-cust" });
    const saved = await adapter.savePaymentMethod({ pspCustomerId, clientToken: "tok_single_vault", idempotencyKey: "k-save" });
    const remove: RequestMatcher = { method: "DELETE", path: /\/paymenthandles\/mhdl_\d+$/ };
    fake.loseAnswer(remove);
    await expect(adapter.deleteSavedPaymentMethod(pspCustomerId, saved.token)).resolves.toBeUndefined();
    expect(await adapter.listSavedPaymentMethods(pspCustomerId)).toEqual([]);
    expect(sent(fake, remove)).toHaveLength(1);
  });

  it("surfaces a delete Paysafe rejected outright, without second-guessing it", async () => {
    const fake = new FakePaysafeApi();
    const { adapter } = makePair({
      fetch: async (input, init) =>
        init?.method === "DELETE"
          ? new Response(JSON.stringify({ error: { code: "5269", message: "Entity not found" } }), { status: 404 })
          : fake.fetch(input, init),
    });
    const { pspCustomerId } = await adapter.createCustomer({ idempotencyKey: "k-cust" });
    const saved = await adapter.savePaymentMethod({ pspCustomerId, clientToken: "tok_single_vault", idempotencyKey: "k-save" });
    const err = await rejection(adapter.deleteSavedPaymentMethod(pspCustomerId, saved.token));
    expect(err).toMatchObject({ code: "invalid_request", raw: { error: { code: "5269" } } });
  });

  it("surfaces the transport error when the delete cannot be confirmed", async () => {
    const { adapter, fake } = makePair();
    const { pspCustomerId } = await adapter.createCustomer({ idempotencyKey: "k-cust" });
    const saved = await adapter.savePaymentMethod({ pspCustomerId, clientToken: "tok_single_vault", idempotencyKey: "k-save" });
    fake.refuse({ method: "DELETE", path: /\/paymenthandles\/mhdl_\d+$/ }, 503);
    const err = await rejection(adapter.deleteSavedPaymentMethod(pspCustomerId, saved.token));
    expect(err).toMatchObject({ code: "psp_unavailable" });
    expect(await adapter.listSavedPaymentMethods(pspCustomerId)).toHaveLength(1);
  });

  it("recovers a native subscription whose answer was lost without re-sending the create", async () => {
    const { adapter, fake } = makePair();
    const subscribe: RequestMatcher = { method: "POST", path: /^\/subscriptionsplans\/v1\/plans\/[^/]+\/subscriptions$/ };
    fake.loseAnswer(subscribe);
    const record = await adapter.createNativeSubscription({
      savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
      amount: 1499,
      currency: "USD",
      interval: "month",
      idempotencyKey: "k-nsub",
    });
    expect(record).toMatchObject({ status: "active", amount: 1499, merchantRefNum: "k-nsub" });
    expect(fake.uniqueSubscriptionCreations).toBe(1);
    expect(sent(fake, subscribe)).toHaveLength(1);
  });

  it("settles a cancel whose answer was lost by re-reading the subscription, not by re-sending the PATCH", async () => {
    const { adapter, fake } = makePair();
    const created = await adapter.createNativeSubscription({
      savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
      amount: 1499,
      currency: "USD",
      interval: "month",
      idempotencyKey: "k-nsub",
    });
    const patch: RequestMatcher = { method: "PATCH", path: `/subscriptionsplans/v1/subscriptions/${created.id}` };
    fake.loseAnswer(patch);
    const canceled = await adapter.cancelNativeSubscription({ subscriptionId: created.id, idempotencyKey: "k-cancel" });
    expect(canceled.status).toBe("canceled");
    expect(sent(fake, patch)).toHaveLength(1);
  });

  it("does not re-send a plan creation whose answer was lost — plans carry no reference to look up", async () => {
    const { adapter, fake } = makePair();
    fake.loseAnswer({ method: "POST", path: "/subscriptionsplans/v1/plans" });
    const err = await rejection(
      adapter.createNativeSubscription({
        savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
        amount: 1499,
        currency: "USD",
        interval: "month",
        idempotencyKey: "k-nsub",
      }),
    );
    expect(err).toMatchObject({ code: "psp_unavailable", retryable: true });
    expect(fake.uniquePlanCreations).toBe(1);
    expect(fake.uniqueSubscriptionCreations).toBe(0);
  });
});
