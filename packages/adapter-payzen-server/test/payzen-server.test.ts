import { describe, expect, it } from "vitest";
import { getRefundState, isPayFanoutError, type PaymentMethodCapability } from "@payfanout/core";
import { runServerAdapterConformanceTests } from "@payfanout/conformance";
import { payzenOnboarding, PayZenServerAdapter, type PayZenServerAdapterConfig } from "../src/index.js";
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

/**
 * A correctly signed IPN whose newest transaction is a VERIFICATION — an
 * operation type outside the adapter's DEBIT/CREDIT vocabulary, so parsing
 * must land on type "unknown" instead of throwing.
 */
const UNKNOWN_KR_ANSWER =
  '{"shopId":"69876357","orderCycle":"CLOSED","orderStatus":"PAID","serverDate":"2026-01-15T10:05:00+00:00",' +
  '"orderDetails":{"orderTotalAmount":0,"orderEffectiveAmount":0,"orderCurrency":"EUR","mode":"TEST",' +
  '"orderId":"myOrderId-475883","_type":"V4/OrderDetails"},"transactions":[{"uuid":"8faeed4bbba748b78dfe0466cd45c1a4",' +
  '"amount":0,"currency":"EUR","paymentMethodType":"CARD","status":"ACCEPTED","detailedStatus":"ACCEPTED",' +
  '"operationType":"VERIFICATION","_type":"V4/PaymentTransaction"}],"_type":"V4/Payment"}';
/** hex(HMAC-SHA-256(demo password, UNKNOWN_KR_ANSWER)). */
const UNKNOWN_IPN_HEADERS = {
  "kr-hash": "949c8ba6a0cdeed50e0d0d3fdfc941403d555c84ccf86f1f4f8ca1ec952311d3",
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
    onboarding: payzenOnboarding,
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
      expectedAmount: 990,
      unknownEvent: { rawBody: UNKNOWN_KR_ANSWER, headers: UNKNOWN_IPN_HEADERS },
    },
    // Both expectations hold genuinely: payfanout_id round-trips via the
    // transaction metadata stamp and PayZen echoes metadata on every read —
    // no honesty flags needed.
    money: {
      completedPayment: async (adapter, { amount, id, metadata }) => {
        const session = await adapter.createPaymentSession({
          amount,
          currency: "EUR",
          id,
          metadata,
          idempotencyKey: key(),
        });
        const tx = lastFake.payOrder(session.pspSessionId);
        lastFake.settle(tx.uuid); // the capture batch ran — refundable from here
        return tx.uuid;
      },
      authorizedPayment: async (adapter, { amount }) => {
        const session = await adapter.createPaymentSession({
          amount,
          currency: "EUR",
          captureMethod: "manual",
          idempotencyKey: key(),
        });
        return lastFake.payOrder(session.pspSessionId).uuid; // AUTHORISED_TO_VALIDATE
      },
      cancelablePayment: async (adapter) => {
        const session = await adapter.createPaymentSession({ amount: 2000, currency: "EUR", idempotencyKey: key() });
        return lastFake.payOrder(session.pspSessionId).uuid; // AUTHORISED — cancelable until the batch
      },
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
          return a.cancelPayment(tx.uuid, "c");
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

describe("PayZenServerAdapter capabilities", () => {
  it("declares the platform currency table for router pre-screening, minus the adapter exclusions", () => {
    const { adapter } = makePair();
    const currencies = adapter.getCapabilities().supportedCurrencies!;
    expect(currencies).toContain("EUR");
    expect(currencies).toContain("JPY");
    expect(currencies).not.toContain("BHD"); // not on the platform
    expect(currencies).not.toContain("CNY"); // adapter-excluded: fractional-digit mismatch
    expect(currencies).not.toContain("KHR");
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

  it("rejects payment method types the platform has no mapping for", async () => {
    const { adapter } = makePair();
    await expect(
      adapter.createPaymentSession({
        amount: 100,
        currency: "EUR",
        paymentMethodTypes: ["card", "ideal"],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining('"ideal"') as string,
    });
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

describe("PayZenServerAdapter payment method selection", () => {
  const ALL_ENABLED = [
    { type: "card", flow: "embedded", supported: true },
    { type: "apple_pay", flow: "popup", supported: true },
    { type: "paypal", flow: "popup", supported: true },
  ] as const;

  it("declares conservative smartForm capabilities and honors the config override wholesale", () => {
    const methods = makePair().adapter.getCapabilities().paymentMethods;
    expect(methods).toContainEqual({ type: "card", flow: "embedded", supported: true });
    // Wallet/APM contracts are per-shop — never claimed available by default.
    expect(methods).toContainEqual({ type: "apple_pay", flow: "popup", supported: false });
    expect(methods).toContainEqual({ type: "paypal", flow: "popup", supported: false });

    const overridden = makePair({ paymentMethods: [...ALL_ENABLED] }).adapter.getCapabilities().paymentMethods;
    expect(overridden.filter((m) => m.supported)).toHaveLength(3);
  });

  it("maps requested types onto the documented paymentMethods codes, deduplicated", async () => {
    const { adapter, fake } = makePair({ paymentMethods: [...ALL_ENABLED] });
    await adapter.createPaymentSession({
      amount: 100,
      currency: "EUR",
      paymentMethodTypes: ["card", "paypal", "apple_pay", "card"],
      idempotencyKey: "k-methods",
    });
    expect(fake.lastRequestBody).toMatchObject({ paymentMethods: ["CARDS", "PAYPAL", "APPLE_PAY"] });

    // A single-method restriction still sends the field — PayZen then renders
    // that method's entry page directly.
    await adapter.createPaymentSession({
      amount: 100,
      currency: "EUR",
      paymentMethodTypes: ["card"],
      idempotencyKey: "k-card-only",
    });
    expect(fake.lastRequestBody).toMatchObject({ paymentMethods: ["CARDS"] });
  });

  it("omits the paymentMethods field for unrestricted sessions (PayZen offers all shop-eligible methods)", async () => {
    const { adapter, fake } = makePair({ paymentMethods: [...ALL_ENABLED] });
    await adapter.createPaymentSession({ amount: 100, currency: "EUR", idempotencyKey: "k-all" });
    expect(fake.lastRequestBody).not.toHaveProperty("paymentMethods");
  });

  it("rejects methods declared unsupported for the shop, pointing at the config override", async () => {
    const { adapter } = makePair(); // default declaration: wallets exist but supported: false
    await expect(
      adapter.createPaymentSession({
        amount: 100,
        currency: "EUR",
        paymentMethodTypes: ["card", "paypal"],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("config.paymentMethods") as string,
    });
  });

  it("reports the unified method type of non-card transactions", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 700, currency: "EUR", idempotencyKey: "k-pp" });
    const tx = fake.payOrder(session.pspSessionId);
    tx.paymentMethodType = "PAYPAL";
    expect((await adapter.retrievePayment(session.pspSessionId)).paymentMethodType).toBe("paypal");
    tx.paymentMethodType = "APPLE_PAY";
    expect((await adapter.retrievePayment(session.pspSessionId)).paymentMethodType).toBe("apple_pay");
    tx.paymentMethodType = "PAYCONIQ"; // outside the adapter's vocabulary — honest "other"
    expect((await adapter.retrievePayment(session.pspSessionId)).paymentMethodType).toBe("other");
  });

});

describe("PayZenServerAdapter hosted bank rails", () => {
  const REDIRECT_ENABLED: PaymentMethodCapability[] = [
    { type: "card", flow: "embedded", supported: true },
    { type: "sepa_debit", flow: "redirect", supported: true, currencies: ["EUR"] },
    { type: "ideal", flow: "redirect", supported: true, currencies: ["EUR"], countries: ["NL"] },
    {
      type: "bank_redirect_generic",
      flow: "redirect",
      supported: true,
      currencies: ["EUR", "PLN"],
      countries: ["FR", "ES", "GR", "IT", "PL"],
    },
    { type: "voucher_generic", flow: "redirect", supported: true, currencies: ["EUR"], countries: ["PT"] },
  ];
  const makeRedirectPair = (): ReturnType<typeof makePair> => makePair({ paymentMethods: [...REDIRECT_ENABLED] });

  it("declares the bank rails conservatively with their documented constraints", () => {
    const methods = makePair().adapter.getCapabilities().paymentMethods;
    expect(methods).toContainEqual({ type: "sepa_debit", flow: "redirect", supported: false, currencies: ["EUR"] });
    expect(methods).toContainEqual({
      type: "ideal",
      flow: "redirect",
      supported: false,
      currencies: ["EUR"],
      countries: ["NL"],
    });
    expect(methods.find((m) => m.type === "bank_redirect_generic")).toMatchObject({
      flow: "redirect",
      supported: false,
      currencies: ["EUR", "PLN"],
      countries: ["FR", "ES", "GR", "IT", "PL"],
    });
    expect(methods).toContainEqual({
      type: "voucher_generic",
      flow: "redirect",
      supported: false,
      currencies: ["EUR"],
      countries: ["PT"],
    });
  });

  it("creates a payment order with the documented method codes and returns the hosted page URL", async () => {
    const { adapter, fake } = makeRedirectPair();
    const session = await adapter.createPaymentSession({
      id: "order-42",
      amount: 4990,
      currency: "EUR",
      paymentMethodTypes: ["sepa_debit", "ideal"],
      returnUrl: "https://host.example/checkout/return",
      webhookUrl: "https://host.example/webhooks/payzen",
      captureMethod: "manual",
      sca: { challenge: "force" },
      metadata: { plan: "pro" },
      idempotencyKey: "order-42-attempt-1",
    });
    expect(session).toMatchObject({
      id: "order-42",
      pspName: "payzen",
      pspSessionId: "pf-order-42-attempt-1",
      amount: 4990,
      currency: "EUR",
      status: "requires_action", // the buyer authorises at the hosted page next
      metadata: { plan: "pro" },
    });
    expect(session.clientSecret).toMatch(/^https:\/\/secure\.payzen\.eu\//);
    expect(fake.lastRequestBody).toMatchObject({
      amount: 4990,
      currency: "EUR",
      orderId: "pf-order-42-attempt-1",
      channelOptions: { channelType: "URL" },
      paymentMethods: ["SDD", "IDEAL"],
      returnMode: "GET",
      returnUrl: "https://host.example/checkout/return",
      ipnTargetUrl: "https://host.example/webhooks/payzen",
      strongAuthentication: "CHALLENGE_REQUESTED",
      transactionOptions: { cardOptions: { manualValidation: "YES" } },
      metadata: { plan: "pro", payfanout_key: "order-42-attempt-1", payfanout_id: "order-42" },
    });
    // CreatePaymentOrder documents no contrib field — never sent on this route.
    expect(fake.lastRequestBody).not.toHaveProperty("contrib");
    expect(fake.uniquePaymentOrderCreations).toBe(1);
    expect(fake.uniqueFormTokenCreations).toBe(0); // the embedded route stayed out of this
  });

  it("withholds the MOTO exemption on the hosted route (undocumented on CreatePaymentOrder)", async () => {
    const { adapter, fake } = makeRedirectPair();
    await adapter.createPaymentSession({
      amount: 100,
      currency: "EUR",
      paymentMethodTypes: ["sepa_debit"],
      returnUrl: "https://h.example/r",
      sca: { exemption: "moto" },
      idempotencyKey: "k-moto",
    });
    expect(fake.lastRequestBody).not.toHaveProperty("transactionOptions");
  });

  it("maps a payment order answer without a paymentURL to a non-retryable processing_error", async () => {
    // The fake only injects ERROR envelopes, so a raw fetch stands in for the
    // degenerate SUCCESS answer.
    const broken = new PayZenServerAdapter({
      shopId: "69876357",
      password: "testpassword_UnitOnly",
      environment: "sandbox",
      paymentMethods: [...REDIRECT_ENABLED],
      maxNetworkRetries: 0,
      fetch: async () =>
        new Response(
          JSON.stringify({ status: "SUCCESS", answer: { paymentOrderStatus: "RUNNING", _type: "V4/PaymentOrder" } }),
          { status: 200 },
        ),
    });
    await expect(
      broken.createPaymentSession({
        amount: 100,
        currency: "EUR",
        paymentMethodTypes: ["ideal"],
        returnUrl: "https://h.example/r",
        idempotencyKey: "k-nourl",
      }),
    ).rejects.toMatchObject({ code: "processing_error", retryable: false });
  });

  it("narrows the pay-by-bank family to currency-eligible codes", async () => {
    const { adapter, fake } = makeRedirectPair();
    await adapter.createPaymentSession({
      amount: 100,
      currency: "EUR",
      paymentMethodTypes: ["bank_redirect_generic"],
      returnUrl: "https://h.example/r",
      idempotencyKey: "k-eur",
    });
    expect(fake.lastRequestBody).toMatchObject({
      paymentMethods: ["IP_WIRE", "IP_WIRE_INST", "MYBANK", "PRZELEWY24"],
    });
    await adapter.createPaymentSession({
      amount: 100,
      currency: "PLN",
      paymentMethodTypes: ["bank_redirect_generic"],
      returnUrl: "https://h.example/r",
      idempotencyKey: "k-pln",
    });
    expect(fake.lastRequestBody).toMatchObject({ paymentMethods: ["PRZELEWY24"] });
  });

  it("rejects rails that cannot settle in the session currency", async () => {
    const { adapter } = makeRedirectPair();
    await expect(
      adapter.createPaymentSession({
        amount: 100,
        currency: "USD",
        paymentMethodTypes: ["sepa_debit"],
        returnUrl: "https://h.example/r",
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("USD") as string,
    });
  });

  it("requires returnUrl and refuses mixing the two surfaces", async () => {
    const { adapter } = makeRedirectPair();
    await expect(
      adapter.createPaymentSession({
        amount: 100,
        currency: "EUR",
        paymentMethodTypes: ["ideal"],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("returnUrl") as string,
    });
    await expect(
      adapter.createPaymentSession({
        amount: 100,
        currency: "EUR",
        paymentMethodTypes: ["card", "sepa_debit"],
        returnUrl: "https://h.example/r",
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("mix") as string,
    });
  });

  it("keeps the bank rails behind the per-shop contract gate", async () => {
    const { adapter } = makePair(); // defaults: redirect rails declared but supported: false
    await expect(
      adapter.createPaymentSession({
        amount: 100,
        currency: "EUR",
        paymentMethodTypes: ["sepa_debit"],
        returnUrl: "https://h.example/r",
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("config.paymentMethods") as string,
    });
  });

  it("round-trips a hosted payment end to end with honest bank-rail method types", async () => {
    const { adapter, fake } = makeRedirectPair();
    const session = await adapter.createPaymentSession({
      id: "order-77",
      amount: 2500,
      currency: "EUR",
      paymentMethodTypes: ["sepa_debit"],
      returnUrl: "https://h.example/r",
      idempotencyKey: "k-77",
    });
    const tx = fake.payOrder(session.pspSessionId);
    tx.paymentMethodType = "SDD";
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.status).toBe("succeeded");
    expect(info.id).toBe("order-77"); // payfanout_id round-trips via metadata
    expect(info.paymentMethodType).toBe("sepa_debit");
    tx.paymentMethodType = "MYBANK";
    expect((await adapter.retrievePayment(session.pspSessionId)).paymentMethodType).toBe("bank_redirect_generic");
    tx.paymentMethodType = "MULTIBANCO";
    expect((await adapter.retrievePayment(session.pspSessionId)).paymentMethodType).toBe("voucher_generic");
  });

  it("replays converge on the same orderId with a fresh payment order each time", async () => {
    const { adapter, fake } = makeRedirectPair();
    const input = {
      amount: 900,
      currency: "EUR",
      returnUrl: "https://h.example/r",
      idempotencyKey: "replay-po",
    };
    const first = await adapter.createPaymentSession({ ...input, paymentMethodTypes: ["ideal"] });
    const second = await adapter.createPaymentSession({ ...input, paymentMethodTypes: ["ideal"] });
    expect(second.pspSessionId).toBe(first.pspSessionId); // deterministic derivation
    expect(second.clientSecret).not.toBe(first.clientSecret); // a new payment order every call
    expect(fake.uniquePaymentOrderCreations).toBe(2);
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
    expect(info.paymentMethodDetails).toEqual({ brand: "mastercard", last4: "0067", expMonth: 6, expYear: 2029 });
    expect(info.amountRefunded).toBe(0);
    expect(info.amountCaptured).toBe(1099); // AUTHORISED = committed to the capture batch
  });

  it("echoes the transaction metadata as stored at the PSP, payfanout stamps included", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      id: "order-88",
      amount: 1000,
      currency: "EUR",
      metadata: { plan: "pro" },
      idempotencyKey: "k-88",
    });
    fake.payOrder(session.pspSessionId);
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.metadata).toEqual({ plan: "pro", payfanout_key: "k-88", payfanout_id: "order-88" });
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
    expect(pending.amountCapturable).toBe(4000); // awaiting Transaction/Validate
    expect(pending.amountCaptured).toBeUndefined();

    const captured = await adapter.capturePayment(pending.pspPaymentId, 4000, "cap-1");
    expect(captured.status).toBe("succeeded");
    expect(captured.amountCaptured).toBe(4000); // validation commits the full authorization
    expect(captured.amountCapturable).toBeUndefined();
    expect(fake.lastOperation).toBe("Transaction/Validate"); // never Transaction/Capture (Brazil-only WS)
    // The required idempotencyKey has no Validate field to ride — replay
    // safety comes from the PSP state machine (second validate = PSP_503).
    expect(fake.lastRequestBody).toEqual({ uuid: pending.pspPaymentId });
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
    await expect(adapter.capturePayment(tx.uuid, 1500, "cap-2")).rejects.toMatchObject({ code: "invalid_request" });
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
    await adapter.capturePayment(tx.uuid, undefined, "cap-3");
    await expect(adapter.capturePayment(tx.uuid, undefined, "cap-4")).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("cancels a pre-capture authorization by orderId", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 2000, currency: "EUR", idempotencyKey: "k" });
    fake.payOrder(session.pspSessionId); // AUTHORISED — cancelable until capture
    const canceled = await adapter.cancelPayment(session.pspSessionId, "void-1");
    expect(canceled.status).toBe("canceled");
    expect(canceled.amountCaptured).toBeUndefined(); // nothing was ever captured
    expect(canceled.amountCapturable).toBeUndefined();
  });

  it("cancelling twice surfaces the already-cancelled rejection", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 2000, currency: "EUR", idempotencyKey: "k" });
    const tx = fake.payOrder(session.pspSessionId);
    await adapter.cancelPayment(tx.uuid, "void-2");
    try {
      await adapter.cancelPayment(tx.uuid, "void-3");
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
    // PayZen has no refund-reason vocabulary — the unified token goes through
    // verbatim as the audit-trail comment.
    const { adapter, fake } = makePair();
    const uuid = await capturedPayment(adapter, fake);
    await adapter.refundPayment({
      pspPaymentId: uuid,
      amount: 100,
      reason: "requested_by_customer",
      idempotencyKey: "r",
    });
    expect(fake.lastRequestBody).toMatchObject({ comment: "requested_by_customer" });
  });
});

describe("PayZenServerAdapter verifyCredentials (Test connection probe)", () => {
  it("returns { ok: true } after one single-shot, side-effect-free Charge/SDKTest call", async () => {
    const { adapter, fake } = makePair();
    await expect(adapter.verifyCredentials()).resolves.toEqual({ ok: true });
    expect(fake.lastOperation).toBe("Charge/SDKTest");
    // No `mode` field — PayZen selects TEST/LIVE by the key set, not the body.
    expect(fake.lastRequestBody).toEqual({ value: "connection-test" });
    expect(fake.uniqueTransactionCreations).toBe(0); // nothing was mutated
  });

  it("classifies an INT_905 credential rejection as category 'auth'", async () => {
    const { fake } = makePair();
    const adapter = new PayZenServerAdapter({
      shopId: fake.shopId,
      password: "testpassword_WrongKey",
      environment: "sandbox",
      fetch: fake.fetch,
      maxNetworkRetries: 0,
    });
    await expect(adapter.verifyCredentials()).resolves.toEqual({
      ok: false,
      category: "auth",
      message: "Authentication failed — check the PayZen shop id and password.",
    });
  });

  it("is single-shot: a transient failure returns 'network' instead of replaying into success", async () => {
    // maxNetworkRetries would normally retry a transient failure; the probe
    // disables transport retries, so one injected failure is the whole story
    // (were it retried, the un-failed second attempt would return { ok: true }).
    const { adapter, fake } = makePair({ maxNetworkRetries: 2 });
    fake.failNextWith({ networkError: true });
    await expect(adapter.verifyCredentials()).resolves.toEqual({
      ok: false,
      category: "network",
      message: "Could not reach PayZen — try again.",
    });
  });

  it("classifies an HTTP 5xx as category 'network'", async () => {
    const { adapter, fake } = makePair();
    fake.failNextWith({ status: 503 });
    const result = await adapter.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe("network");
  });

  it("classifies an HTTP 429 as category 'network'", async () => {
    const { adapter, fake } = makePair();
    fake.failNextWith({ status: 429 });
    const result = await adapter.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe("network");
  });

  it("classifies a bare 4xx from infrastructure (no PayZen envelope) as category 'internal', not auth", async () => {
    // Only an INT_905 envelope proves a bad key; a raw proxy 4xx does not, so
    // it is reported as an unexpected fault rather than mislabeled auth.
    const { adapter, fake } = makePair();
    fake.failNextWith({ status: 401 });
    await expect(adapter.verifyCredentials()).resolves.toEqual({
      ok: false,
      category: "internal",
      message: "Could not verify PayZen credentials.",
    });
  });

  it("classifies an unexpected envelope error as category 'internal' without leaking details", async () => {
    const { adapter, fake } = makePair();
    // Neither an INT_905 auth rejection nor a transient outage — the catch-all.
    fake.failNextEnvelope(
      { errorCode: "INT_002", errorMessage: "unexpected", detailedErrorCode: null, detailedErrorMessage: null },
      "Charge/SDKTest",
    );
    await expect(adapter.verifyCredentials()).resolves.toEqual({
      ok: false,
      category: "internal",
      message: "Could not verify PayZen credentials.",
    });
  });
});
