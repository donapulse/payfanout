import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isPayFanoutError, type PaymentMethodCapability } from "@payfanout/core";
import { StripeServerAdapter, type StripeServerAdapterConfig } from "../src/index.js";
import { FakeStripe, stripeError } from "./fake-stripe.js";

// Captures the options the adapter hands the lazily-imported SDK constructor.
const sdkConstructions = vi.hoisted(() => [] as Array<{ key: string; options: Record<string, unknown> }>);
vi.mock("stripe", () => ({
  default: class {
    constructor(key: string, options: Record<string, unknown>) {
      sdkConstructions.push({ key, options });
      return {
        paymentIntents: {
          retrieve: async () => ({
            id: "pi_sdk",
            object: "payment_intent",
            status: "succeeded",
            amount: 100,
            currency: "usd",
            created: 1,
          }),
        },
      };
    }
  },
}));

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

function sign(rawBody: string, secret: string, timestampSec = NOW_MS / 1000): Record<string, string> {
  const signature = createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`, "utf8").digest("hex");
  return { "stripe-signature": `t=${timestampSec},v1=${signature}` };
}

describe("Stripe checkout fields", () => {
  it("maps statementDescriptor/receiptEmail/shippingDetails to Stripe params", async () => {
    const { adapter, fake } = makePair();
    await adapter.createPaymentSession({
      amount: 1000,
      currency: "USD",
      idempotencyKey: "k1",
      statementDescriptor: "ORDER 42",
      receiptEmail: "buyer@example.com",
      shippingDetails: {
        name: "Ann Buyer",
        phone: "+15550001111",
        address: { line1: "1 Way", line2: "Apt 2", city: "NYC", state: "NY", postalCode: "10001", country: "US" },
      },
    });
    expect(fake.lastPaymentIntentParams).toMatchObject({
      statement_descriptor_suffix: "ORDER 42",
      receipt_email: "buyer@example.com",
      shipping: {
        name: "Ann Buyer",
        phone: "+15550001111",
        address: { line1: "1 Way", line2: "Apt 2", city: "NYC", state: "NY", postal_code: "10001", country: "US" },
      },
    });
  });

  it("rejects invalid statement descriptors locally (length, forbidden charset)", async () => {
    const { adapter } = makePair();
    const base = { amount: 100, currency: "USD", idempotencyKey: "k" };
    await expect(
      adapter.createPaymentSession({ ...base, statementDescriptor: "X".repeat(23) }),
    ).rejects.toThrowError(/1-22 characters/);
    await expect(
      adapter.createPaymentSession({ ...base, statementDescriptor: 'BAD"QUOTE' }),
    ).rejects.toThrowError(/1-22 characters/);
    await expect(
      adapter.createPaymentSession({ ...base, statementDescriptor: "   " }),
    ).rejects.toThrowError(/1-22 characters/);
  });

  it("requires a recipient name on shipping details (Stripe hard-requires it)", async () => {
    const { adapter } = makePair();
    await expect(
      adapter.createPaymentSession({
        amount: 100,
        currency: "USD",
        idempotencyKey: "k",
        shippingDetails: { address: { line1: "1 Way" } },
      }),
    ).rejects.toThrowError(/shippingDetails\.name/);
  });

  it("maps SCA preferences onto payment_method_options.card, omitting it entirely by default", async () => {
    const { adapter, fake } = makePair();
    await adapter.createPaymentSession({ amount: 100, currency: "USD", idempotencyKey: "k1" });
    expect(fake.lastPaymentIntentParams).not.toHaveProperty("payment_method_options");

    await adapter.createPaymentSession({
      amount: 100,
      currency: "USD",
      idempotencyKey: "k2",
      sca: { challenge: "force" },
    });
    expect(fake.lastPaymentIntentParams).toMatchObject({
      payment_method_options: { card: { request_three_d_secure: "challenge" } },
    });

    await adapter.createPaymentSession({
      amount: 100,
      currency: "USD",
      idempotencyKey: "k3",
      sca: { exemption: "moto" },
    });
    expect(fake.lastPaymentIntentParams).toMatchObject({
      payment_method_options: { card: { moto: true } },
    });

    // "automatic" challenge is the PSP default — nothing to send.
    await adapter.createPaymentSession({
      amount: 100,
      currency: "USD",
      idempotencyKey: "k4",
      sca: { challenge: "automatic" },
    });
    expect(fake.lastPaymentIntentParams).not.toHaveProperty("payment_method_options");
  });
});

describe("Stripe updatePaymentSession", () => {
  it("updates amount/metadata in place — same pspSessionId and clientSecret", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({
      id: "order-7",
      amount: 1000,
      currency: "USD",
      idempotencyKey: "k1",
    });
    const updated = await adapter.updatePaymentSession({
      pspSessionId: session.pspSessionId,
      amount: 1750,
      metadata: { cart: "v2" },
      idempotencyKey: "k2",
    });
    expect(updated.pspSessionId).toBe(session.pspSessionId);
    expect(updated.clientSecret).toBe(session.clientSecret);
    expect(updated.amount).toBe(1750);
    expect(updated.id).toBe("order-7"); // payfanout_id metadata still round-trips
    expect(updated.metadata).toMatchObject({ cart: "v2", payfanout_id: "order-7" });
  });

  it("re-checks the three-decimal rule when the update names the currency", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ amount: 1000, currency: "USD", idempotencyKey: "k1" });
    await expect(
      adapter.updatePaymentSession({
        pspSessionId: session.pspSessionId,
        amount: 1001,
        currency: "BHD",
        idempotencyKey: "k2",
      }),
    ).rejects.toThrowError(/multiple of 10/);
  });

  it("rejects updates to verification sessions and maps PSP-side update failures", async () => {
    const { adapter, fake } = makePair();
    await expect(
      adapter.updatePaymentSession({ pspSessionId: "seti_1", amount: 100, idempotencyKey: "k" }),
    ).rejects.toThrowError(/amountless/);

    const session = await adapter.createPaymentSession({ amount: 500, currency: "USD", idempotencyKey: "k1" });
    fake.simulateClientConfirm(session.pspSessionId); // succeeded -> no longer updatable
    try {
      await adapter.updatePaymentSession({ pspSessionId: session.pspSessionId, amount: 900, idempotencyKey: "k2" });
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

describe("Stripe refund lifecycle", () => {
  it("retrieveRefund polls a pending refund to its terminal state", async () => {
    const { adapter, fake } = makePair();
    const pending = fake.seedRefund({ status: "pending", amount: 700, payment_intent: "pi_55" });
    const first = await adapter.retrieveRefund(pending.id);
    expect(first).toMatchObject({ refundId: pending.id, status: "pending", amount: 700, pspPaymentId: "pi_55" });
    expect(first.createdAt).toBe(new Date(1_780_000_200 * 1000).toISOString());

    fake.seedRefund({ id: pending.id, status: "succeeded", amount: 700, payment_intent: "pi_55" });
    expect((await adapter.retrieveRefund(pending.id)).status).toBe("succeeded");

    fake.seedRefund({ id: pending.id, status: "failed", amount: 700 });
    expect((await adapter.retrieveRefund(pending.id)).status).toBe("failed");
  });

  it("maps a missing refund to a PayFanoutError with raw preserved", async () => {
    const { adapter } = makePair();
    try {
      await adapter.retrieveRefund("re_missing");
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) expect(err.raw).toBeDefined();
    }
  });

  it("listRefunds filters by payment and pages with cursors", async () => {
    const { adapter, fake } = makePair();
    fake.seedRefund({ status: "succeeded", payment_intent: "pi_1", amount: 100 });
    fake.seedRefund({ status: "succeeded", payment_intent: "pi_2", amount: 200 });
    fake.seedRefund({ status: "pending", payment_intent: "pi_1", amount: 300 });

    const forPi1 = await adapter.listRefunds({ pspPaymentId: "pi_1" });
    expect(forPi1.refunds.map((r) => r.amount)).toEqual([300, 100]); // newest first
    expect(forPi1.nextCursor).toBeUndefined();

    const pageOne = await adapter.listRefunds({ limit: 2 });
    expect(pageOne.refunds).toHaveLength(2);
    expect(pageOne.nextCursor).toBe(pageOne.refunds[1]!.refundId);
    const pageTwo = await adapter.listRefunds({ limit: 2, cursor: pageOne.nextCursor });
    expect(pageTwo.refunds).toHaveLength(1);
    expect(pageTwo.nextCursor).toBeUndefined();
  });
});

describe("Stripe fetchEvents (missed-webhook recovery)", () => {
  it("normalizes events exactly like webhook ingress, with since + cursor paging", async () => {
    const { adapter, fake } = makePair();
    fake.seedEvent("payment_intent.succeeded", { object: "payment_intent", id: "pi_a" }, 100);
    fake.seedEvent("payment_intent.payment_failed", { object: "payment_intent", id: "pi_b" }, 200);
    fake.seedEvent("charge.refund.updated", { object: "refund", id: "re_1", status: "failed", payment_intent: "pi_a" }, 300);

    const all = await adapter.fetchEvents();
    expect(all.events.map((e) => e.type)).toEqual([
      "payment.refund_failed",
      "payment.failed",
      "payment.succeeded",
    ]);
    expect(all.events[0]!.pspPaymentId).toBe("pi_a");
    expect(all.events.every((e) => e.pspName === "stripe")).toBe(true);

    const since = await adapter.fetchEvents({ since: new Date(150 * 1000) });
    expect(since.events.map((e) => e.pspPaymentId)).toEqual(["pi_a", "pi_b"]);

    const pageOne = await adapter.fetchEvents({ limit: 1 });
    expect(pageOne.events).toHaveLength(1);
    expect(pageOne.nextCursor).toBe(pageOne.events[0]!.id);
    const pageTwo = await adapter.fetchEvents({ limit: 1, cursor: pageOne.nextCursor });
    expect(pageTwo.events).toHaveLength(1);
    expect(pageTwo.events[0]!.id).not.toBe(pageOne.events[0]!.id);
  });

  it("rejects garbage `since` values locally", async () => {
    const { adapter } = makePair();
    await expect(adapter.fetchEvents({ since: "not-a-date" })).rejects.toThrowError(/ISO 8601/);
  });
});

describe("Stripe listPayments", () => {
  it("pages newest-first and maps each entry through toPaymentInfo", async () => {
    const { adapter, fake } = makePair();
    const s1 = await adapter.createPaymentSession({ amount: 100, currency: "USD", idempotencyKey: "k1" });
    const s2 = await adapter.createPaymentSession({ amount: 200, currency: "USD", idempotencyKey: "k2" });
    fake.simulateClientConfirm(s2.pspSessionId);

    const page = await adapter.listPayments({ limit: 1 });
    expect(page.payments).toHaveLength(1);
    expect(page.payments[0]!.pspPaymentId).toBe(s2.pspSessionId);
    expect(page.payments[0]!.status).toBe("succeeded");
    expect(page.nextCursor).toBe(s2.pspSessionId);

    const rest = await adapter.listPayments({ limit: 5, cursor: page.nextCursor });
    expect(rest.payments.map((p) => p.pspPaymentId)).toEqual([s1.pspSessionId]);
    expect(rest.nextCursor).toBeUndefined();
  });
});

describe("Stripe webhook refund mapping + secret rotation", () => {
  it("charge.refund.updated maps by refund status: failed -> refund_failed, succeeded -> refunded, pending -> unknown", async () => {
    const { adapter } = makePair();
    const parse = (status: string) =>
      adapter.parseWebhookEvent(
        JSON.stringify({
          id: `evt_${status}`,
          type: "charge.refund.updated",
          created: 1_780_000_400,
          data: { object: { object: "refund", id: "re_9", status, amount: 700, currency: "eur", payment_intent: "pi_9" } },
        }),
      );
    expect((await parse("failed")).type).toBe("payment.refund_failed");
    expect((await parse("canceled")).type).toBe("payment.refund_failed");
    expect((await parse("succeeded")).type).toBe("payment.refunded");
    expect((await parse("pending")).type).toBe("unknown");
    const failed = await parse("failed");
    expect(failed.pspPaymentId).toBe("pi_9");
    // Refund-object events carry their own money facts — no retrieve round-trip needed.
    expect(failed.amount).toBe(700);
    expect(failed.currency).toBe("EUR");
    expect(failed.refundId).toBe("re_9");
  });

  it("refund.failed / refund.updated events map the same way; charge.refunded stays payment.refunded", async () => {
    const { adapter } = makePair();
    const failedEvent = await adapter.parseWebhookEvent(
      JSON.stringify({
        id: "evt_rf",
        type: "refund.failed",
        created: 1,
        data: { object: { object: "refund", id: "re_1", status: "failed" } },
      }),
    );
    expect(failedEvent.type).toBe("payment.refund_failed");
    const chargeRefunded = await adapter.parseWebhookEvent(
      JSON.stringify({
        id: "evt_cr",
        type: "charge.refunded",
        created: 1,
        data: { object: { object: "charge", id: "ch_1", payment_intent: "pi_1" } },
      }),
    );
    expect(chargeRefunded.type).toBe("payment.refunded");
  });

  it("accepts signatures from ANY configured secret during rotation, none after removal", async () => {
    const OLD = "whsec_old";
    const NEW = "whsec_new";
    const { adapter } = makePair({ webhookSigningSecret: [OLD, NEW] });
    const rawBody = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", created: 1 });
    await expect(adapter.verifyWebhookSignature(rawBody, sign(rawBody, OLD))).resolves.toBe(true);
    await expect(adapter.verifyWebhookSignature(rawBody, sign(rawBody, NEW))).resolves.toBe(true);
    await expect(adapter.verifyWebhookSignature(rawBody, sign(rawBody, "whsec_other"))).resolves.toBe(false);

    const { adapter: rotated } = makePair({ webhookSigningSecret: [NEW] });
    await expect(rotated.verifyWebhookSignature(rawBody, sign(rawBody, OLD))).resolves.toBe(false);
  });

  it("verifies with mixed-case header names (proxies rewrite casing)", async () => {
    const { adapter } = makePair();
    const rawBody = JSON.stringify({ id: "evt_mc", type: "payment_intent.succeeded", created: 1 });
    const value = sign(rawBody, SIGNING_SECRET)["stripe-signature"]!;
    await expect(adapter.verifyWebhookSignature(rawBody, { "Stripe-Signature": value })).resolves.toBe(true);
  });

  it("rejects configs with no usable webhook secret", () => {
    expect(() => makePair({ webhookSigningSecret: [] })).toThrowError(/webhookSigningSecret/);
    expect(() => makePair({ webhookSigningSecret: ["", ""] })).toThrowError(/webhookSigningSecret/);
  });

  it("rejects nonsensical tolerance/timeout settings eagerly", () => {
    expect(() => makePair({ webhookToleranceSeconds: 0 })).toThrowError(/webhookToleranceSeconds/);
    expect(() => makePair({ webhookToleranceSeconds: -300 })).toThrowError(/webhookToleranceSeconds/);
    expect(() => makePair({ requestTimeoutMs: 0 })).toThrowError(/requestTimeoutMs/);
    expect(() => makePair({ requestTimeoutMs: 500.5 })).toThrowError(/requestTimeoutMs/);
  });
});

describe("Stripe capability declaration", () => {
  it("declares the default method list until told otherwise", () => {
    const { adapter } = makePair();
    expect(adapter.getCapabilities().paymentMethods).toEqual([
      { type: "card", flow: "embedded", supported: true },
      { type: "apple_pay", flow: "popup", supported: true },
      { type: "google_pay", flow: "popup", supported: true },
      // The rails are single-currency; card/wallets follow the account's
      // presentment list, which is not a per-method constraint.
      { type: "ideal", flow: "redirect", supported: true, currencies: ["EUR"] },
      { type: "sepa_debit", flow: "embedded", supported: true, currencies: ["EUR"] },
      { type: "ach", flow: "embedded", supported: true, currencies: ["USD"] },
      { type: "bacs_debit", flow: "embedded", supported: true, currencies: ["GBP"] },
    ]);
  });

  it("honors a per-account capability override (dashboard enablement varies)", () => {
    const override: PaymentMethodCapability[] = [
      { type: "card", flow: "embedded", supported: true },
      { type: "ideal", flow: "redirect", supported: false },
    ];
    const { adapter } = makePair({ paymentMethods: override });
    expect(adapter.getCapabilities().paymentMethods).toEqual(override);
  });
});

describe("Stripe SDK client construction (lazy load)", () => {
  it("pins apiVersion and threads maxNetworkRetries/requestTimeoutMs into the client", async () => {
    const defaults = new StripeServerAdapter({
      secretKey: "sk_test_a",
      apiVersion: "2024-06-20",
      webhookSigningSecret: SIGNING_SECRET,
      environment: "sandbox",
    });
    await defaults.retrievePayment("pi_sdk");
    const tuned = new StripeServerAdapter({
      secretKey: "sk_test_b",
      apiVersion: "2024-06-20",
      webhookSigningSecret: SIGNING_SECRET,
      environment: "sandbox",
      maxNetworkRetries: 5,
      requestTimeoutMs: 10_000,
    });
    await tuned.retrievePayment("pi_sdk");
    // No timeout key on the defaults: the SDK's own 80s default stays in charge.
    expect(sdkConstructions[0]).toEqual({
      key: "sk_test_a",
      options: { apiVersion: "2024-06-20", maxNetworkRetries: 2 },
    });
    expect(sdkConstructions[1]).toEqual({
      key: "sk_test_b",
      options: { apiVersion: "2024-06-20", maxNetworkRetries: 5, timeout: 10_000 },
    });
  });
});

describe("Stripe payment method details + mandates", () => {
  it("surfaces brand/last4/wallet for card payments", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 1000, currency: "USD", idempotencyKey: "k" });
    fake.simulateClientConfirm(session.pspSessionId, {
      card: { brand: "Visa", last4: "4242", wallet: { type: "apple_pay" }, exp_month: 11, exp_year: 2031 },
    });
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.paymentMethodDetails).toEqual({
      brand: "visa",
      last4: "4242",
      wallet: "apple_pay",
      expMonth: 11,
      expYear: 2031,
    });
    expect(info.mandateReference).toBeUndefined(); // cards have no mandate
  });

  it("stays absent before confirmation and for detail-less charges", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 1000, currency: "USD", idempotencyKey: "k" });
    const before = await adapter.retrievePayment(session.pspSessionId);
    expect(before.paymentMethodDetails).toBeUndefined();

    fake.simulateClientConfirm(session.pspSessionId, { card: {} });
    const after = await adapter.retrievePayment(session.pspSessionId);
    expect(after.paymentMethodDetails).toBeUndefined(); // empty details are not reported as an empty object
  });

  it("surfaces the mandate reference for debit rails (SEPA)", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 1000,
      currency: "EUR",
      paymentMethodTypes: ["sepa_debit"],
      idempotencyKey: "k",
    });
    fake.simulateClientConfirm(session.pspSessionId, {
      paymentMethodType: "sepa_debit",
      mandate: "mandate_1KcXpG2eZvKYlo2C",
    });
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.paymentMethodType).toBe("sepa_debit");
    expect(info.mandateReference).toBe("mandate_1KcXpG2eZvKYlo2C");
  });
});

describe("Stripe async-rails + dispute event mapping", () => {
  const parse = (adapter: StripeServerAdapter, type: string, object: Record<string, unknown>) =>
    adapter.parseWebhookEvent(
      JSON.stringify({ id: `evt_${type}`, type, created: 1_780_000_500, data: { object } }),
    );

  it("payment_intent.processing maps to payment.processing", async () => {
    const { adapter } = makePair();
    const event = await parse(adapter, "payment_intent.processing", {
      object: "payment_intent",
      id: "pi_9",
      amount: 3200,
      currency: "usd",
    });
    expect(event.type).toBe("payment.processing");
    expect(event.pspPaymentId).toBe("pi_9");
    expect(event.amount).toBe(3200);
    expect(event.currency).toBe("USD");
    expect(event.refundId).toBeUndefined();
  });

  it("charge.dispute.closed maps by outcome: won / warning_closed / lost", async () => {
    const { adapter } = makePair();
    const dispute = (status: string) =>
      parse(adapter, "charge.dispute.closed", { object: "dispute", id: "dp_1", status, payment_intent: "pi_7" });
    expect((await dispute("won")).type).toBe("payment.chargeback_won");
    expect((await dispute("warning_closed")).type).toBe("payment.chargeback_won");
    expect((await dispute("lost")).type).toBe("payment.chargeback_lost");
    expect((await dispute("needs_response")).type).toBe("unknown");
    expect((await dispute("won")).pspPaymentId).toBe("pi_7");
    // Opening stays what it was.
    const opened = await parse(adapter, "charge.dispute.created", { object: "dispute", id: "dp_1", payment_intent: "pi_7" });
    expect(opened.type).toBe("payment.chargeback");
  });
});

describe("Stripe vaulting (Customers + saved PaymentMethods)", () => {
  it("save-during-checkout: customer + savePaymentMethod vaults and surfaces the token", async () => {
    const { adapter, fake } = makePair();
    const customer = await adapter.createCustomer({
      id: "user-7",
      email: "u7@example.com",
      idempotencyKey: "k-cust",
    });
    expect(customer.pspCustomerId).toMatch(/^cus_/);
    expect(customer.id).toBe("user-7");

    const session = await adapter.createPaymentSession({
      amount: 3000,
      currency: "USD",
      customer: customer.pspCustomerId,
      savePaymentMethod: true,
      idempotencyKey: "k-sess",
    });
    expect(fake.lastPaymentIntentParams).toMatchObject({
      customer: customer.pspCustomerId,
      setup_future_usage: "off_session",
    });
    fake.simulateClientConfirm(session.pspSessionId);
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.savedPaymentMethodToken).toMatch(/^pm_/);

    const methods = await adapter.listSavedPaymentMethods(customer.pspCustomerId);
    expect(methods.map((m) => m.token)).toContain(info.savedPaymentMethodToken);
    expect(methods[0]).toMatchObject({
      pspCustomerId: customer.pspCustomerId,
      paymentMethodType: "card",
      details: { brand: "visa", last4: "4242" },
    });
  });

  it("sessions without savePaymentMethod never vault — no token surfaces", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 1000, currency: "USD", idempotencyKey: "k" });
    fake.simulateClientConfirm(session.pspSessionId);
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.savedPaymentMethodToken).toBeUndefined();
  });

  it("pages past Stripe's 100-item limit — customers with >100 methods list completely", async () => {
    const { adapter, fake } = makePair();
    const customer = await adapter.createCustomer({ idempotencyKey: "k-cust" });
    const seeded = Array.from({ length: 150 }, () => fake.seedPaymentMethod(customer.pspCustomerId).id);

    const methods = await adapter.listSavedPaymentMethods(customer.pspCustomerId);
    expect(methods).toHaveLength(150);
    expect(new Set(methods.map((m) => m.token))).toEqual(new Set(seeded));
    // Two round-trips: a full page of 100, then the cursor-anchored remainder.
    expect(fake.listPaymentMethodsCalls).toHaveLength(2);
    expect(fake.listPaymentMethodsCalls[0]).toEqual({ limit: 100 });
    expect(fake.listPaymentMethodsCalls[1]).toEqual({ limit: 100, starting_after: seeded[99] });
  });

  it("savePaymentMethod without customer is rejected locally", async () => {
    const { adapter } = makePair();
    await expect(
      adapter.createPaymentSession({ amount: 1000, currency: "USD", savePaymentMethod: true, idempotencyKey: "k" }),
    ).rejects.toThrowError(/requires `customer`/);
  });

  it("zero-amount save mode keeps the instrument vaulted — verification mode still detaches", async () => {
    const { adapter, fake } = makePair();
    const customer = await adapter.createCustomer({ idempotencyKey: "k-cust" });
    const saveSession = await adapter.createPaymentSession({
      amount: 0,
      currency: "USD",
      customer: customer.pspCustomerId,
      savePaymentMethod: true,
      idempotencyKey: "k-save",
    });
    const pm = fake.simulateSetupConfirm(saveSession.pspSessionId);
    const saved = await adapter.verifyPaymentMethod({
      pspSessionId: saveSession.pspSessionId,
      idempotencyKey: "k-verify-save",
    });
    expect(saved.status).toBe("succeeded");
    expect(saved.savedPaymentMethodToken).toBe(pm.id);
    expect(fake.detachedPaymentMethods).not.toContain(pm.id); // stays vaulted

    // Plain verification (no customer) keeps the detach guarantee.
    const verifySession = await adapter.createPaymentSession({ amount: 0, currency: "USD", idempotencyKey: "k-ver" });
    const verifyPm = fake.simulateSetupConfirm(verifySession.pspSessionId);
    const verified = await adapter.verifyPaymentMethod({
      pspSessionId: verifySession.pspSessionId,
      idempotencyKey: "k-verify-only",
    });
    expect(verified.savedPaymentMethodToken).toBeUndefined();
    expect(fake.detachedPaymentMethods).toContain(verifyPm.id);
  });

  it("chargeSavedPaymentMethod: MIT off_session by default, on-session for 'initial'", async () => {
    const { adapter, fake } = makePair();
    const customer = await adapter.createCustomer({ idempotencyKey: "k-cust" });
    const pm = fake.seedPaymentMethod(customer.pspCustomerId);

    const initial = await adapter.chargeSavedPaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      savedPaymentMethodToken: pm.id,
      amount: 1500,
      currency: "USD",
      occurrence: "initial",
      idempotencyKey: "k-c1",
    });
    expect(initial.status).toBe("succeeded");
    expect(fake.lastPaymentIntentParams).toMatchObject({ confirm: true, off_session: false });

    const recurring = await adapter.chargeSavedPaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      savedPaymentMethodToken: pm.id,
      amount: 1500,
      currency: "USD",
      idempotencyKey: "k-c2",
    });
    expect(recurring.status).toBe("succeeded");
    expect(recurring.paymentMethodDetails).toEqual({ brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 });
    expect(fake.lastPaymentIntentParams).toMatchObject({ off_session: true });
  });

  it("banks demanding authentication surface as authentication_required", async () => {
    const { adapter, fake } = makePair();
    const customer = await adapter.createCustomer({ idempotencyKey: "k-cust" });
    const pm = fake.seedPaymentMethod(customer.pspCustomerId, { behavior: "auth_required" });
    await expect(
      adapter.chargeSavedPaymentMethod({
        pspCustomerId: customer.pspCustomerId,
        savedPaymentMethodToken: pm.id,
        amount: 900,
        currency: "USD",
        idempotencyKey: "k-c",
      }),
    ).rejects.toMatchObject({ code: "authentication_required", retryable: false });
  });

  it("deleteSavedPaymentMethod enforces ownership, then kills the token", async () => {
    const { adapter, fake } = makePair();
    const owner = await adapter.createCustomer({ idempotencyKey: "k-a" });
    const other = await adapter.createCustomer({ idempotencyKey: "k-b" });
    const pm = fake.seedPaymentMethod(owner.pspCustomerId);

    await expect(adapter.deleteSavedPaymentMethod(other.pspCustomerId, pm.id)).rejects.toThrowError(
      /does not belong to customer/,
    );
    await adapter.deleteSavedPaymentMethod(owner.pspCustomerId, pm.id);
    expect(await adapter.listSavedPaymentMethods(owner.pspCustomerId)).toEqual([]);
  });
});

describe("Stripe error path on new surfaces", () => {
  it("wraps SDK failures from update/list/fetch into PayFanoutErrors", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 100, currency: "USD", idempotencyKey: "k" });
    for (const call of [
      () => adapter.updatePaymentSession({ pspSessionId: session.pspSessionId, amount: 200, idempotencyKey: "k2" }),
      () => adapter.listPayments(),
      () => adapter.listRefunds(),
      () => adapter.fetchEvents(),
      () => adapter.retrieveRefund("re_x"),
    ]) {
      fake.failNextWith(stripeError({ type: "StripeAPIError", statusCode: 500, message: "boom" }));
      try {
        await call();
        expect.unreachable("expected rejection");
      } catch (err) {
        expect(isPayFanoutError(err)).toBe(true);
        if (isPayFanoutError(err)) expect(err.raw).toBeDefined();
      }
    }
  });
});
