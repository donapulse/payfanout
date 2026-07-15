import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StripeServerAdapter, verifyStripeWebhookSignature } from "../src/index.js";
import { FakeStripe } from "./fake-stripe.js";

const NOW_MS = Date.parse("2026-07-04T12:00:00Z");

function makePair(): { adapter: StripeServerAdapter; fake: FakeStripe } {
  const fake = new FakeStripe();
  const adapter = new StripeServerAdapter({
    secretKey: "sk_test_123",
    apiVersion: "2024-06-20",
    webhookSigningSecret: "whsec_x",
    environment: "sandbox",
    client: fake,
    now: () => NOW_MS,
  });
  return { adapter, fake };
}

describe("StripeServerAdapter edges", () => {
  it("maps explicit unified method types onto Stripe payment_method_types", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 1000,
      currency: "USD",
      paymentMethodTypes: ["card", "apple_pay", "ideal", "ach"],
      idempotencyKey: "k",
    });
    const pi = await fake.paymentIntents.retrieve(session.pspSessionId);
    // apple_pay rides the card rails; ach maps to us_bank_account; no
    // duplicates. iDEAL declares EUR, so a USD intent must not carry it —
    // Stripe rejects a currency-incompatible explicit entry outright.
    expect(pi.payment_method_types).toEqual(["card", "us_bank_account"]);
  });

  it("rejects method types Stripe cannot express", async () => {
    const { adapter } = makePair();
    await expect(
      adapter.createPaymentSession({
        amount: 1000,
        currency: "USD",
        paymentMethodTypes: ["paysafecard"],
        idempotencyKey: "k",
      }),
    ).rejects.toThrowError(/does not support payment method type "paysafecard"/);
    // Precedence when mixed with a currency-ineligible rail: the currency
    // filter drops sepa_debit, then the unknown type still fails the mapping.
    await expect(
      adapter.createPaymentSession({
        amount: 1000,
        currency: "USD",
        paymentMethodTypes: ["paysafecard", "sepa_debit"],
        idempotencyKey: "k",
      }),
    ).rejects.toThrowError(/does not support payment method type "paysafecard"/);
  });

  it("passes every canonical refund reason through in Stripe's own vocabulary", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 1000, currency: "USD", idempotencyKey: "k" });
    fake.simulateClientConfirm(session.pspSessionId);

    const captured: Record<string, unknown>[] = [];
    const realCreate = fake.refunds.create.bind(fake.refunds);
    fake.refunds.create = async (params, opts) => {
      captured.push(params);
      return realCreate(params, opts);
    };

    // RefundReason is exactly Stripe's refund-reason enum — sent verbatim.
    await adapter.refundPayment({
      pspPaymentId: session.pspSessionId,
      amount: 100,
      reason: "requested_by_customer",
      idempotencyKey: "r1",
    });
    await adapter.refundPayment({
      pspPaymentId: session.pspSessionId,
      amount: 100,
      reason: "duplicate",
      idempotencyKey: "r2",
    });
    await adapter.refundPayment({
      pspPaymentId: session.pspSessionId,
      amount: 100,
      reason: "fraudulent",
      idempotencyKey: "r3",
    });
    await adapter.refundPayment({ pspPaymentId: session.pspSessionId, amount: 100, idempotencyKey: "r4" });
    expect(captured.map((params) => params["reason"])).toEqual([
      "requested_by_customer",
      "duplicate",
      "fraudulent",
      undefined,
    ]);
    expect(captured[3]).not.toHaveProperty("reason");
  });

  it("tolerates an unexpanded latest_charge (string) without inventing refund data", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 1000, currency: "USD", idempotencyKey: "k" });
    const pi = await fake.paymentIntents.retrieve(session.pspSessionId);
    pi.status = "succeeded";
    pi.latest_charge = "ch_unexpanded_1";
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.amountRefunded).toBe(0);
    expect(info.paymentMethodType).toBe("card"); // falls back to payment_method_types[0]
  });

  it("keeps zero-amount sessions working when verification is enabled by default", async () => {
    const { adapter } = makePair();
    expect(adapter.getCapabilities().supportsPaymentMethodVerification).toBe(true);
    const session = await adapter.createPaymentSession({ amount: 0, currency: "USD", idempotencyKey: "k" });
    expect(session.status).toBe("requires_payment_method");
    expect(session.amount).toBe(0);
  });
});

describe("Stripe signature verification edges", () => {
  const SECRET = "whsec_x";
  // Mirrors Stripe's documented scheme: HMAC-SHA256 over `${t}.${payload}`.
  const sign = (payload: string, t: number): string =>
    createHmac("sha256", SECRET).update(`${t}.${payload}`).digest("hex");

  it("rejects headers missing t= or v1=, and non-hex signatures", () => {
    const body = "{}";
    const t = NOW_MS / 1000;
    expect(verifyStripeWebhookSignature(body, {}, SECRET, 300, NOW_MS)).toBe(false);
    expect(
      verifyStripeWebhookSignature(body, { "stripe-signature": `v1=${sign(body, t)}` }, SECRET, 300, NOW_MS),
    ).toBe(false);
    expect(
      verifyStripeWebhookSignature(body, { "stripe-signature": `t=${t}` }, SECRET, 300, NOW_MS),
    ).toBe(false);
    expect(
      verifyStripeWebhookSignature(body, { "stripe-signature": `t=${t},v1=zzzz-not-hex` }, SECRET, 300, NOW_MS),
    ).toBe(false);
    expect(
      verifyStripeWebhookSignature(body, { "stripe-signature": `t=abc,v1=${sign(body, t)}` }, SECRET, 300, NOW_MS),
    ).toBe(false);
  });

  it("accepts when any one of multiple v1 signatures matches (secret rotation)", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const t = NOW_MS / 1000;
    const good = sign(body, t);
    const stale = "a".repeat(64);
    expect(
      verifyStripeWebhookSignature(
        body,
        { "stripe-signature": `t=${t},v1=${stale},v1=${good}` },
        SECRET,
        300,
        NOW_MS,
      ),
    ).toBe(true);
  });
});
