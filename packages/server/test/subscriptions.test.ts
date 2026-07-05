import { describe, expect, it } from "vitest";
import { PayFanoutError, type ChargeSavedPaymentMethodInput, type PaymentInfo } from "@payfanout/core";
import {
  addInterval,
  InMemorySubscriptionStore,
  PaymentService,
  SubscriptionManager,
  type SubscriptionEvent,
  type SubscriptionManagerOptions,
} from "../src/index.js";
import { FakeAdapter, makePaymentInfo } from "./fake-adapter.js";

const T0 = Date.parse("2026-01-31T10:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Scripted charging harness: control every charge outcome, capture every input. */
function harness(options: Partial<SubscriptionManagerOptions> = {}): {
  manager: SubscriptionManager;
  store: InMemorySubscriptionStore;
  charges: ChargeSavedPaymentMethodInput[];
  clock: { now: number };
  events: SubscriptionEvent[];
  scriptNext: (outcome: "ok" | "declined" | "psp_down") => void;
} {
  const adapter = new FakeAdapter({ capabilities: { supportsSavedPaymentMethods: true } });
  const charges: ChargeSavedPaymentMethodInput[] = [];
  const script: Array<"ok" | "declined" | "psp_down"> = [];
  adapter.chargeSavedPaymentMethod = async (input): Promise<PaymentInfo> => {
    charges.push(input);
    const outcome = script.shift() ?? "ok";
    if (outcome === "declined") {
      throw new PayFanoutError({ code: "card_declined", message: "Declined.", retryable: false });
    }
    if (outcome === "psp_down") {
      throw new PayFanoutError({ code: "psp_unavailable", message: "Down.", retryable: true });
    }
    return makePaymentInfo({
      pspName: "fake",
      pspPaymentId: `pay_${charges.length}`,
      amount: input.amount,
      currency: input.currency,
    });
  };
  const service = new PaymentService({ adapters: [adapter] });
  const store = new InMemorySubscriptionStore();
  const clock = { now: T0 };
  const events: SubscriptionEvent[] = [];
  const manager = new SubscriptionManager({
    service,
    store,
    now: () => clock.now,
    onEvent: (event) => {
      events.push(event);
    },
    generateId: () => `sub_gen_${events.length}`,
    ...options,
  });
  return { manager, store, charges, clock, events, scriptNext: (o) => script.push(o) };
}

const PLAN = { amount: 2500, currency: "usd", interval: "month" as const };

const create = (m: SubscriptionManager, overrides: Record<string, unknown> = {}) =>
  m.createSubscription({
    pspName: "fake",
    pspCustomerId: "cust_1",
    savedPaymentMethodToken: "tok_saved",
    plan: PLAN,
    id: "sub_1",
    idempotencyKey: "first-charge-key",
    ...overrides,
  });

describe("addInterval (calendar-safe period math)", () => {
  it("clamps month-end anchors instead of skipping months", () => {
    expect(addInterval("2026-01-31T10:00:00.000Z", "month", 1)).toBe("2026-02-28T10:00:00.000Z");
    expect(addInterval("2024-01-31T10:00:00.000Z", "month", 1)).toBe("2024-02-29T10:00:00.000Z"); // leap
    expect(addInterval("2026-03-31T10:00:00.000Z", "month", 1)).toBe("2026-04-30T10:00:00.000Z");
    expect(addInterval("2026-01-15T10:00:00.000Z", "month", 1)).toBe("2026-02-15T10:00:00.000Z");
  });

  it("handles year wrap, multi-counts, weeks, days — preserving time of day", () => {
    expect(addInterval("2026-11-30T23:59:59.000Z", "month", 3)).toBe("2027-02-28T23:59:59.000Z");
    expect(addInterval("2026-02-28T08:30:00.000Z", "year", 1)).toBe("2027-02-28T08:30:00.000Z");
    expect(addInterval("2024-02-29T08:30:00.000Z", "year", 1)).toBe("2025-02-28T08:30:00.000Z");
    expect(addInterval("2026-01-01T00:00:00.000Z", "week", 2)).toBe("2026-01-15T00:00:00.000Z");
    expect(addInterval("2026-01-01T12:00:00.000Z", "day", 10)).toBe("2026-01-11T12:00:00.000Z");
  });

  it("rejects garbage dates", () => {
    expect(() => addInterval("not-a-date", "month", 1)).toThrowError(/Invalid period start/);
  });
});

describe("createSubscription", () => {
  it("charges the first period immediately as a customer-present 'initial' charge", async () => {
    const { manager, charges, events } = harness();
    const { subscription, payment } = await create(manager);

    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({
      pspCustomerId: "cust_1",
      savedPaymentMethodToken: "tok_saved",
      amount: 2500,
      currency: "USD",
      occurrence: "initial",
      idempotencyKey: "first-charge-key",
    });
    expect(charges[0]!.metadata).toMatchObject({ payfanout_subscription_id: "sub_1" });

    expect(payment?.pspPaymentId).toBe("pay_1");
    expect(subscription).toMatchObject({
      id: "sub_1",
      status: "active",
      currentPeriodStart: "2026-01-31T10:00:00.000Z",
      currentPeriodEnd: "2026-02-28T10:00:00.000Z", // month-end clamp
      failedAttempts: 0,
      cancelAtPeriodEnd: false,
      lastPaymentId: "pay_1",
    });
    expect(events.map((e) => e.type)).toEqual(["subscription.created", "subscription.charged"]);
  });

  it("a failed first charge throws and persists NOTHING", async () => {
    const { manager, store, scriptNext } = harness();
    scriptNext("declined");
    await expect(create(manager)).rejects.toMatchObject({ code: "card_declined" });
    expect(await store.get("sub_1")).toBeUndefined();
  });

  it("future startAt = trial: no charge now, first charge when due", async () => {
    const { manager, charges, clock } = harness();
    const { subscription, payment } = await create(manager, {
      startAt: new Date(T0 + 14 * DAY),
    });
    expect(payment).toBeUndefined();
    expect(charges).toHaveLength(0);
    expect(subscription.currentPeriodEnd).toBe(new Date(T0 + 14 * DAY).toISOString());

    clock.now = T0 + 13 * DAY;
    expect((await manager.chargeDueSubscriptions()).charged).toHaveLength(0);

    clock.now = T0 + 14 * DAY + 1;
    const run = await manager.chargeDueSubscriptions();
    expect(run.charged).toHaveLength(1);
    expect(charges[0]!.occurrence).toBe("recurring");
  });

  it("validates plans and duplicate ids eagerly", async () => {
    const { manager } = harness();
    await expect(create(manager, { plan: { ...PLAN, amount: 0 } })).rejects.toThrowError(/positive/);
    await expect(create(manager, { plan: { ...PLAN, amount: 10.5 } })).rejects.toThrowError(/minor units/);
    await expect(create(manager, { plan: { ...PLAN, intervalCount: 0 } })).rejects.toThrowError(/intervalCount/);
    await expect(create(manager, { plan: { ...PLAN, interval: "fortnight" as never } })).rejects.toThrowError(/interval/);
    await create(manager);
    await expect(create(manager)).rejects.toThrowError(/already exists/);
  });
});

describe("renewals", () => {
  it("does nothing before the period ends; renews once due, anchored on the period end", async () => {
    const { manager, charges, clock } = harness();
    await create(manager);
    charges.length = 0;

    clock.now = Date.parse("2026-02-27T10:00:00.000Z");
    expect((await manager.chargeDueSubscriptions()).charged).toHaveLength(0);

    // The cron fires LATE — the next anchor must not drift.
    clock.now = Date.parse("2026-03-02T22:00:00.000Z");
    const run = await manager.chargeDueSubscriptions();
    expect(run.charged).toHaveLength(1);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({
      occurrence: "recurring",
      idempotencyKey: "payfanout-sub-sub_1-2026-02-28T10:00:00.000Z-a0",
    });
    const renewed = await manager.retrieveSubscription("sub_1");
    expect(renewed.currentPeriodStart).toBe("2026-02-28T10:00:00.000Z");
    expect(renewed.currentPeriodEnd).toBe("2026-03-28T10:00:00.000Z"); // from period end, not from "now"
  });

  it("catchUpLimit 1 (default) collects one overdue period per run", async () => {
    const { manager, charges, clock } = harness();
    await create(manager);
    charges.length = 0;
    clock.now = Date.parse("2026-05-15T00:00:00.000Z"); // ~3 periods overdue

    expect((await manager.chargeDueSubscriptions()).charged).toHaveLength(1);
    expect((await manager.chargeDueSubscriptions()).charged).toHaveLength(1);
    expect(charges).toHaveLength(2); // one per run — never a surprise multi-charge
  });

  it("a raised catchUpLimit collects sequential periods in one run, correctly anchored", async () => {
    const { manager, charges, clock } = harness({ catchUpLimit: 12 });
    await create(manager);
    charges.length = 0;
    clock.now = Date.parse("2026-05-15T00:00:00.000Z");

    const run = await manager.chargeDueSubscriptions();
    expect(run.charged).toHaveLength(3); // Feb 28, Mar 28, Apr 28 anchors all collected
    expect(charges.map((c) => c.idempotencyKey)).toEqual([
      "payfanout-sub-sub_1-2026-02-28T10:00:00.000Z-a0",
      "payfanout-sub-sub_1-2026-03-28T10:00:00.000Z-a0",
      "payfanout-sub-sub_1-2026-04-28T10:00:00.000Z-a0",
    ]);
    const record = await manager.retrieveSubscription("sub_1");
    expect(record.currentPeriodEnd).toBe("2026-05-28T10:00:00.000Z"); // paid through — no longer due
  });
});

describe("dunning (failed renewals)", () => {
  it("failure -> past_due with backoff; retry uses a FRESH idempotency key; success recovers", async () => {
    const { manager, charges, clock, events, scriptNext } = harness();
    await create(manager);
    charges.length = 0;
    events.length = 0;

    clock.now = Date.parse("2026-02-28T10:00:01.000Z");
    scriptNext("declined");
    const failRun = await manager.chargeDueSubscriptions();
    expect(failRun.failed).toHaveLength(1);
    let record = await manager.retrieveSubscription("sub_1");
    expect(record).toMatchObject({
      status: "past_due",
      failedAttempts: 1,
      nextRetryAt: new Date(clock.now + 24 * HOUR).toISOString(),
      lastError: { code: "card_declined" },
    });
    expect(events.map((e) => e.type)).toEqual(["subscription.charge_failed", "subscription.past_due"]);

    // Still cooling down -> no charge attempt at all.
    clock.now += 23 * HOUR;
    await manager.chargeDueSubscriptions();
    expect(charges).toHaveLength(1);

    // Backoff elapsed -> retry with attempt-scoped key (a1, not a0 — a0 would
    // replay the PSP-cached failure).
    clock.now += 2 * HOUR;
    const recoverRun = await manager.chargeDueSubscriptions();
    expect(recoverRun.charged).toHaveLength(1);
    expect(charges[1]!.idempotencyKey).toBe("payfanout-sub-sub_1-2026-02-28T10:00:00.000Z-a1");
    record = await manager.retrieveSubscription("sub_1");
    expect(record.status).toBe("active");
    expect(record.failedAttempts).toBe(0);
    expect(record.nextRetryAt).toBeUndefined();
    expect(record.lastError).toBeUndefined();
    expect(record.currentPeriodEnd).toBe("2026-03-28T10:00:00.000Z"); // anchor preserved through dunning
  });

  it("exhausting the retry schedule cancels the subscription", async () => {
    const { manager, clock, events, scriptNext } = harness({ retryDelaysHours: [24, 72] });
    await create(manager);
    events.length = 0;

    clock.now = Date.parse("2026-02-28T10:00:01.000Z");
    scriptNext("declined");
    await manager.chargeDueSubscriptions(); // attempt 1 -> past_due (+24h)
    clock.now += 25 * HOUR;
    scriptNext("psp_down");
    await manager.chargeDueSubscriptions(); // attempt 2 -> past_due (+72h)
    expect((await manager.retrieveSubscription("sub_1")).failedAttempts).toBe(2);

    clock.now += 73 * HOUR;
    scriptNext("declined");
    const finalRun = await manager.chargeDueSubscriptions(); // attempt 3 -> schedule exhausted
    expect(finalRun.canceled).toHaveLength(1);
    const record = await manager.retrieveSubscription("sub_1");
    expect(record.status).toBe("canceled");
    expect(record.canceledAt).toBeDefined();
    expect(events.map((e) => e.type)).toEqual([
      "subscription.charge_failed",
      "subscription.past_due",
      "subscription.charge_failed",
      "subscription.past_due",
      "subscription.charge_failed",
      "subscription.canceled",
    ]);
  });
});

describe("cancellation", () => {
  it("immediate cancel stops renewals now; canceling again is a no-op", async () => {
    const { manager, charges, clock, events } = harness();
    await create(manager);
    charges.length = 0;
    events.length = 0;

    const canceled = await manager.cancelSubscription("sub_1");
    expect(canceled.status).toBe("canceled");
    expect(canceled.canceledAt).toBe(new Date(T0).toISOString());
    await manager.cancelSubscription("sub_1"); // idempotent
    expect(events.filter((e) => e.type === "subscription.canceled")).toHaveLength(1);

    clock.now = Date.parse("2026-06-01T00:00:00.000Z");
    await manager.chargeDueSubscriptions();
    expect(charges).toHaveLength(0);
  });

  it("atPeriodEnd lets the paid window run out, then ends WITHOUT charging", async () => {
    const { manager, charges, clock, events } = harness();
    await create(manager);
    charges.length = 0;
    events.length = 0;

    const flagged = await manager.cancelSubscription("sub_1", { atPeriodEnd: true });
    expect(flagged.status).toBe("active");
    expect(flagged.cancelAtPeriodEnd).toBe(true);

    clock.now = Date.parse("2026-02-20T00:00:00.000Z"); // still paid through
    await manager.chargeDueSubscriptions();
    expect((await manager.retrieveSubscription("sub_1")).status).toBe("active");

    clock.now = Date.parse("2026-03-01T00:00:00.000Z"); // window over
    const run = await manager.chargeDueSubscriptions();
    expect(run.canceled).toHaveLength(1);
    expect(charges).toHaveLength(0); // ended, never charged again
    expect(events.map((e) => e.type)).toEqual(["subscription.canceled"]);
  });
});

describe("updates, retrieval, listing", () => {
  it("plan changes apply from the next renewal; new tokens reset dunning", async () => {
    const { manager, charges, clock, scriptNext } = harness();
    await create(manager);
    charges.length = 0;

    await manager.updateSubscription("sub_1", { plan: { amount: 4900, currency: "USD", interval: "month" } });

    // Push into dunning, then rescue with a fresh card.
    clock.now = Date.parse("2026-02-28T10:00:01.000Z");
    scriptNext("declined");
    await manager.chargeDueSubscriptions();
    expect(charges[0]!.amount).toBe(4900); // updated plan already billed
    const updated = await manager.updateSubscription("sub_1", { savedPaymentMethodToken: "tok_new_card" });
    expect(updated.failedAttempts).toBe(0);
    expect(updated.nextRetryAt).toBeUndefined();

    const run = await manager.chargeDueSubscriptions(); // no backoff left — retries immediately
    expect(run.charged).toHaveLength(1);
    expect(charges[1]).toMatchObject({ savedPaymentMethodToken: "tok_new_card", amount: 4900 });
  });

  it("rejects updates to canceled subscriptions and unknown ids", async () => {
    const { manager } = harness();
    await create(manager);
    await manager.cancelSubscription("sub_1");
    await expect(manager.updateSubscription("sub_1", {})).rejects.toThrowError(/canceled/);
    await expect(manager.retrieveSubscription("ghost")).rejects.toThrowError(/Unknown subscription/);
  });

  it("lists by customer and status", async () => {
    const { manager } = harness();
    await create(manager);
    await create(manager, { id: "sub_2", pspCustomerId: "cust_2" });
    await manager.cancelSubscription("sub_2");

    expect((await manager.listSubscriptions()).map((s) => s.id).sort()).toEqual(["sub_1", "sub_2"]);
    expect((await manager.listSubscriptions({ pspCustomerId: "cust_2" })).map((s) => s.id)).toEqual(["sub_2"]);
    expect((await manager.listSubscriptions({ status: "canceled" })).map((s) => s.id)).toEqual(["sub_2"]);
  });
});

describe("robustness", () => {
  it("a throwing onEvent hook never breaks billing", async () => {
    const { manager } = harness({
      onEvent: () => {
        throw new Error("metrics down");
      },
    });
    const { subscription } = await create(manager);
    expect(subscription.status).toBe("active");
  });

  it("validates manager options eagerly", () => {
    expect(() => harness({ catchUpLimit: 0 })).toThrowError(/catchUpLimit/);
    expect(() => harness({ retryDelaysHours: [24, -1] })).toThrowError(/retryDelaysHours/);
  });

  it("generates ids when the host does not supply one", async () => {
    const { manager } = harness();
    const { subscription } = await create(manager, { id: undefined });
    expect(subscription.id).toMatch(/^sub_gen_/);
  });
});
