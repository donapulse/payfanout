import { describe, expect, it } from "vitest";
import { getRefundState, isPayFanoutError, type ServerPaymentAdapter } from "@payfanout/core";
import { runServerAdapterConformanceTests } from "@payfanout/conformance";
import {
  PAYPAL_SUPPORTED_CURRENCIES,
  PayPalServerAdapter,
  paypalOnboarding,
  type PayPalServerAdapterConfig,
} from "../src/index.js";
import { FakePayPalApi } from "./fake-paypal-api.js";

const WEBHOOK_ID = "1JE4291016473214C";

/**
 * PAYMENT.CAPTURE.COMPLETED delivery, simulator-shaped. The exact byte
 * sequence matters: the fake's verify endpoint (like the real postback)
 * accepts only the delivered bytes, so the fixture is stringified once and
 * registered verbatim.
 */
const CAPTURE_COMPLETED_EVENT = JSON.stringify({
  id: "WH-7YX49823S2290830K-0JE13296W68552352",
  event_version: "1.0",
  create_time: "2026-05-16T05:19:19.355Z",
  resource_type: "capture",
  resource_version: "2.0",
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  summary: "Payment completed for $ 50.00 USD",
  resource: {
    id: "2GG279541U471931P",
    status: "COMPLETED",
    amount: { currency_code: "USD", value: "50.00" },
    final_capture: true,
    custom_id: "order-77",
    seller_protection: { status: "ELIGIBLE", dispute_categories: ["ITEM_NOT_RECEIVED", "UNAUTHORIZED_TRANSACTION"] },
    seller_receivable_breakdown: {
      gross_amount: { currency_code: "USD", value: "50.00" },
      paypal_fee: { currency_code: "USD", value: "1.76" },
      net_amount: { currency_code: "USD", value: "48.24" },
    },
    supplementary_data: { related_ids: { order_id: "5O190127TN364715T" } },
    create_time: "2026-05-16T05:18:59Z",
    update_time: "2026-05-16T05:19:01Z",
    links: [
      { href: "https://api.paypal.com/v2/payments/captures/2GG279541U471931P", rel: "self", method: "GET" },
      { href: "https://api.paypal.com/v2/payments/captures/2GG279541U471931P/refund", rel: "refund", method: "POST" },
      { href: "https://api.paypal.com/v2/checkout/orders/5O190127TN364715T", rel: "up", method: "GET" },
    ],
  },
  links: [
    {
      href: "https://api.paypal.com/v1/notifications/webhooks-events/WH-7YX49823S2290830K-0JE13296W68552352",
      rel: "self",
      method: "GET",
    },
    {
      href: "https://api.paypal.com/v1/notifications/webhooks-events/WH-7YX49823S2290830K-0JE13296W68552352/resend",
      rel: "resend",
      method: "POST",
    },
  ],
});

const WEBHOOK_HEADERS: Record<string, string> = {
  "paypal-transmission-id": "9a622600-5b46-11f0-9a3f-1d1e5b6a9d3e",
  "paypal-transmission-time": "2026-05-16T05:19:20Z",
  "paypal-transmission-sig": "dGhpcy1pcy1hLWZha2Utc2lnbmF0dXJlLWZvci10ZXN0cw==",
  "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77",
  "paypal-auth-algo": "SHA256withRSA",
};

/**
 * A genuine, signature-verifiable delivery of an event type the adapter has
 * no mapping for — must parse to "unknown", never throw.
 */
const ORDER_APPROVED_EVENT = JSON.stringify({
  id: "WH-58D329510W468432D-8HN650336L201105X",
  event_version: "1.0",
  create_time: "2026-05-16T05:18:15.000Z",
  resource_type: "checkout-order",
  resource_version: "2.0",
  event_type: "CHECKOUT.ORDER.APPROVED",
  summary: "An order has been approved by buyer",
  resource: {
    id: "5O190127TN364715T",
    intent: "CAPTURE",
    status: "APPROVED",
    purchase_units: [{ reference_id: "default", amount: { currency_code: "USD", value: "50.00" } }],
  },
  links: [
    {
      href: "https://api.paypal.com/v1/notifications/webhooks-events/WH-58D329510W468432D-8HN650336L201105X",
      rel: "self",
      method: "GET",
    },
  ],
});

const ORDER_APPROVED_HEADERS: Record<string, string> = {
  "paypal-transmission-id": "af4d4300-5b47-11f0-b2ab-c1cb46a52d0d",
  "paypal-transmission-time": "2026-05-16T05:18:16Z",
  "paypal-transmission-sig": "YW5vdGhlci1mYWtlLXNpZ25hdHVyZS1mb3ItdGVzdHM=",
  "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77",
  "paypal-auth-algo": "SHA256withRSA",
};

function makePair(config: Partial<PayPalServerAdapterConfig> = {}): {
  adapter: PayPalServerAdapter;
  fake: FakePayPalApi;
} {
  const fake = new FakePayPalApi({ webhookId: WEBHOOK_ID });
  fake.registerWebhookFixture(CAPTURE_COMPLETED_EVENT, WEBHOOK_HEADERS);
  fake.registerWebhookFixture(ORDER_APPROVED_EVENT, ORDER_APPROVED_HEADERS);
  const adapter = new PayPalServerAdapter({
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    environment: "sandbox",
    webhookId: WEBHOOK_ID,
    fetch: fake.fetch,
    sleep: async () => {}, // retry backoff must not slow the suite down
    ...config,
  });
  return { adapter, fake };
}

// ---------------------------------------------------------------------------
// The exact same conformance contract the Stripe and Paysafe adapters pass.
// ---------------------------------------------------------------------------
let lastFake: FakePayPalApi;

/** Approve + complete an AUTHORIZE-intent order; the uncaptured ORDER id stays canonical. */
async function approvedAuthorization(adapter: ServerPaymentAdapter, amount: number): Promise<string> {
  const session = await adapter.createPaymentSession({
    amount,
    currency: "USD",
    captureMethod: "manual",
    idempotencyKey: `authorize-${Math.random()}`,
  });
  lastFake.approveOrder(session.pspSessionId);
  await adapter.completePayment!({
    pspSessionId: session.pspSessionId,
    clientToken: session.pspSessionId,
    idempotencyKey: `authorize-c-${Math.random()}`,
  });
  return session.pspSessionId;
}

runServerAdapterConformanceTests(
  "paypal",
  () => {
    const { adapter, fake } = makePair();
    lastFake = fake;
    return adapter;
  },
  {
    createSessionInput: () => ({
      amount: 1099,
      currency: "USD",
      returnUrl: "https://merchant.example/return",
      idempotencyKey: `key-${Math.random()}`,
    }),
    zeroDecimalSessionInput: () => ({
      amount: 500,
      currency: "JPY",
      returnUrl: "https://merchant.example/return",
      idempotencyKey: `key-${Math.random()}`,
    }),
    // threeDecimalSessionInput is deliberately absent: PayPal supports no
    // 3-decimal currency at all (BHD/KWD/… are rejected locally).
    onboarding: paypalOnboarding,
    webhook: {
      validRawBody: CAPTURE_COMPLETED_EVENT,
      validHeaders: WEBHOOK_HEADERS,
      expectedType: "payment.succeeded",
      expectedEventId: "WH-7YX49823S2290830K-0JE13296W68552352",
      expectedAmount: 5000, // the fixture capture's "50.00" USD
      unknownEvent: { rawBody: ORDER_APPROVED_EVENT, headers: ORDER_APPROVED_HEADERS },
    },
    money: {
      completedPayment: async (adapter, { amount, id, metadata }) => {
        const session = await adapter.createPaymentSession({
          id,
          amount,
          currency: "USD",
          metadata,
          idempotencyKey: `money-create-${Math.random()}`,
        });
        lastFake.approveOrder(session.pspSessionId);
        const info = await adapter.completePayment!({
          pspSessionId: session.pspSessionId,
          clientToken: session.pspSessionId,
          idempotencyKey: `money-complete-${Math.random()}`,
        });
        return info.pspPaymentId; // the durable CAPTURE id — refunds key on it
      },
      authorizedPayment: (adapter, { amount }) => approvedAuthorization(adapter, amount),
      // The only PayPal state cancelPayment can void is an uncaptured authorization.
      cancelablePayment: (adapter) => approvedAuthorization(adapter, 1000),
      // PayPal has no metadata object — the host id rides custom_id (round-trips),
      // session metadata is never echoed back by retrievePayment.
      expectations: { metadataEcho: false },
    },
    failingCalls: [
      {
        name: "capturing an order the buyer never approved",
        invoke: async (a) => {
          const session = await a.createPaymentSession({ amount: 100, currency: "USD", idempotencyKey: "k-unapproved" });
          return a.completePayment!({
            pspSessionId: session.pspSessionId,
            clientToken: session.pspSessionId,
            idempotencyKey: "k-unapproved-c",
          });
        },
        expectedCode: "invalid_request",
      },
      {
        name: "capturing when the buyer's funding source declines",
        invoke: async (a) => {
          const session = await a.createPaymentSession({ amount: 100, currency: "USD", idempotencyKey: "k-decline" });
          lastFake.approveOrder(session.pspSessionId, { decline: true });
          return a.completePayment!({
            pspSessionId: session.pspSessionId,
            clientToken: session.pspSessionId,
            idempotencyKey: "k-decline-c",
          });
        },
        expectedCode: "card_declined",
      },
      {
        name: "refunding an unknown capture",
        invoke: (a) => a.refundPayment({ pspPaymentId: "2GGDOESNOTEXIST", idempotencyKey: "k-refund-missing" }),
        expectedCode: "invalid_request",
      },
      {
        name: "refunding more than the captured amount",
        invoke: async (a) => {
          const session = await a.createPaymentSession({ amount: 1000, currency: "USD", idempotencyKey: "k-over" });
          lastFake.approveOrder(session.pspSessionId);
          const paid = await a.completePayment!({
            pspSessionId: session.pspSessionId,
            clientToken: session.pspSessionId,
            idempotencyKey: "k-over-c",
          });
          return a.refundPayment({ pspPaymentId: paid.pspPaymentId, amount: 2000, idempotencyKey: "k-over-r" });
        },
        expectedCode: "invalid_request",
      },
      {
        name: "creating a session in an unsupported 3-decimal currency (BHD)",
        invoke: (a) => a.createPaymentSession({ amount: 1234, currency: "BHD", idempotencyKey: "k-bhd" }),
        expectedCode: "invalid_request",
      },
      {
        name: "creating a HUF session with sub-unit minor amount (whole-unit rule)",
        invoke: (a) => a.createPaymentSession({ amount: 1050, currency: "HUF", idempotencyKey: "k-huf" }),
        expectedCode: "invalid_request",
      },
      {
        name: "PayPal 5xx outage",
        invoke: (a) => {
          lastFake.failNextWith(500, { name: "INTERNAL_SERVICE_ERROR", message: "down" }, 3);
          return a.retrievePayment("5O190127TN000001");
        },
        expectedCode: "psp_unavailable",
      },
      {
        name: "PayPal rate limiting (429)",
        invoke: (a) => {
          lastFake.failNextWith(429, { name: "RATE_LIMIT_REACHED", message: "slow down" }, 3);
          return a.retrievePayment("5O190127TN000001");
        },
        expectedCode: "rate_limited",
      },
    ],
    idempotency: {
      run: async (adapter, key) => {
        const input = { amount: 555, currency: "USD", idempotencyKey: key };
        const first = await adapter.createPaymentSession(input);
        const second = await adapter.createPaymentSession(input);
        return [first, second];
      },
      sideEffectCount: () => lastFake.uniqueOrderCreations,
    },
    completePayment: {
      input: (session) => {
        // The fake's popup stand-in: without buyer approval nothing is capturable.
        lastFake.approveOrder(session.pspSessionId);
        return {
          pspSessionId: session.pspSessionId,
          clientToken: session.pspSessionId,
          idempotencyKey: `complete-${Math.random()}`,
        };
      },
    },
  },
);

// ---------------------------------------------------------------------------
// PayPal-specific behavior.
// ---------------------------------------------------------------------------
describe("PayPalServerAdapter specifics", () => {
  it("declares the hard currency whitelist for router pre-screening", () => {
    const { adapter } = makePair();
    const declared = adapter.getCapabilities().supportedCurrencies;
    // Must stay in lockstep with money.ts, which revalidates as defense-in-depth.
    expect(declared).toEqual([...PAYPAL_SUPPORTED_CURRENCIES]);
    expect(declared).toContain("USD");
    expect(declared).not.toContain("BHD"); // PayPal supports no 3-decimal currency
  });

  it("creates an order with intent CAPTURE, custom_id round-trip, and the experience context", async () => {
    const { adapter, fake } = makePair({
      brandName: "Demo Shop",
      locale: "fr-FR",
      userAction: "CONTINUE",
      cancelUrl: "https://merchant.example/cancel",
    });
    const session = await adapter.createPaymentSession({
      id: "order-9",
      amount: 2599,
      currency: "EUR",
      returnUrl: "https://merchant.example/return",
      statementDescriptor: "DEMO SHOP 9",
      billingDetails: { email: "buyer@example.com" },
      shippingDetails: {
        name: "Ann Buyer",
        address: { line1: "1 Way", line2: "Apt 2", city: "Berlin", state: "BE", postalCode: "10115", country: "DE" },
      },
      metadata: { plan: "pro" },
      idempotencyKey: "k-create",
    });
    expect(session.id).toBe("order-9");
    expect(session.pspSessionId).toMatch(/^5O/);
    expect(session.clientSecret).toBe(session.pspSessionId);
    // Sandbox-verified: creating with payment_source.paypal answers
    // PAYER_ACTION_REQUIRED, so a fresh session awaits the buyer's approval.
    expect(session.status).toBe("requires_action");
    expect(session.amount).toBe(2599);
    expect(session.metadata).toEqual({ plan: "pro" });
    expect(fake.lastRequestBody).toMatchObject({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: { currency_code: "EUR", value: "25.99" },
          custom_id: "order-9",
          soft_descriptor: "DEMO SHOP 9",
          shipping: {
            name: { full_name: "Ann Buyer" },
            address: {
              address_line_1: "1 Way",
              address_line_2: "Apt 2",
              admin_area_2: "Berlin",
              admin_area_1: "BE",
              postal_code: "10115",
              country_code: "DE",
            },
          },
        },
      ],
      payment_source: {
        paypal: {
          email_address: "buyer@example.com",
          experience_context: {
            user_action: "CONTINUE",
            return_url: "https://merchant.example/return",
            cancel_url: "https://merchant.example/cancel",
            brand_name: "Demo Shop",
            locale: "fr-FR",
            shipping_preference: "SET_PROVIDED_ADDRESS",
          },
        },
      },
    });
    expect(fake.lastRequestHeaders["paypal-request-id"]).toBe("k-create");
    expect(fake.lastRequestHeaders["prefer"]).toBe("return=representation");
  });

  it("withholds over-length statement descriptors and country-less shipping instead of failing", async () => {
    const { adapter, fake } = makePair();
    await adapter.createPaymentSession({
      amount: 100,
      currency: "USD",
      statementDescriptor: "THIS DESCRIPTOR IS WAY TOO LONG FOR A CARD STATEMENT",
      shippingDetails: { name: "No Country", address: { line1: "1 Way", city: "Nowhere" } },
      idempotencyKey: "k",
    });
    const body = fake.lastRequestBody as { purchase_units: Array<Record<string, unknown>> };
    expect(body.purchase_units[0]).not.toHaveProperty("soft_descriptor");
    expect(body.purchase_units[0]).not.toHaveProperty("shipping");
  });

  it("falls back to config.returnUrl and synthesizes cancel_url from it", async () => {
    const { adapter, fake } = makePair({ returnUrl: "https://merchant.example/fallback" });
    await adapter.createPaymentSession({ amount: 100, currency: "USD", idempotencyKey: "k" });
    expect(fake.lastRequestBody).toMatchObject({
      payment_source: {
        paypal: {
          experience_context: {
            return_url: "https://merchant.example/fallback",
            cancel_url: "https://merchant.example/fallback",
          },
        },
      },
    });
  });

  it("rejects sessions restricted to non-paypal method types", async () => {
    const { adapter } = makePair();
    await expect(
      adapter.createPaymentSession({ amount: 100, currency: "USD", paymentMethodTypes: ["card"], idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("completePayment captures with the CAPTURE id as the canonical pspPaymentId", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      id: "order-1",
      amount: 5000,
      currency: "USD",
      idempotencyKey: "k",
    });
    fake.approveOrder(session.pspSessionId);
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: session.pspSessionId,
      idempotencyKey: "k-complete",
    });
    expect(info.status).toBe("succeeded");
    expect(info.pspPaymentId).toMatch(/^2GG/); // the capture id, NOT the order id
    expect(info.id).toBe("order-1"); // custom_id round-trip
    expect(info.amount).toBe(5000);
    expect(info.amountRefunded).toBe(0);
    expect(info.amountCaptured).toBe(5000);
    expect(info.capturedAt).toBeDefined();
    expect(info.paymentMethodType).toBe("paypal");
    expect(info.paymentMethodDetails).toEqual({ wallet: "paypal" });
    expect(fake.lastRequestHeaders["paypal-request-id"]).toBe("k-complete");
  });

  it("completePayment rejects a clientToken that names a different order (tamper guard)", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ amount: 100, currency: "USD", idempotencyKey: "k" });
    await expect(
      adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: "5OSOMEOTHERORDER", idempotencyKey: "k2" }),
    ).rejects.toThrowError(/does not match/);
    await expect(
      adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: "", idempotencyKey: "k3" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("a PENDING capture surfaces as processing (eCheck-style funding)", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 300, currency: "USD", idempotencyKey: "k" });
    fake.approveOrder(session.pspSessionId, { pendingCapture: true });
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: session.pspSessionId,
      idempotencyKey: "k-c",
    });
    expect(info.status).toBe("processing");
    expect(info.capturedAt).toBeUndefined();
  });

  it("retrievePayment falls back from the aged-out order id to the capture id", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ id: "order-2", amount: 700, currency: "USD", idempotencyKey: "k" });
    fake.approveOrder(session.pspSessionId);
    const paid = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: session.pspSessionId,
      idempotencyKey: "k-c",
    });

    // By order id — the active-window path.
    const byOrder = await adapter.retrievePayment(session.pspSessionId);
    expect(byOrder.status).toBe("succeeded");
    expect(byOrder.pspPaymentId).toBe(paid.pspPaymentId);

    // By capture id — the durable path (order GETs age out after a few days).
    const byCapture = await adapter.retrievePayment(paid.pspPaymentId);
    expect(byCapture.status).toBe("succeeded");
    expect(byCapture.amount).toBe(700);
    expect(byCapture.id).toBe("order-2");
    expect(byCapture.pspPaymentId).toBe(paid.pspPaymentId);

    await expect(adapter.retrievePayment("MISSING-EVERYWHERE")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refunds resolve the capture from an order id and report cumulative refund state", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 5000, currency: "USD", idempotencyKey: "k" });
    fake.approveOrder(session.pspSessionId);
    await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: session.pspSessionId,
      idempotencyKey: "k-c",
    });

    // Partial refund addressed by ORDER id — the adapter resolves the capture.
    const partial = await adapter.refundPayment({
      pspPaymentId: session.pspSessionId,
      amount: 1500,
      reason: "requested_by_customer",
      idempotencyKey: "r1",
    });
    expect(partial.status).toBe("succeeded");
    expect(partial.amount).toBe(1500);
    expect(fake.lastRequestBody).toMatchObject({ note_to_payer: "requested_by_customer" });

    let info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.amountRefunded).toBe(1500);
    expect(getRefundState(info)).toBe("partial");

    // Remainder refund addressed by CAPTURE id directly.
    const rest = await adapter.refundPayment({ pspPaymentId: info.pspPaymentId, idempotencyKey: "r2" });
    expect(rest.amount).toBe(3500);
    info = await adapter.retrievePayment(session.pspSessionId);
    expect(getRefundState(info)).toBe("full");

    const polled = await adapter.retrieveRefund(partial.refundId);
    expect(polled.refundId).toBe(partial.refundId);
    expect(polled.status).toBe("succeeded");
    expect(polled.amount).toBe(1500);
    expect(polled.pspPaymentId).toBe(info.pspPaymentId); // capture id from links[rel=up]
    expect(polled.createdAt).toBeDefined();
  });

  it("refusing to refund an uncaptured order names the problem", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ amount: 100, currency: "USD", idempotencyKey: "k" });
    await expect(
      adapter.refundPayment({ pspPaymentId: session.pspSessionId, idempotencyKey: "r" }),
    ).rejects.toThrowError(/no capture to refund/);
  });

  it("maps a missing refund id to PayFanoutError with raw preserved", async () => {
    const { adapter } = makePair();
    try {
      await adapter.retrieveRefund("1JUMISSING");
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("invalid_request");
        expect(err.raw).toBeDefined();
      }
    }
  });
});
