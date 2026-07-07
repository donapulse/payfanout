import { describe, expect, it } from "vitest";
import { getRefundState, isPayFanoutError } from "@payfanout/core";
import { runServerAdapterConformanceTests } from "@payfanout/conformance";
import { PayZenServerAdapter, type PayZenServerAdapterConfig } from "../src/index.js";
import { FakePayZenApi } from "./fake-payzen-api.js";

function makePair(config: Partial<PayZenServerAdapterConfig> = {}): {
  adapter: PayZenServerAdapter;
  fake: FakePayZenApi;
} {
  const fake = new FakePayZenApi();
  const adapter = new PayZenServerAdapter({
    shopId: fake.shopId,
    password: fake.password,
    environment: "sandbox",
    hmacKey: fake.hmacKey,
    fetch: fake.fetch,
    // Deterministic failure injection: transport retries are covered by their
    // own tests in payzen-features.test.ts.
    maxNetworkRetries: 0,
    ...config,
  });
  return { adapter, fake };
}

/**
 * Deterministic IPN fixture: the exact kr-answer string and its
 * HMAC-SHA-256 over the DEMO store keys, both computed with an independent
 * tool. kr-hash covers the kr-answer STRING (not the delivery envelope), so
 * the conformance suite's re-serialization test genuinely changes the bytes
 * being hashed.
 */
const KR_ANSWER =
  '{"shopId":"69876357","orderCycle":"CLOSED","orderStatus":"PAID","serverDate":"2026-01-15T10:00:00+00:00",' +
  '"orderDetails":{"orderTotalAmount":990,"orderEffectiveAmount":990,"orderCurrency":"EUR","mode":"TEST",' +
  '"orderId":"myOrderId-475882","_type":"V4/OrderDetails"},"transactions":[{"uuid":"1c8356b0e24442b2acc579cf1ae4d814",' +
  '"amount":990,"currency":"EUR","paymentMethodType":"CARD","status":"PAID","detailedStatus":"AUTHORISED",' +
  '"operationType":"DEBIT","_type":"V4/PaymentTransaction"}],"_type":"V4/Payment"}';
/** hex(HMAC-SHA-256(demo password, KR_ANSWER)) — the IPN key family. */
const KR_HASH_PASSWORD = "f9bcc2c69e4970656f2b61f2a75a713a809818b43df50b1f5f63caf43846c367";
/** hex(HMAC-SHA-256(demo HMAC-SHA-256 key, KR_ANSWER)) — the browser-return key family. */
const KR_HASH_HMAC = "19c9a4259d1d35fea6b2d92377c7e30649fe540f896cede45bee59b425685ca6";

const IPN_HEADERS = {
  "kr-hash": KR_HASH_PASSWORD,
  "kr-hash-algorithm": "sha256_hmac",
  "kr-hash-key": "password",
};

const key = (): string => `k-${Math.random().toString(36).slice(2)}`;

// ---------------------------------------------------------------------------
// The exact same conformance contract the Stripe and Paysafe adapters pass.
//
// No `idempotency` fixture, deliberately: PayZen exposes NO idempotency
// mechanism (live-verified — identical CreatePayment bodies mint distinct
// formTokens) and Transaction/Refund carries no metadata/reference field a
// replayed key could be matched against, so refund dedupe cannot be
// implemented honestly. The adapter's synthesized guarantees (deterministic
// orderId, metadata stamps, never auto-retrying refunds) are covered below.
// ---------------------------------------------------------------------------
let lastFake: FakePayZenApi;
runServerAdapterConformanceTests(
  "payzen",
  () => {
    const { adapter, fake } = makePair();
    lastFake = fake;
    return adapter;
  },
  {
    createSessionInput: () => ({ amount: 1099, currency: "EUR", idempotencyKey: key() }),
    zeroDecimalSessionInput: () => ({ amount: 500, currency: "JPY", idempotencyKey: key() }),
    // BHD is unsupported by PayZen (absent from its currency table) — KWD
    // proves the 3-decimal path instead.
    threeDecimalSessionInput: () => ({ amount: 1234, currency: "KWD", idempotencyKey: key() }),
    webhook: {
      validRawBody: KR_ANSWER,
      validHeaders: IPN_HEADERS,
      expectedType: "payment.succeeded",
      // Stable dedupe rule: transaction uuid + detailedStatus (PayZen has no
      // event id and kr-hash regenerates per delivery).
      expectedEventId: "1c8356b0e24442b2acc579cf1ae4d814:AUTHORISED",
    },
    failingCalls: [
      {
        name: "retrievePayment on an unknown transaction uuid",
        invoke: (a) => a.retrievePayment("ffffffffffffffffffffffffffffffff"),
        expectedCode: "invalid_request",
      },
      {
        name: "createPaymentSession with BHD (not supported by PayZen)",
        invoke: (a) => a.createPaymentSession({ amount: 1234, currency: "BHD", idempotencyKey: "k" }),
        expectedCode: "invalid_request",
      },
      {
        // 4,000,000 core minor units = 40,000.00 KHR, but PayZen prices KHR
        // with 0 fractional digits and would read 4,000,000 riel — a 100x
        // overcharge. Excluded like CNY (1 digit vs ISO's 2).
        name: "createPaymentSession with KHR (PayZen fractional digits differ from ISO 4217)",
        invoke: (a) => a.createPaymentSession({ amount: 4_000_000, currency: "KHR", idempotencyKey: "k" }),
        expectedCode: "invalid_request",
      },
      {
        name: "refund exceeding the refundable remainder",
        invoke: async (a) => {
          const session = await a.createPaymentSession({ amount: 2000, currency: "EUR", idempotencyKey: key() });
          const tx = lastFake.payOrder(session.pspSessionId);
          lastFake.settle(tx.uuid);
          return a.refundPayment({ pspPaymentId: tx.uuid, amount: 5000, idempotencyKey: "r" });
        },
        expectedCode: "invalid_request",
      },
      {
        name: "cancelPayment on a captured transaction",
        invoke: async (a) => {
          const session = await a.createPaymentSession({ amount: 2000, currency: "EUR", idempotencyKey: key() });
          const tx = lastFake.payOrder(session.pspSessionId);
          lastFake.settle(tx.uuid);
          return a.cancelPayment(tx.uuid);
        },
        expectedCode: "invalid_request",
      },
      {
        name: "refund declined by the issuer (acquirer refusal envelope)",
        invoke: async (a) => {
          const session = await a.createPaymentSession({ amount: 2000, currency: "EUR", idempotencyKey: key() });
          const tx = lastFake.payOrder(session.pspSessionId);
          lastFake.settle(tx.uuid);
          lastFake.failNextEnvelope(
            { errorCode: "PSP_101", errorMessage: "Refund refused", detailedErrorCode: "05" },
            "Transaction/Refund",
          );
          return a.refundPayment({ pspPaymentId: tx.uuid, amount: 500, idempotencyKey: "r" });
        },
        expectedCode: "card_declined",
      },
      {
        name: "HTTP 503 from infrastructure in front of the gateway",
        invoke: (a) => {
          lastFake.failNextWith({ status: 503 });
          return a.retrievePayment("ffffffffffffffffffffffffffffffff");
        },
        expectedCode: "psp_unavailable",
      },
      {
        name: "HTTP 429 from infrastructure in front of the gateway",
        invoke: (a) => {
          lastFake.failNextWith({ status: 429 });
          return a.retrievePayment("ffffffffffffffffffffffffffffffff");
        },
        expectedCode: "rate_limited",
      },
      {
        name: "network failure reaching the gateway",
        invoke: (a) => {
          lastFake.failNextWith({ networkError: true });
          return a.retrievePayment("ffffffffffffffffffffffffffffffff");
        },
        expectedCode: "psp_unavailable",
      },
      {
        name: "auth failure envelope (INT_905 rides HTTP 200)",
        invoke: () =>
          new PayZenServerAdapter({
            shopId: lastFake.shopId,
            password: "testpassword_WrongKey",
            environment: "sandbox",
            fetch: lastFake.fetch,
            maxNetworkRetries: 0,
          }).retrievePayment("ffffffffffffffffffffffffffffffff"),
        expectedCode: "invalid_request",
      },
    ],
  },
);

// ---------------------------------------------------------------------------
// PayZen-specific behavior.
// ---------------------------------------------------------------------------
describe("PayZen deterministic signature vectors", () => {
  it("verifies the browser-return family (kr-hash-key: sha256_hmac) against the published demo key", async () => {
    const { adapter } = makePair();
    await expect(
      adapter.verifyWebhookSignature(KR_ANSWER, {
        "kr-hash": KR_HASH_HMAC,
        "kr-hash-algorithm": "sha256_hmac",
        "kr-hash-key": "sha256_hmac",
      }),
    ).resolves.toBe(true);
    // The right hash under the wrong family declaration must fail.
    await expect(
      adapter.verifyWebhookSignature(KR_ANSWER, { ...IPN_HEADERS, "kr-hash": KR_HASH_HMAC }),
    ).resolves.toBe(false);
  });
});

describe("PayZenServerAdapter sessions", () => {
  it("creates a formToken session with the derived orderId and payfanout metadata stamps", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      id: "order-9",
      amount: 2500,
      currency: "EUR",
      captureMethod: "manual",
      webhookUrl: "https://host.example/webhooks/payzen",
      billingDetails: {
        name: "Ann Buyer",
        email: "ann@example.com",
        address: { line1: "1 Way", city: "Berlin", postalCode: "10115", country: "DE" },
      },
      receiptEmail: "receipts@example.com",
      sca: { challenge: "force" },
      metadata: { plan: "pro" },
      idempotencyKey: "order-9-attempt-1",
    });
    expect(session).toMatchObject({
      id: "order-9",
      pspName: "payzen",
      pspSessionId: "pf-order-9-attempt-1",
      amount: 2500,
      currency: "EUR",
      status: "requires_payment_method",
      metadata: { plan: "pro" },
    });
    expect(session.clientSecret).toMatch(/DEMOTOKENPAYZEN$/); // the formToken IS the client secret
    expect(fake.lastRequestBody).toMatchObject({
      amount: 2500,
      currency: "EUR",
      orderId: "pf-order-9-attempt-1",
      contrib: "payfanout",
      strongAuthentication: "CHALLENGE_REQUESTED",
      ipnTargetUrl: "https://host.example/webhooks/payzen",
      transactionOptions: { cardOptions: { manualValidation: "YES" } },
      metadata: { plan: "pro", payfanout_key: "order-9-attempt-1", payfanout_id: "order-9" },
      customer: {
        email: "receipts@example.com", // receiptEmail wins over billing email
        billingDetails: { firstName: "Ann", lastName: "Buyer", address: "1 Way", city: "Berlin", zipCode: "10115", country: "DE" },
      },
    });
    // No per-transaction descriptor field exists in V4 — never sent.
    expect(fake.lastRequestBody).not.toHaveProperty("statementDescriptor");
  });

  it("maps shipping details and the MOTO exemption request", async () => {
    const { adapter, fake } = makePair();
    await adapter.createPaymentSession({
      amount: 100,
      currency: "EUR",
      shippingDetails: {
        name: "Bo Receiver",
        phone: "+49301234567",
        address: { line1: "2 Depot", line2: "Dock 4", city: "Hamburg", state: "HH", postalCode: "20095", country: "DE" },
      },
      sca: { exemption: "moto" },
      idempotencyKey: "k-ship",
    });
    expect(fake.lastRequestBody).toMatchObject({
      transactionOptions: { cardOptions: { paymentSource: "MOTO" } },
      customer: {
        shippingDetails: {
          firstName: "Bo",
          lastName: "Receiver",
          phoneNumber: "+49301234567",
          address: "2 Depot",
          address2: "Dock 4",
          city: "Hamburg",
          state: "HH",
          zipCode: "20095",
          country: "DE",
        },
      },
    });
  });

  it("replayed session creation mints a new formToken for the SAME orderId (no PSP-side dedupe exists)", async () => {
    const { adapter, fake } = makePair();
    const input = { amount: 900, currency: "EUR", idempotencyKey: "replay-me" };
    const first = await adapter.createPaymentSession(input);
    const second = await adapter.createPaymentSession(input);
    expect(second.pspSessionId).toBe(first.pspSessionId); // deterministic derivation
    expect(second.clientSecret).not.toBe(first.clientSecret); // live-verified gateway behavior
    expect(fake.uniqueFormTokenCreations).toBe(2); // harmless: no transaction exists until the shopper pays
  });

  it("distinguishes adapter-excluded currencies (CNY, KHR) from platform-unsupported ones (BHD)", async () => {
    const { adapter } = makePair();
    // PayZen supports CNY and KHR — claiming otherwise would be false. The
    // exclusion is the adapter's (fractional-digit mismatch with ISO 4217).
    await expect(
      adapter.createPaymentSession({ amount: 100, currency: "CNY", idempotencyKey: "k" }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("adapter excludes CNY") as string,
    });
    await expect(
      adapter.createPaymentSession({ amount: 4_000_000, currency: "KHR", idempotencyKey: "k" }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("adapter excludes KHR") as string,
    });
    await expect(
      adapter.createPaymentSession({ amount: 1234, currency: "BHD", idempotencyKey: "k" }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("PayZen does not support") as string,
    });
  });

  it("rejects non-card payment method requests", async () => {
    const { adapter } = makePair();
    await expect(
      adapter.createPaymentSession({
        amount: 100,
        currency: "EUR",
        paymentMethodTypes: ["card", "ideal"],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("keeps zero- and three-decimal amounts untouched end to end (JPY, KWD)", async () => {
    const { adapter, fake } = makePair();
    const jpy = await adapter.createPaymentSession({ amount: 500, currency: "JPY", idempotencyKey: "k-jpy" });
    fake.payOrder(jpy.pspSessionId);
    const jpyInfo = await adapter.retrievePayment(jpy.pspSessionId);
    expect(jpyInfo.amount).toBe(500);
    expect(jpyInfo.currency).toBe("JPY");

    const kwd = await adapter.createPaymentSession({ amount: 1234, currency: "KWD", idempotencyKey: "k-kwd" });
    fake.payOrder(kwd.pspSessionId);
    const kwdInfo = await adapter.retrievePayment(kwd.pspSessionId);
    expect(kwdInfo.amount).toBe(1234); // KWD 1.234 — integer minor units at every boundary
    expect(kwdInfo.currency).toBe("KWD");
  });
});

describe("PayZenServerAdapter reads", () => {
  it("retrieves by orderId (Order/Get) right after the browser pays, with receipt-grade facts", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      id: "order-77",
      amount: 1099,
      currency: "EUR",
      idempotencyKey: "k-77",
    });
    fake.payOrder(session.pspSessionId, { card: { brand: "MASTERCARD", pan: "597010XXXXXX0067" } });
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.status).toBe("succeeded"); // AUTHORISED: auto-capture scheduled
    expect(info.id).toBe("order-77"); // payfanout_id round-trips via metadata
    expect(info.pspPaymentId).toMatch(/^[0-9a-f]{32}$/);
    expect(info.paymentMethodDetails).toEqual({ brand: "mastercard", last4: "0067" });
    expect(info.amountRefunded).toBe(0);
  });

  it("retrieves by transaction uuid (Transaction/Get) with the answer preserved on raw", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 1099, currency: "EUR", idempotencyKey: "k" });
    const tx = fake.payOrder(session.pspSessionId);
    const info = await adapter.retrievePayment(tx.uuid);
    expect(info.pspPaymentId).toBe(tx.uuid);
    expect(info.createdAt).toBe(tx.creationDate);
    expect((info.raw as { uuid?: string }).uuid).toBe(tx.uuid);
  });

  it("orderId reads report the NEWEST payment attempt (retry-after-decline reality)", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 1099, currency: "EUR", idempotencyKey: "k" });
    fake.payOrder(session.pspSessionId, { status: "REFUSED" });
    const retry = fake.payOrder(session.pspSessionId);
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.pspPaymentId).toBe(retry.uuid);
    expect(info.status).toBe("succeeded");
  });

  it("a refused attempt reads as failed", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 1099, currency: "EUR", idempotencyKey: "k" });
    fake.payOrder(session.pspSessionId, { status: "REFUSED" });
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.status).toBe("failed");
  });
});

describe("PayZenServerAdapter capture and cancel", () => {
  it("manual flow: AUTHORISED_TO_VALIDATE -> requires_capture -> Transaction/Validate -> succeeded", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 4000,
      currency: "EUR",
      captureMethod: "manual",
      idempotencyKey: "k",
    });
    fake.payOrder(session.pspSessionId); // manualValidation:"YES" -> AUTHORISED_TO_VALIDATE
    const pending = await adapter.retrievePayment(session.pspSessionId);
    expect(pending.status).toBe("requires_capture");

    const captured = await adapter.capturePayment(pending.pspPaymentId, 4000);
    expect(captured.status).toBe("succeeded");
    expect(fake.lastOperation).toBe("Transaction/Validate"); // never Transaction/Capture (Brazil-only WS)
  });

  it("rejects a capture amount differing from the authorization (no partial validate)", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 4000,
      currency: "EUR",
      captureMethod: "manual",
      idempotencyKey: "k",
    });
    const tx = fake.payOrder(session.pspSessionId);
    await expect(adapter.capturePayment(tx.uuid, 1500)).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("capturing an already-validated transaction surfaces the PSP status error", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 4000,
      currency: "EUR",
      captureMethod: "manual",
      idempotencyKey: "k",
    });
    const tx = fake.payOrder(session.pspSessionId);
    await adapter.capturePayment(tx.uuid);
    await expect(adapter.capturePayment(tx.uuid)).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("cancels a pre-capture authorization by orderId", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 2000, currency: "EUR", idempotencyKey: "k" });
    fake.payOrder(session.pspSessionId); // AUTHORISED — cancelable until capture
    const canceled = await adapter.cancelPayment(session.pspSessionId);
    expect(canceled.status).toBe("canceled");
  });

  it("cancelling twice surfaces the already-cancelled rejection", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 2000, currency: "EUR", idempotencyKey: "k" });
    const tx = fake.payOrder(session.pspSessionId);
    await adapter.cancelPayment(tx.uuid);
    try {
      await adapter.cancelPayment(tx.uuid);
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("invalid_request");
        expect(err.retryable).toBe(false); // state rejections never cascade
        expect(err.raw).toBeDefined();
      }
    }
  });
});

describe("PayZenServerAdapter refunds", () => {
  async function capturedPayment(adapter: PayZenServerAdapter, fake: FakePayZenApi, amount = 5000): Promise<string> {
    const session = await adapter.createPaymentSession({ amount, currency: "EUR", idempotencyKey: key() });
    const tx = fake.payOrder(session.pspSessionId);
    fake.settle(tx.uuid);
    return tx.uuid;
  }

  it("partial then remainder: refunds are CREDIT transactions and amountRefunded sums them", async () => {
    const { adapter, fake } = makePair();
    const uuid = await capturedPayment(adapter, fake);

    const partial = await adapter.refundPayment({ pspPaymentId: uuid, amount: 1500, idempotencyKey: "r1" });
    expect(partial.status).toBe("succeeded");
    expect(partial.amount).toBe(1500);
    expect(partial.refundId).toMatch(/^[0-9a-f]{32}$/);
    expect(partial.refundId).not.toBe(uuid); // a refund is a NEW transaction

    let info = await adapter.retrievePayment(uuid);
    expect(info.amountRefunded).toBe(1500);
    expect(getRefundState(info)).toBe("partial");

    const rest = await adapter.refundPayment({ pspPaymentId: uuid, idempotencyKey: "r2" });
    expect(rest.amount).toBe(3500); // remainder, not the original total
    info = await adapter.retrievePayment(uuid);
    expect(info.amountRefunded).toBe(5000);
    expect(getRefundState(info)).toBe("full");
  });

  it("orderId reads sum successful credits too (partial-after-partial)", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 5000, currency: "EUR", idempotencyKey: "k-o" });
    const tx = fake.payOrder(session.pspSessionId);
    fake.settle(tx.uuid);
    await adapter.refundPayment({ pspPaymentId: tx.uuid, amount: 1000, idempotencyKey: "r1" });
    await adapter.refundPayment({ pspPaymentId: tx.uuid, amount: 700, idempotencyKey: "r2" });
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.amountRefunded).toBe(1700);
    expect(info.pspPaymentId).toBe(tx.uuid); // credits never shadow the payment
  });

  it("replaying a refund with the same idempotencyKey STACKS a second refund — PayZen offers no dedupe channel", async () => {
    // This documents the platform gap the guide warns about: Transaction/
    // Refund has no metadata/reference field, so the adapter cannot detect a
    // replay. Hosts must re-read amountRefunded before retrying refunds.
    const { adapter, fake } = makePair();
    const uuid = await capturedPayment(adapter, fake);
    await adapter.refundPayment({ pspPaymentId: uuid, amount: 1000, idempotencyKey: "same-key" });
    await adapter.refundPayment({ pspPaymentId: uuid, amount: 1000, idempotencyKey: "same-key" });
    expect(fake.uniqueRefundCreations).toBe(2);
    expect((await adapter.retrievePayment(uuid)).amountRefunded).toBe(2000);
  });

  it("full refund of an uncaptured payment resolves as a cancellation, reported honestly", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 3000, currency: "EUR", idempotencyKey: "k" });
    const tx = fake.payOrder(session.pspSessionId); // AUTHORISED, not captured
    const refund = await adapter.refundPayment({ pspPaymentId: tx.uuid, idempotencyKey: "r1" });
    expect(refund.status).toBe("succeeded"); // authorization released — the shopper was never charged
    expect(refund.refundId).toBe(tx.uuid); // the cancellation modifies the original transaction
    expect(refund.amount).toBe(3000);
    expect((refund.raw as { detailedStatus?: string }).detailedStatus).toBe("CANCELLED");

    const polled = await adapter.retrieveRefund(refund.refundId);
    expect(polled.status).toBe("succeeded"); // CANCELLED original still reads as a successful release
  });

  it("partial refund of an uncaptured payment surfaces PSP_076 as a retryable timing error", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 3000, currency: "EUR", idempotencyKey: "k" });
    const tx = fake.payOrder(session.pspSessionId);
    try {
      await adapter.refundPayment({ pspPaymentId: tx.uuid, amount: 500, idempotencyKey: "r1" });
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("processing_error"); // becomes refundable once capture lands
        expect(err.retryable).toBe(true);
      }
    }
  });

  it("refunding a refused payment rejects with the unpaid-transaction error", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 3000, currency: "EUR", idempotencyKey: "k" });
    const tx = fake.payOrder(session.pspSessionId, { status: "REFUSED" });
    await expect(adapter.refundPayment({ pspPaymentId: tx.uuid, idempotencyKey: "r" })).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
    });
  });

  it("a fully refunded payment rejects further full refunds locally", async () => {
    const { adapter, fake } = makePair();
    const uuid = await capturedPayment(adapter, fake, 1000);
    await adapter.refundPayment({ pspPaymentId: uuid, idempotencyKey: "r1" });
    await expect(adapter.refundPayment({ pspPaymentId: uuid, idempotencyKey: "r2" })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("retrieveRefund polls a pending credit to its terminal state", async () => {
    const { adapter, fake } = makePair();
    const uuid = await capturedPayment(adapter, fake);
    const refund = await adapter.refundPayment({ pspPaymentId: uuid, amount: 800, idempotencyKey: "r1" });

    const credit = fake.getTransaction(refund.refundId)!;
    credit.detailedStatus = "REFUND_TO_RETRY"; // the gateway retries the credit later
    expect((await adapter.retrieveRefund(refund.refundId)).status).toBe("pending");

    credit.detailedStatus = "CAPTURED";
    const done = await adapter.retrieveRefund(refund.refundId);
    expect(done.status).toBe("succeeded");
    expect(done.pspPaymentId).toBe(uuid); // parentTransactionUuid links back to the payment
    expect(done.amount).toBe(800);

    credit.detailedStatus = "REFUSED";
    expect((await adapter.retrieveRefund(refund.refundId)).status).toBe("failed");
  });

  it("passes the reason through as the Back Office comment", async () => {
    const { adapter, fake } = makePair();
    const uuid = await capturedPayment(adapter, fake);
    await adapter.refundPayment({ pspPaymentId: uuid, amount: 100, reason: "customer request", idempotencyKey: "r" });
    expect(fake.lastRequestBody).toMatchObject({ comment: "customer request" });
  });
});
