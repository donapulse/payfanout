import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isPayFanoutError, type ServerPaymentAdapter } from "@payfanout/core";
import { runServerAdapterConformanceTests } from "@payfanout/conformance";
import {
  adyenOnboarding,
  AdyenServerAdapter,
  buildAdyenHmacPayload,
  encodeSessionContext,
  mapAdyenRefusal,
  type AdyenNotificationItem,
  type AdyenServerAdapterConfig,
} from "../src/index.js";
import { FakeAdyenApi } from "./fake-adyen-api.js";

const SIGNING_KEY = "session-signing-key";
const WEBHOOK_USER = "webhook-user";
const WEBHOOK_PASSWORD = "webhook-password";

/**
 * Adyen's published HMAC test vector (key and expected signature both from the
 * webhook verification page) — the one fixture that proves this implementation
 * agrees with Adyen's own, byte for byte.
 */
const HMAC_KEY = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056";
const PUBLISHED_SIGNING_STRING =
  "7914073381342284::TestMerchant:TestPayment-1407325143704:1130:EUR:AUTHORISATION:true";
const PUBLISHED_SIGNATURE = "coqCmt/IZ4E3CzPvMY8zTjQVL5hYJUiBRg8UU+iCWo0=";

/** Documented sandbox test card, encrypted-credential form for server-side tests. */
const CLIENT_TOKEN = JSON.stringify({
  type: "scheme",
  encryptedCardNumber: "test_4111111111111111",
  encryptedExpiryMonth: "test_03",
  encryptedExpiryYear: "test_2030",
  encryptedSecurityCode: "test_737",
});

function makePair(config: Partial<AdyenServerAdapterConfig> = {}): {
  adapter: AdyenServerAdapter;
  fake: FakeAdyenApi;
} {
  const fake = new FakeAdyenApi();
  const adapter = new AdyenServerAdapter({
    apiKey: "checkout-api-key",
    merchantAccount: "TestMerchant",
    environment: "sandbox",
    // returnUrl is required on POST /payments, so a host that does not pass one
    // per session configures the fallback once — as the conformance sessions do.
    defaultReturnUrl: "https://host.example/return",
    sessionSigningKey: SIGNING_KEY,
    hmacKeys: [HMAC_KEY],
    webhookBasicAuth: { username: WEBHOOK_USER, password: WEBHOOK_PASSWORD },
    fetch: fake.fetch,
    sleep: async () => {},
    ...config,
  });
  return { adapter, fake };
}

function webhookHeaders(): Record<string, string> {
  const credentials = Buffer.from(`${WEBHOOK_USER}:${WEBHOOK_PASSWORD}`, "utf8").toString("base64");
  return { authorization: `Basic ${credentials}`, "content-type": "application/json" };
}

function envelope(item: AdyenNotificationItem): string {
  return JSON.stringify({ live: "false", notificationItems: [{ NotificationRequestItem: item }] });
}

/** Signs an item the way Adyen does, for fixtures other than the published vector. */
function signed(item: AdyenNotificationItem): AdyenNotificationItem {
  const signature = createHmac("sha256", Buffer.from(HMAC_KEY, "hex"))
    .update(buildAdyenHmacPayload(item)!, "utf8")
    .digest("base64");
  return { ...item, additionalData: { ...item.additionalData, hmacSignature: signature } };
}

/** The published vector, verbatim, with its documented signature rather than a recomputed one. */
const authorisationItem: AdyenNotificationItem = {
  additionalData: { hmacSignature: PUBLISHED_SIGNATURE },
  amount: { currency: "EUR", value: 1130 },
  eventCode: "AUTHORISATION",
  eventDate: "2026-08-02T10:00:00+02:00",
  merchantAccountCode: "TestMerchant",
  merchantReference: "TestPayment-1407325143704",
  paymentMethod: "visa",
  pspReference: "7914073381342284",
  reason: "",
  success: "true",
};

/** A real Adyen event code the adapter deliberately does not map. */
const reportAvailableItem = signed({
  amount: { currency: "EUR", value: 0 },
  eventCode: "REPORT_AVAILABLE",
  eventDate: "2026-08-02T10:05:00+02:00",
  merchantAccountCode: "TestMerchant",
  merchantReference: "settlement_detail_report_batch_1",
  pspReference: "8836100000000001",
  success: "true",
});

async function completedPayment(
  adapter: ServerPaymentAdapter,
  input: {
    amount: number;
    id?: string;
    metadata?: Record<string, string>;
    captureMethod?: "automatic" | "manual";
  },
): Promise<string> {
  const key = `money-${Math.random().toString(36).slice(2)}`;
  const session = await adapter.createPaymentSession({
    amount: input.amount,
    currency: "EUR",
    ...(input.id ? { id: input.id } : {}),
    ...(input.metadata && Object.keys(input.metadata).length > 0 ? { metadata: input.metadata } : {}),
    ...(input.captureMethod ? { captureMethod: input.captureMethod } : {}),
    idempotencyKey: `${key}-session`,
  });
  const info = await adapter.completePayment!({
    pspSessionId: session.pspSessionId,
    clientToken: CLIENT_TOKEN,
    idempotencyKey: `${key}-complete`,
  });
  // The composite "{pspReference}:{value}:{currency}" — a push-only provider has
  // no read, so the money facts travel with the reference.
  return info.pspPaymentId;
}

// ---------------------------------------------------------------------------
// The same conformance contract every adapter passes.
// ---------------------------------------------------------------------------
let lastFake: FakeAdyenApi;
runServerAdapterConformanceTests(
  "adyen",
  () => {
    const { adapter, fake } = makePair();
    lastFake = fake;
    return adapter;
  },
  {
    onboarding: adyenOnboarding,
    createSessionInput: () => ({ amount: 1099, currency: "EUR", idempotencyKey: `key-${Math.random()}` }),
    zeroDecimalSessionInput: () => ({ amount: 500, currency: "JPY", idempotencyKey: `key-${Math.random()}` }),
    threeDecimalSessionInput: () => ({ amount: 1234, currency: "BHD", idempotencyKey: `key-${Math.random()}` }),
    webhook: {
      validRawBody: envelope(authorisationItem),
      validHeaders: webhookHeaders(),
      expectedType: "payment.succeeded",
      // pspReference alone repeats across an authorisation and its capture; the
      // dedupe key is the pair.
      expectedEventId: "AUTHORISATION:7914073381342284",
      expectedAmount: 1130,
      // The amount is one of the eight signed values; moving it while leaving the
      // delivered signature alone is what the signature is there to catch.
      tamperedSignedValueBody: envelope({ ...authorisationItem, amount: { currency: "EUR", value: 9999 } }),
      unknownEvent: { rawBody: envelope(reportAvailableItem), headers: webhookHeaders() },
    },
    money: {
      completedPayment: (adapter, input) => completedPayment(adapter, input),
      authorizedPayment: (adapter, input) =>
        completedPayment(adapter, { amount: input.amount, captureMethod: "manual" }),
      cancelablePayment: (adapter) => completedPayment(adapter, { amount: 1500, captureMethod: "manual" }),
    },
    failingCalls: [
      {
        name: "completePayment with no clientToken",
        invoke: async (a) => {
          const session = await a.createPaymentSession({ amount: 100, currency: "EUR", idempotencyKey: "k" });
          return a.completePayment!({ pspSessionId: session.pspSessionId, clientToken: "", idempotencyKey: "k2" });
        },
        expectedCode: "invalid_request",
      },
      {
        name: "completePayment with a tampered session context",
        invoke: async (a) => {
          const session = await a.createPaymentSession({ amount: 100, currency: "EUR", idempotencyKey: "k" });
          const [payload, signature] = session.pspSessionId.split(".");
          const inflated = Buffer.from(
            JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), amount: 1 }),
          ).toString("base64url");
          return a.completePayment!({
            pspSessionId: `${inflated}.${signature}`,
            clientToken: CLIENT_TOKEN,
            idempotencyKey: "k2",
          });
        },
        expectedCode: "invalid_request",
      },
      {
        name: "completePayment with an expired session context",
        invoke: async (a) => {
          const expired = await encodeSessionContext(
            {
              v: 1,
              amount: 100,
              currency: "EUR",
              captureMethod: "automatic",
              reference: "pf_expired",
              expiresAt: Date.now() - 1,
            },
            SIGNING_KEY,
          );
          return a.completePayment!({ pspSessionId: expired, clientToken: CLIENT_TOKEN, idempotencyKey: "k3" });
        },
        expectedCode: "session_expired",
      },
      {
        name: "completePayment when Adyen refuses the card",
        invoke: async (a) => {
          const session = await a.createPaymentSession({ amount: 2500, currency: "EUR", idempotencyKey: "k" });
          return a.completePayment!({
            pspSessionId: session.pspSessionId,
            clientToken: JSON.stringify({ ...JSON.parse(CLIENT_TOKEN), holderName: "REFUSED" }),
            idempotencyKey: "k4",
          });
        },
        expectedCode: "card_declined",
      },
      {
        name: "createPaymentSession in a currency the adapter excludes",
        invoke: (a) => a.createPaymentSession({ amount: 100000, currency: "CLP", idempotencyKey: "k" }),
        expectedCode: "invalid_request",
      },
      {
        name: "capturePayment on a bare pspReference (no money facts)",
        invoke: (a) => a.capturePayment!("8836100000000042", 1000, "k"),
        expectedCode: "invalid_request",
      },
      {
        name: "refundPayment on an unknown pspReference",
        invoke: (a) =>
          a.refundPayment({ pspPaymentId: "8836100000000042:1000:EUR", amount: 500, idempotencyKey: "k" }),
        expectedCode: "invalid_request",
      },
      {
        name: "refundPayment while Adyen rate limits",
        invoke: (a) => {
          lastFake.rateLimited = true;
          return a.refundPayment({ pspPaymentId: "8836100000000042:1000:EUR", idempotencyKey: "k" });
        },
        expectedCode: "rate_limited",
      },
      {
        name: "cancelPayment while Adyen is unavailable",
        invoke: (a) => {
          lastFake.serverError = true;
          return a.cancelPayment("8836100000000042", "k");
        },
        expectedCode: "psp_unavailable",
      },
    ],
    idempotency: {
      run: async (adapter, key) => {
        const session = await adapter.createPaymentSession({
          amount: 555,
          currency: "EUR",
          idempotencyKey: `${key}-s`,
        });
        const input = { pspSessionId: session.pspSessionId, clientToken: CLIENT_TOKEN, idempotencyKey: key };
        const first = await adapter.completePayment!(input);
        const second = await adapter.completePayment!(input);
        return [first, second];
      },
      sideEffectCount: () => lastFake.uniquePaymentCreations,
    },
    completePayment: {
      input: (session) => ({
        pspSessionId: session.pspSessionId,
        clientToken: CLIENT_TOKEN,
        idempotencyKey: "conf-complete-1",
      }),
    },
  },
);

// ---------------------------------------------------------------------------
// Adyen-specific behavior.
// ---------------------------------------------------------------------------
describe("AdyenServerAdapter specifics", () => {
  it("creates no Adyen object at session time and signs the context into the session id", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      id: "order-9",
      amount: 2500,
      currency: "eur",
      captureMethod: "manual",
      metadata: { plan: "pro" },
      idempotencyKey: "k",
    });
    expect(fake.uniquePaymentCreations).toBe(0);
    expect(fake.lastRequestPath).toBeUndefined(); // nothing was called at all
    expect(session.status).toBe("requires_payment_method");
    expect(session.currency).toBe("EUR");
    expect(session.metadata).toEqual({ plan: "pro" });
    // The browser needs the session facts, so the token IS the client secret.
    expect(session.clientSecret).toBe(session.pspSessionId);
  });

  it("derives the same merchant reference for a replayed session creation", async () => {
    const { adapter } = makePair();
    const input = { amount: 700, currency: "EUR", idempotencyKey: "stable-key" } as const;
    const first = await adapter.createPaymentSession(input);
    const second = await adapter.createPaymentSession(input);
    expect(second.id).toBe(first.id);
    expect(second.id).toMatch(/^pf_[0-9a-f]{32}$/);
  });

  it("posts the documented /payments shape and round-trips the host id through metadata", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      id: "order-77",
      amount: 2500,
      currency: "EUR",
      returnUrl: "https://host.example/return",
      receiptEmail: "shopper@example.test",
      metadata: { plan: "pro" },
      idempotencyKey: "k",
    });
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: CLIENT_TOKEN,
      idempotencyKey: "complete-1",
    });
    expect(info.status).toBe("succeeded"); // Authorised, automatic capture
    expect(info.id).toBe("order-77");
    expect(info.metadata).toMatchObject({ plan: "pro", payfanout_id: "order-77" });
    expect(info.pspPaymentId).toMatch(/^\d{16}:2500:EUR$/);
    expect(fake.lastPaymentBody).toMatchObject({
      merchantAccount: "TestMerchant",
      amount: { currency: "EUR", value: 2500 },
      reference: "order-77",
      returnUrl: "https://host.example/return",
      shopperEmail: "shopper@example.test",
      paymentMethod: { type: "scheme", encryptedCardNumber: "test_4111111111111111" },
    });
    // Automatic capture sends no manualCapture flag.
    expect(fake.lastPaymentBody).not.toHaveProperty("additionalData");
    // The caller's key is hashed to fit Adyen's 64-character header.
    expect(fake.lastIdempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("asks for manual capture per payment and reports the authorization as capturable", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 4000,
      currency: "EUR",
      captureMethod: "manual",
      idempotencyKey: "k",
    });
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: CLIENT_TOKEN,
      idempotencyKey: "c1",
    });
    expect(fake.lastPaymentBody).toMatchObject({ additionalData: { manualCapture: "true" } });
    expect(info.status).toBe("requires_capture");
    expect(info.amountCapturable).toBe(4000);
    expect(info.amountCaptured).toBeUndefined();
  });

  it("acknowledges a capture without claiming it settled", async () => {
    const { adapter, fake } = makePair();
    const pspPaymentId = await completedPayment(adapter, { amount: 4000, captureMethod: "manual" });
    const captured = await adapter.capturePayment(pspPaymentId, 1500, "cap-1");
    expect(captured.status).toBe("processing");
    expect(captured.amount).toBe(4000); // the payment's amount, not the capture's
    expect(captured.amountCaptured).toBeUndefined();
    expect(fake.lastRequestBody).toMatchObject({
      merchantAccount: "TestMerchant",
      amount: { currency: "EUR", value: 1500 },
    });
    expect(fake.lastRequestPath).toMatch(/\/payments\/\d{16}\/captures$/);
    expect((captured.raw as { status?: string }).status).toBe("received");
  });

  it("captures the full authorized amount when no amount is given", async () => {
    const { adapter, fake } = makePair();
    const pspPaymentId = await completedPayment(adapter, { amount: 4000, captureMethod: "manual" });
    await adapter.capturePayment(pspPaymentId, undefined, "cap-full");
    expect(fake.lastRequestBody).toMatchObject({ amount: { currency: "EUR", value: 4000 } });
  });

  it("cancels from a bare pspReference — a cancel needs no money facts", async () => {
    const { adapter, fake } = makePair();
    const seeded = fake.seedPayment({ value: 1500, currency: "EUR" });
    const info = await adapter.cancelPayment(seeded.pspReference, "void-1");
    expect(info.status).toBe("processing");
    expect(info.amount).toBe(0);
    expect(info.currency).toBe("XXX"); // no currency travels on a bare reference
    expect(fake.lastRequestBody).toEqual({ merchantAccount: "TestMerchant" });
    expect(fake.uniqueCancelRequests).toBe(1);
  });

  it("refunds partially and fully, always pending, with the refund's own reference", async () => {
    const { adapter, fake } = makePair();
    const pspPaymentId = await completedPayment(adapter, { amount: 5000 });
    const partial = await adapter.refundPayment({ pspPaymentId, amount: 1500, idempotencyKey: "r1" });
    expect(partial.status).toBe("pending");
    expect(partial.amount).toBe(1500);
    expect(partial.refundId).not.toBe(pspPaymentId.split(":")[0]);
    expect(fake.lastRequestBody).toMatchObject({ amount: { currency: "EUR", value: 1500 } });

    // No amount = the whole payment, read off the composite reference.
    const full = await adapter.refundPayment({ pspPaymentId, idempotencyKey: "r2" });
    expect(full.amount).toBe(5000);
    expect(fake.uniqueRefundRequests).toBe(2);
  });

  it("surfaces a 3-D Secure challenge as requires_action with the action on raw", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 3200,
      currency: "EUR",
      returnUrl: "https://host.example/return",
      idempotencyKey: "k",
    });
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: JSON.stringify({ ...JSON.parse(CLIENT_TOKEN), holderName: "CHALLENGE" }),
      idempotencyKey: "c1",
    });
    expect(info.status).toBe("requires_action");
    expect((info.raw as { action?: { type?: string } }).action?.type).toBe("threeDS2");
  });

  it("finishes a resolved action through /payments/details", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 3200, currency: "EUR", idempotencyKey: "k" });
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: JSON.stringify({ details: { threeDSResult: "eyJ0..." }, paymentData: "Ab02b4c0..." }),
      idempotencyKey: "c2",
    });
    expect(fake.lastRequestPath).toMatch(/\/payments\/details$/);
    expect(fake.lastRequestBody).toEqual({ details: { threeDSResult: "eyJ0..." }, paymentData: "Ab02b4c0..." });
    expect(info.status).toBe("succeeded");
    expect(info.amount).toBe(3200); // from the signed context, not the details response
  });

  it("finishes a 3-D Secure challenge when one caller key drives /payments and /payments/details", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 3200,
      currency: "EUR",
      returnUrl: "https://host.example/return",
      idempotencyKey: "k",
    });
    // The documented flow routes both calls through one completion handler, so
    // they carry the SAME caller key. Adyen stores idempotency keys per company
    // account, not per endpoint: derived from the key alone, the second call
    // would replay the challenge response and the payment would never authorise.
    const challenged = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: JSON.stringify({ ...JSON.parse(CLIENT_TOKEN), holderName: "CHALLENGE" }),
      idempotencyKey: "one-caller-key",
    });
    expect(challenged.status).toBe("requires_action");
    const challengeKey = fake.lastIdempotencyKey;
    const action = (challenged.raw as { action: { paymentData: string } }).action;

    const finished = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: JSON.stringify({ details: { threeDSResult: "eyJ0..." }, paymentData: action.paymentData }),
      idempotencyKey: "one-caller-key",
    });
    expect(finished.status).toBe("succeeded");
    expect(fake.lastRequestPath).toMatch(/\/payments\/details$/);
    // Same caller key, different endpoint, different header value — and each one
    // still deduplicates a replay of its own request.
    expect(fake.lastIdempotencyKey).not.toBe(challengeKey);
    expect(fake.lastIdempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps a capture and a refund apart when the host reuses one key", async () => {
    const { adapter, fake } = makePair();
    const pspPaymentId = await completedPayment(adapter, { amount: 4000, captureMethod: "manual" });
    await adapter.capturePayment(pspPaymentId, 4000, "one-caller-key");
    await adapter.refundPayment({ pspPaymentId, amount: 1000, idempotencyKey: "one-caller-key" });
    expect(fake.uniqueCaptureRequests).toBe(1);
    expect(fake.uniqueRefundRequests).toBe(1);
  });

  it("sends returnUrl on every /payments call, from the session or the configured default", async () => {
    const { adapter: withDefault, fake } = makePair({ defaultReturnUrl: "https://host.example/adyen-return" });
    const session = await withDefault.createPaymentSession({ amount: 100, currency: "EUR", idempotencyKey: "k" });
    await withDefault.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: CLIENT_TOKEN,
      idempotencyKey: "c1",
    });
    expect(fake.lastPaymentBody).toMatchObject({ returnUrl: "https://host.example/adyen-return" });

    // The session's own returnUrl wins over the configured fallback.
    const own = await withDefault.createPaymentSession({
      amount: 100,
      currency: "EUR",
      returnUrl: "https://host.example/order-1",
      idempotencyKey: "k2",
    });
    await withDefault.completePayment({
      pspSessionId: own.pspSessionId,
      clientToken: CLIENT_TOKEN,
      idempotencyKey: "c2",
    });
    expect(fake.lastPaymentBody).toMatchObject({ returnUrl: "https://host.example/order-1" });
  });

  it("refuses a session with no returnUrl anywhere rather than posting a payment Adyen rejects", async () => {
    const { adapter, fake } = makePair({ defaultReturnUrl: undefined });
    await expect(
      adapter.createPaymentSession({ amount: 100, currency: "EUR", idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: /returnUrl/ });
    expect(fake.lastRequestPath).toBeUndefined();
    // A context signed before a returnUrl existed cannot complete either.
    const legacy = await encodeSessionContext(
      {
        v: 1,
        amount: 100,
        currency: "EUR",
        captureMethod: "automatic",
        reference: "pf_legacy",
        expiresAt: Date.now() + 60_000,
      },
      SIGNING_KEY,
    );
    await expect(
      adapter.completePayment({ pspSessionId: legacy, clientToken: CLIENT_TOKEN, idempotencyKey: "c1" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: /returnUrl/ });
  });

  it("rejects a host id carrying the delimiter that would break webhook verification", async () => {
    const { adapter } = makePair();
    for (const id of ["order:1234", "order\\1234"]) {
      await expect(
        adapter.createPaymentSession({ id, amount: 100, currency: "EUR", idempotencyKey: "k" }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
  });

  it("applies the currency exclusion to captures and refunds, not only to session creation", async () => {
    const { adapter, fake } = makePair();
    // A payment created outside PayFanout, reconciled through the documented
    // composite reference: CLP would otherwise be sent at 100x its value.
    await expect(adapter.capturePayment("8836100000000042:100000:CLP", undefined, "k")).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      adapter.refundPayment({ pspPaymentId: "8836100000000042:100000:CLP", idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.lastRequestPath).toBeUndefined();
  });

  it("applies the currency exclusion to a hand-minted session context too", async () => {
    const { adapter, fake } = makePair();
    // encodeSessionContext is exported, so createPaymentSession is not the only
    // door into completePayment.
    const pspSessionId = await encodeSessionContext(
      {
        v: 1,
        amount: 100000,
        currency: "CLP",
        captureMethod: "automatic",
        reference: "outside-payfanout",
        returnUrl: "https://shop.example/return",
        expiresAt: Date.now() + 60_000,
      },
      SIGNING_KEY,
    );
    await expect(
      adapter.completePayment!({ pspSessionId, clientToken: CLIENT_TOKEN, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.lastRequestPath).toBeUndefined();
  });

  it("separates a processing Error from an issuer refusal", async () => {
    // Adyen documents Error as a failure while processing, distinct from
    // Refused — telling the shopper their card was declined would be wrong.
    const error = mapAdyenRefusal({ resultCode: "Error", refusalReason: "Internal error" });
    expect(error.code).toBe("processing_error");
    const refused = mapAdyenRefusal({ resultCode: "Refused" });
    expect(refused.code).toBe("card_declined");
  });

  it("omits a webhook amount priced on a deviating exponent", async () => {
    const { adapter } = makePair();
    const item = signed({
      amount: { currency: "ISK", value: 1000 },
      eventCode: "AUTHORISATION",
      eventDate: "2026-08-02T10:00:00+02:00",
      merchantAccountCode: "TestMerchant",
      merchantReference: "outside-payfanout",
      pspReference: "8836100000000099",
      success: "true",
    });
    const event = await adapter.parseWebhookEvent(envelope(item));
    // ISK is 0-decimal in ISO 4217 and 2-decimal at Adyen; reporting the raw
    // value would be off by a factor of 100.
    expect(event.amount).toBeUndefined();
    expect(event.currency).toBe("ISK");
  });

  it("maps refusal reason codes onto the taxonomy and never marks them retryable", async () => {
    const cases: Array<[string, string]> = [
      ["6", "expired_card"],
      ["12", "insufficient_funds"],
      ["11", "authentication_required"],
      ["20", "fraud_suspected"],
      ["24", "invalid_card_data"],
      ["9", "processing_error"],
      // An unrecognized refusal is still a decline — never a retryable error.
      ["999", "card_declined"],
    ];
    for (const [refusalReasonCode, expected] of cases) {
      const { adapter } = makePair();
      const session = await adapter.createPaymentSession({ amount: 2500, currency: "EUR", idempotencyKey: "k" });
      try {
        await adapter.completePayment({
          pspSessionId: session.pspSessionId,
          clientToken: JSON.stringify({ ...JSON.parse(CLIENT_TOKEN), holderName: `REFUSED:${refusalReasonCode}` }),
          idempotencyKey: `c-${refusalReasonCode}`,
        });
        expect.unreachable(`expected a rejection for refusalReasonCode ${refusalReasonCode}`);
      } catch (err) {
        expect(isPayFanoutError(err)).toBe(true);
        if (isPayFanoutError(err)) {
          expect(err.code).toBe(expected);
          expect(err.retryable).toBe(false);
          expect(err.raw).toMatchObject({ resultCode: "Refused", refusalReasonCode });
        }
      }
    }
  });

  it("self-heals a duplicate racing the in-flight original (errorCode 704) by retrying", async () => {
    const { adapter, fake } = makePair();
    fake.transientConflicts = 1;
    const session = await adapter.createPaymentSession({ amount: 2000, currency: "EUR", idempotencyKey: "k" });
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: CLIENT_TOKEN,
      idempotencyKey: "c1",
    });
    expect(info.status).toBe("succeeded");
    expect(fake.transientConflicts).toBe(0);
  });

  it("rejects metadata Adyen would refuse", async () => {
    const { adapter } = makePair();
    const base = { amount: 100, currency: "EUR", idempotencyKey: "k" } as const;
    await expect(
      adapter.createPaymentSession({ ...base, metadata: { "a-very-long-metadata-key": "v" } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      adapter.createPaymentSession({ ...base, metadata: { plan: "x".repeat(81) } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"]));
    await expect(adapter.createPaymentSession({ ...base, metadata: tooMany })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("accepts an empty metadata map without sending one", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 100,
      currency: "EUR",
      metadata: {},
      idempotencyKey: "k",
    });
    await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: CLIENT_TOKEN,
      idempotencyKey: "c1",
    });
    expect(fake.lastPaymentBody).not.toHaveProperty("metadata");
  });

  it("rejects clientTokens that are not an Adyen submission", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ amount: 100, currency: "EUR", idempotencyKey: "k" });
    const complete = (clientToken: string) =>
      adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken, idempotencyKey: "c1" });
    await expect(complete("not json")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(complete('["scheme"]')).rejects.toMatchObject({ code: "invalid_request" });
    await expect(complete('{"details":"threeDSResult"}')).rejects.toMatchObject({ code: "invalid_request" });
    // A paymentMethod blob without its type is not something /payments accepts.
    await expect(complete('{"encryptedCardNumber":"test_4111111111111111"}')).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("refuses to invent an id when Adyen answers without a reference", async () => {
    const noReference = { fetch: async () => new Response(JSON.stringify({ resultCode: "Authorised" }), { status: 200 }) };
    const { adapter } = makePair(noReference);
    const session = await adapter.createPaymentSession({ amount: 100, currency: "EUR", idempotencyKey: "k" });
    await expect(
      adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: CLIENT_TOKEN, idempotencyKey: "c1" }),
    ).rejects.toMatchObject({ code: "processing_error", retryable: false });
    await expect(
      adapter.refundPayment({ pspPaymentId: "8836100000000042:1000:EUR", idempotencyKey: "r1" }),
    ).rejects.toMatchObject({ code: "processing_error", retryable: false });
  });

  it("rejects a host id longer than an Adyen reference and unknown payment method types", async () => {
    const { adapter } = makePair();
    await expect(
      adapter.createPaymentSession({ id: "x".repeat(81), amount: 100, currency: "EUR", idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      adapter.createPaymentSession({
        amount: 100,
        currency: "EUR",
        paymentMethodTypes: ["ideal"],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects every currency whose Adyen exponent disagrees with ISO 4217", async () => {
    const { adapter } = makePair();
    for (const currency of ["CLP", "CVE", "IDR", "ISK"]) {
      await expect(
        adapter.createPaymentSession({ amount: 1000, currency, idempotencyKey: "k" }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
  });

  it("targets the pinned Checkout version, and the live host only with a live URL prefix", async () => {
    const { adapter, fake } = makePair();
    await completedPayment(adapter, { amount: 100 });
    expect(fake.lastRequestPath).toBe("/v72/payments");

    const live = new AdyenServerAdapter({
      apiKey: "k",
      merchantAccount: "TestMerchant",
      environment: "live",
      liveUrlPrefix: "1797a841fbb37ca7-AdyenDemo",
      apiVersion: "v71",
      sessionSigningKey: SIGNING_KEY,
      hmacKeys: [HMAC_KEY],
      webhookBasicAuth: { username: WEBHOOK_USER, password: WEBHOOK_PASSWORD },
      fetch: async (input) => {
        expect(String(input)).toBe(
          "https://1797a841fbb37ca7-AdyenDemo-checkout-live.adyenpayments.com/checkout/v71/payments/ref/cancels",
        );
        return new Response(JSON.stringify({ pspReference: "8836100000000009", status: "received" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await live.cancelPayment("ref", "k");
  });
});

describe("Adyen webhook verification", () => {
  it("agrees with Adyen's published HMAC test vector", async () => {
    expect(buildAdyenHmacPayload(authorisationItem)).toBe(PUBLISHED_SIGNING_STRING);
    const { adapter } = makePair();
    await expect(
      adapter.verifyWebhookSignature(envelope(authorisationItem), webhookHeaders()),
    ).resolves.toBe(true);
  });

  it("verifies against any active key so a rotation needs no cutover", async () => {
    const { adapter } = makePair({ hmacKeys: ["00".repeat(32), HMAC_KEY] });
    await expect(adapter.verifyWebhookSignature(envelope(authorisationItem), webhookHeaders())).resolves.toBe(true);
  });

  it("refuses a delivery whose credentials are wrong or missing", async () => {
    const { adapter } = makePair();
    const rawBody = envelope(authorisationItem);
    await expect(adapter.verifyWebhookSignature(rawBody, {})).resolves.toBe(false);
    await expect(
      adapter.verifyWebhookSignature(rawBody, { authorization: "Basic " + Buffer.from("a:b").toString("base64") }),
    ).resolves.toBe(false);
    await expect(adapter.verifyWebhookSignature(rawBody, { authorization: "Bearer token" })).resolves.toBe(false);
    await expect(adapter.verifyWebhookSignature(rawBody, { authorization: "nonsense" })).resolves.toBe(false);
  });

  it("still verifies a re-encoded payload, because the signature covers values", async () => {
    const { adapter } = makePair();
    // Adyen signs eight extracted values, so re-encoding cannot invalidate the
    // signature. Refusing a re-encoded body would mean guessing the wire format.
    const reencoded = JSON.stringify(JSON.parse(envelope(authorisationItem)), null, 2);
    await expect(adapter.verifyWebhookSignature(reencoded, webhookHeaders())).resolves.toBe(true);
  });

  it("refuses an item whose signed values make the signing payload ambiguous", async () => {
    const { adapter } = makePair();
    // No escaping rule is documented for a value containing the delimiter, so a
    // colon in the merchant reference is refused rather than signed ambiguously.
    const ambiguous: AdyenNotificationItem = {
      ...authorisationItem,
      merchantReference: "order:1130:EUR:AUTHORISATION:true",
    };
    expect(buildAdyenHmacPayload(ambiguous)).toBeUndefined();
    await expect(adapter.verifyWebhookSignature(envelope(ambiguous), webhookHeaders())).resolves.toBe(false);
  });

  it("refuses an item with no signature and a body that is not an envelope", async () => {
    const { adapter } = makePair();
    const unsigned = { ...authorisationItem, additionalData: {} };
    await expect(adapter.verifyWebhookSignature(envelope(unsigned), webhookHeaders())).resolves.toBe(false);
    await expect(adapter.verifyWebhookSignature('{"live":"false"}', webhookHeaders())).resolves.toBe(false);
    await expect(adapter.verifyWebhookSignature("notjson", webhookHeaders())).resolves.toBe(false);
    await expect(adapter.verifyWebhookSignature("42", webhookHeaders())).resolves.toBe(false);
    await expect(adapter.verifyWebhookSignature("[]", webhookHeaders())).resolves.toBe(false);
  });

  it("leaves whitespace and escapes INSIDE string values alone", async () => {
    const { adapter } = makePair();
    // `reason` is not one of the eight signed fields, so the published signature
    // still matches — what is proven here is that quotes and spaces inside a
    // string value are not read as a rewritten document.
    const withText = { ...authorisationItem, reason: 'issuer said "no", twice' };
    await expect(adapter.verifyWebhookSignature(envelope(withText), webhookHeaders())).resolves.toBe(true);
  });
});

describe("Adyen webhook parsing", () => {
  async function parse(item: AdyenNotificationItem) {
    const { adapter } = makePair();
    return adapter.parseWebhookEvent(envelope(signed(item)));
  }

  it("maps an authorisation by its own success flag", async () => {
    const succeeded = await parse({ ...authorisationItem, additionalData: {} });
    expect(succeeded).toMatchObject({
      id: "AUTHORISATION:7914073381342284",
      type: "payment.succeeded",
      pspPaymentId: "7914073381342284",
      amount: 1130,
      currency: "EUR",
      occurredAt: "2026-08-02T08:00:00.000Z",
    });
    expect(succeeded.refundId).toBeUndefined();
    const failed = await parse({ ...authorisationItem, additionalData: {}, success: "false" });
    expect(failed.type).toBe("payment.failed");
  });

  it("reports a modification against the ORIGINAL payment and keeps its own reference as the refund id", async () => {
    const refunded = await parse({
      amount: { currency: "EUR", value: 500 },
      eventCode: "REFUND",
      eventDate: "2026-08-02T11:00:00Z",
      merchantAccountCode: "TestMerchant",
      merchantReference: "order-77",
      originalReference: "7914073381342284",
      pspReference: "8836100000000123",
      success: "true",
    });
    expect(refunded).toMatchObject({
      type: "payment.refunded",
      pspPaymentId: "7914073381342284",
      refundId: "8836100000000123",
      amount: 500,
    });
  });

  it("never turns a failed refund into a refunded payment", async () => {
    for (const [eventCode, success] of [
      ["REFUND", "false"],
      ["REFUND_FAILED", "true"],
      ["REFUNDED_REVERSED", "true"],
    ] as const) {
      const event = await parse({
        eventCode,
        success,
        pspReference: "8836100000000124",
        originalReference: "7914073381342284",
        merchantAccountCode: "TestMerchant",
        merchantReference: "order-77",
        eventDate: "2026-08-02T11:00:00Z",
      });
      expect(event.type).toBe("payment.refund_failed");
    }
  });

  it("maps the capture, cancellation, expiry and dispute vocabulary", async () => {
    const cases: Array<[string, string, string]> = [
      ["CAPTURE", "true", "payment.succeeded"],
      ["CAPTURE", "false", "payment.failed"],
      ["CAPTURE_FAILED", "true", "payment.failed"],
      ["CANCELLATION", "true", "payment.canceled"],
      // A cancel that itself failed says nothing about the payment.
      ["CANCELLATION", "false", "unknown"],
      ["EXPIRE", "true", "payment.canceled"],
      ["OFFER_CLOSED", "true", "payment.canceled"],
      ["NOTIFICATION_OF_CHARGEBACK", "true", "payment.chargeback"],
      ["CHARGEBACK", "true", "payment.chargeback"],
      ["CHARGEBACK_REVERSED", "true", "payment.chargeback_won"],
      ["SECOND_CHARGEBACK", "true", "payment.chargeback_lost"],
      // One event covers both outcomes of a reversal without saying which.
      ["CANCEL_OR_REFUND", "true", "unknown"],
    ];
    for (const [eventCode, success, expected] of cases) {
      const event = await parse({
        eventCode,
        success,
        pspReference: "8836100000000125",
        merchantAccountCode: "TestMerchant",
        merchantReference: "order-77",
        eventDate: "2026-08-02T11:00:00Z",
      });
      expect(event.type, `${eventCode} success=${success}`).toBe(expected);
    }
  });

  it('treats the STRING "false" as false, never as a truthy value', async () => {
    const event = await parse({
      eventCode: "AUTHORISATION",
      success: "false",
      pspReference: "8836100000000126",
      merchantAccountCode: "TestMerchant",
      merchantReference: "order-77",
      eventDate: "2026-08-02T11:00:00Z",
    });
    expect(event.type).toBe("payment.failed");
  });

  it("rejects unparseable, empty and batched payloads", async () => {
    const { adapter } = makePair();
    await expect(adapter.parseWebhookEvent("not json")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(adapter.parseWebhookEvent("{}")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      adapter.parseWebhookEvent(JSON.stringify({ live: "false", notificationItems: [{ NotificationRequestItem: {} }] })),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const batched = JSON.stringify({
      live: "false",
      notificationItems: [
        { NotificationRequestItem: signed(authorisationItem) },
        { NotificationRequestItem: signed({ ...authorisationItem, pspReference: "8836100000000127" }) },
      ],
    });
    // JSON deliveries carry exactly one item; a batch is refused, never partially processed.
    await expect(adapter.parseWebhookEvent(batched)).rejects.toMatchObject({ code: "invalid_request" });
  });
});
