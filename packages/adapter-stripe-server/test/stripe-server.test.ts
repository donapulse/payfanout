import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getRefundState, isPayFanoutError } from "@payfanout/core";
import { runServerAdapterConformanceTests } from "@payfanout/conformance";
import { StripeServerAdapter, type StripeServerAdapterConfig } from "../src/index.js";
import { FakeStripe, stripeError } from "./fake-stripe.js";

const NOW_MS = Date.parse("2026-07-04T12:00:00Z");
const SIGNING_SECRET = "whsec_test_secret";

function makePair(config: Partial<StripeServerAdapterConfig> = {}): { adapter: StripeServerAdapter; fake: FakeStripe } {
  const fake = new FakeStripe();
  const adapter = new StripeServerAdapter({
    secretKey: "sk_test_123",
    apiVersion: "2024-06-20",
    webhookSigningSecret: SIGNING_SECRET,
    environment: "sandbox",
    client: fake,
    now: () => NOW_MS,
    ...config,
  });
  return { adapter, fake };
}

function signedWebhook(body: object, timestampSec = NOW_MS / 1000): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify(body);
  const signature = createHmac("sha256", SIGNING_SECRET).update(`${timestampSec}.${rawBody}`, "utf8").digest("hex");
  return { rawBody, headers: { "stripe-signature": `t=${timestampSec},v1=${signature}` } };
}

const webhookFixture = signedWebhook({
  id: "evt_conformance_1",
  type: "payment_intent.succeeded",
  created: 1_780_000_200,
  data: { object: { object: "payment_intent", id: "pi_42" } },
});

// ---------------------------------------------------------------------------
// Shared conformance suite — the same contract Paysafe (and any future PSP) runs.
// ---------------------------------------------------------------------------
let lastFake: FakeStripe;
runServerAdapterConformanceTests(
  "stripe",
  () => {
    const { adapter, fake } = makePair();
    lastFake = fake;
    return adapter;
  },
  {
    createSessionInput: () => ({
      amount: 1099,
      currency: "USD",
      idempotencyKey: `key-${Math.random()}`,
    }),
    zeroDecimalSessionInput: () => ({
      amount: 500, // ¥500 — exponent 0, minor units == major units
      currency: "JPY",
      idempotencyKey: `key-${Math.random()}`,
    }),
    threeDecimalSessionInput: () => ({
      amount: 1230, // BHD 1.230 — must be a multiple of 10 for Stripe
      currency: "BHD",
      idempotencyKey: `key-${Math.random()}`,
    }),
    webhook: {
      validRawBody: webhookFixture.rawBody,
      validHeaders: webhookFixture.headers,
      expectedType: "payment.succeeded",
      expectedEventId: "evt_conformance_1",
    },
    vault: {
      // Confirm-on-client PSP: vault during checkout, then hand back the token.
      storedToken: async (adapter, pspCustomerId) => {
        const session = await adapter.createPaymentSession({
          amount: 990,
          currency: "USD",
          customer: pspCustomerId,
          savePaymentMethod: true,
          idempotencyKey: `vault-fixture-${Math.random()}`,
        });
        lastFake.simulateClientConfirm(session.pspSessionId);
        const info = await adapter.retrievePayment(session.pspSessionId);
        if (!info.savedPaymentMethodToken) throw new Error("save-during-checkout produced no token");
        return info.savedPaymentMethodToken;
      },
    },
    failingCalls: [
      {
        name: "retrievePayment on a missing id",
        invoke: (a) => a.retrievePayment("pi_missing"),
        expectedCode: "invalid_request",
      },
      {
        name: "refundPayment on a missing payment",
        invoke: (a) => a.refundPayment({ pspPaymentId: "pi_missing", idempotencyKey: "k" }),
        expectedCode: "invalid_request",
      },
      {
        name: "createPaymentSession when the card is declined",
        invoke: (a) => {
          lastFake.failNextWith(
            stripeError({
              type: "StripeCardError",
              code: "card_declined",
              decline_code: "insufficient_funds",
              message: "Your card has insufficient funds.",
            }),
          );
          return a.createPaymentSession({ amount: 100, currency: "USD", idempotencyKey: "k" });
        },
        expectedCode: "insufficient_funds",
      },
    ],
    idempotency: {
      run: async (adapter, key) => {
        const input = { amount: 777, currency: "USD", idempotencyKey: key };
        const first = await adapter.createPaymentSession(input);
        const second = await adapter.createPaymentSession(input);
        return [first, second];
      },
      sideEffectCount: () => lastFake.uniquePaymentIntentCreations,
    },
  },
);

// ---------------------------------------------------------------------------
// Stripe-specific behavior.
// ---------------------------------------------------------------------------
describe("StripeServerAdapter specifics", () => {
  it("requires explicit apiVersion and environment", () => {
    expect(() => makePair({ apiVersion: "" })).toThrowError(/apiVersion/);
    expect(
      () => makePair({ environment: "test" as unknown as "sandbox" }),
    ).toThrowError(/never inferred from key prefixes/);
  });

  it("rejects three-decimal amounts that are not multiples of 10 (Stripe quirk stays in the adapter)", async () => {
    const { adapter } = makePair();
    await expect(
      adapter.createPaymentSession({ amount: 1234, currency: "BHD", idempotencyKey: "k" }),
    ).rejects.toThrowError(/multiple of 10/);
  });

  it("stamps payfanout_id into metadata and echoes it back on retrieve", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      id: "order-77",
      amount: 1000,
      currency: "USD",
      idempotencyKey: "k",
    });
    expect(session.id).toBe("order-77");
    fake.simulateClientConfirm(session.pspSessionId);
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.id).toBe("order-77");
    expect(info.pspPaymentId).toBe(session.pspSessionId);
  });

  it("runs the full manual-capture flow: authorize -> requires_capture -> partial capture -> succeeded", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 5000,
      currency: "USD",
      captureMethod: "manual",
      idempotencyKey: "k",
    });
    fake.simulateClientConfirm(session.pspSessionId);
    const authorized = await adapter.retrievePayment(session.pspSessionId);
    expect(authorized.status).toBe("requires_capture");

    const captured = await adapter.capturePayment(session.pspSessionId, 3000, "cap-key");
    expect(captured.status).toBe("succeeded");
    expect(captured.amount).toBe(3000);
  });

  it("cancels an authorized-but-uncaptured payment", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 5000,
      currency: "USD",
      captureMethod: "manual",
      idempotencyKey: "k",
    });
    fake.simulateClientConfirm(session.pspSessionId);
    const canceled = await adapter.cancelPayment(session.pspSessionId, "void-key");
    expect(canceled.status).toBe("canceled");
  });

  it("supports partial refunds with derived refund state", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 5000, currency: "USD", idempotencyKey: "k" });
    fake.simulateClientConfirm(session.pspSessionId);

    const partial = await adapter.refundPayment({
      pspPaymentId: session.pspSessionId,
      amount: 2000,
      idempotencyKey: "re-1",
    });
    expect(partial.status).toBe("succeeded");
    let info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.amountRefunded).toBe(2000);
    expect(getRefundState(info)).toBe("partial");

    await adapter.refundPayment({ pspPaymentId: session.pspSessionId, idempotencyKey: "re-2" });
    info = await adapter.retrievePayment(session.pspSessionId);
    expect(getRefundState(info)).toBe("full");
  });

  it("maps a failed attempt (requires_payment_method + last_payment_error) to failed", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 100, currency: "USD", idempotencyKey: "k" });
    fake.simulateClientConfirm(session.pspSessionId);
    const pi = await fake.paymentIntents.retrieve(session.pspSessionId);
    pi.status = "requires_payment_method";
    pi.last_payment_error = { code: "card_declined" };
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.status).toBe("failed");
  });

  describe("verifyPaymentMethod (SetupIntent + guaranteed detach)", () => {
    it("creates a SetupIntent session for amount 0", async () => {
      const { adapter } = makePair();
      const session = await adapter.createPaymentSession({ amount: 0, currency: "USD", idempotencyKey: "k" });
      expect(session.pspSessionId).toMatch(/^seti_/);
      expect(session.amount).toBe(0);
      expect(session.clientSecret).toContain("secret");
    });

    it("detaches the attached PaymentMethod after a successful verification", async () => {
      const { adapter, fake } = makePair();
      const setiId = fake.seedSetupIntent("succeeded", "pm_attached_1");
      const info = await adapter.verifyPaymentMethod({ pspSessionId: setiId });
      expect(info.status).toBe("succeeded");
      expect(info.amount).toBe(0);
      expect(fake.detachedPaymentMethods).toEqual(["pm_attached_1"]);
    });

    it("detaches even when the verification itself failed", async () => {
      const { adapter, fake } = makePair();
      const setiId = fake.seedSetupIntent("canceled", "pm_attached_2");
      const info = await adapter.verifyPaymentMethod({ pspSessionId: setiId });
      expect(info.status).toBe("failed");
      expect(fake.detachedPaymentMethods).toEqual(["pm_attached_2"]);
    });

    it("surfaces a loud processing_error when the detach fails (never silently leaves a PM attached)", async () => {
      const { adapter, fake } = makePair();
      const setiId = fake.seedSetupIntent("succeeded", "pm_attached_3");
      const retrieveOk = fake.setupIntents.retrieve.bind(fake.setupIntents);
      fake.setupIntents.retrieve = async (id) => {
        const seti = await retrieveOk(id);
        fake.failNextWith(stripeError({ type: "StripeAPIError", statusCode: 500, message: "detach exploded" }));
        return seti;
      };
      try {
        await adapter.verifyPaymentMethod({ pspSessionId: setiId });
        expect.unreachable();
      } catch (err) {
        expect(isPayFanoutError(err)).toBe(true);
        if (isPayFanoutError(err)) {
          expect(err.code).toBe("processing_error");
          expect(err.message).toMatch(/detach/i);
        }
      }
    });

    it("treats detaching a never-attached PaymentMethod as success (customer-less SetupIntents)", async () => {
      const { adapter, fake } = makePair();
      const setiId = fake.seedSetupIntent("succeeded", "pm_unattached");
      const retrieveOk = fake.setupIntents.retrieve.bind(fake.setupIntents);
      fake.setupIntents.retrieve = async (id) => {
        const seti = await retrieveOk(id);
        fake.failNextWith(
          stripeError({
            type: "StripeInvalidRequestError",
            statusCode: 400,
            message: "The payment method you provided is not attached to a customer so detachment is impossible.",
          }),
        );
        return seti;
      };
      const info = await adapter.verifyPaymentMethod({ pspSessionId: setiId });
      expect(info.status).toBe("succeeded"); // no PayFanoutError — nothing was stored
    });

    it("reports the capability off and rejects when the strategy is disabled", async () => {
      const { adapter } = makePair({ verifyPaymentMethodStrategy: "disabled" });
      expect(adapter.getCapabilities().supportsPaymentMethodVerification).toBe(false);
      await expect(adapter.verifyPaymentMethod({ pspSessionId: "seti_x" })).rejects.toThrowError(/disabled/);
    });
  });

  describe("webhook replay protection", () => {
    it("rejects stale timestamps beyond the tolerance", async () => {
      const { adapter } = makePair();
      const stale = signedWebhook({ id: "evt_old", type: "payment_intent.succeeded", created: 1, data: {} }, NOW_MS / 1000 - 3600);
      await expect(adapter.verifyWebhookSignature(stale.rawBody, stale.headers)).resolves.toBe(false);
    });

    it("maps refund and dispute events, and unknown types to 'unknown'", async () => {
      const { adapter } = makePair();
      const refundEvt = await adapter.parseWebhookEvent(
        JSON.stringify({
          id: "evt_r",
          type: "charge.refunded",
          created: 1_780_000_300,
          data: { object: { object: "charge", id: "ch_9", payment_intent: "pi_9" } },
        }),
      );
      expect(refundEvt.type).toBe("payment.refunded");
      expect(refundEvt.pspPaymentId).toBe("pi_9");

      const disputeEvt = await adapter.parseWebhookEvent(
        JSON.stringify({
          id: "evt_d",
          type: "charge.dispute.created",
          created: 1_780_000_300,
          data: { object: { object: "dispute", id: "dp_1", payment_intent: "pi_9" } },
        }),
      );
      expect(disputeEvt.type).toBe("payment.chargeback");

      const exotic = await adapter.parseWebhookEvent(
        JSON.stringify({ id: "evt_x", type: "invoice.finalized", created: 1_780_000_300, data: { object: {} } }),
      );
      expect(exotic.type).toBe("unknown");
    });
  });

  it("maps rate-limit and 5xx errors as retryable", async () => {
    const { adapter, fake } = makePair();
    fake.failNextWith(stripeError({ type: "StripeRateLimitError", statusCode: 429, message: "slow down" }));
    try {
      await adapter.retrievePayment("pi_any");
      expect.unreachable();
    } catch (err) {
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("rate_limited");
        expect(err.retryable).toBe(true);
        expect(err.pspName).toBe("stripe");
      } else expect.unreachable();
    }
  });
});
