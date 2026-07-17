import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getRefundState, isPayFanoutError } from "@payfanout/core";
import { runServerAdapterConformanceTests } from "@payfanout/conformance";
import { GoCardlessServerAdapter, gocardlessOnboarding, type GoCardlessServerAdapterConfig } from "../src/index.js";
import { FakeGoCardlessApi } from "./fake-gocardless-api.js";

const WEBHOOK_SECRET = "fake-webhook-endpoint-secret";
const RETURN_URL = "https://merchant.example/return";

function makePair(config: Partial<GoCardlessServerAdapterConfig> = {}): {
  adapter: GoCardlessServerAdapter;
  fake: FakeGoCardlessApi;
} {
  const fake = new FakeGoCardlessApi();
  const adapter = new GoCardlessServerAdapter({
    accessToken: "fake-sandbox-access-token",
    environment: "sandbox",
    webhookSecret: WEBHOOK_SECRET,
    fetch: fake.fetch,
    sleep: async () => {}, // transport backoff must not slow tests down
    ...config,
  });
  return { adapter, fake };
}

function signedDelivery(events: object[]): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify({ events });
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf8").digest("hex");
  return { rawBody, headers: { "webhook-signature": signature } };
}

const webhookFixture = signedDelivery([
  {
    id: "EV_CONFORMANCE_1",
    created_at: "2026-07-07T10:00:00.000Z",
    resource_type: "payments",
    action: "confirmed",
    links: { payment: "PM123" },
    details: { origin: "gocardless", cause: "payment_confirmed" },
  },
]);

// Valid, correctly signed, but not a payer-state change this adapter maps.
const unknownEventFixture = signedDelivery([
  {
    id: "EV_CONFORMANCE_UNKNOWN",
    created_at: "2026-07-07T10:00:00.000Z",
    resource_type: "mandates",
    action: "cancelled",
    links: { mandate: "MD123" },
    details: { origin: "bank", cause: "bank_account_disabled" },
  },
]);

// ---------------------------------------------------------------------------
// The exact same conformance contract the Stripe and Paysafe adapters pass.
// ---------------------------------------------------------------------------
let lastFake: FakeGoCardlessApi;
runServerAdapterConformanceTests(
  "gocardless",
  () => {
    const { adapter, fake } = makePair();
    lastFake = fake;
    return adapter;
  },
  {
    onboarding: gocardlessOnboarding,
    // GoCardless supports eight two-decimal currencies only (no JPY, no BHD),
    // and one-off billing request payments are GBP/EUR — the zero/three-decimal
    // fixtures do not apply.
    createSessionInput: () => ({
      amount: 1099,
      currency: "GBP",
      returnUrl: RETURN_URL,
      idempotencyKey: `key-${Math.random()}`,
    }),
    webhook: {
      validRawBody: webhookFixture.rawBody,
      validHeaders: webhookFixture.headers,
      expectedType: "payment.succeeded",
      expectedEventId: "EV_CONFORMANCE_1",
      // No expectedAmount: GoCardless events carry no money fields at all.
      unknownEvent: { rawBody: unknownEventFixture.rawBody, headers: unknownEventFixture.headers },
    },
    money: {
      // Same path a payer takes: hosted flow fulfils the billing request into
      // a payment, then the bank collects (confirmed) — the refundable state.
      completedPayment: async (adapter, { amount, id, metadata }) => {
        const session = await adapter.createPaymentSession({
          id,
          amount,
          currency: "GBP",
          returnUrl: RETURN_URL,
          metadata,
          idempotencyKey: `k-completed-${id}`,
        });
        const { paymentId } = lastFake.fulfilBillingRequest(session.pspSessionId);
        lastFake.confirmPayment(paymentId);
        return paymentId;
      },
      // A pending billing request — the payer has not authorised at the bank.
      cancelablePayment: async (adapter) => {
        const session = await adapter.createPaymentSession({
          amount: 1500,
          currency: "GBP",
          returnUrl: RETURN_URL,
          idempotencyKey: "k-cancelable",
        });
        return session.pspSessionId;
      },
      // No authorizedPayment: bank debits have no authorize-then-capture split.
      // id round-trip and metadata echo both hold — payfanout_id and host keys
      // ride payment_request.metadata onto the payment GoCardless creates.
    },
    failingCalls: [
      {
        name: "retrievePayment on a missing id",
        invoke: (a) => a.retrievePayment("PM_missing"),
        expectedCode: "invalid_request",
      },
      {
        name: "refundPayment when refunds are not enabled on the account",
        invoke: async (a) => {
          const session = await a.createPaymentSession({
            amount: 1099,
            currency: "GBP",
            returnUrl: RETURN_URL,
            idempotencyKey: "k-refund-403",
          });
          const { paymentId } = lastFake.fulfilBillingRequest(session.pspSessionId);
          lastFake.confirmPayment(paymentId);
          lastFake.refundsEnabled = false;
          return a.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "k-refund-403-r" });
        },
        expectedCode: "invalid_request",
      },
      {
        name: "cancelPayment on a non-cancellable payment",
        invoke: async (a) => {
          const session = await a.createPaymentSession({
            amount: 1099,
            currency: "GBP",
            returnUrl: RETURN_URL,
            idempotencyKey: "k-cancel-422",
          });
          const { paymentId } = lastFake.fulfilBillingRequest(session.pspSessionId);
          lastFake.confirmPayment(paymentId); // confirmed payments cannot cancel
          return a.cancelPayment(paymentId, "k-cancel-422-key");
        },
        expectedCode: "invalid_request",
      },
      {
        name: "createPaymentSession with an unsupported currency",
        invoke: (a) =>
          a.createPaymentSession({ amount: 500, currency: "USD", returnUrl: RETURN_URL, idempotencyKey: "k-usd" }),
        expectedCode: "invalid_request",
      },
      {
        name: "a GoCardless 500 maps to psp_unavailable",
        invoke: (a) => {
          lastFake.failNextWith(
            500,
            { error: { message: "Internal server error", type: "gocardless", code: 500 } },
            Number.POSITIVE_INFINITY,
          );
          return a.retrievePayment("PM1");
        },
        expectedCode: "psp_unavailable",
      },
      {
        name: "rate limiting maps to rate_limited",
        invoke: (a) => {
          lastFake.failNextWith(
            429,
            {
              error: {
                message: "Rate limit exceeded",
                type: "invalid_api_usage",
                code: 429,
                errors: [{ reason: "rate_limit_exceeded", message: "Rate limit exceeded" }],
              },
            },
            Number.POSITIVE_INFINITY,
          );
          return a.retrievePayment("PM1");
        },
        expectedCode: "rate_limited",
      },
    ],
    nativeSubscriptions: {
      // A GoCardless subscription charges a MANDATE — the mandate id is the
      // savedPaymentMethodToken. Each call seeds its own mandate so every
      // create is independently creatable.
      createInput: () => ({
        savedPaymentMethodToken: lastFake.seedMandate().id,
        amount: 1099,
        currency: "GBP",
        interval: "month",
        idempotencyKey: `k-nsub-${Math.random()}`,
      }),
    },
    idempotency: {
      // Sessions cannot prove byte-identical replays: GoCardless never
      // dedupes flow creates (sandbox-verified), so a replayed session gets a
      // fresh authorisation_url. Refunds can — same key twice returns the
      // original refund with exactly one create.
      run: async (adapter, key) => {
        const session = await adapter.createPaymentSession({
          amount: 2599,
          currency: "GBP",
          returnUrl: RETURN_URL,
          idempotencyKey: `${key}-seed`,
        });
        const { paymentId } = lastFake.fulfilBillingRequest(session.pspSessionId);
        lastFake.confirmPayment(paymentId);
        const first = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 700, idempotencyKey: key });
        const second = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 700, idempotencyKey: key });
        return [first, second];
      },
      sideEffectCount: () => lastFake.uniqueRefundCreations,
    },
  },
);

// ---------------------------------------------------------------------------
// GoCardless-specific behavior.
// ---------------------------------------------------------------------------
describe("GoCardlessServerAdapter specifics", () => {
  it("creates a billing request + hosted flow and returns the authorisation URL as clientSecret", async () => {
    const { adapter, fake } = makePair({ exitUri: "https://merchant.example/exit", fallbackEnabled: false });
    const session = await adapter.createPaymentSession({
      id: "order-9",
      amount: 2500,
      currency: "GBP",
      returnUrl: RETURN_URL,
      statementDescriptor: "ACME ORDER 9",
      billingDetails: {
        name: "Alice Smith",
        email: "alice@example.com",
        address: { line1: "1 Somewhere Lane", city: "London", postalCode: "E5 8EE", country: "GB" },
      },
      metadata: { order: "9" },
      idempotencyKey: "k-create",
    });

    expect(session.pspSessionId).toMatch(/^BRQ/);
    expect(session.clientSecret).toMatch(/^https:\/\/pay\.gocardless\.com\/billing\/static\/flow\?id=BRF/);
    expect(session).toMatchObject({ id: "order-9", amount: 2500, currency: "GBP", status: "requires_action" });

    // The flow create is the last request — assert it carried the redirect trip + prefill.
    expect(fake.lastRequestBody).toMatchObject({
      billing_request_flows: {
        redirect_uri: RETURN_URL,
        exit_uri: "https://merchant.example/exit",
        prefilled_customer: {
          given_name: "Alice",
          family_name: "Smith",
          email: "alice@example.com",
          address_line1: "1 Somewhere Lane",
          city: "London",
          postal_code: "E5 8EE",
          country_code: "GB",
        },
        links: { billing_request: session.pspSessionId },
      },
    });
    // Only the billing request create carries the host key — GoCardless does
    // not dedupe flow creates (sandbox-verified), so the flow POST goes out plain.
    expect(fake.idempotencyKeysSeen).toEqual([{ path: "/billing_requests", key: "k-create" }]);
  });

  it("stamps payfanout_id, statement text, and fallback_enabled onto the billing request", async () => {
    const { adapter, fake } = makePair({ fallbackEnabled: true });
    const session = await adapter.createPaymentSession({
      id: "order-42",
      amount: 1099,
      currency: "EUR",
      returnUrl: RETURN_URL,
      statementDescriptor: "ACME 42",
      idempotencyKey: "k",
    });
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.id).toBe("order-42"); // payfanout_id round-trips via metadata
    expect(info.metadata).toEqual({ payfanout_id: "order-42" }); // echoed as stored
    const raw = info.raw as {
      metadata?: Record<string, string>;
      payment_request?: { description?: string; metadata?: Record<string, string> };
      fallback_enabled?: boolean;
    };
    expect(raw.metadata).toEqual({ payfanout_id: "order-42" });
    // Stamped on payment_request too — GoCardless stores it on the payment.
    expect(raw.payment_request?.metadata).toEqual({ payfanout_id: "order-42" });
    expect(raw.payment_request?.description).toBe("ACME 42");
    expect(raw.fallback_enabled).toBe(true);
    expect(fake.uniqueBillingRequestCreations).toBe(1);
  });

  it("echoes PSP-stored metadata on the payment, capping at GoCardless's 3 keys", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      id: "order-meta",
      amount: 1000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      metadata: { plan: "pro", seats: "3", promo: "spring" },
      idempotencyKey: "k",
    });
    const { paymentId } = fake.fulfilBillingRequest(session.pspSessionId);
    fake.confirmPayment(paymentId);
    const info = await adapter.retrievePayment(paymentId);
    expect(info.id).toBe("order-meta");
    // payfanout_id claims a slot; "promo" overflowed the 3-key cap and was withheld.
    expect(info.metadata).toEqual({ payfanout_id: "order-meta", plan: "pro", seats: "3" });
    // Bank debits: no capture split, so the capture money facts stay absent.
    expect(info.amountCaptured).toBeUndefined();
    expect(info.amountCapturable).toBeUndefined();
  });

  it("declares the one-off GBP/EUR constraint for router pre-screening", () => {
    const { adapter } = makePair();
    expect(adapter.getCapabilities().supportedCurrencies).toEqual(["GBP", "EUR"]);
  });

  it("resolves the whole redirect round-trip: requires_action -> processing -> succeeded", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 4000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      idempotencyKey: "k",
    });

    // Payer has not authorised at the bank yet.
    let info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.status).toBe("requires_action");
    expect(info.pspPaymentId).toBe(session.pspSessionId);

    // Hosted flow completed: the billing request fulfils into a real payment.
    const { paymentId } = fake.fulfilBillingRequest(session.pspSessionId);
    info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.status).toBe("processing"); // pending_submission
    expect(info.pspPaymentId).toBe(paymentId);
    expect(info.amount).toBe(4000);
    // The BR path stamps both PSP objects it used onto raw.
    expect(info.raw).toMatchObject({ billing_request: { id: session.pspSessionId }, payment: { id: paymentId } });

    // The bank collected: terminal success.
    fake.confirmPayment(paymentId);
    info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.status).toBe("succeeded");
  });

  it("surfaces the mandate reference and tolerates a failing mandate lookup", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 4000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      idempotencyKey: "k",
    });
    const { paymentId } = fake.fulfilBillingRequest(session.pspSessionId);
    fake.confirmPayment(paymentId);

    const info = await adapter.retrievePayment(paymentId);
    expect(info.status).toBe("succeeded");
    expect(info.mandateReference).toMatch(/^REF-/);
    expect(info.paymentMethodType).toBe("bank_redirect_generic");

    fake.mandateLookupFails = true;
    const withoutMandate = await adapter.retrievePayment(paymentId);
    expect(withoutMandate.status).toBe("succeeded"); // lookup failure never fails the retrieve
    expect(withoutMandate.mandateReference).toBeUndefined();
  });

  it("cancels either stage, threading the Idempotency-Key onto the action POST", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 1000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      idempotencyKey: "k1",
    });
    const canceledSession = await adapter.cancelPayment(session.pspSessionId, "cancel-br-key");
    expect(canceledSession.status).toBe("canceled");
    expect(fake.idempotencyKeysSeen).toContainEqual({
      path: `/billing_requests/${session.pspSessionId}/actions/cancel`,
      key: "cancel-br-key",
    });

    const other = await adapter.createPaymentSession({
      amount: 2000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      idempotencyKey: "k2",
    });
    const { paymentId } = fake.fulfilBillingRequest(other.pspSessionId);
    // pending_submission cancels
    const canceledPayment = await adapter.cancelPayment(paymentId, "cancel-pm-key");
    expect(canceledPayment.status).toBe("canceled");
    expect(canceledPayment.pspPaymentId).toBe(paymentId);
    expect(fake.idempotencyKeysSeen).toContainEqual({
      path: `/payments/${paymentId}/actions/cancel`,
      key: "cancel-pm-key",
    });
  });

  it("computes total_amount_confirmation across partial-after-partial refunds", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 5000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      idempotencyKey: "k",
    });
    const { paymentId } = fake.fulfilBillingRequest(session.pspSessionId);
    fake.confirmPayment(paymentId);

    const first = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 1500, idempotencyKey: "r1" });
    expect(first.status).toBe("pending"); // bank refunds submit asynchronously
    expect(first.amount).toBe(1500);
    expect(fake.lastRequestBody).toMatchObject({
      refunds: { amount: 1500, total_amount_confirmation: 1500, links: { payment: paymentId } },
    });

    const second = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 500, idempotencyKey: "r2" });
    expect(second.amount).toBe(500);
    expect(fake.lastRequestBody).toMatchObject({
      refunds: { amount: 500, total_amount_confirmation: 2000 },
    });

    let info = await adapter.retrievePayment(paymentId);
    expect(info.amountRefunded).toBe(2000);
    expect(getRefundState(info)).toBe("partial");

    // Omitted amount = refund the remainder (GoCardless has no implicit full refund).
    await adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r3" });
    expect(fake.lastRequestBody).toMatchObject({
      refunds: { amount: 3000, total_amount_confirmation: 5000 },
    });
    info = await adapter.retrievePayment(paymentId);
    expect(getRefundState(info)).toBe("full");
  });

  it("rejects refunds past the remaining amount and on fully-refunded payments", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 1000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      idempotencyKey: "k",
    });
    const { paymentId } = fake.fulfilBillingRequest(session.pspSessionId);
    fake.confirmPayment(paymentId);

    await expect(
      adapter.refundPayment({ pspPaymentId: paymentId, amount: 1001, idempotencyKey: "r1" }),
    ).rejects.toThrowError(/exceeds the remaining refundable amount/);

    await adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r2" });
    await expect(adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r3" })).rejects.toThrowError(
      /nothing left to refund/,
    );
  });

  it("polls a refund to its terminal state via retrieveRefund", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 1000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      idempotencyKey: "k",
    });
    const { paymentId } = fake.fulfilBillingRequest(session.pspSessionId);
    fake.confirmPayment(paymentId);
    const refund = await adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r1" });

    let polled = await adapter.retrieveRefund(refund.refundId);
    expect(polled).toMatchObject({ status: "pending", amount: 1000, pspPaymentId: paymentId });
    expect(polled.createdAt).toBeDefined();

    fake.setRefundStatus(refund.refundId, "paid");
    polled = await adapter.retrieveRefund(refund.refundId);
    expect(polled.status).toBe("succeeded");

    fake.setRefundStatus(refund.refundId, "funds_returned");
    polled = await adapter.retrieveRefund(refund.refundId);
    expect(polled.status).toBe("failed");
  });

  it("requires returnUrl on session creation (the hosted flow needs a redirect_uri)", async () => {
    const { adapter } = makePair();
    try {
      await adapter.createPaymentSession({ amount: 100, currency: "GBP", idempotencyKey: "k" });
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("invalid_request");
        expect(err.message).toMatch(/returnUrl/);
        expect(err.raw).toBeDefined();
      }
    }
  });

  it("rejects unknown and declared-but-unsupported payment method types", async () => {
    const { adapter } = makePair();
    const base = { amount: 100, currency: "GBP", returnUrl: RETURN_URL } as const;
    await expect(
      adapter.createPaymentSession({ ...base, paymentMethodTypes: ["card"], idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    // ach sits in the default capability list with supported: false — a
    // declared-yet-unsupported type must reject, not slip through.
    await expect(
      adapter.createPaymentSession({ ...base, paymentMethodTypes: ["ach"], idempotencyKey: "k2" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      adapter.createPaymentSession({ ...base, paymentMethodTypes: ["bacs_debit"], idempotencyKey: "k3" }),
    ).resolves.toMatchObject({ status: "requires_action" });
  });
});
