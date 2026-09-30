import { describe, expect, it } from "vitest";
import { isPayFanoutError, type PayFanoutError } from "@payfanout/core";
import {
  StripeServerAdapter,
  stripeEventBodyToUnified,
  type StripePaymentIntentLike,
  type StripeServerAdapterConfig,
} from "../src/index.js";
import { FakeStripe, stripeError } from "./fake-stripe.js";

// Stripe's units per docs.stripe.com/currencies (read 2026-09-30): ISK is a
// two-decimal value whose decimals are always 00, MGA is zero-decimal, and
// UGX is given both units. PayFanout's are ISO 4217's: ISK 0, MGA 2, UGX 0.

const NOW_MS = Date.parse("2026-09-30T12:00:00Z");

function makePair(config: Partial<StripeServerAdapterConfig> = {}): { adapter: StripeServerAdapter; fake: FakeStripe } {
  const fake = new FakeStripe();
  const adapter = new StripeServerAdapter({
    secretKey: "sk_test_123",
    apiVersion: "2024-06-20",
    webhookSigningSecret: "whsec_test_secret",
    environment: "sandbox",
    client: fake,
    now: () => NOW_MS,
    ...config,
  });
  return { adapter, fake };
}

interface StripeCall {
  call: string;
  args: unknown[];
}

const RESOURCES = [
  "paymentIntents",
  "setupIntents",
  "paymentMethods",
  "customers",
  "refunds",
  "subscriptions",
  "products",
  "events",
] as const;

/** Logs every request the adapter makes to the fake, in order, with its arguments. */
function recordCalls(fake: FakeStripe): StripeCall[] {
  const log: StripeCall[] = [];
  for (const resource of RESOURCES) {
    const methods = fake[resource] as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const [method, fn] of Object.entries(methods)) {
      methods[method] = (...args: unknown[]) => {
        log.push({ call: `${resource}.${method}`, args });
        return fn(...args);
      };
    }
  }
  return log;
}

const names = (log: StripeCall[]): string[] => log.map(({ call }) => call);

async function rejectionOf(call: Promise<unknown>): Promise<PayFanoutError> {
  const err = await call.then(
    () => {
      throw new Error("expected a rejection");
    },
    (reason: unknown) => reason,
  );
  if (!isPayFanoutError(err)) throw err;
  return err;
}

/** A PaymentIntent as Stripe holds it, in Stripe's units, as an earlier release or another integration made it. */
async function stripeIntent(
  fake: FakeStripe,
  stripeAmount: number,
  currency: string,
  state: "open" | "authorized" | "succeeded" = "open",
): Promise<StripePaymentIntentLike> {
  const pi = await fake.paymentIntents.create({
    amount: stripeAmount,
    currency,
    capture_method: state === "authorized" ? "manual" : "automatic",
  });
  if (state !== "open") fake.simulateClientConfirm(pi.id);
  return pi;
}

function vaulted(fake: FakeStripe): { pspCustomerId: string; savedPaymentMethodToken: string } {
  const customer = fake.seedCustomer();
  return { pspCustomerId: customer.id, savedPaymentMethodToken: fake.seedPaymentMethod(customer.id).id };
}

function event(type: string, object: Record<string, unknown>): string {
  return JSON.stringify({ id: `evt_${type}`, type, created: 1_780_000_500, data: { object } });
}

/** PayFanout amounts and the exact figures Stripe must be sent for them. */
const CASES = [
  { currency: "ISK", amount: 1000, partial: 600, stripe: 100_000, stripePartial: 60_000 },
  { currency: "MGA", amount: 150_000, partial: 50_000, stripe: 1500, stripePartial: 500 },
  { currency: "USD", amount: 1099, partial: 500, stripe: 1099, stripePartial: 500 },
  { currency: "JPY", amount: 500, partial: 200, stripe: 500, stripePartial: 200 },
  { currency: "KWD", amount: 1230, partial: 500, stripe: 1230, stripePartial: 500 },
];

describe.each(CASES)("$currency amounts on every path", ({ currency, amount, partial, stripe, stripePartial }) => {
  const lower = currency.toLowerCase();

  it("createPaymentSession sends Stripe's units and reports PayFanout's", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount, currency, idempotencyKey: "k" });
    expect(fake.lastPaymentIntentParams).toMatchObject({ amount: stripe, currency: lower });
    expect(session).toMatchObject({ amount, currency });
  });

  it("updatePaymentSession reads the PaymentIntent first only when the call names no currency", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount, currency, idempotencyKey: "k1" });
    const log = recordCalls(fake);
    const named = await adapter.updatePaymentSession({
      pspSessionId: session.pspSessionId,
      amount: partial,
      currency,
      idempotencyKey: "k2",
    });
    expect(names(log)).toEqual(["paymentIntents.update"]);
    expect(log[0]!.args).toEqual([session.pspSessionId, { amount: stripePartial, currency: lower }, { idempotencyKey: "k2" }]);
    expect(named.amount).toBe(partial);

    log.length = 0;
    const unnamed = await adapter.updatePaymentSession({
      pspSessionId: session.pspSessionId,
      amount,
      idempotencyKey: "k3",
    });
    expect(names(log)).toEqual(["paymentIntents.retrieve", "paymentIntents.update"]);
    expect(log[0]!.args).toEqual([session.pspSessionId]);
    expect(log[1]!.args).toEqual([session.pspSessionId, { amount: stripe }, { idempotencyKey: "k3" }]);
    expect(unnamed).toMatchObject({ amount, currency });

    log.length = 0;
    await adapter.updatePaymentSession({ pspSessionId: session.pspSessionId, metadata: { a: "1" }, idempotencyKey: "k4" });
    expect(names(log)).toEqual(["paymentIntents.update"]);
    expect(log[0]!.args).toEqual([session.pspSessionId, { metadata: { a: "1" } }, { idempotencyKey: "k4" }]);
  });

  it("capturePayment reads the PaymentIntent before a partial capture, not before a full one", async () => {
    const { adapter, fake } = makePair();
    const first = await adapter.createPaymentSession({ amount, currency, captureMethod: "manual", idempotencyKey: "k1" });
    const second = await adapter.createPaymentSession({ amount, currency, captureMethod: "manual", idempotencyKey: "k2" });
    fake.simulateClientConfirm(first.pspSessionId);
    fake.simulateClientConfirm(second.pspSessionId);
    expect(await adapter.retrievePayment(first.pspSessionId)).toMatchObject({
      status: "requires_capture",
      amount,
      amountCaptured: 0,
      amountCapturable: amount,
    });

    const log = recordCalls(fake);
    const captured = await adapter.capturePayment(first.pspSessionId, partial, "cap-1");
    expect(names(log)).toEqual(["paymentIntents.retrieve", "paymentIntents.capture"]);
    expect(log[0]!.args).toEqual([first.pspSessionId]);
    expect(log[1]!.args).toEqual([first.pspSessionId, { amount_to_capture: stripePartial }, { idempotencyKey: "cap-1" }]);
    expect(captured).toMatchObject({ status: "succeeded", amount: partial, amountCaptured: partial, amountCapturable: 0 });

    log.length = 0;
    const full = await adapter.capturePayment(second.pspSessionId, undefined, "cap-2");
    expect(names(log)).toEqual(["paymentIntents.capture"]);
    expect(log[0]!.args).toEqual([second.pspSessionId, {}, { idempotencyKey: "cap-2" }]);
    expect(full).toMatchObject({ amount, amountCaptured: amount });
  });

  it("cancelPayment reports the canceled intent in PayFanout's units", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount, currency, captureMethod: "manual", idempotencyKey: "k" });
    fake.simulateClientConfirm(session.pspSessionId);
    const canceled = await adapter.cancelPayment(session.pspSessionId, "void");
    expect(canceled).toMatchObject({ status: "canceled", amount, amountCapturable: 0 });
  });

  it("refundPayment reads the PaymentIntent before a partial refund, not before a full one", async () => {
    const { adapter, fake } = makePair();
    const first = await adapter.createPaymentSession({ amount, currency, idempotencyKey: "k1" });
    const second = await adapter.createPaymentSession({ amount, currency, idempotencyKey: "k2" });
    fake.simulateClientConfirm(first.pspSessionId);
    fake.simulateClientConfirm(second.pspSessionId);

    const log = recordCalls(fake);
    const refunded = await adapter.refundPayment({ pspPaymentId: first.pspSessionId, amount: partial, idempotencyKey: "r1" });
    expect(names(log)).toEqual(["paymentIntents.retrieve", "refunds.create"]);
    expect(log[0]!.args).toEqual([first.pspSessionId, { expand: ["latest_charge"] }]);
    expect(log[1]!.args).toEqual([{ payment_intent: first.pspSessionId, amount: stripePartial }, { idempotencyKey: "r1" }]);
    expect(refunded).toMatchObject({ status: "succeeded", amount: partial });

    log.length = 0;
    const full = await adapter.refundPayment({ pspPaymentId: second.pspSessionId, idempotencyKey: "r2" });
    expect(names(log)).toEqual(["refunds.create"]);
    expect(log[0]!.args).toEqual([{ payment_intent: second.pspSessionId }, { idempotencyKey: "r2" }]);
    expect(full.amount).toBe(amount);

    expect(await adapter.retrievePayment(first.pspSessionId)).toMatchObject({ amount, amountRefunded: partial });
    expect(await adapter.retrieveRefund(refunded.refundId)).toMatchObject({ amount: partial });
    expect((await adapter.listRefunds()).refunds.map((r) => r.amount)).toEqual([amount, partial]);
  });

  it("chargeSavedPaymentMethod sends Stripe's units and reports PayFanout's", async () => {
    const { adapter, fake } = makePair();
    const charged = await adapter.chargeSavedPaymentMethod({ ...vaulted(fake), amount, currency, idempotencyKey: "c" });
    expect(fake.lastPaymentIntentParams).toMatchObject({ amount: stripe, currency: lower, confirm: true });
    expect(charged).toMatchObject({ status: "succeeded", amount, amountCaptured: amount, currency });
  });

  it("native subscriptions send unit_amount in Stripe's units and report PayFanout's", async () => {
    const { adapter, fake } = makePair();
    const created = await adapter.createNativeSubscription({
      ...vaulted(fake),
      amount,
      currency,
      interval: "month",
      idempotencyKey: "s",
    });
    const item = (fake.lastSubscriptionParams?.["items"] as Array<Record<string, unknown>>)[0]!;
    expect(item["price_data"]).toMatchObject({ currency: lower, unit_amount: stripe });
    expect(created).toMatchObject({ amount, currency });
    expect((await adapter.retrieveNativeSubscription({ subscriptionId: created.id })).amount).toBe(amount);
    expect((await adapter.listNativeSubscriptions()).subscriptions.map((s) => s.amount)).toEqual([amount]);
    const canceled = await adapter.cancelNativeSubscription({ subscriptionId: created.id, idempotencyKey: "c" });
    expect(canceled).toMatchObject({ status: "canceled", amount });
  });

  it("subscription installments sum unit_amount x quantity in Stripe's units before converting", async () => {
    const { adapter, fake } = makePair();
    const sub = fake.seedSubscription({
      currency: lower,
      items: [
        { price: fake.seedPrice({ currency: lower, unitAmount: stripePartial }), quantity: 2 },
        { price: fake.seedPrice({ currency: lower, unitAmount: stripe }) },
      ],
    });
    const record = await adapter.retrieveNativeSubscription({ subscriptionId: sub.id });
    expect(record.amount).toBe(2 * partial + amount);
  });

  it("listPayments reports every amount in PayFanout's units", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount, currency, idempotencyKey: "k" });
    fake.simulateClientConfirm(session.pspSessionId);
    await adapter.refundPayment({ pspPaymentId: session.pspSessionId, amount: partial, idempotencyKey: "r" });
    const page = await adapter.listPayments();
    expect(page.payments).toHaveLength(1);
    expect(page.payments[0]).toMatchObject({ amount, amountRefunded: partial, amountCaptured: amount, amountCapturable: 0 });
  });

  it("webhook and polled events carry amounts in PayFanout's units", async () => {
    const { adapter, fake } = makePair();
    const succeeded = await adapter.parseWebhookEvent(
      event("payment_intent.succeeded", { object: "payment_intent", id: "pi_9", amount: stripe, currency: lower }),
    );
    expect(succeeded).toMatchObject({ type: "payment.succeeded", pspPaymentId: "pi_9", amount, currency });
    const chargeRefunded = await adapter.parseWebhookEvent(
      event("charge.refunded", {
        object: "charge",
        id: "ch_9",
        payment_intent: "pi_9",
        amount_refunded: stripePartial,
        currency: lower,
        refunds: { data: [{ id: "re_9" }] },
      }),
    );
    expect(chargeRefunded).toMatchObject({ type: "payment.refunded", amount: partial, currency, refundId: "re_9" });
    const refund = await adapter.parseWebhookEvent(
      event("refund.updated", { object: "refund", id: "re_8", status: "succeeded", amount: stripePartial, currency: lower }),
    );
    expect(refund).toMatchObject({ type: "payment.refunded", amount: partial, currency, refundId: "re_8" });

    fake.seedEvent("payment_intent.processing", { object: "payment_intent", id: "pi_7", amount: stripe, currency: lower });
    const polled = await adapter.fetchEvents();
    expect(polled.events[0]).toMatchObject({ type: "payment.processing", amount, currency });
  });
});

describe("MGA: Stripe charges whole ariary", () => {
  it("refuses an amount that is not a multiple of 100 on every send path, before the request carrying it", async () => {
    const { adapter, fake } = makePair();
    const open = await stripeIntent(fake, 1500, "mga");
    const paid = await stripeIntent(fake, 1500, "mga", "succeeded");
    const authorized = await stripeIntent(fake, 1500, "mga", "authorized");
    // Money already moved on these: a capture, and a refund of part of the charge.
    const captured = await stripeIntent(fake, 1500, "mga", "authorized");
    await fake.paymentIntents.capture(captured.id, {});
    const refunded = await stripeIntent(fake, 1500, "mga", "succeeded");
    await fake.refunds.create({ payment_intent: refunded.id, amount: 500 });
    // No longer requires_capture: only that status shows nothing was captured.
    const voided = await stripeIntent(fake, 1500, "mga", "authorized");
    await fake.paymentIntents.cancel(voided.id);
    const vault = vaulted(fake);
    const log = recordCalls(fake);
    // What an earlier release, which sent these unconverted, may already have done under the key.
    const calls: Array<[() => Promise<unknown>, string[], string | undefined]> = [
      [() => adapter.createPaymentSession({ amount: 1050, currency: "MGA", idempotencyKey: "a" }), [], undefined],
      [
        () => adapter.updatePaymentSession({ pspSessionId: open.id, amount: 1050, currency: "MGA", idempotencyKey: "b" }),
        [],
        undefined,
      ],
      [
        () => adapter.updatePaymentSession({ pspSessionId: open.id, amount: 1050, idempotencyKey: "c" }),
        ["paymentIntents.retrieve"],
        undefined,
      ],
      // Still requires_capture: nothing was captured, so the refusal is final.
      [() => adapter.capturePayment(authorized.id, 1050, "d"), ["paymentIntents.retrieve"], undefined],
      [() => adapter.capturePayment(captured.id, 1050, "d2"), ["paymentIntents.retrieve"], "a capture"],
      [() => adapter.capturePayment(voided.id, 1050, "d3"), ["paymentIntents.retrieve"], "a capture"],
      // A charge with nothing refunded: the refusal is final.
      [
        () => adapter.refundPayment({ pspPaymentId: paid.id, amount: 1050, idempotencyKey: "e" }),
        ["paymentIntents.retrieve"],
        undefined,
      ],
      [
        () => adapter.refundPayment({ pspPaymentId: refunded.id, amount: 1050, idempotencyKey: "e2" }),
        ["paymentIntents.retrieve"],
        "a refund",
      ],
      [
        () => adapter.refundPayment({ pspPaymentId: open.id, amount: 1050, idempotencyKey: "e3" }),
        ["paymentIntents.retrieve"],
        "a refund",
      ],
      [
        () => adapter.chargeSavedPaymentMethod({ ...vault, amount: 1050, currency: "MGA", idempotencyKey: "f" }),
        [],
        "a charge",
      ],
      [
        () =>
          adapter.createNativeSubscription({ ...vault, amount: 1050, currency: "MGA", interval: "month", idempotencyKey: "g" }),
        [],
        "a charge",
      ],
    ];
    for (const [call, expected, sentBefore] of calls) {
      log.length = 0;
      const err = await rejectionOf(call());
      expect(err).toMatchObject({ code: "invalid_request", retryable: false, pspName: "stripe" });
      expect(err.message).toMatch(/^Stripe takes MGA amounts with 0 decimals where PayFanout has 2, so .* must be a multiple of 100 minor units, got 1050/);
      expect(err.raw).toMatchObject({ currency: "MGA", payfanoutExponent: 2, stripeExponent: 0, amount: 1050 });
      expect(err.outcomeUnknown).toBe(sentBefore === undefined ? undefined : true);
      expect(err.message).toMatch(
        sentBefore === undefined
          ? /, got 1050$/
          : new RegExp(
              `, got 1050\\. An earlier release sent such requests unconverted, so check the Stripe Dashboard for ${sentBefore} under this idempotency key before sending another$`,
            ),
      );
      expect(names(log)).toEqual(expected);
    }
  });

  it("names the record read first on the refusal's raw", async () => {
    const { adapter, fake } = makePair();
    const authorized = await stripeIntent(fake, 1500, "mga", "authorized");
    const err = await rejectionOf(adapter.capturePayment(authorized.id, 150, "k"));
    expect(err.message).toMatch(/amount_to_capture must be a multiple of 100/);
    expect((err.raw as { record: unknown }).record).toMatchObject({ id: authorized.id, currency: "mga" });
  });

  it("reports whole ariary as PayFanout hundredths, and fails a read that leaves the safe integer range", async () => {
    const { adapter, fake } = makePair();
    const small = await stripeIntent(fake, 7, "mga");
    expect((await adapter.retrievePayment(small.id)).amount).toBe(700);
    const huge = await stripeIntent(fake, 1e14, "mga");
    const err = await rejectionOf(adapter.retrievePayment(huge.id));
    expect(err).toMatchObject({ code: "unsupported_operation", retryable: false });
    expect(err.message).toMatch(/MGA amount 100000000000000 leaves the safe integer range/);
    const fraction = await stripeIntent(fake, 10.5, "mga");
    expect((await rejectionOf(adapter.retrievePayment(fraction.id))).message).toMatch(/10\.5, which is not an integer/);
  });
});

describe("ISK: Stripe's two-decimal representation", () => {
  it("sends the safe-integer boundary and refuses one past it before any request", async () => {
    const { adapter, fake } = makePair();
    const log = recordCalls(fake);
    await adapter.createPaymentSession({ amount: 90_071_992_547_409, currency: "ISK", idempotencyKey: "a" });
    expect(fake.lastPaymentIntentParams?.["amount"]).toBe(9_007_199_254_740_900);
    log.length = 0;
    const err = await rejectionOf(
      adapter.createPaymentSession({ amount: 90_071_992_547_410, currency: "ISK", idempotencyKey: "b" }),
    );
    expect(err).toMatchObject({ code: "invalid_request", retryable: false, pspName: "stripe" });
    expect(err.message).toMatch(/amount 90071992547410 leaves the safe integer range once multiplied by 100/);
    expect(names(log)).toEqual([]);
  });

  it("fails closed on every read of an amount that is not a multiple of 100", async () => {
    const { adapter, fake } = makePair();
    const odd = await stripeIntent(fake, 150, "isk");
    const err = await rejectionOf(adapter.retrievePayment(odd.id));
    expect(err).toMatchObject({ code: "unsupported_operation", retryable: false, pspName: "stripe" });
    expect(err.outcomeUnknown).toBeUndefined();
    expect(err.message).toMatch(
      new RegExp(`^PaymentIntent ${odd.id} is in ISK, and its amounts cannot be reported in PayFanout's minor units: .*150 is not a multiple of 100\\. Read it in the Stripe Dashboard$`),
    );
    expect(err.raw).toMatchObject({ currency: "ISK", payfanoutExponent: 0, stripeExponent: 2, stripeAmount: 150, record: odd });

    // Every amount PaymentInfo reports is checked, not only `amount`.
    const capturable = await stripeIntent(fake, 100_000, "isk", "authorized");
    capturable.amount_capturable = 99_950;
    expect((await rejectionOf(adapter.retrievePayment(capturable.id))).raw).toMatchObject({ stripeAmount: 99_950 });
    const refunded = await stripeIntent(fake, 100_000, "isk", "succeeded");
    (refunded.latest_charge as { amount_refunded: number }).amount_refunded = 50;
    expect((await rejectionOf(adapter.retrievePayment(refunded.id))).raw).toMatchObject({ stripeAmount: 50 });
    const fraction = await stripeIntent(fake, 1000.5, "isk");
    expect((await rejectionOf(adapter.retrievePayment(fraction.id))).message).toMatch(/1000\.5, which is not an integer/);

    const refund = fake.seedRefund({ status: "succeeded", amount: 150, currency: "isk", payment_intent: "pi_x" });
    expect(await rejectionOf(adapter.retrieveRefund(refund.id))).toMatchObject({ code: "unsupported_operation" });
    const sub = fake.seedSubscription({ currency: "isk", items: [{ price: fake.seedPrice({ currency: "isk", unitAmount: 150 }) }] });
    expect(await rejectionOf(adapter.retrieveNativeSubscription({ subscriptionId: sub.id }))).toMatchObject({
      code: "unsupported_operation",
    });
  });

  it("marks an answer it cannot report outcomeUnknown: the call went through", async () => {
    const { adapter, fake } = makePair();
    const authorized = await stripeIntent(fake, 150, "isk", "authorized");
    const err = await rejectionOf(adapter.cancelPayment(authorized.id, "void"));
    expect(err).toMatchObject({ code: "unsupported_operation", retryable: false, outcomeUnknown: true });
    expect(err.message).toMatch(
      new RegExp(`^Stripe answered the cancellation with PaymentIntent ${authorized.id}, which is in ISK, .*The cancellation may have taken effect: check PaymentIntent ${authorized.id} in the Stripe Dashboard$`),
    );
    expect((await fake.paymentIntents.retrieve(authorized.id)).status).toBe("canceled");
  });

  it("omits an event amount that is not a multiple of 100, keeping the currency", async () => {
    const { adapter } = makePair();
    const parsed = await adapter.parseWebhookEvent(
      event("payment_intent.succeeded", { object: "payment_intent", id: "pi_1", amount: 150, currency: "isk" }),
    );
    expect(parsed).toMatchObject({ type: "payment.succeeded", pspPaymentId: "pi_1", currency: "ISK" });
    expect(parsed).not.toHaveProperty("amount");
  });
});

describe("UGX: refused, as Stripe documents it with two units", () => {
  it("refuses every send that names UGX before any request", async () => {
    const { adapter, fake } = makePair();
    const open = await stripeIntent(fake, 5000, "usd");
    const vault = vaulted(fake);
    const log = recordCalls(fake);
    // A charge or subscription create an earlier release sent unconverted may already have charged.
    const calls: Array<[() => Promise<unknown>, boolean]> = [
      [() => adapter.createPaymentSession({ amount: 5000, currency: "UGX", idempotencyKey: "a" }), false],
      [
        () => adapter.updatePaymentSession({ pspSessionId: open.id, amount: 5000, currency: "ugx", idempotencyKey: "b" }),
        false,
      ],
      [() => adapter.updatePaymentSession({ pspSessionId: open.id, currency: "UGX", idempotencyKey: "c" }), false],
      [() => adapter.chargeSavedPaymentMethod({ ...vault, amount: 5000, currency: "UGX", idempotencyKey: "d" }), true],
      [
        () =>
          adapter.createNativeSubscription({ ...vault, amount: 5000, currency: "UGX", interval: "month", idempotencyKey: "e" }),
        true,
      ],
      [
        () =>
          adapter.createNativeSubscription({
            ...vault,
            amount: 5000,
            currency: "UGX",
            interval: "month",
            planId: fake.seedPrice({ currency: "ugx" }).id,
            idempotencyKey: "f",
          }),
        true,
      ],
    ];
    for (const [call, sentBefore] of calls) {
      const err = await rejectionOf(call());
      expect(err).toMatchObject({ code: "invalid_request", retryable: false, pspName: "stripe" });
      expect(err.message).toMatch(
        /^The Stripe adapter refuses UGX: Stripe's currencies page lists UGX as a zero-decimal currency and also asks for UGX amounts as two-decimal values ending in 00, so the unit it reads them in is unknown\. Take UGX payments with another provider/,
      );
      expect(err.message.endsWith("before sending another")).toBe(sentBefore);
      expect(err.outcomeUnknown).toBe(sentBefore ? true : undefined);
      expect(err.raw).toEqual({ currency: "UGX", payfanoutExponent: 0 });
    }
    expect(names(log)).toEqual([]);
  });

  it("refuses an amount for a UGX PaymentIntent after reading it, open unless the read shows nothing moved", async () => {
    const { adapter, fake } = makePair();
    const open = await stripeIntent(fake, 5000, "ugx");
    const authorized = await stripeIntent(fake, 5000, "ugx", "authorized");
    const captured = await stripeIntent(fake, 5000, "ugx", "authorized");
    await fake.paymentIntents.capture(captured.id, {});
    const voided = await stripeIntent(fake, 5000, "ugx", "authorized");
    await fake.paymentIntents.cancel(voided.id);
    const paid = await stripeIntent(fake, 5000, "ugx", "succeeded");
    const refunded = await stripeIntent(fake, 5000, "ugx", "succeeded");
    await fake.refunds.create({ payment_intent: refunded.id, amount: 1000 });
    const log = recordCalls(fake);
    const UPDATE = "update: .*\\. Check the Stripe Dashboard for an update under this idempotency key, then cancel it and take the payment with another provider";
    const CAPTURE = "capture: .*\\. Check the Stripe Dashboard for a capture under this idempotency key before capturing it there";
    const REFUND = "refund: .*\\. Check the Stripe Dashboard for a refund under this idempotency key before refunding it there";
    const calls: Array<[() => Promise<unknown>, StripePaymentIntentLike, string, boolean]> = [
      [() => adapter.updatePaymentSession({ pspSessionId: open.id, amount: 6000, idempotencyKey: "a" }), open, UPDATE, true],
      [() => adapter.capturePayment(authorized.id, 1000, "b"), authorized, CAPTURE, false],
      [() => adapter.capturePayment(captured.id, 1000, "b2"), captured, CAPTURE, true],
      [() => adapter.capturePayment(voided.id, 1000, "b3"), voided, CAPTURE, true],
      [() => adapter.refundPayment({ pspPaymentId: paid.id, amount: 1000, idempotencyKey: "c" }), paid, REFUND, false],
      [() => adapter.refundPayment({ pspPaymentId: refunded.id, amount: 1000, idempotencyKey: "c2" }), refunded, REFUND, true],
    ];
    for (const [call, pi, message, outcomeOpen] of calls) {
      log.length = 0;
      const err = await rejectionOf(call());
      expect(err).toMatchObject({ code: "invalid_request", retryable: false, pspName: "stripe" });
      expect(err.outcomeUnknown).toBe(outcomeOpen ? true : undefined);
      expect(err.message).toMatch(new RegExp(`^PaymentIntent ${pi.id} is in UGX, so no amount can be sent for its ${message}$`));
      expect(err.message.includes("unknown. An earlier release sent such requests unconverted. Check")).toBe(outcomeOpen);
      expect(err.message).not.toMatch(/(Capture|Refund) it in the Stripe Dashboard/);
      expect(err.raw).toEqual({ currency: "UGX", payfanoutExponent: 0, record: pi });
      expect(names(log)).toEqual(["paymentIntents.retrieve"]);
    }
  });

  it("refuses to read a UGX record: payments, refunds, subscriptions", async () => {
    const { adapter, fake } = makePair();
    const pi = await stripeIntent(fake, 5000, "ugx", "succeeded");
    const err = await rejectionOf(adapter.retrievePayment(pi.id));
    expect(err).toMatchObject({ code: "unsupported_operation", retryable: false, pspName: "stripe" });
    expect(err.outcomeUnknown).toBeUndefined();
    expect(err.message).toMatch(
      new RegExp(`^PaymentIntent ${pi.id} is in UGX, and its amounts cannot be reported in PayFanout's minor units: .*unknown\\. Read it in the Stripe Dashboard$`),
    );
    expect(err.raw).toEqual({ currency: "UGX", payfanoutExponent: 0, record: pi });

    const refund = fake.seedRefund({ status: "succeeded", amount: 5000, currency: "ugx" });
    const refundErr = await rejectionOf(adapter.retrieveRefund(refund.id));
    expect(refundErr).toMatchObject({ code: "unsupported_operation" });
    expect(refundErr.message).toMatch(new RegExp(`^Refund ${refund.id} is in UGX`));

    const sub = fake.seedSubscription({ currency: "ugx", items: [{ price: fake.seedPrice({ currency: "ugx", unitAmount: 5000 }) }] });
    const subErr = await rejectionOf(adapter.retrieveNativeSubscription({ subscriptionId: sub.id }));
    expect(subErr).toMatchObject({ code: "unsupported_operation" });
    expect(subErr.message).toMatch(new RegExp(`^Subscription ${sub.id} is in UGX`));
  });

  it("lets a call that sends no amount go through, then refuses its answer marked outcomeUnknown", async () => {
    const { adapter, fake } = makePair();
    const open = await stripeIntent(fake, 5000, "ugx");
    const authorized = await stripeIntent(fake, 5000, "ugx", "authorized");
    const cancelable = await stripeIntent(fake, 5000, "ugx", "authorized");
    const paid = await stripeIntent(fake, 5000, "ugx", "succeeded");
    const sub = fake.seedSubscription({ currency: "ugx", items: [{ price: fake.seedPrice({ currency: "ugx", unitAmount: 5000 }) }] });
    const log = recordCalls(fake);
    const calls: Array<[() => Promise<unknown>, string, string, string]> = [
      [() => adapter.capturePayment(authorized.id, undefined, "a"), "paymentIntents.capture", "capture", `PaymentIntent ${authorized.id}`],
      [() => adapter.cancelPayment(cancelable.id, "b"), "paymentIntents.cancel", "cancellation", `PaymentIntent ${cancelable.id}`],
      [() => adapter.refundPayment({ pspPaymentId: paid.id, idempotencyKey: "c" }), "refunds.create", "refund", "Refund re_"],
      [
        () => adapter.updatePaymentSession({ pspSessionId: open.id, metadata: { cart: "2" }, idempotencyKey: "d" }),
        "paymentIntents.update",
        "update",
        `PaymentIntent ${open.id}`,
      ],
      [
        () => adapter.cancelNativeSubscription({ subscriptionId: sub.id, idempotencyKey: "e" }),
        "subscriptions.cancel",
        "cancellation",
        `Subscription ${sub.id}`,
      ],
    ];
    for (const [call, request, action, subject] of calls) {
      log.length = 0;
      const err = await rejectionOf(call());
      expect(names(log)).toEqual([request]);
      expect(err).toMatchObject({ code: "unsupported_operation", retryable: false, pspName: "stripe", outcomeUnknown: true });
      expect(err.message).toMatch(new RegExp(`^Stripe answered the ${action} with ${subject}.*, which is in UGX, `));
      expect(err.message).toMatch(new RegExp(`The ${action} may have taken effect: check ${subject}.* in the Stripe Dashboard$`));
    }
    expect((await fake.paymentIntents.retrieve(authorized.id)).status).toBe("succeeded");
    expect((await fake.paymentIntents.retrieve(cancelable.id)).status).toBe("canceled");
    expect((await fake.subscriptions.retrieve(sub.id)).status).toBe("canceled");

    // A replayed cancel resolves through the re-fetch, and still cannot report the record.
    log.length = 0;
    const replay = await rejectionOf(adapter.cancelNativeSubscription({ subscriptionId: sub.id, idempotencyKey: "e" }));
    expect(names(log)).toEqual(["subscriptions.cancel", "subscriptions.retrieve"]);
    expect(replay).toMatchObject({ code: "unsupported_operation", outcomeUnknown: true });
  });

  it("refuses a currency-only update of a UGX PaymentIntent, whose amount cannot be kept", async () => {
    const { adapter, fake } = makePair();
    const open = await stripeIntent(fake, 5000, "ugx");
    const log = recordCalls(fake);
    const err = await rejectionOf(adapter.updatePaymentSession({ pspSessionId: open.id, currency: "USD", idempotencyKey: "k" }));
    expect(err).toMatchObject({ code: "invalid_request", retryable: false, pspName: "stripe" });
    expect(err.message).toMatch(
      new RegExp(`^PaymentIntent ${open.id} is in UGX, so the amount a currency change keeps cannot be reported .* Send the amount with the currency$`),
    );
    expect(names(log)).toEqual(["paymentIntents.retrieve"]);
  });

  it("creates a subscription whose Price turns out to be in UGX, then refuses its answer marked outcomeUnknown", async () => {
    const { adapter, fake } = makePair();
    const vault = vaulted(fake);
    const price = fake.seedPrice({ currency: "ugx", unitAmount: 5000 });
    const log = recordCalls(fake);
    const err = await rejectionOf(
      adapter.createNativeSubscription({
        ...vault,
        amount: 5000,
        currency: "USD",
        interval: "month",
        planId: price.id,
        idempotencyKey: "s",
      }),
    );
    expect(names(log)).toEqual(["subscriptions.create"]);
    expect(fake.uniqueSubscriptionCreations).toBe(1);
    expect(err).toMatchObject({ code: "unsupported_operation", retryable: false, pspName: "stripe", outcomeUnknown: true });
    expect(err.message).toMatch(
      /^Stripe answered the subscription creation with (Subscription sub_\d+), which is in UGX, .*\. The subscription creation may have taken effect: check \1 in the Stripe Dashboard$/,
    );
  });

  it("leaves a zero-amount verification session alone: a SetupIntent carries no amount or currency", async () => {
    const { adapter, fake } = makePair();
    const log = recordCalls(fake);
    const session = await adapter.createPaymentSession({ amount: 0, currency: "UGX", idempotencyKey: "k" });
    expect(names(log)).toEqual(["setupIntents.create"]);
    expect(session).toMatchObject({ amount: 0, currency: "UGX" });
    expect(session.pspSessionId).toMatch(/^seti_/);
  });

  it("omits the amount of UGX events, keeping the currency and every other field", async () => {
    const { adapter, fake } = makePair();
    const succeeded = await adapter.parseWebhookEvent(
      event("payment_intent.succeeded", { object: "payment_intent", id: "pi_u", amount: 5000, currency: "ugx" }),
    );
    expect(succeeded).toMatchObject({ id: "evt_payment_intent.succeeded", type: "payment.succeeded", pspPaymentId: "pi_u", currency: "UGX" });
    expect(succeeded).not.toHaveProperty("amount");

    const chargeRefunded = stripeEventBodyToUnified({
      id: "evt_cr",
      type: "charge.refunded",
      created: 1,
      data: {
        object: {
          object: "charge",
          id: "ch_u",
          payment_intent: "pi_u",
          amount_refunded: 5000,
          currency: "ugx",
          refunds: { data: [{ id: "re_u" }] },
        },
      },
    });
    expect(chargeRefunded).toMatchObject({ type: "payment.refunded", currency: "UGX", refundId: "re_u" });
    expect(chargeRefunded).not.toHaveProperty("amount");

    const refund = await adapter.parseWebhookEvent(
      event("refund.failed", { object: "refund", id: "re_f", status: "failed", amount: 5000, currency: "ugx" }),
    );
    expect(refund).toMatchObject({ type: "payment.refund_failed", currency: "UGX", refundId: "re_f" });
    expect(refund).not.toHaveProperty("amount");

    fake.seedEvent("payment_intent.processing", { object: "payment_intent", id: "pi_p", amount: 5000, currency: "ugx" });
    const polled = await adapter.fetchEvents();
    expect(polled.events[0]).toMatchObject({ type: "payment.processing", pspPaymentId: "pi_p", currency: "UGX" });
    expect(polled.events[0]).not.toHaveProperty("amount");
  });
});

describe("list pages holding a record whose amounts cannot be reported", () => {
  it("listPayments fails the page whole, naming each record and carrying the cursor it would have had", async () => {
    const { adapter, fake } = makePair();
    const oldest = await stripeIntent(fake, 1000, "usd");
    const ugx = await stripeIntent(fake, 5000, "ugx");
    const isk = await stripeIntent(fake, 150, "isk");
    const newest = await stripeIntent(fake, 2000, "usd");

    const err = await rejectionOf(adapter.listPayments({ limit: 3 }));
    expect(err).toMatchObject({ code: "unsupported_operation", retryable: false, pspName: "stripe" });
    expect(err.outcomeUnknown).toBeUndefined();
    expect(err.message).toMatch(
      new RegExp(`^This page lists PaymentIntents whose amounts cannot be reported in PayFanout's minor units \\(${isk.id} in ISK, ${ugx.id} in UGX\\): .*; the next page starts at cursor ${ugx.id}$`),
    );
    expect(err.raw).toEqual({
      records: [
        { id: isk.id, currency: "ISK", reason: expect.stringMatching(/150 is not a multiple of 100/) as string },
        { id: ugx.id, currency: "UGX", reason: expect.stringMatching(/zero-decimal/) as string },
      ],
      nextCursor: ugx.id,
    });

    const rest = await adapter.listPayments({ limit: 3, cursor: (err.raw as { nextCursor: string }).nextCursor });
    expect(rest.payments.map((p) => p.pspPaymentId)).toEqual([oldest.id]);
    expect(rest.nextCursor).toBeUndefined();
    const first = await adapter.listPayments({ limit: 1 });
    expect(first.payments.map((p) => p.pspPaymentId)).toEqual([newest.id]);

    // The last page has no cursor to carry.
    const whole = await rejectionOf(adapter.listPayments());
    expect(whole.raw).not.toHaveProperty("nextCursor");
    expect(whole.message).not.toMatch(/next page/);
  });

  it("listRefunds fails the page whole the same way", async () => {
    const { adapter, fake } = makePair();
    fake.seedRefund({ status: "succeeded", amount: 1000, currency: "usd", created: 1 });
    const ugx = fake.seedRefund({ status: "succeeded", amount: 5000, currency: "ugx", created: 2 });
    fake.seedRefund({ status: "succeeded", amount: 100_000, currency: "isk", created: 3 });
    const err = await rejectionOf(adapter.listRefunds({ limit: 2 }));
    expect(err).toMatchObject({ code: "unsupported_operation" });
    expect(err.message).toMatch(/^This page lists refunds whose amounts/);
    expect(err.raw).toEqual({
      records: [{ id: ugx.id, currency: "UGX", reason: expect.stringMatching(/zero-decimal/) as string }],
      nextCursor: ugx.id,
    });
    const rest = await adapter.listRefunds({ limit: 2, cursor: ugx.id });
    expect(rest.refunds.map((r) => r.amount)).toEqual([1000]);
  });

  it("listNativeSubscriptions fails the page whole the same way", async () => {
    const { adapter, fake } = makePair();
    fake.seedSubscription({ currency: "usd", created: 1 });
    const ugx = fake.seedSubscription({
      currency: "ugx",
      created: 2,
      items: [{ price: fake.seedPrice({ currency: "ugx", unitAmount: 5000 }) }],
    });
    const err = await rejectionOf(adapter.listNativeSubscriptions({ limit: 1 }));
    expect(err).toMatchObject({ code: "unsupported_operation" });
    expect(err.message).toMatch(/^This page lists subscriptions whose amounts/);
    expect(err.raw).toEqual({
      records: [{ id: ugx.id, currency: "UGX", reason: expect.stringMatching(/zero-decimal/) as string }],
      nextCursor: ugx.id,
    });
    const rest = await adapter.listNativeSubscriptions({ limit: 1, cursor: ugx.id });
    expect(rest.subscriptions.map((s) => s.currency)).toEqual(["USD"]);
  });
});

describe("list pages holding an ISK amount that is not a multiple of 100", () => {
  it("listPayments fails the page when the only odd amount is amount_capturable", async () => {
    const { adapter, fake } = makePair();
    await stripeIntent(fake, 1000, "usd");
    const odd = await stripeIntent(fake, 100_000, "isk", "authorized");
    odd.amount_capturable = 99_950;
    await stripeIntent(fake, 2000, "usd");
    const err = await rejectionOf(adapter.listPayments({ limit: 2 }));
    expect(err).toMatchObject({ code: "unsupported_operation", retryable: false, pspName: "stripe" });
    expect(err.raw).toEqual({
      records: [{ id: odd.id, currency: "ISK", reason: expect.stringMatching(/, and 99950 is not a multiple of 100$/) as string }],
      nextCursor: odd.id,
    });
  });

  it("listRefunds fails the page holding an ISK refund of 150", async () => {
    const { adapter, fake } = makePair();
    fake.seedRefund({ status: "succeeded", amount: 1000, currency: "usd" });
    const odd = fake.seedRefund({ status: "succeeded", amount: 150, currency: "isk" });
    fake.seedRefund({ status: "succeeded", amount: 2000, currency: "usd" });
    const err = await rejectionOf(adapter.listRefunds({ limit: 2 }));
    expect(err).toMatchObject({ code: "unsupported_operation", retryable: false, pspName: "stripe" });
    expect(err.raw).toEqual({
      records: [{ id: odd.id, currency: "ISK", reason: expect.stringMatching(/, and 150 is not a multiple of 100$/) as string }],
      nextCursor: odd.id,
    });
  });

  it("listNativeSubscriptions fails the page holding an installment that is not a multiple of 100", async () => {
    const { adapter, fake } = makePair();
    fake.seedSubscription({ currency: "usd" });
    const odd = fake.seedSubscription({
      currency: "isk",
      items: [{ price: fake.seedPrice({ currency: "isk", unitAmount: 150 }) }],
    });
    fake.seedSubscription({ currency: "usd" });
    const err = await rejectionOf(adapter.listNativeSubscriptions({ limit: 2 }));
    expect(err).toMatchObject({ code: "unsupported_operation", retryable: false, pspName: "stripe" });
    expect(err.raw).toEqual({
      records: [{ id: odd.id, currency: "ISK", reason: expect.stringMatching(/, and 150 is not a multiple of 100$/) as string }],
      nextCursor: odd.id,
    });
  });
});

describe("currency-only updates keep the session's amount in PayFanout's minor units", () => {
  it("always sends the kept amount converted for the new currency", async () => {
    const { adapter, fake } = makePair();
    const usd = await adapter.createPaymentSession({ amount: 1000, currency: "USD", idempotencyKey: "a" });
    const log = recordCalls(fake);
    const toIsk = await adapter.updatePaymentSession({ pspSessionId: usd.pspSessionId, currency: "ISK", idempotencyKey: "b" });
    expect(names(log)).toEqual(["paymentIntents.retrieve", "paymentIntents.update"]);
    expect(log[1]!.args).toEqual([usd.pspSessionId, { amount: 100_000, currency: "isk" }, { idempotencyKey: "b" }]);
    expect(toIsk).toMatchObject({ amount: 1000, currency: "ISK" });

    const backToUsd = await adapter.updatePaymentSession({ pspSessionId: usd.pspSessionId, currency: "USD", idempotencyKey: "c" });
    expect(fake.lastPaymentIntentParams).toEqual({ amount: 1000, currency: "usd" });
    expect(backToUsd).toMatchObject({ amount: 1000, currency: "USD" });

    // Stripe's figure stays 1000, and is sent all the same.
    log.length = 0;
    const toEur = await adapter.updatePaymentSession({ pspSessionId: usd.pspSessionId, currency: "EUR", idempotencyKey: "d" });
    expect(names(log)).toEqual(["paymentIntents.retrieve", "paymentIntents.update"]);
    expect(fake.lastPaymentIntentParams).toEqual({ amount: 1000, currency: "eur" });
    expect(toEur).toMatchObject({ amount: 1000, currency: "EUR" });

    const toMga = await adapter.updatePaymentSession({ pspSessionId: usd.pspSessionId, currency: "MGA", idempotencyKey: "e" });
    expect(fake.lastPaymentIntentParams).toEqual({ amount: 10, currency: "mga" });
    expect(toMga).toMatchObject({ amount: 1000, currency: "MGA" });
  });

  it("sends the same request again when a currency change that went through is retried under its key", async () => {
    const { adapter, fake } = makePair();
    const usd = await adapter.createPaymentSession({ amount: 1000, currency: "USD", idempotencyKey: "a" });
    fake.loseNextAnswer(stripeError({ type: "StripeConnectionError", message: "socket hang up" }));
    const lost = await rejectionOf(adapter.updatePaymentSession({ pspSessionId: usd.pspSessionId, currency: "ISK", idempotencyKey: "b" }));
    expect(lost).toMatchObject({ code: "psp_unavailable", retryable: true });
    expect((await fake.paymentIntents.retrieve(usd.pspSessionId)).currency).toBe("isk");

    const log = recordCalls(fake);
    const retried = await adapter.updatePaymentSession({ pspSessionId: usd.pspSessionId, currency: "ISK", idempotencyKey: "b" });
    expect(log[1]!.args).toEqual([usd.pspSessionId, { amount: 100_000, currency: "isk" }, { idempotencyKey: "b" }]);
    expect(retried).toMatchObject({ amount: 1000, currency: "ISK" });
  });

  it("meets Stripe's refusal of a reused key when the parameters differ", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ amount: 1000, currency: "USD", idempotencyKey: "a" });
    await adapter.updatePaymentSession({ pspSessionId: session.pspSessionId, amount: 1500, idempotencyKey: "b" });
    const err = await rejectionOf(
      adapter.updatePaymentSession({ pspSessionId: session.pspSessionId, amount: 2000, idempotencyKey: "b" }),
    );
    expect(err).toMatchObject({ code: "invalid_request", retryable: false, outcomeUnknown: true });
  });

  it("refuses a kept amount the new currency cannot take, after the read and before the update", async () => {
    const { adapter, fake } = makePair();
    const usd = await adapter.createPaymentSession({ amount: 1055, currency: "USD", idempotencyKey: "a" });
    const log = recordCalls(fake);
    const mga = await rejectionOf(adapter.updatePaymentSession({ pspSessionId: usd.pspSessionId, currency: "MGA", idempotencyKey: "b" }));
    expect(mga).toMatchObject({ code: "invalid_request" });
    expect(mga.outcomeUnknown).toBeUndefined();
    expect(mga.message).toMatch(/the amount the currency change keeps must be a multiple of 100 minor units, got 1055$/);
    expect(names(log)).toEqual(["paymentIntents.retrieve"]);

    const odd = await stripeIntent(fake, 150, "isk");
    const keep = await rejectionOf(adapter.updatePaymentSession({ pspSessionId: odd.id, currency: "USD", idempotencyKey: "d" }));
    expect(keep).toMatchObject({ code: "invalid_request" });
    expect(keep.raw).toMatchObject({ currency: "ISK", stripeAmount: 150, record: odd });
  });
});

describe("same-key retries of a capture or refund that went through", () => {
  it("send the same request again and get Stripe's saved answer", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 1000,
      currency: "ISK",
      captureMethod: "manual",
      idempotencyKey: "a",
    });
    fake.simulateClientConfirm(session.pspSessionId);
    fake.loseNextAnswer(stripeError({ type: "StripeConnectionError", message: "socket hang up" }));
    expect(await rejectionOf(adapter.capturePayment(session.pspSessionId, 600, "cap"))).toMatchObject({
      code: "psp_unavailable",
    });
    const captured = await adapter.capturePayment(session.pspSessionId, 600, "cap");
    expect(captured).toMatchObject({ status: "succeeded", amount: 600, amountCaptured: 600 });

    fake.loseNextAnswer(stripeError({ type: "StripeConnectionError", message: "socket hang up" }));
    const refund = { pspPaymentId: session.pspSessionId, amount: 200, idempotencyKey: "re" };
    expect(await rejectionOf(adapter.refundPayment(refund))).toMatchObject({ code: "psp_unavailable" });
    expect(await adapter.refundPayment(refund)).toMatchObject({ status: "succeeded", amount: 200 });
    expect(fake.uniqueRefundCreations).toBe(1);
    expect((await adapter.retrievePayment(session.pspSessionId)).amountRefunded).toBe(200);
  });
});

describe("three-decimal amounts: the multiple-of-10 rule stays where it ran before", () => {
  it("refuses a KWD amount that is not a multiple of 10 on creation, a named update, charges and subscriptions", async () => {
    const { adapter, fake } = makePair();
    const open = await stripeIntent(fake, 1230, "kwd");
    const vault = vaulted(fake);
    const log = recordCalls(fake);
    for (const call of [
      () => adapter.createPaymentSession({ amount: 1235, currency: "KWD", idempotencyKey: "a" }),
      () => adapter.updatePaymentSession({ pspSessionId: open.id, amount: 1235, currency: "KWD", idempotencyKey: "b" }),
      () => adapter.chargeSavedPaymentMethod({ ...vault, amount: 1235, currency: "KWD", idempotencyKey: "c" }),
      () => adapter.createNativeSubscription({ ...vault, amount: 1235, currency: "KWD", interval: "month", idempotencyKey: "d" }),
    ]) {
      const err = await rejectionOf(call());
      expect(err).toMatchObject({ code: "invalid_request", retryable: false, pspName: "stripe" });
      expect(err.outcomeUnknown).toBeUndefined();
      expect(err.message).toBe("Stripe requires three-decimal KWD amounts to be a multiple of 10 minor units, got 1235");
      expect(err.raw).toEqual({ currency: "KWD", payfanoutExponent: 3, stripeExponent: 3, amount: 1235 });
    }
    expect(names(log)).toEqual([]);
  });

  it("leaves captures, refunds, amount-only updates and a currency change's kept amount to Stripe", async () => {
    const { adapter, fake } = makePair();
    const open = await stripeIntent(fake, 1230, "kwd");
    const authorized = await stripeIntent(fake, 1230, "kwd", "authorized");
    const paid = await stripeIntent(fake, 1230, "kwd", "succeeded");
    const usd = await stripeIntent(fake, 1235, "usd");
    const log = recordCalls(fake);
    await adapter.updatePaymentSession({ pspSessionId: open.id, amount: 1235, idempotencyKey: "a" });
    expect(log.at(-1)!.args[1]).toEqual({ amount: 1235 });
    await adapter.capturePayment(authorized.id, 1225, "b");
    expect(log.at(-1)!.args[1]).toEqual({ amount_to_capture: 1225 });
    await adapter.refundPayment({ pspPaymentId: paid.id, amount: 1225, idempotencyKey: "c" });
    expect(log.at(-1)!.args[0]).toEqual({ payment_intent: paid.id, amount: 1225 });
    await adapter.updatePaymentSession({ pspSessionId: usd.id, currency: "KWD", idempotencyKey: "d" });
    expect(log.at(-1)!.args[1]).toEqual({ amount: 1235, currency: "kwd" });
  });
});

describe("amounts in no known currency pass unchanged", () => {
  it("reports a refund that states no currency as it comes, unless the refund call read the payment's", async () => {
    const { adapter, fake } = makePair();
    const bare = fake.seedRefund({ status: "pending", amount: 150 });
    expect((await adapter.retrieveRefund(bare.id)).amount).toBe(150);

    const session = await adapter.createPaymentSession({ amount: 1000, currency: "ISK", idempotencyKey: "k" });
    fake.simulateClientConfirm(session.pspSessionId);
    const create = fake.refunds.create;
    fake.refunds.create = async (params, opts) => {
      const { currency: _dropped, ...refund } = await create(params, opts);
      return refund;
    };
    const partial = await adapter.refundPayment({ pspPaymentId: session.pspSessionId, amount: 400, idempotencyKey: "r1" });
    expect(partial.amount).toBe(400);
    const rest = await adapter.refundPayment({ pspPaymentId: session.pspSessionId, idempotencyKey: "r2" });
    expect(rest.amount).toBe(60_000);
  });

  it("reads a subscription's units from its first price when it states no currency of its own", async () => {
    const { adapter, fake } = makePair();
    const price = fake.seedPrice({ currency: "isk", unitAmount: 250_000 });
    price.recurring = null;
    const sub = fake.seedSubscription({
      items: [
        { price, quantity: 2 },
        { price: fake.seedPrice({ currency: "isk", unitAmount: 100 }), quantity: null },
      ],
    });
    delete sub.currency;
    const record = await adapter.retrieveNativeSubscription({ subscriptionId: sub.id });
    expect(record).toMatchObject({ amount: 5001, currency: "ISK" });

    const empty = fake.seedSubscription({ currency: "isk" });
    delete empty.items;
    expect(await adapter.retrieveNativeSubscription({ subscriptionId: empty.id })).toMatchObject({ amount: 0, currency: "ISK" });
  });

  it("sends an amount unchanged for a PaymentIntent whose currency is no currency code", async () => {
    const { adapter, fake } = makePair();
    const odd = await stripeIntent(fake, 1000, "", "authorized");
    const log = recordCalls(fake);
    const captured = await adapter.capturePayment(odd.id, 400, "k");
    expect(log[1]!.args[1]).toEqual({ amount_to_capture: 400 });
    expect(captured.amount).toBe(400);
  });

  it("reports a listed PaymentIntent without the optional amounts Stripe left off", async () => {
    const { adapter, fake } = makePair();
    const pi = await stripeIntent(fake, 100_000, "isk");
    delete pi.amount_received;
    delete pi.amount_capturable;
    const page = await adapter.listPayments();
    expect(page.payments[0]).toMatchObject({ amount: 1000, amountRefunded: 0 });
    expect(page.payments[0]).not.toHaveProperty("amountCaptured");
    expect(page.payments[0]).not.toHaveProperty("amountCapturable");
  });

  it("keeps an event amount as delivered when the object states no currency code", async () => {
    const { adapter } = makePair();
    const none = await adapter.parseWebhookEvent(
      event("payment_intent.succeeded", { object: "payment_intent", id: "pi_n", amount: 100_000 }),
    );
    expect(none.amount).toBe(100_000);
    expect(none).not.toHaveProperty("currency");
    const malformed = await adapter.parseWebhookEvent(
      event("payment_intent.succeeded", { object: "payment_intent", id: "pi_m", amount: 150, currency: "is" }),
    );
    expect(malformed).toMatchObject({ amount: 150, currency: "IS" });
  });
});
