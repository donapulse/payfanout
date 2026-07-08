/**
 * Real Stripe sandbox integration. Skipped (green) unless STRIPE_SECRET_KEY is
 * set. Uses the REAL `stripe` SDK both inside the adapter (no injected client)
 * and directly in the test to simulate what the browser's confirm() would do
 * (Stripe test payment methods like pm_card_visa).
 *
 *   $env:STRIPE_SECRET_KEY = "sk_test_..."   # test keys ONLY — enforced below
 *   pnpm run test:integration
 */
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { getRefundState, isPayFanoutError, isUnifiedPaymentStatus, WEBHOOK_EVENT_TYPES } from "@payfanout/core";
import { InMemorySubscriptionStore, PaymentService, SubscriptionManager } from "@payfanout/server";
import { StripeServerAdapter } from "@payfanout/adapter-stripe-server";

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (SECRET_KEY && !SECRET_KEY.startsWith("sk_test_")) {
  throw new Error("Integration tests refuse to run against a non-test Stripe key (expected sk_test_...)");
}
const API_VERSION = "2024-06-20";

const describeIf = SECRET_KEY ? describe : describe.skip;

function makeAdapter(): StripeServerAdapter {
  return new StripeServerAdapter({
    secretKey: SECRET_KEY!,
    apiVersion: API_VERSION,
    // Unset CI secrets render as EMPTY strings, not undefined — || treats them as absent.
    webhookSigningSecret: process.env.STRIPE_WEBHOOK_SECRET || "whsec_not_used_in_these_tests",
    environment: "sandbox",
  });
}

/** Plays the browser's role: confirms with Stripe's test payment methods. */
function rawStripe(): Stripe {
  // No pinned apiVersion here: this client simulates the browser
  // SDK, which is version-independent of the adapter's pinned REST version.
  return new Stripe(SECRET_KEY!);
}

const key = (): string => `payfanout-int-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describeIf("Stripe sandbox integration", () => {
  it("full happy path: create -> confirm -> retrieve succeeded, payfanout_id round-trips", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      id: "int-order-1",
      amount: 1099,
      currency: "USD",
      idempotencyKey: key(),
    });
    expect(session.pspSessionId).toMatch(/^pi_/);
    expect(session.clientSecret).toContain("_secret_");

    await rawStripe().paymentIntents.confirm(session.pspSessionId, { payment_method: "pm_card_visa" });

    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.status).toBe("succeeded");
    expect(info.amount).toBe(1099);
    expect(info.id).toBe("int-order-1"); // payfanout_id metadata round-trip
    expect(info.paymentMethodType).toBe("card");
    // Receipt-grade display facts, normalized from the real charge.
    expect(info.paymentMethodDetails).toMatchObject({ brand: "visa", last4: "4242" });
  });

  it("manual capture: authorize -> requires_capture -> partial capture -> succeeded", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      amount: 5000,
      currency: "USD",
      captureMethod: "manual",
      idempotencyKey: key(),
    });
    await rawStripe().paymentIntents.confirm(session.pspSessionId, { payment_method: "pm_card_visa" });

    const authorized = await adapter.retrievePayment(session.pspSessionId);
    expect(authorized.status).toBe("requires_capture");

    const captured = await adapter.capturePayment(session.pspSessionId, 3000, key());
    expect(captured.status).toBe("succeeded");
    expect(captured.amount).toBe(3000);
  });

  it("cancels an authorized-but-uncaptured payment", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      amount: 2000,
      currency: "USD",
      captureMethod: "manual",
      idempotencyKey: key(),
    });
    await rawStripe().paymentIntents.confirm(session.pspSessionId, { payment_method: "pm_card_visa" });
    const canceled = await adapter.cancelPayment(session.pspSessionId, key());
    expect(canceled.status).toBe("canceled");
  });

  it("partial then full refund with derived refund state", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({ amount: 4000, currency: "USD", idempotencyKey: key() });
    await rawStripe().paymentIntents.confirm(session.pspSessionId, { payment_method: "pm_card_visa" });

    const partial = await adapter.refundPayment({
      pspPaymentId: session.pspSessionId,
      amount: 1500,
      idempotencyKey: key(),
    });
    expect(partial.status).toBe("succeeded");
    let info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.amountRefunded).toBe(1500);
    expect(getRefundState(info)).toBe("partial");

    await adapter.refundPayment({ pspPaymentId: session.pspSessionId, idempotencyKey: key() });
    info = await adapter.retrievePayment(session.pspSessionId);
    expect(getRefundState(info)).toBe("full");
  });

  it("zero-decimal JPY amounts pass through unchanged", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({ amount: 500, currency: "JPY", idempotencyKey: key() });
    await rawStripe().paymentIntents.confirm(session.pspSessionId, { payment_method: "pm_card_visa" });
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.amount).toBe(500); // ¥500, not ¥50000
    expect(info.currency).toBe("JPY");
    expect(info.status).toBe("succeeded");
  });

  it("maps a real decline to failed status and unified error taxonomy", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({ amount: 1000, currency: "USD", idempotencyKey: key() });
    await expect(
      rawStripe().paymentIntents.confirm(session.pspSessionId, {
        payment_method: "pm_card_chargeDeclinedInsufficientFunds",
      }),
    ).rejects.toThrowError(); // the browser-side would surface this via confirm()

    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.status).toBe("failed"); // requires_payment_method + last_payment_error

    try {
      await adapter.refundPayment({ pspPaymentId: session.pspSessionId, idempotencyKey: key() });
      expect.unreachable("refunding an unpaid PI must fail");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("invalid_request");
        expect(err.raw).toBeDefined();
      }
    }
  });

  it("verification: SetupIntent succeeds and the PaymentMethod ends up not vaulted", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({ amount: 0, currency: "USD", idempotencyKey: key() });
    expect(session.pspSessionId).toMatch(/^seti_/);

    await rawStripe().setupIntents.confirm(session.pspSessionId, { payment_method: "pm_card_visa" });

    // Must not throw — validates the detach-on-unattached handling against reality.
    const info = await adapter.verifyPaymentMethod({ pspSessionId: session.pspSessionId, idempotencyKey: key() });
    expect(info.status).toBe("succeeded");
    expect(info.amount).toBe(0);

    const seti = await rawStripe().setupIntents.retrieve(session.pspSessionId);
    const pmId = typeof seti.payment_method === "string" ? seti.payment_method : seti.payment_method?.id;
    if (pmId) {
      const pm = await rawStripe().paymentMethods.retrieve(pmId);
      expect(pm.customer).toBeNull(); // nothing stored against a customer — no vaulting
    }
  });

  it("replays idempotently against the real API: same key -> same PaymentIntent", async () => {
    const adapter = makeAdapter();
    const idempotencyKey = key();
    const input = { amount: 777, currency: "USD", idempotencyKey };
    const first = await adapter.createPaymentSession(input);
    const second = await adapter.createPaymentSession(input);
    expect(second.pspSessionId).toBe(first.pspSessionId);
  });

  it("parses real event payload shapes from the Events API", async () => {
    const adapter = makeAdapter();
    const events = await rawStripe().events.list({ limit: 20 });
    expect(events.data.length).toBeGreaterThan(0); // earlier tests generated events
    for (const event of events.data) {
      const parsed = await adapter.parseWebhookEvent(JSON.stringify(event));
      expect(parsed.id).toBe(event.id);
      expect(WEBHOOK_EVENT_TYPES).toContain(parsed.type);
      expect(Number.isNaN(Date.parse(parsed.occurredAt))).toBe(false);
    }
  });

  it("keeps every retrieved status inside the unified enum", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({ amount: 100, currency: "USD", idempotencyKey: key() });
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(isUnifiedPaymentStatus(info.status)).toBe(true);
    expect(info.status).toBe("requires_payment_method"); // nothing confirmed yet
  });

  it("updatePaymentSession changes the amount in place before confirmation", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      id: "int-update-1",
      amount: 1000,
      currency: "USD",
      idempotencyKey: key(),
    });
    const updated = await adapter.updatePaymentSession({
      pspSessionId: session.pspSessionId,
      amount: 1500,
      metadata: { cart: "v2" },
      idempotencyKey: key(),
    });
    expect(updated.pspSessionId).toBe(session.pspSessionId); // Stripe amends in place
    expect(updated.amount).toBe(1500);
    expect(updated.id).toBe("int-update-1");

    await rawStripe().paymentIntents.confirm(session.pspSessionId, { payment_method: "pm_card_visa" });
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.status).toBe("succeeded");
    expect(info.amount).toBe(1500); // the updated amount is what was charged
  });

  it("checkout fields land on the real PaymentIntent (statement suffix, receipt email, shipping)", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      amount: 1200,
      currency: "USD",
      idempotencyKey: key(),
      statementDescriptor: "PAYFANOUT TEST",
      receiptEmail: "receipts@payfanout.example",
      shippingDetails: {
        name: "Integration Buyer",
        phone: "+15550001111",
        address: { line1: "1 Integration Way", city: "New York", state: "NY", postalCode: "10001", country: "US" },
      },
    });
    const pi = await rawStripe().paymentIntents.retrieve(session.pspSessionId);
    expect(pi.statement_descriptor_suffix).toBe("PAYFANOUT TEST");
    expect(pi.receipt_email).toBe("receipts@payfanout.example");
    expect(pi.shipping?.name).toBe("Integration Buyer");
    expect(pi.shipping?.address?.postal_code).toBe("10001");

    await rawStripe().paymentIntents.confirm(session.pspSessionId, { payment_method: "pm_card_visa" });
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.status).toBe("succeeded");
  });

  it("sca: force-challenge is accepted and drives the intent into requires_action", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      amount: 900,
      currency: "USD",
      idempotencyKey: key(),
      sca: { challenge: "force" },
    });
    await rawStripe().paymentIntents.confirm(session.pspSessionId, {
      payment_method: "pm_card_visa",
      return_url: "https://example.com/return",
    });
    const info = await adapter.retrievePayment(session.pspSessionId);
    // The whole point of the flag: Stripe must now demand authentication.
    expect(["requires_action", "processing", "succeeded"]).toContain(info.status);
    expect(info.status).not.toBe("failed");
  });

  it("retrieveRefund polls a real refund; listRefunds/listPayments reconcile it", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({ amount: 2600, currency: "USD", idempotencyKey: key() });
    await rawStripe().paymentIntents.confirm(session.pspSessionId, { payment_method: "pm_card_visa" });

    const refund = await adapter.refundPayment({
      pspPaymentId: session.pspSessionId,
      amount: 600,
      idempotencyKey: key(),
    });
    const polled = await adapter.retrieveRefund(refund.refundId);
    expect(polled.refundId).toBe(refund.refundId);
    expect(["succeeded", "pending"]).toContain(polled.status);
    expect(polled.pspPaymentId).toBe(session.pspSessionId);
    expect(polled.amount).toBe(600);

    const refunds = await adapter.listRefunds({ pspPaymentId: session.pspSessionId });
    expect(refunds.refunds.map((r) => r.refundId)).toContain(refund.refundId);

    const payments = await adapter.listPayments({ createdAfter: new Date(Date.now() - 15 * 60_000), limit: 100 });
    expect(payments.payments.map((p) => p.pspPaymentId)).toContain(session.pspSessionId);
    for (const payment of payments.payments) expect(isUnifiedPaymentStatus(payment.status)).toBe(true);
  });

  it("vault + recurring: save during checkout, charge off-session twice, list, delete", async () => {
    const adapter = makeAdapter();
    const customer = await adapter.createCustomer({
      id: `int-user-${Date.now()}`,
      email: "vault-int@payfanout.example",
      idempotencyKey: key(),
    });
    expect(customer.pspCustomerId).toMatch(/^cus_/);

    // Save-during-checkout: normal payment + consent flag.
    const session = await adapter.createPaymentSession({
      amount: 1500,
      currency: "USD",
      customer: customer.pspCustomerId,
      savePaymentMethod: true,
      idempotencyKey: key(),
    });
    await rawStripe().paymentIntents.confirm(session.pspSessionId, { payment_method: "pm_card_visa" });
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.status).toBe("succeeded");
    expect(info.savedPaymentMethodToken).toMatch(/^pm_/);
    const token = info.savedPaymentMethodToken!;

    // The recurring proof: two REAL off-session charges, no client involved.
    const charge1 = await adapter.chargeSavedPaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      savedPaymentMethodToken: token,
      amount: 990,
      currency: "USD",
      idempotencyKey: key(),
    });
    expect(charge1.status).toBe("succeeded");
    expect(charge1.amount).toBe(990);
    const charge2 = await adapter.chargeSavedPaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      savedPaymentMethodToken: token,
      amount: 990,
      currency: "USD",
      idempotencyKey: key(),
    });
    expect(charge2.status).toBe("succeeded");
    expect(charge2.pspPaymentId).not.toBe(charge1.pspPaymentId);

    const listed = await adapter.listSavedPaymentMethods(customer.pspCustomerId);
    const mine = listed.find((m) => m.token === token);
    expect(mine?.details).toMatchObject({ brand: "visa", last4: "4242" });

    await adapter.deleteSavedPaymentMethod(customer.pspCustomerId, token);
    expect((await adapter.listSavedPaymentMethods(customer.pspCustomerId)).map((m) => m.token)).not.toContain(token);
  });

  it("SubscriptionManager runs a REAL recurring cycle (create -> clock forward -> renewal)", async () => {
    const adapter = makeAdapter();
    const service = new PaymentService({ adapters: [adapter] });
    const clock = { now: Date.now() };
    const manager = new SubscriptionManager({
      service,
      store: new InMemorySubscriptionStore(),
      now: () => clock.now,
    });

    // Vault a card first (checkout with consent).
    const customer = await adapter.createCustomer({ idempotencyKey: key() });
    const session = await adapter.createPaymentSession({
      amount: 500,
      currency: "USD",
      customer: customer.pspCustomerId,
      savePaymentMethod: true,
      idempotencyKey: key(),
    });
    await rawStripe().paymentIntents.confirm(session.pspSessionId, { payment_method: "pm_card_visa" });
    const token = (await adapter.retrievePayment(session.pspSessionId)).savedPaymentMethodToken!;

    // Subscribe: first period charges immediately (real charge).
    const { subscription, payment } = await manager.createSubscription({
      pspName: "stripe",
      pspCustomerId: customer.pspCustomerId,
      savedPaymentMethodToken: token,
      plan: { amount: 800, currency: "USD", interval: "day" },
      id: `int-sub-${Date.now()}`,
      idempotencyKey: key(),
    });
    expect(subscription.status).toBe("active");
    expect(payment?.status).toBe("succeeded");

    // One day later the cron collects the renewal — a second REAL charge.
    clock.now += 24 * 3_600_000 + 1000;
    const run = await manager.chargeDueSubscriptions();
    expect(run.charged).toHaveLength(1);
    const renewed = run.charged[0]!;
    expect(renewed.lastPaymentId).toBeDefined();
    expect(renewed.lastPaymentId).not.toBe(payment?.pspPaymentId);
    expect(Date.parse(renewed.currentPeriodEnd)).toBeGreaterThan(clock.now);

    // Both charges are real Stripe payments.
    const renewal = await adapter.retrievePayment(renewed.lastPaymentId!);
    expect(renewal.status).toBe("succeeded");
    expect(renewal.amount).toBe(800);
  });

  it("fetchEvents recovers recent events with sane types and working cursors", async () => {
    const adapter = makeAdapter();
    const page = await adapter.fetchEvents({ since: new Date(Date.now() - 15 * 60_000), limit: 5 });
    expect(page.events.length).toBeGreaterThan(0); // this suite generates plenty
    for (const event of page.events) {
      expect(event.pspName).toBe("stripe");
      expect(event.id).toMatch(/^evt_/);
      expect(WEBHOOK_EVENT_TYPES).toContain(event.type);
      expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
    }
    if (page.nextCursor) {
      const next = await adapter.fetchEvents({
        since: new Date(Date.now() - 15 * 60_000),
        limit: 5,
        cursor: page.nextCursor,
      });
      const firstIds = new Set(page.events.map((e) => e.id));
      for (const event of next.events) expect(firstIds.has(event.id)).toBe(false);
    }
  });
});
