import { describe, expect, it, vi } from "vitest";
import {
  isPayFanoutError,
  utf8ToBase64Url,
  type CreatePaymentSessionInput,
  type PayFanoutError,
} from "@payfanout/core";
import { decodeSessionContext, PaysafeServerAdapter, type PaysafeServerAdapterConfig } from "../src/index.js";
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
const VERIFY: RequestMatcher = { method: "POST", path: VERIFICATIONS };
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

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
const bankEnvelope = (details: Record<string, unknown>): string =>
  `paysafe-bank.${utf8ToBase64Url(JSON.stringify(details))}`;
const eftEnvelope = bankEnvelope(EFT_DETAILS);
const eftSession = (amount = 12_50): Partial<CreatePaymentSessionInput> => ({
  amount,
  currency: "CAD",
  country: "CA",
  paymentMethodTypes: ["pad"],
});

const interacInput: CreatePaymentSessionInput = {
  amount: 5_44,
  currency: "CAD",
  country: "CA",
  paymentMethodTypes: ["interac_etransfer"],
  returnUrl: "https://shop.example/return",
  receiptEmail: "payer@example.com",
  idempotencyKey: "k-interac",
};

describe("Paysafe card completion replays", () => {
  it("answers a completion whose answer was lost with the payment Paysafe made, without re-sending it", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter);
    fake.loseAnswer(CREATE_PAYMENT);
    const info = await adapter.completePayment({ pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" });
    expect(info).toMatchObject({ status: "succeeded", amount: 2000, currency: "USD" });
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(1);
    // The key's read before sending, then one read after the lost answer.
    expect(lookups(fake, "payments", "k-complete")).toHaveLength(2);
  });

  it("reads a lost payment back patiently while the lookup trails it, never re-sending it", async () => {
    const { adapter, fake, sleeps } = makePair();
    const pspSessionId = await cardSession(adapter);
    fake.loseAnswer(CREATE_PAYMENT);
    fake.hideFromLookups("payments", "k-complete", 2); // the key's read, then the first read-back
    const info = await adapter.completePayment({ pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" });
    expect(info.status).toBe("succeeded");
    expect(fake.uniquePaymentCreations).toBe(1);
    const attempts = sent(fake, CREATE_PAYMENT);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.body?.["dupCheck"]).toBe(false);
    expect(sleeps).toEqual([250]);
  });

  it("ends a completion whose lost answer cannot be read back with a non-retryable processing_error, then recovers it under the same key", async () => {
    const { adapter, fake, sleeps } = makePair();
    const pspSessionId = await cardSession(adapter);
    const input = { pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" };
    fake.loseAnswer(CREATE_PAYMENT);
    fake.hideFromLookups("payments", "k-complete");
    const err = await rejection(adapter.completePayment(input));
    expect(err).toMatchObject({ code: "processing_error", retryable: false, pspName: "paysafe" });
    expect(err.message).toContain('merchantRefNum "k-complete" went unanswered');
    expect(err.message).toContain("same idempotency key");
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(1); // money-moving: never re-sent after an unknown outcome
    expect(lookups(fake, "payments", "k-complete")).toHaveLength(4);
    expect(sleeps).toEqual([250, 500]);
    fake.hideFromLookups("payments", "k-complete", 0);
    const replay = await adapter.completePayment(input);
    expect(replay.status).toBe("succeeded");
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(1);
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("reads a same-token replay's 5283 back as the payment it already made", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter);
    const input = { pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" };
    fake.loseAnswer(CREATE_PAYMENT);
    fake.hideFromLookups("payments", "k-complete", 4);
    await rejection(adapter.completePayment(input));
    fake.hideFromLookups("payments", "k-complete", 1); // the replay's read of its key misses it too
    const replay = await adapter.completePayment(input);
    expect(replay.status).toBe("succeeded");
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(2); // the lost one, then the replay Paysafe refused with 5283
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

  it("lets a new card complete under the key of a declined attempt, charging once", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter);
    const declined = await rejection(
      adapter.completePayment({ pspSessionId, clientToken: "tok_declined", idempotencyKey: "order-1" }),
    );
    expect(declined.code).toBe("insufficient_funds");
    // Replaying the declined card itself reads its decline back without sending anything.
    const again = await rejection(
      adapter.completePayment({ pspSessionId, clientToken: "tok_declined", idempotencyKey: "order-1" }),
    );
    expect(again).toMatchObject({ code: "insufficient_funds", retryable: false });
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(1);
    const info = await adapter.completePayment({ pspSessionId, clientToken: "tok_card_b", idempotencyKey: "order-1" });
    expect(info).toMatchObject({ status: "succeeded", amount: 2000 });
    expect(fake.uniquePaymentCreations).toBe(1);
    const attempts = sent(fake, CREATE_PAYMENT);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.body?.["dupCheck"])).toEqual([false, false]);
    expect(attempts[1]!.body).toMatchObject({ merchantRefNum: "order-1", paymentHandleToken: "tok_card_b" });
  });

  it("reads a key's records past Paysafe's default page of ten", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter);
    const decline = { status: 402, code: "3009", message: "Your request has been declined by the issuing bank." };
    for (let n = 0; n < 10; n += 1) {
      fake.recordFailure(CREATE_PAYMENT, decline);
      await rejection(adapter.completePayment({ pspSessionId, clientToken: `tok_decline_${n}`, idempotencyKey: "order-many" }));
    }
    const paid = await adapter.completePayment({ pspSessionId, clientToken: "tok_good", idempotencyKey: "order-many" });
    // Paid again with a fresh tokenization: the key's eleventh record is its payment.
    const again = await adapter.completePayment({ pspSessionId, clientToken: "tok_again", idempotencyKey: "order-many" });
    expect(again.pspPaymentId).toBe(paid.pspPaymentId);
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(11);
  });

  it("refuses a key holding a full lookup page rather than reading part of it", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter);
    const decline = { status: 402, code: "3009", message: "Your request has been declined by the issuing bank." };
    for (let n = 0; n < 50; n += 1) {
      fake.recordFailure(CREATE_PAYMENT, decline);
      await rejection(adapter.completePayment({ pspSessionId, clientToken: `tok_decline_${n}`, idempotencyKey: "order-full" }));
    }
    const err = await rejection(
      adapter.completePayment({ pspSessionId, clientToken: "tok_good", idempotencyKey: "order-full" }),
    );
    expect(err).toMatchObject({ code: "processing_error", retryable: false });
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(50);
  });

  it("sends a new card after a decline filed without its handle, as Paysafe's decline example is", async () => {
    const { adapter, fake } = makePair();
    fake.failedPaymentsLikeDeclineExample = true;
    const pspSessionId = await cardSession(adapter);
    fake.recordFailure(CREATE_PAYMENT, { status: 402, code: "3009", message: "Your request has been declined by the issuing bank." });
    const declined = await rejection(
      adapter.completePayment({ pspSessionId, clientToken: "tok_card_a", idempotencyKey: "order-tokenless" }),
    );
    // The same card again: its handle is spent (5283), and the decline is read back.
    const replayed = await rejection(
      adapter.completePayment({ pspSessionId, clientToken: "tok_card_a", idempotencyKey: "order-tokenless" }),
    );
    expect(replayed).toMatchObject({ code: declined.code, retryable: false });
    const info = await adapter.completePayment({ pspSessionId, clientToken: "tok_card_b", idempotencyKey: "order-tokenless" });
    expect(info.status).toBe("succeeded");
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sent(fake, CREATE_PAYMENT).map((a) => a.body?.["paymentHandleToken"])).toEqual([
      "tok_card_a",
      "tok_card_a",
      "tok_card_b",
    ]);
  });

  it("lets a bank debit follow a declined one filed without its handle", async () => {
    const { adapter, fake } = makePair();
    fake.failedPaymentsLikeDeclineExample = true;
    const pspSessionId = await cardSession(adapter, eftSession());
    fake.recordFailure(CREATE_PAYMENT, { status: 402, code: "3009", message: "Your request has been declined by the issuing bank." });
    await rejection(adapter.completePayment({ pspSessionId, clientToken: eftEnvelope, idempotencyKey: "order-eft-retry" }));
    await adapter.completePayment({ pspSessionId, clientToken: eftEnvelope, idempotencyKey: "order-eft-retry" });
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(2);
  });

  it("answers a completion retried with a fresh tokenization with the payment the key already made", async () => {
    // The completion's answer never reached the browser, and the customer paid again.
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter);
    const first = await adapter.completePayment({ pspSessionId, clientToken: "tok_first", idempotencyKey: "order-2" });
    const again = await adapter.completePayment({ pspSessionId, clientToken: "tok_second", idempotencyKey: "order-2" });
    expect(again.pspPaymentId).toBe(first.pspPaymentId);
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(1);
  });

  it("will not pick one of several live payments other handles made under the key", async () => {
    const { adapter, fake } = makePair();
    // Two concurrent completions with different cards can both land under one key.
    for (const token of ["tok_x", "tok_y"]) {
      await fake.fetch(`https://api.test.paysafe.com${PAYMENTS}`, {
        method: "POST",
        headers: { authorization: "Basic legacy" },
        body: JSON.stringify({
          merchantRefNum: "order-3",
          dupCheck: false,
          amount: 2000,
          currencyCode: "USD",
          paymentHandleToken: token,
          settleWithAuth: true,
        }),
      });
    }
    const pspSessionId = await cardSession(adapter);
    const err = await rejection(adapter.completePayment({ pspSessionId, clientToken: "tok_z", idempotencyKey: "order-3" }));
    expect(err).toMatchObject({ code: "processing_error", retryable: false });
    expect(err.message).toContain("2 payments");
    expect(fake.uniquePaymentCreations).toBe(2);
  });

  it("answers a handle another call spent with a non-retryable processing_error, never an invalid_request", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter);
    await adapter.completePayment({ pspSessionId, clientToken: "tok_once", idempotencyKey: "k-first" });
    const err = await rejection(
      adapter.completePayment({ pspSessionId, clientToken: "tok_once", idempotencyKey: "k-second" }),
    );
    expect(err).toMatchObject({ code: "processing_error", retryable: false, raw: { cause: { error: { code: "5283" } } } });
    expect(err.message).toContain("payment handle as no longer payable");
    expect(err.message).toContain('merchantRefNum "k-second"');
    expect(err.message).toContain("can never be read back");
    expect(fake.uniquePaymentCreations).toBe(1);
    // The key's read, then three patient reads before giving the answer.
    expect(lookups(fake, "payments", "k-second")).toHaveLength(4);
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
    let reads = 0;
    const scripted: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        posts += 1;
        throw new TypeError("connection reset after the request was sent");
      }
      reads += 1;
      // The key's read before sending finds nothing; the read-back finds these.
      const payments =
        reads === 1
          ? []
          : [
              { id: "pay_other", merchantRefNum: "someone-else", amount: 2000, currencyCode: "USD", status: "COMPLETED" },
              // A record that omits its reference and its handle is taken at the lookup's word.
              { id: "pay_9", amount: 2000, currencyCode: "USD", status: "COMPLETED", settleWithAuth: true },
            ];
      return new Response(JSON.stringify({ payments }));
    };
    const { adapter } = makePair({ fetch: scripted });
    const pspSessionId = await cardSession(adapter);
    const info = await adapter.completePayment({ pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" });
    expect(info.pspPaymentId).toBe("pay_9");
    expect(posts).toBe(1);
  });
});

describe("Paysafe saved-method charge replays", () => {
  const charge = (adapter: PaysafeServerAdapter, idempotencyKey: string, amount = 1500, token = SEEDED_MULTI_USE_TOKEN) =>
    adapter.chargeSavedPaymentMethod({
      pspCustomerId: "cust_1",
      savedPaymentMethodToken: token,
      amount,
      currency: "USD",
      idempotencyKey,
    });

  it("never re-sends a saved-card charge whose answer was lost: it is read back patiently", async () => {
    const { adapter, fake, sleeps } = makePair();
    fake.loseAnswer(CREATE_PAYMENT);
    fake.hideFromLookups("payments", "k-renewal", 1);
    const info = await charge(adapter, "k-renewal");
    expect(info).toMatchObject({ status: "succeeded", amount: 1500 });
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(1);
    expect(sent(fake, CREATE_PAYMENT)[0]!.body?.["dupCheck"]).toBe(true);
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sleeps).toEqual([250]);
  });

  it("ends a saved-card charge whose lost answer cannot be read back, and a later replay reads it back", async () => {
    const { adapter, fake } = makePair();
    fake.loseAnswer(CREATE_PAYMENT);
    fake.hideFromLookups("payments", "k-renewal");
    const err = await rejection(charge(adapter, "k-renewal"));
    expect(err).toMatchObject({ code: "processing_error", retryable: false });
    expect(err.message).toContain("went unanswered");
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(1);
    expect(lookups(fake, "payments", "k-renewal")).toHaveLength(3);
    fake.hideFromLookups("payments", "k-renewal", 0);
    const replay = await charge(adapter, "k-renewal");
    expect(replay.status).toBe("succeeded");
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(2); // the replay, which Paysafe refused as a duplicate
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("answers a replayed renewal with the charge it already made", async () => {
    const { adapter, fake } = makePair();
    const first = await charge(adapter, "payfanout-sub-1-2026-08-01-a0");
    const again = await charge(adapter, "payfanout-sub-1-2026-08-01-a0");
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("reads a replay Paysafe answers 3044 ('You have submitted a duplicate request.') back the same way", async () => {
    const { adapter, fake } = makePair();
    fake.duplicateCode = "3044";
    const first = await charge(adapter, "k-renewal");
    const again = await charge(adapter, "k-renewal");
    expect(again.pspPaymentId).toBe(first.pspPaymentId);
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("fails closed when Paysafe reports a duplicate it cannot show: a non-retryable processing_error", async () => {
    const { adapter, fake, sleeps } = makePair();
    await charge(adapter, "k-lost");
    fake.hideFromLookups("payments", "k-lost");
    const err = await rejection(charge(adapter, "k-lost"));
    expect(err).toMatchObject({ code: "processing_error", retryable: false, pspName: "paysafe" });
    expect(err.message).toContain('merchantRefNum "k-lost"');
    expect(err.message).toContain("30 days back");
    expect(err.raw).toMatchObject({ merchantRefNum: "k-lost", cause: { error: { code: "5031" } } });
    expect(lookups(fake, "payments", "k-lost")).toHaveLength(3);
    expect(sleeps).toEqual([250, 500]);
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("rejects a charge of another saved card under a key a charge already used", async () => {
    const { adapter, fake } = makePair();
    const { pspCustomerId } = await adapter.createCustomer({ idempotencyKey: "k-cust" });
    const saved = await adapter.savePaymentMethod({ pspCustomerId, clientToken: "tok_single_vault", idempotencyKey: "k-save" });
    await charge(adapter, "k-renewal");
    const err = await rejection(charge(adapter, "k-renewal", 1500, saved.token));
    expect(err).toMatchObject({ code: "invalid_request", retryable: false });
    expect(err.message).toContain("payment handle");
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
    expect(attempts[1]!.body).toMatchObject({ merchantRefNum: "k-complete", dupCheck: false });
    expect(lookups(fake, "payments", "k-complete")).toHaveLength(1); // the key's read before sending, only
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
    expect(lookups(fake, "payments", "k-complete")).toHaveLength(1);
  });

  it("does not re-send a payment after a 5xx that may have hidden it; the same key completes it later", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter);
    const input = { pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" };
    fake.refuse(CREATE_PAYMENT, 503); // refused before processing, which nothing tells the adapter
    const err = await rejection(adapter.completePayment(input));
    expect(err).toMatchObject({ code: "processing_error", retryable: false });
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(1);
    expect(lookups(fake, "payments", "k-complete")).toHaveLength(4);
    const info = await adapter.completePayment(input);
    expect(info.status).toBe("succeeded");
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(2);
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("re-sends a verification after a 5xx once the lookup shows nothing: it moves no money", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter, { amount: 0 });
    fake.refuse(VERIFY, 503);
    const info = await adapter.verifyPaymentMethod({ pspSessionId, clientToken: "tok_verify", idempotencyKey: "k-verify" });
    expect(info.status).toBe("succeeded");
    expect(sent(fake, VERIFY)).toHaveLength(2);
    expect(lookups(fake, "verifications", "k-verify")).toHaveLength(1);
  });

  it("gives up on a verification after maxNetworkRetries, looking up after every unknown outcome", async () => {
    const { adapter, fake } = makePair({ maxNetworkRetries: 1 });
    const pspSessionId = await cardSession(adapter, { amount: 0 });
    fake.refuse(VERIFY, 503, 5);
    const err = await rejection(
      adapter.verifyPaymentMethod({ pspSessionId, clientToken: "tok_verify", idempotencyKey: "k-verify" }),
    );
    expect(err).toMatchObject({ code: "psp_unavailable", retryable: true });
    expect(sent(fake, VERIFY)).toHaveLength(2);
    expect(lookups(fake, "verifications", "k-verify")).toHaveLength(2);
  });

  it("stops a verification when the lookup itself fails, and a replay under the same key recovers it", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter, { amount: 0 });
    const input = { pspSessionId, clientToken: "tok_verify", idempotencyKey: "k-verify" };
    fake.loseAnswer(VERIFY);
    fake.refuse({ method: "GET", path: VERIFICATIONS }, 429); // the read-back is refused too
    const err = await rejection(adapter.verifyPaymentMethod(input));
    expect(err).toMatchObject({ code: "psp_unavailable", retryable: true });
    expect(sent(fake, VERIFY)).toHaveLength(1); // outcome unknown: never re-sent blind
    const replay = await adapter.verifyPaymentMethod(input);
    expect(replay.status).toBe("succeeded");
    expect(sent(fake, VERIFY)).toHaveLength(2);
  });

  it("ends a payment whose read-backs all fail as retry-later, and a replay under the same key recovers it", async () => {
    const fake = new FakePaysafeApi();
    let failReads = true;
    const { adapter } = makePair({
      fetch: (input, init) => {
        const response = fake.fetch(input, init);
        if (init?.method === "POST" && failReads) {
          failReads = false;
          fake.refuse({ method: "GET", path: PAYMENTS }, 429, 3);
        }
        return response;
      },
    });
    const pspSessionId = await cardSession(adapter);
    const input = { pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" };
    fake.loseAnswer(CREATE_PAYMENT);
    const err = await rejection(adapter.completePayment(input));
    expect(err).toMatchObject({ code: "processing_error", retryable: false });
    expect(fake.requestsTo("POST", PAYMENTS)).toHaveLength(1);
    const replay = await adapter.completePayment(input);
    expect(replay.status).toBe("succeeded");
    expect(fake.requestsTo("POST", PAYMENTS)).toHaveLength(1); // read back before anything was sent
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

  it("reads an 'entity not found' lookup as nothing found", async () => {
    let posts = 0;
    const reads: string[] = [];
    const scripted: typeof fetch = async (input, init) => {
      if (init?.method === "POST") {
        posts += 1;
        return new Response(
          JSON.stringify({ id: "pay_9", status: "COMPLETED", amount: 2000, currencyCode: "USD", settleWithAuth: true }),
        );
      }
      reads.push(urlOf(input));
      return new Response(JSON.stringify({ error: { code: "5269", message: "Entity not found" } }), { status: 404 });
    };
    const { adapter } = makePair({ fetch: scripted });
    const pspSessionId = await cardSession(adapter);
    const info = await adapter.completePayment({ pspSessionId, clientToken: "tok_card", idempotencyKey: "k-complete" });
    expect(info.pspPaymentId).toBe("pay_9");
    expect(posts).toBe(1);
    expect(reads).toEqual([`https://api.test.paysafe.com${PAYMENTS}?merchantRefNum=k-complete&limit=50`]);
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

  it("sends dupCheck false on single-use completions, true on saved-card charges, captures, refunds and verifications, and none on handles or voids", async () => {
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
    const interac = await adapter.createPaymentSession(interacInput);
    await adapter.completePayment({ pspSessionId: interac.pspSessionId, clientToken: "redirect", idempotencyKey: "k-interac-pay" });
    const dupChecks = Object.fromEntries(
      sent(fake, CREATE_PAYMENT).map((r) => [r.body?.["merchantRefNum"], r.body?.["dupCheck"]]),
    );
    expect(dupChecks).toEqual({ "k-card": false, "k-auth": false, "k-saved": true, "k-eft": false, "k-interac-pay": false });
    for (const endpoint of [SETTLE, REFUND, VERIFY]) {
      const bodies = sent(fake, endpoint).map((r) => r.body);
      expect(bodies.length, String(endpoint.path)).toBeGreaterThan(0);
      for (const body of bodies) expect(body?.["dupCheck"], String(endpoint.path)).toBe(true);
    }
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

  it("does not re-send a capture whose lost answer cannot be read back", async () => {
    const { adapter, fake } = makePair();
    const id = await authorize(adapter);
    fake.loseAnswer(SETTLE);
    fake.hideFromLookups("settlements", "k-capture");
    const err = await rejection(adapter.capturePayment(id, 2000, "k-capture"));
    expect(err).toMatchObject({ code: "processing_error", retryable: false });
    expect(err.message).toContain('settlement request with merchantRefNum "k-capture" went unanswered');
    expect(sent(fake, SETTLE)).toHaveLength(1);
    expect(lookups(fake, "settlements", "k-capture")).toHaveLength(3);
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

  it("surfaces a capture Paysafe refuses on state with nothing to read back: the documented 402 stands", async () => {
    const { adapter, fake } = makePair();
    const id = await authorize(adapter);
    const err = await rejection(adapter.capturePayment(id, 2500, "k-capture"));
    expect(err).toMatchObject({ code: "invalid_request", raw: { error: { code: "3204" } } });
    expect(lookups(fake, "settlements", "k-capture")).toHaveLength(3);
  });

  it("rethrows a capture Paysafe recorded as failed, as it does a payment", async () => {
    const { adapter, fake } = makePair();
    const id = await authorize(adapter);
    fake.recordFailure(SETTLE, { status: 500, code: "1007", message: "An internal error occurred." });
    const err = await rejection(adapter.capturePayment(id, 2000, "k-capture"));
    expect(err).toMatchObject({ code: "processing_error", retryable: false, raw: { error: { code: "1007" } } });
    expect(sent(fake, SETTLE)).toHaveLength(1);
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

  it("reads a void back when the re-sent one is refused after a lost answer, never taking the refusal for the whole story", async () => {
    const { adapter, fake } = makePair();
    const id = await authorize(adapter);
    fake.loseAnswer(VOID);
    fake.hideFromLookups("voidAuths", "k-void", 1); // the read before the re-send misses it
    const canceled = await adapter.cancelPayment(id, "k-void");
    expect(canceled.status).toBe("canceled");
    expect(sent(fake, VOID)).toHaveLength(2); // the lost one, then the re-send Paysafe refused (3501)
    expect(lookups(fake, "voidauths", "k-void")).toHaveLength(2);
  });

  it("ends as retry-later when a void refused after a lost answer still cannot be read back", async () => {
    const { adapter, fake } = makePair();
    const id = await authorize(adapter);
    fake.loseAnswer(VOID);
    fake.hideFromLookups("voidAuths", "k-void");
    const err = await rejection(adapter.cancelPayment(id, "k-void"));
    expect(err).toMatchObject({ code: "processing_error", retryable: false, raw: { cause: { error: { code: "3501" } } } });
    expect(err.message).toContain("went unanswered");
    expect(sent(fake, VOID)).toHaveLength(2);
  });

  it("falls back to the voided remainder when the void answer omits its amount", async () => {
    const fake = new FakePaysafeApi();
    const { adapter } = makePair({
      fetch: async (input, init) => {
        const response = await fake.fetch(input, init);
        if (init?.method !== "POST" || !urlOf(input).endsWith("/voidauths")) return response;
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

  it("does not re-send a refund whose lost answer cannot be read back", async () => {
    const { adapter, fake } = makePair();
    const id = await settle(adapter);
    fake.loseAnswer(REFUND);
    fake.hideFromLookups("refunds", "k-refund");
    const err = await rejection(adapter.refundPayment({ pspPaymentId: id, amount: 500, idempotencyKey: "k-refund" }));
    expect(err).toMatchObject({ code: "processing_error", retryable: false });
    expect(sent(fake, REFUND)).toHaveLength(1);
    expect(fake.uniqueRefundCreations).toBe(1);
  });

  it("rethrows a refund Paysafe recorded as declined when its lost answer is read back", async () => {
    const { adapter, fake } = makePair();
    const id = await settle(adapter);
    fake.loseAnswer(REFUND);
    fake.recordFailure(REFUND, {
      status: 402,
      code: "3421",
      message: "The purchase return authorization has been declined by the issuing bank.",
    });
    const err = await rejection(adapter.refundPayment({ pspPaymentId: id, amount: 500, idempotencyKey: "k-refund" }));
    expect(err).toMatchObject({ code: "card_declined", retryable: false, raw: { status: "FAILED", error: { code: "3421" } } });
    expect(fake.uniqueRefundCreations).toBe(0);
  });

  it("reads a refund replay Paysafe answers 3417 (another request in progress) back as that refund", async () => {
    const { adapter, fake } = makePair();
    const id = await settle(adapter);
    const first = await adapter.refundPayment({ pspPaymentId: id, amount: 500, idempotencyKey: "k-refund" });
    fake.rejectAs(REFUND, "3417");
    const again = await adapter.refundPayment({ pspPaymentId: id, amount: 500, idempotencyKey: "k-refund" });
    expect(again.refundId).toBe(first.refundId);
    expect(fake.uniqueRefundCreations).toBe(1);
  });

  it("ends as retry-later when Paysafe reports another request in progress and nothing can be read back", async () => {
    const { adapter, fake } = makePair();
    const id = await settle(adapter);
    fake.rejectAs(REFUND, "3417");
    const err = await rejection(adapter.refundPayment({ pspPaymentId: id, amount: 500, idempotencyKey: "k-refund" }));
    expect(err).toMatchObject({ code: "processing_error", retryable: false, raw: { cause: { error: { code: "3417" } } } });
    expect(err.message).toContain("still processing another request");
    expect(lookups(fake, "refunds", "k-refund")).toHaveLength(3);
  });

  it("ends as retry-later when Paysafe calls a capture a duplicate (3044) that cannot be read back", async () => {
    const { adapter, fake } = makePair();
    const id = await authorize(adapter);
    fake.rejectAs(SETTLE, "3044");
    const err = await rejection(adapter.capturePayment(id, 2000, "k-capture"));
    expect(err).toMatchObject({ code: "processing_error", retryable: false, raw: { cause: { error: { code: "3044" } } } });
    expect(err.message).toContain("as already processed");
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
    fake.loseAnswer(VERIFY);
    const first = await adapter.verifyPaymentMethod(input);
    const again = await adapter.verifyPaymentMethod(input);
    expect(first.status).toBe("succeeded");
    expect(again.pspPaymentId).toBe(first.pspPaymentId);
    const attempts = sent(fake, VERIFY);
    expect(attempts).toHaveLength(2); // the lost one, then the replay Paysafe rejected as a duplicate
    expect(attempts.every((a) => a.body?.["dupCheck"] === true)).toBe(true);
  });

  it("rejects a verification of another card under a key a verification already used", async () => {
    const { adapter } = makePair();
    const pspSessionId = await cardSession(adapter, { amount: 0 });
    await adapter.verifyPaymentMethod({ pspSessionId, clientToken: "tok_verify", idempotencyKey: "k-verify" });
    const err = await rejection(
      adapter.verifyPaymentMethod({ pspSessionId, clientToken: "tok_other", idempotencyKey: "k-verify" }),
    );
    expect(err).toMatchObject({ code: "invalid_request", retryable: false });
    expect(err.message).toContain("different Paysafe verification");
  });

  it("reads verification failures back from their recorded code and status", async () => {
    const cases = [
      // A decline (402) is recorded FAILED with its code.
      { token: "tok_declined", expected: "insufficient_funds" },
      // ERROR is Paysafe's failure "for non-business reason".
      {
        token: "tok_verify",
        failure: { status: 502, code: "1001", message: "An error occurred with the external processing gateway.", recordStatus: "ERROR" as const },
        expected: "processing_error",
      },
      // An unmapped code on a FAILED record is a decline, Paysafe's 402.
      {
        token: "tok_verify",
        failure: { status: 402, code: "3013", message: "Your request has been declined by the issuing bank due to problems with the credit card account." },
        expected: "card_declined",
      },
    ];
    for (const { token, failure, expected } of cases) {
      const { adapter, fake } = makePair();
      const pspSessionId = await cardSession(adapter, { amount: 0 });
      fake.loseAnswer(VERIFY);
      if (failure) fake.recordFailure(VERIFY, failure);
      const err = await rejection(adapter.verifyPaymentMethod({ pspSessionId, clientToken: token, idempotencyKey: "k-verify" }));
      expect(err, expected).toMatchObject({ code: expected, retryable: false });
    }
  });

  it("does not take a 429 after an unanswered verification for the whole story", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter, { amount: 0 });
    fake.refuse(VERIFY, 503);
    fake.refuse(VERIFY, 429, 2);
    const err = await rejection(
      adapter.verifyPaymentMethod({ pspSessionId, clientToken: "tok_verify", idempotencyKey: "k-verify" }),
    );
    expect(err).toMatchObject({ code: "processing_error", retryable: false, raw: { cause: { error: { code: "1200" } } } });
    expect(err.message).toContain("went unanswered");
    expect(sent(fake, VERIFY)).toHaveLength(3);
    expect(lookups(fake, "verifications", "k-verify")).toHaveLength(4);
  });
});

describe("Paysafe payment-handle replays", () => {
  it("reuses the Interac handle a lost answer hid instead of minting a second redirect", async () => {
    const { adapter, fake } = makePair();
    fake.loseAnswer(CREATE_HANDLE);
    const session = await adapter.createPaymentSession(interacInput);
    expect(session.status).toBe("requires_action");
    expect(fake.uniqueHandleCreations).toBe(1);
    expect(sent(fake, CREATE_HANDLE)).toHaveLength(1);
  });

  it("re-sends an Interac handle refused before processing once the lookup shows nothing", async () => {
    const { adapter, fake } = makePair();
    fake.refuse(CREATE_HANDLE, 503);
    const session = await adapter.createPaymentSession(interacInput);
    expect(session.status).toBe("requires_action");
    expect(fake.uniqueHandleCreations).toBe(1);
    expect(sent(fake, CREATE_HANDLE)).toHaveLength(2);
  });

  it("reuses the most advanced Interac handle the key holds, and mints anew when none is usable", async () => {
    const handle = (n: number, status: string): Record<string, unknown> => ({
      id: `ph_${n}`,
      paymentHandleToken: `PH${n}Token`,
      merchantRefNum: "k-interac",
      paymentType: "INTERAC_ETRANSFER",
      amount: 5_44,
      currencyCode: "CAD",
      status,
      links: [{ rel: "redirect_payment", href: `https://api.test.paysafe.com/alternatepayments/v1/redirect?paymentHandleId=ph_${n}` }],
    });
    const cases: Array<{ statuses: string[]; reused?: string }> = [
      { statuses: ["EXPIRED", "INITIATED", "PROCESSING", "PAYABLE", "COMPLETED"], reused: "PH5Token" },
      { statuses: ["FAILED", "INITIATED", "PROCESSING"], reused: "PH3Token" },
      { statuses: ["EXPIRED", "FAILED"] },
    ];
    for (const { statuses, reused } of cases) {
      const fake = new FakePaysafeApi();
      const { adapter } = makePair({
        fetch: async (input, init) =>
          (init?.method ?? "GET") === "GET" && new URL(urlOf(input)).pathname === HANDLES
            ? new Response(JSON.stringify({ paymentHandles: statuses.map((status, i) => handle(i + 1, status)) }))
            : fake.fetch(input, init),
      });
      const session = await adapter.createPaymentSession(interacInput);
      const context = await decodeSessionContext(session.pspSessionId, SIGNING_KEY);
      if (reused) {
        expect(context.paymentHandleToken, statuses.join()).toBe(reused);
        expect(fake.uniqueHandleCreations).toBe(0);
      } else {
        expect(fake.uniqueHandleCreations).toBe(1);
      }
    }
  });

  it("rejects a replayed Interac session whose key minted a handle for another amount", async () => {
    const { adapter, fake } = makePair();
    await adapter.createPaymentSession(interacInput);
    const err = await rejection(adapter.createPaymentSession({ ...interacInput, amount: 6_00 }));
    expect(err).toMatchObject({ code: "invalid_request", raw: { expected: { amount: 6_00 }, found: [{ amount: 5_44 }] } });
    expect(fake.uniqueHandleCreations).toBe(1);
  });

  it("answers a replayed Interac completion with the payment it made", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession(interacInput);
    const input = { pspSessionId: session.pspSessionId, clientToken: "redirect", idempotencyKey: "k-interac-pay" };
    const first = await adapter.completePayment(input);
    const again = await adapter.completePayment(input);
    expect(again.pspPaymentId).toBe(first.pspPaymentId);
    expect(fake.uniquePaymentCreations).toBe(1);
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

  it("answers a replayed bank completion from the payment it made, reading the key back patiently", async () => {
    const { adapter, fake, sleeps } = makePair();
    const pspSessionId = await cardSession(adapter, eftSession());
    const input = { pspSessionId, clientToken: eftEnvelope, idempotencyKey: "k-eft" };
    const first = await adapter.completePayment(input);
    // The payment lookup trails, but the key's handle shows a payments call spent it.
    fake.hideFromLookups("payments", "k-eft", 1);
    const again = await adapter.completePayment(input);
    expect(again.pspPaymentId).toBe(first.pspPaymentId);
    expect(fake.uniqueHandleCreations).toBe(1);
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sent(fake, CREATE_HANDLE)).toHaveLength(1);
    expect(sleeps).toEqual([250]);
  });

  it("will not debit again while the payment its spent handle made stays hidden", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter, eftSession());
    const input = { pspSessionId, clientToken: eftEnvelope, idempotencyKey: "k-eft" };
    await adapter.completePayment(input);
    fake.hideFromLookups("payments", "k-eft");
    const err = await rejection(adapter.completePayment(input));
    expect(err).toMatchObject({ code: "processing_error", retryable: false, raw: { cause: { status: "COMPLETED" } } });
    expect(err.message).toContain("payment handle as no longer payable");
    expect(fake.uniqueHandleCreations).toBe(1);
    expect(sent(fake, CREATE_PAYMENT)).toHaveLength(1);
  });

  it("lets a bank debit complete under the key of a declined one, debiting once", async () => {
    const { adapter, fake } = makePair();
    const pspSessionId = await cardSession(adapter, eftSession());
    const input = { pspSessionId, clientToken: eftEnvelope, idempotencyKey: "k-eft" };
    fake.recordFailure(CREATE_PAYMENT, { status: 402, code: "3009", message: "Your request has been declined by the issuing bank." });
    const declined = await rejection(adapter.completePayment(input));
    expect(declined.code).toBe("card_declined");
    const info = await adapter.completePayment(input);
    expect(info.status).toBe("processing");
    expect(fake.uniqueHandleCreations).toBe(2); // the declined attempt spent its handle
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sent(fake, CREATE_PAYMENT).map((r) => r.body?.["dupCheck"])).toEqual([false, false]);
  });

  it("reuses the uncharged handle an earlier attempt minted from the same bank details", async () => {
    const { adapter, fake } = makePair({ maxNetworkRetries: 0 });
    const pspSessionId = await cardSession(adapter, eftSession());
    const input = { pspSessionId, clientToken: eftEnvelope, idempotencyKey: "k-eft" };
    fake.refuse(CREATE_PAYMENT, 429);
    expect((await rejection(adapter.completePayment(input))).code).toBe("rate_limited");
    const info = await adapter.completePayment(input);
    expect(info.status).toBe("processing");
    expect(fake.uniqueHandleCreations).toBe(1);
    expect(sent(fake, CREATE_HANDLE)).toHaveLength(1);
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("mints a new handle when the uncharged one was minted from other bank details", async () => {
    const others = [
      { accountHolderName: "Marie Tremblay" },
      // Paysafe's documented invalid-routing simulation values: another branch.
      { institutionId: "123", transitNumber: "12345" },
    ];
    for (const changed of others) {
      const { adapter, fake } = makePair({ maxNetworkRetries: 0 });
      const pspSessionId = await cardSession(adapter, eftSession());
      fake.refuse(CREATE_PAYMENT, 429);
      await rejection(adapter.completePayment({ pspSessionId, clientToken: eftEnvelope, idempotencyKey: "k-eft" }));
      const other = bankEnvelope({ ...EFT_DETAILS, ...changed });
      const info = await adapter.completePayment({ pspSessionId, clientToken: other, idempotencyKey: "k-eft" });
      expect(info.status, JSON.stringify(changed)).toBe("processing");
      expect(fake.uniqueHandleCreations).toBe(2);
      expect(fake.uniquePaymentCreations).toBe(1);
    }
  });

  it("reuses an uncharged handle whose echo states no bank details: nothing contradicts them", async () => {
    const fake = new FakePaysafeApi();
    const { adapter } = makePair({
      fetch: async (input, init) =>
        (init?.method ?? "GET") === "GET" && new URL(urlOf(input)).pathname === HANDLES
          ? new Response(
              JSON.stringify({
                paymentHandles: [
                  { id: "ph_x", paymentHandleToken: "PHxToken", merchantRefNum: "k-eft", paymentType: "EFT", amount: 12_50, currencyCode: "CAD", status: "PAYABLE" },
                ],
              }),
            )
          : fake.fetch(input, init),
    });
    const pspSessionId = await cardSession(adapter, eftSession());
    await adapter.completePayment({ pspSessionId, clientToken: eftEnvelope, idempotencyKey: "k-eft" });
    expect(fake.uniqueHandleCreations).toBe(0);
    expect(sent(fake, CREATE_PAYMENT)[0]!.body).toMatchObject({ paymentHandleToken: "PHxToken", dupCheck: false });
  });

  it("rejects a bank completion whose key already paid another amount", async () => {
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
    expect(err).toMatchObject({ code: "invalid_request", raw: { expected: { amount: 13_00 }, found: [{ amount: 12_50 }] } });
    expect(err.message).toContain("different Paysafe payment");
    expect(fake.uniqueHandleCreations).toBe(1);
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("rejects a bank completion whose key already minted a handle for another amount", async () => {
    const { adapter, fake } = makePair({ maxNetworkRetries: 0 });
    fake.refuse(CREATE_PAYMENT, 429);
    await rejection(
      adapter.completePayment({
        pspSessionId: await cardSession(adapter, eftSession(12_50)),
        clientToken: eftEnvelope,
        idempotencyKey: "k-eft",
      }),
    );
    const err = await rejection(
      adapter.completePayment({
        pspSessionId: await cardSession(adapter, eftSession(13_00)),
        clientToken: eftEnvelope,
        idempotencyKey: "k-eft",
      }),
    );
    expect(err).toMatchObject({ code: "invalid_request" });
    expect(err.message).toContain("different Paysafe payment handle");
    expect(fake.uniqueHandleCreations).toBe(1);
    expect(fake.uniquePaymentCreations).toBe(0);
  });

  it("models /paymenthandles as accepting dupCheck, which Paysafe's handle examples send true and false", async () => {
    const fake = new FakePaysafeApi();
    const mint = (dupCheck: boolean) =>
      fake.fetch(`https://api.test.paysafe.com${HANDLES}`, {
        method: "POST",
        headers: { authorization: "Basic legacy" },
        body: JSON.stringify({
          merchantRefNum: "k-handle",
          transactionType: "PAYMENT",
          paymentType: "EFT",
          amount: 5_00,
          currencyCode: "CAD",
          eft: { accountHolderName: "Jean Tremblay", institutionId: "001", transitNumber: "22446", accountNumber: "897543213" },
          dupCheck,
        }),
      });
    expect((await mint(true)).status).toBe(201);
    expect((await mint(true)).status).toBe(409);
    expect((await mint(false)).status).toBe(201);
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
