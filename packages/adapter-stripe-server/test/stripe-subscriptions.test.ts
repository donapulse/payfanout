import { describe, expect, it } from "vitest";
import { isPayFanoutError, type NativeSubscriptionStatus } from "@payfanout/core";
import { StripeServerAdapter, type StripeServerAdapterConfig } from "../src/index.js";
import { FakeStripe, stripeError } from "./fake-stripe.js";

const NOW_MS = Date.parse("2026-07-04T12:00:00Z");

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

/** Customer + attached vaulted instrument, as a prior save-during-checkout would leave them. */
function seedVaulted(fake: FakeStripe, behavior?: "auth_required" | "declined"): { customerId: string; pmId: string } {
  const customer = fake.seedCustomer();
  const pm = fake.seedPaymentMethod(customer.id, behavior ? { behavior } : {});
  return { customerId: customer.id, pmId: pm.id };
}

describe("Stripe native subscription capability declaration", () => {
  it("declares every operation of the Billing surface", () => {
    const { adapter } = makePair();
    expect(adapter.getCapabilities().nativeSubscriptions).toEqual({
      list: true,
      retrieve: true,
      create: true,
      cancel: true,
    });
  });
});

describe("Stripe createNativeSubscription", () => {
  it("creates a product + inline price_data when no planId is given, and maps the record", async () => {
    const { adapter, fake } = makePair();
    const { customerId, pmId } = seedVaulted(fake);
    const record = await adapter.createNativeSubscription({
      pspCustomerId: customerId,
      savedPaymentMethodToken: pmId,
      amount: 2599,
      currency: "USD",
      interval: "month",
      intervalCount: 3,
      merchantRefNum: "plan-gold-3m",
      metadata: { tier: "gold" },
      idempotencyKey: "nsub-1",
    });

    expect(fake.lastProductParams).toEqual({ name: "plan-gold-3m" });
    expect(fake.lastSubscriptionParams).toMatchObject({
      customer: customerId,
      default_payment_method: pmId,
      off_session: true,
      payment_behavior: "error_if_incomplete",
      metadata: { tier: "gold", payfanout_merchant_ref: "plan-gold-3m" },
    });
    const item = (fake.lastSubscriptionParams?.["items"] as Array<Record<string, unknown>>)[0]!;
    expect(item["price_data"]).toMatchObject({
      currency: "usd",
      unit_amount: 2599,
      recurring: { interval: "month", interval_count: 3 },
    });
    expect((item["price_data"] as Record<string, unknown>)["product"]).toMatch(/^prod_/);
    expect(fake.lastSubscriptionParams).not.toHaveProperty("billing_cycle_anchor");
    expect(fake.lastSubscriptionParams).not.toHaveProperty("proration_behavior");

    expect(record).toMatchObject({
      pspName: "stripe",
      status: "active",
      amount: 2599,
      currency: "USD",
      interval: "month",
      intervalCount: 3,
      savedPaymentMethodToken: pmId,
      pspCustomerId: customerId,
      merchantRefNum: "plan-gold-3m",
    });
    expect(record.id).toMatch(/^sub_/);
    expect(record.planId).toMatch(/^price_/);
    expect(Number.isNaN(Date.parse(record.currentPeriodStart!))).toBe(false);
    expect(Number.isNaN(Date.parse(record.currentPeriodEnd!))).toBe(false);
    expect(record.raw).toBeDefined();
  });

  it("names the on-the-fly product 'Subscription' when no merchantRefNum is given", async () => {
    const { adapter, fake } = makePair();
    const { customerId, pmId } = seedVaulted(fake);
    await adapter.createNativeSubscription({
      pspCustomerId: customerId,
      savedPaymentMethodToken: pmId,
      amount: 500,
      currency: "USD",
      interval: "week",
      idempotencyKey: "nsub-name",
    });
    expect(fake.lastProductParams).toEqual({ name: "Subscription" });
  });

  it("bills an existing Price when planId is given — the price's own facts win on the record", async () => {
    const { adapter, fake } = makePair();
    const { customerId, pmId } = seedVaulted(fake);
    const price = fake.seedPrice({ currency: "eur", unitAmount: 2500, interval: "year" });
    const record = await adapter.createNativeSubscription({
      pspCustomerId: customerId,
      savedPaymentMethodToken: pmId,
      amount: 999, // what the caller believed — the wire truth is the price
      currency: "EUR",
      interval: "month",
      planId: price.id,
      idempotencyKey: "nsub-plan",
    });
    expect(fake.uniqueProductCreations).toBe(0);
    expect((fake.lastSubscriptionParams?.["items"] as Array<Record<string, unknown>>)[0]).toEqual({ price: price.id });
    expect(record.amount).toBe(2500);
    expect(record.currency).toBe("EUR");
    expect(record.interval).toBe("year");
    expect(record.planId).toBe(price.id);
  });

  it("maps startAt to a future billing_cycle_anchor with prorations disabled (free until the anchor)", async () => {
    const { adapter, fake } = makePair();
    const { customerId, pmId } = seedVaulted(fake);
    const startAt = "2026-08-01T00:00:00Z";
    const record = await adapter.createNativeSubscription({
      pspCustomerId: customerId,
      savedPaymentMethodToken: pmId,
      amount: 1200,
      currency: "USD",
      interval: "month",
      startAt,
      idempotencyKey: "nsub-anchor",
    });
    expect(fake.lastSubscriptionParams).toMatchObject({
      billing_cycle_anchor: Date.parse(startAt) / 1000,
      proration_behavior: "none",
    });
    expect(record.currentPeriodEnd).toBe(new Date(startAt).toISOString());
  });

  it("rejects invalid cadences locally: schedule, missing interval, bad intervalCount", async () => {
    const { adapter, fake } = makePair();
    const { customerId, pmId } = seedVaulted(fake);
    const base = {
      pspCustomerId: customerId,
      savedPaymentMethodToken: pmId,
      amount: 1000,
      currency: "USD",
      idempotencyKey: "k",
    };
    // Stripe prices know day/week/month/year only — an RRULE cannot be expressed faithfully.
    await expect(
      adapter.createNativeSubscription({ ...base, schedule: "FREQ=MONTHLY;BYMONTHDAY=1" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/RRULE/) as string });
    await expect(adapter.createNativeSubscription(base)).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/interval/) as string,
    });
    await expect(
      adapter.createNativeSubscription({ ...base, interval: "month", intervalCount: 0 }),
    ).rejects.toThrowError(/intervalCount/);
    await expect(
      adapter.createNativeSubscription({ ...base, interval: "month", intervalCount: 1.5 }),
    ).rejects.toThrowError(/intervalCount/);
    expect(fake.lastSubscriptionParams).toBeUndefined(); // nothing reached Stripe
  });

  it("requires pspCustomerId and a positive amount, and keeps the three-decimal rule", async () => {
    const { adapter, fake } = makePair();
    const { customerId, pmId } = seedVaulted(fake);
    await expect(
      adapter.createNativeSubscription({
        savedPaymentMethodToken: pmId,
        amount: 1000,
        currency: "USD",
        interval: "month",
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/pspCustomerId/) as string });
    await expect(
      adapter.createNativeSubscription({
        pspCustomerId: customerId,
        savedPaymentMethodToken: pmId,
        amount: 0,
        currency: "USD",
        interval: "month",
        idempotencyKey: "k",
      }),
    ).rejects.toThrowError(/positive amount/);
    await expect(
      adapter.createNativeSubscription({
        pspCustomerId: customerId,
        savedPaymentMethodToken: pmId,
        amount: 1234,
        currency: "BHD",
        interval: "month",
        idempotencyKey: "k",
      }),
    ).rejects.toThrowError(/multiple of 10/);
    await expect(
      adapter.createNativeSubscription({
        pspCustomerId: customerId,
        savedPaymentMethodToken: pmId,
        amount: 1000,
        currency: "USD",
        interval: "month",
        startAt: "not-a-date",
        idempotencyKey: "k",
      }),
    ).rejects.toThrowError(/ISO 8601/);
    expect(fake.lastSubscriptionParams).toBeUndefined();
  });

  it("surfaces first-invoice failures as unified card errors — no incomplete subscription is left behind", async () => {
    const { adapter, fake } = makePair();
    const declined = seedVaulted(fake, "declined");
    await expect(
      adapter.createNativeSubscription({
        pspCustomerId: declined.customerId,
        savedPaymentMethodToken: declined.pmId,
        amount: 1000,
        currency: "USD",
        interval: "month",
        idempotencyKey: "nsub-declined",
      }),
    ).rejects.toMatchObject({ code: "insufficient_funds", retryable: false });

    const auth = seedVaulted(fake, "auth_required");
    await expect(
      adapter.createNativeSubscription({
        pspCustomerId: auth.customerId,
        savedPaymentMethodToken: auth.pmId,
        amount: 1000,
        currency: "USD",
        interval: "month",
        idempotencyKey: "nsub-auth",
      }),
    ).rejects.toMatchObject({ code: "authentication_required", retryable: false });
    expect(fake.uniqueSubscriptionCreations).toBe(0);
  });

  it("rejects unknown customers and detached instruments with the mapped Stripe error", async () => {
    const { adapter, fake } = makePair();
    const { customerId } = seedVaulted(fake);
    const stray = fake.seedPaymentMethod(null); // vaulted nowhere
    await expect(
      adapter.createNativeSubscription({
        pspCustomerId: "cus_missing",
        savedPaymentMethodToken: "pm_any",
        amount: 1000,
        currency: "USD",
        interval: "month",
        idempotencyKey: "k1",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      adapter.createNativeSubscription({
        pspCustomerId: customerId,
        savedPaymentMethodToken: stray.id,
        amount: 1000,
        currency: "USD",
        interval: "month",
        idempotencyKey: "k2",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("replays idempotently: same key -> same subscription, one product and one subscription created", async () => {
    const { adapter, fake } = makePair();
    const { customerId, pmId } = seedVaulted(fake);
    const input = {
      pspCustomerId: customerId,
      savedPaymentMethodToken: pmId,
      amount: 3000,
      currency: "USD",
      interval: "month" as const,
      idempotencyKey: "nsub-idem",
    };
    const first = await adapter.createNativeSubscription(input);
    const second = await adapter.createNativeSubscription(input);
    expect(second.id).toBe(first.id);
    expect(fake.uniqueSubscriptionCreations).toBe(1);
    expect(fake.uniqueProductCreations).toBe(1);
  });
});

describe("Stripe listNativeSubscriptions", () => {
  it("walks pages newest-first with limit + nextCursor until exhaustion", async () => {
    const { adapter, fake } = makePair();
    const { customerId, pmId } = seedVaulted(fake);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const record = await adapter.createNativeSubscription({
        pspCustomerId: customerId,
        savedPaymentMethodToken: pmId,
        amount: 1000 + i,
        currency: "USD",
        interval: "month",
        idempotencyKey: `nsub-page-${i}`,
      });
      ids.push(record.id);
    }
    const walked: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await adapter.listNativeSubscriptions({ limit: 1, ...(cursor ? { cursor } : {}) });
      expect(page.subscriptions.length).toBe(1);
      walked.push(page.subscriptions[0]!.id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(walked).toEqual([...ids].reverse()); // newest first
  });

  it("returns Stripe's default listing: canceled subscriptions are excluded", async () => {
    const { adapter, fake } = makePair();
    const { customerId, pmId } = seedVaulted(fake);
    const keep = await adapter.createNativeSubscription({
      pspCustomerId: customerId,
      savedPaymentMethodToken: pmId,
      amount: 1000,
      currency: "USD",
      interval: "month",
      idempotencyKey: "nsub-keep",
    });
    const gone = await adapter.createNativeSubscription({
      pspCustomerId: customerId,
      savedPaymentMethodToken: pmId,
      amount: 2000,
      currency: "USD",
      interval: "month",
      idempotencyKey: "nsub-gone",
    });
    await adapter.cancelNativeSubscription({ subscriptionId: gone.id, idempotencyKey: "cancel-gone" });
    const page = await adapter.listNativeSubscriptions();
    expect(page.subscriptions.map((s) => s.id)).toEqual([keep.id]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("returns an empty page cleanly", async () => {
    const { adapter } = makePair();
    await expect(adapter.listNativeSubscriptions()).resolves.toEqual({ subscriptions: [] });
  });
});

describe("Stripe retrieveNativeSubscription", () => {
  it("retrieves by id — savedPaymentMethodToken is not needed and ignored", async () => {
    const { adapter, fake } = makePair();
    const sub = fake.seedSubscription({ metadata: { payfanout_merchant_ref: "ref-9" } });
    const record = await adapter.retrieveNativeSubscription({
      subscriptionId: sub.id,
      savedPaymentMethodToken: "pm_ignored",
    });
    expect(record.id).toBe(sub.id);
    expect(record.pspName).toBe("stripe");
    expect(record.merchantRefNum).toBe("ref-9");
  });

  it("maps a missing subscription to invalid_request with raw preserved", async () => {
    const { adapter } = makePair();
    try {
      await adapter.retrieveNativeSubscription({ subscriptionId: "sub_missing" });
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

describe("Stripe subscription status mapping", () => {
  // Every documented wire status maps deliberately; anything else is "unknown".
  const cases: Array<[string, NativeSubscriptionStatus]> = [
    ["incomplete", "pending"], // awaiting the first successful invoice payment
    ["incomplete_expired", "canceled"], // 23h window lapsed — terminal, never billed
    ["trialing", "trialing"],
    ["active", "active"],
    ["past_due", "past_due"],
    ["unpaid", "past_due"], // collection stopped, still owed — awaiting intervention
    ["canceled", "canceled"],
    ["paused", "paused"],
    ["some_future_status", "unknown"],
  ];
  for (const [wire, unified] of cases) {
    it(`maps "${wire}" to "${unified}"`, async () => {
      const { adapter, fake } = makePair();
      const sub = fake.seedSubscription({ status: wire });
      const record = await adapter.retrieveNativeSubscription({ subscriptionId: sub.id });
      expect(record.status).toBe(unified);
    });
  }
});

describe("Stripe cancelNativeSubscription (verified-idempotent)", () => {
  it("cancels a live subscription immediately", async () => {
    const { adapter, fake } = makePair();
    const { customerId, pmId } = seedVaulted(fake);
    const created = await adapter.createNativeSubscription({
      pspCustomerId: customerId,
      savedPaymentMethodToken: pmId,
      amount: 1000,
      currency: "USD",
      interval: "month",
      idempotencyKey: "nsub-c",
    });
    const canceled = await adapter.cancelNativeSubscription({
      subscriptionId: created.id,
      idempotencyKey: "cancel-1",
    });
    expect(canceled.status).toBe("canceled");
    expect(canceled.id).toBe(created.id);
  });

  it("treats a cancel of an already-canceled subscription as success via the re-fetch path", async () => {
    const { adapter, fake } = makePair();
    // The fake's cancel REJECTS on a canceled subscription (as real Stripe
    // does) — resolving here proves the rejection -> re-fetch -> success path.
    const sub = fake.seedSubscription({ status: "canceled" });
    const record = await adapter.cancelNativeSubscription({ subscriptionId: sub.id, idempotencyKey: "cancel-again" });
    expect(record.status).toBe("canceled");
    expect(record.id).toBe(sub.id);
  });

  it("rethrows the original mapped error when the re-fetch shows a live subscription", async () => {
    const { adapter, fake } = makePair();
    const sub = fake.seedSubscription({ status: "active" });
    fake.failNextWith(stripeError({ type: "StripeAPIError", statusCode: 503, message: "cancel exploded" }));
    try {
      await adapter.cancelNativeSubscription({ subscriptionId: sub.id, idempotencyKey: "cancel-503" });
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("psp_unavailable"); // the CANCEL error, not a re-fetch artifact
        expect(err.retryable).toBe(true);
      }
    }
  });

  it("maps a missing subscription to invalid_request (cancel and re-fetch both 404)", async () => {
    const { adapter } = makePair();
    await expect(
      adapter.cancelNativeSubscription({ subscriptionId: "sub_missing", idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("Stripe subscription mapping edges", () => {
  it("falls back to item-level billing periods (2025-03-31.basil moved them off the subscription)", async () => {
    const { adapter, fake } = makePair();
    const sub = fake.seedSubscription({ periodsOnItems: true, created: 1_780_100_000 });
    const record = await adapter.retrieveNativeSubscription({ subscriptionId: sub.id });
    expect(record.currentPeriodStart).toBe(new Date(1_780_100_000 * 1000).toISOString());
    expect(record.currentPeriodEnd).toBe(new Date((1_780_100_000 + 2_592_000) * 1000).toISOString());
  });

  it("sums unit_amount x quantity across items for the per-installment amount", async () => {
    const { adapter, fake } = makePair();
    const sub = fake.seedSubscription({
      items: [
        { price: fake.seedPrice({ unitAmount: 1000 }), quantity: 2 },
        { price: fake.seedPrice({ unitAmount: 250 }) },
      ],
    });
    const record = await adapter.retrieveNativeSubscription({ subscriptionId: sub.id });
    expect(record.amount).toBe(2250);
  });

  it("reports 0 for tiered/custom prices (unit_amount null) instead of inventing an installment", async () => {
    const { adapter, fake } = makePair();
    const price = fake.seedPrice({ unitAmount: null });
    const sub = fake.seedSubscription({ items: [{ price }] });
    const record = await adapter.retrieveNativeSubscription({ subscriptionId: sub.id });
    expect(record.amount).toBe(0);
    expect(record.planId).toBe(price.id);
    expect(record.raw).toBeDefined();
  });

  it("excludes metered items from the amount — usage billing has no fixed installment", async () => {
    const { adapter, fake } = makePair();
    const sub = fake.seedSubscription({
      items: [
        { price: fake.seedPrice({ unitAmount: 1500 }) }, // licensed base fee
        { price: fake.seedPrice({ unitAmount: 3, usageType: "metered" }), quantity: null },
      ],
    });
    const record = await adapter.retrieveNativeSubscription({ subscriptionId: sub.id });
    expect(record.amount).toBe(1500);
  });

  it("omits savedPaymentMethodToken when the subscription bills the customer default", async () => {
    const { adapter, fake } = makePair();
    const sub = fake.seedSubscription({ defaultPaymentMethod: null });
    const record = await adapter.retrieveNativeSubscription({ subscriptionId: sub.id });
    expect(record.savedPaymentMethodToken).toBeUndefined();
  });

  it("omits the interval rather than guessing when the price cadence is unrecognizable", async () => {
    const { adapter, fake } = makePair();
    const sub = fake.seedSubscription({ items: [{ price: fake.seedPrice({ interval: "quarter" }) }] });
    const record = await adapter.retrieveNativeSubscription({ subscriptionId: sub.id });
    expect(record.interval).toBeUndefined();
    expect(record.intervalCount).toBeUndefined();
  });
});

describe("Stripe error path on subscription surfaces", () => {
  it("wraps SDK failures from list/retrieve/create into PayFanoutErrors with raw preserved", async () => {
    const { adapter, fake } = makePair();
    const { customerId, pmId } = seedVaulted(fake);
    for (const call of [
      () => adapter.listNativeSubscriptions(),
      () => adapter.retrieveNativeSubscription({ subscriptionId: "sub_x" }),
      () =>
        adapter.createNativeSubscription({
          pspCustomerId: customerId,
          savedPaymentMethodToken: pmId,
          amount: 1000,
          currency: "USD",
          interval: "month",
          idempotencyKey: `k-${Math.random()}`,
        }),
    ]) {
      fake.failNextWith(stripeError({ type: "StripeRateLimitError", statusCode: 429, message: "slow down" }));
      try {
        await call();
        expect.unreachable("expected rejection");
      } catch (err) {
        expect(isPayFanoutError(err)).toBe(true);
        if (isPayFanoutError(err)) {
          expect(err.code).toBe("rate_limited");
          expect(err.retryable).toBe(true);
          expect(err.raw).toBeDefined();
        }
      }
    }
  });
});
