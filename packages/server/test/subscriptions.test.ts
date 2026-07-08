import { describe, expect, it } from "vitest";
import { PayFanoutError, type ChargeSavedPaymentMethodInput, type PaymentInfo } from "@payfanout/core";
import {
  addInterval,
  InMemorySubscriptionStore,
  PaymentService,
  SubscriptionManager,
  type SubscriptionEvent,
  type SubscriptionManagerOptions,
  type SubscriptionRecord,
  type SubscriptionStatus,
  type SubscriptionStore,
} from "../src/index.js";
import { FakeAdapter, makePaymentInfo } from "./fake-adapter.js";

const T0 = Date.parse("2026-01-31T10:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type ChargeOutcome = "ok" | "declined" | "psp_down" | "processing" | "resolved_failed";

/** Scripted charging harness: control every charge outcome, capture every input. */
function harness(options: Partial<SubscriptionManagerOptions> = {}): {
  manager: SubscriptionManager;
  adapter: FakeAdapter;
  store: InMemorySubscriptionStore;
  charges: ChargeSavedPaymentMethodInput[];
  clock: { now: number };
  events: SubscriptionEvent[];
  scriptNext: (outcome: ChargeOutcome) => void;
} {
  const adapter = new FakeAdapter({ capabilities: { supportsSavedPaymentMethods: true } });
  const charges: ChargeSavedPaymentMethodInput[] = [];
  const script: ChargeOutcome[] = [];
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
      ...(outcome === "processing" ? { status: "processing" as const } : {}),
      ...(outcome === "resolved_failed" ? { status: "failed" as const } : {}),
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
  return { manager, adapter, store, charges, clock, events, scriptNext: (o) => script.push(o) };
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

/** Bare persisted record for store-level tests (bypasses createSubscription). */
const makeRecord = (overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({
  id: "rec_1",
  pspName: "fake",
  pspCustomerId: "cust_1",
  savedPaymentMethodToken: "tok_saved",
  plan: { amount: 2500, currency: "USD", interval: "month", intervalCount: 1 },
  status: "active",
  currentPeriodStart: "2026-01-01T00:00:00.000Z",
  currentPeriodEnd: "2026-02-01T00:00:00.000Z",
  cancelAtPeriodEnd: false,
  failedAttempts: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
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

  it("anchorDay restores a clamped month-end instead of eroding it", () => {
    expect(addInterval("2026-02-28T10:00:00.000Z", "month", 1, 31)).toBe("2026-03-31T10:00:00.000Z");
    expect(addInterval("2026-02-28T10:00:00.000Z", "month", 2, 31)).toBe("2026-04-30T10:00:00.000Z");
    expect(addInterval("2026-04-30T10:00:00.000Z", "month", 1, 31)).toBe("2026-05-31T10:00:00.000Z");
    expect(addInterval("2025-02-28T08:30:00.000Z", "year", 1, 29)).toBe("2026-02-28T08:30:00.000Z");
    expect(addInterval("2027-02-28T08:30:00.000Z", "year", 1, 29)).toBe("2028-02-29T08:30:00.000Z"); // leap restores
    // Without anchorDay the pre-existing clamp-forward behavior stands.
    expect(addInterval("2026-02-28T10:00:00.000Z", "month", 1)).toBe("2026-03-28T10:00:00.000Z");
  });

  it("rejects garbage anchor days", () => {
    expect(() => addInterval("2026-01-31T10:00:00.000Z", "month", 1, 0)).toThrowError(/anchorDay/);
    expect(() => addInterval("2026-01-31T10:00:00.000Z", "month", 1, 32)).toThrowError(/anchorDay/);
    expect(() => addInterval("2026-01-31T10:00:00.000Z", "month", 1, 15.5)).toThrowError(/anchorDay/);
  });

  it("property: anchored month steps land on min(anchorDay, month length), keep the time of day, strictly increase", () => {
    for (let anchorDay = 1; anchorDay <= 31; anchorDay++) {
      let cursor = `2026-01-${String(anchorDay).padStart(2, "0")}T07:45:30.123Z`;
      for (let step = 0; step < 26; step++) {
        const next = addInterval(cursor, "month", 1, anchorDay);
        const d = new Date(next);
        const monthLength = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
        expect(d.getUTCDate()).toBe(Math.min(anchorDay, monthLength));
        expect(next.slice(10)).toBe("T07:45:30.123Z");
        expect(Date.parse(next)).toBeGreaterThan(Date.parse(cursor));
        cursor = next;
      }
    }
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
      anchorDay: 31, // remembered so later periods return to the 31st
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

  it("future startAt = trial: status trialing, no charge now, first charge converts to active", async () => {
    const { manager, charges, clock } = harness();
    const { subscription, payment } = await create(manager, {
      startAt: new Date(T0 + 14 * DAY),
    });
    expect(payment).toBeUndefined();
    expect(charges).toHaveLength(0);
    expect(subscription.status).toBe("trialing");
    expect(subscription.currentPeriodEnd).toBe(new Date(T0 + 14 * DAY).toISOString());

    clock.now = T0 + 13 * DAY;
    expect((await manager.chargeDueSubscriptions()).charged).toHaveLength(0);

    clock.now = T0 + 14 * DAY + 1;
    const run = await manager.chargeDueSubscriptions();
    expect(run.charged).toHaveLength(1);
    expect(charges[0]!.occurrence).toBe("recurring");
    expect((await manager.retrieveSubscription("sub_1")).status).toBe("active");
  });

  it("a past startAt charges immediately and anchors at now, not at the stale instant", async () => {
    const { manager, charges } = harness();
    const { subscription, payment } = await create(manager, { startAt: new Date(T0 - 16 * DAY) }); // Jan 15
    expect(payment).toBeDefined();
    expect(charges).toHaveLength(1);
    expect(subscription).toMatchObject({
      status: "active",
      currentPeriodStart: "2026-01-31T10:00:00.000Z",
      currentPeriodEnd: "2026-02-28T10:00:00.000Z",
      anchorDay: 31,
    });
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
    expect(renewed.currentPeriodEnd).toBe("2026-03-31T10:00:00.000Z"); // from period end, not from "now"; anchor day 31 restored
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
    expect(run.charged).toHaveLength(3); // Feb 28, Mar 31, Apr 30 anchors all collected
    expect(charges.map((c) => c.idempotencyKey)).toEqual([
      "payfanout-sub-sub_1-2026-02-28T10:00:00.000Z-a0",
      "payfanout-sub-sub_1-2026-03-31T10:00:00.000Z-a0",
      "payfanout-sub-sub_1-2026-04-30T10:00:00.000Z-a0",
    ]);
    const record = await manager.retrieveSubscription("sub_1");
    expect(record.currentPeriodEnd).toBe("2026-05-31T10:00:00.000Z"); // paid through — no longer due
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
    expect(record.currentPeriodEnd).toBe("2026-03-31T10:00:00.000Z"); // anchor preserved through dunning
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
    expect(events.map((e) => e.type)).toEqual(["subscription.updated", "subscription.canceled"]);
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

describe("money-safety: bookkeeping failures never enter dunning", () => {
  it("a store.save failure after a successful charge propagates — the next run replays the SAME attempt key", async () => {
    const { manager, store, charges, clock } = harness();
    await create(manager);
    // Due at exactly currentPeriodEnd — the boundary instant counts as due.
    clock.now = Date.parse("2026-02-28T10:00:00.000Z");

    const originalSave = store.save.bind(store);
    let failNextSave = true;
    store.save = async (record) => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error("db down");
      }
      return originalSave(record);
    };

    const run = await manager.chargeDueSubscriptions();
    expect(run.charged).toHaveLength(0);
    expect(run.failed).toHaveLength(0);
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0]!.subscriptionId).toBe("sub_1");

    // The record is untouched: no dunning, no period advance, same attempt key.
    const record = await manager.retrieveSubscription("sub_1");
    expect(record).toMatchObject({ status: "active", failedAttempts: 0, currentPeriodEnd: "2026-02-28T10:00:00.000Z" });

    const rerun = await manager.chargeDueSubscriptions();
    expect(rerun.charged).toHaveLength(1);
    expect(charges.map((c) => c.idempotencyKey)).toEqual([
      "first-charge-key",
      "payfanout-sub-sub_1-2026-02-28T10:00:00.000Z-a0",
      "payfanout-sub-sub_1-2026-02-28T10:00:00.000Z-a0", // PSP-side replay, never a fresh charge
    ]);
  });

  it("one candidate's storage failure does not abandon the rest of the run", async () => {
    const { manager, store, clock } = harness();
    await create(manager);
    await create(manager, { id: "sub_2", pspCustomerId: "cust_2" });
    clock.now = Date.parse("2026-03-15T00:00:00.000Z");

    const originalSave = store.save.bind(store);
    let trip = true;
    store.save = async (record) => {
      if (record.id === "sub_1" && trip) {
        trip = false;
        throw new Error("db down");
      }
      return originalSave(record);
    };

    const run = await manager.chargeDueSubscriptions();
    expect(run.errors.map((e) => e.subscriptionId)).toEqual(["sub_1"]);
    expect(run.charged.map((r) => r.id)).toEqual(["sub_2"]);
  });
});

describe("async rails: renewals resolving as processing", () => {
  it("freezes the record until resolved; resolve(succeeded) advances the period; replays are no-ops", async () => {
    const { manager, charges, clock, events, scriptNext } = harness();
    await create(manager);
    events.length = 0;
    clock.now = Date.parse("2026-02-28T10:00:01.000Z");

    scriptNext("processing");
    const run = await manager.chargeDueSubscriptions();
    expect(run.pending).toHaveLength(1);
    expect(run.charged).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["subscription.charge_pending"]);

    const record = await manager.retrieveSubscription("sub_1");
    expect(record.status).toBe("active");
    expect(record.currentPeriodEnd).toBe("2026-02-28T10:00:00.000Z"); // NOT advanced — money unconfirmed
    expect(record.pendingRenewal).toMatchObject({
      pspPaymentId: "pay_2",
      periodEnd: "2026-02-28T10:00:00.000Z",
      attempt: 0,
    });

    // Frozen: further runs never charge on top of the unresolved renewal.
    await manager.chargeDueSubscriptions();
    expect(charges).toHaveLength(2); // create + the one pending renewal

    const resolved = await manager.resolvePendingRenewal("sub_1", { status: "succeeded", pspPaymentId: "pay_2" });
    expect(resolved).toMatchObject({
      status: "active",
      currentPeriodStart: "2026-02-28T10:00:00.000Z",
      currentPeriodEnd: "2026-03-31T10:00:00.000Z",
      failedAttempts: 0,
      lastPaymentId: "pay_2",
    });
    expect(resolved.pendingRenewal).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["subscription.charge_pending", "subscription.charged"]);

    const replay = await manager.resolvePendingRenewal("sub_1", { status: "succeeded", pspPaymentId: "pay_2" });
    expect(replay.currentPeriodEnd).toBe("2026-03-31T10:00:00.000Z");
    expect(events).toHaveLength(2); // replay emitted nothing
  });

  it("resolve(failed) enters dunning with the pending attempt's count and a fresh retry key", async () => {
    const { manager, charges, clock, scriptNext } = harness();
    await create(manager);
    clock.now = Date.parse("2026-02-28T10:00:01.000Z");

    scriptNext("processing");
    await manager.chargeDueSubscriptions();

    clock.now += 5 * HOUR;
    const failed = await manager.resolvePendingRenewal("sub_1", {
      status: "failed",
      pspPaymentId: "pay_2",
      error: { code: "insufficient_funds", message: "No funds." },
    });
    expect(failed).toMatchObject({
      status: "past_due",
      failedAttempts: 1,
      lastError: { code: "insufficient_funds", message: "No funds." },
      nextRetryAt: new Date(clock.now + 24 * HOUR).toISOString(),
    });
    expect(failed.pendingRenewal).toBeUndefined();

    clock.now += 25 * HOUR;
    const retryRun = await manager.chargeDueSubscriptions();
    expect(retryRun.charged).toHaveLength(1);
    expect(charges.at(-1)!.idempotencyKey).toBe("payfanout-sub-sub_1-2026-02-28T10:00:00.000Z-a1");
  });

  it("guards resolution: no pending renewal, mismatched payment id", async () => {
    const { manager, clock, scriptNext } = harness();
    await create(manager);
    await expect(manager.resolvePendingRenewal("sub_1", { status: "succeeded" })).rejects.toThrowError(
      /no pending renewal/,
    );

    clock.now = Date.parse("2026-02-28T10:00:01.000Z");
    scriptNext("processing");
    await manager.chargeDueSubscriptions();
    await expect(
      manager.resolvePendingRenewal("sub_1", { status: "succeeded", pspPaymentId: "pay_999" }),
    ).rejects.toThrowError(/awaits payment/);
  });

  it("a renewal that RESOLVES with status failed (not thrown) still enters dunning", async () => {
    const { manager, clock, scriptNext } = harness();
    await create(manager);
    clock.now = Date.parse("2026-02-28T10:00:01.000Z");

    scriptNext("resolved_failed");
    const run = await manager.chargeDueSubscriptions();
    expect(run.failed).toHaveLength(1);
    const record = await manager.retrieveSubscription("sub_1");
    expect(record).toMatchObject({
      status: "past_due",
      failedAttempts: 1,
      lastError: { code: "processing_error" },
    });
  });

  it("a first charge that does not succeed synchronously throws and persists nothing", async () => {
    const { manager, store, scriptNext } = harness();
    scriptNext("processing");
    await expect(create(manager)).rejects.toMatchObject({ code: "processing_error" });
    expect(await store.get("sub_1")).toBeUndefined();

    scriptNext("resolved_failed");
    await expect(create(manager)).rejects.toMatchObject({ code: "processing_error" });
    expect(await store.get("sub_1")).toBeUndefined();
  });
});

describe("cancel racing an in-flight renewal", () => {
  it("a cancel landing during a SUCCESSFUL charge stands — paid window advances, status stays canceled", async () => {
    const { manager, adapter, clock } = harness();
    await create(manager);
    clock.now = Date.parse("2026-02-28T10:00:01.000Z");

    adapter.chargeSavedPaymentMethod = async (input) => {
      await manager.cancelSubscription("sub_1");
      return makePaymentInfo({ pspName: "fake", pspPaymentId: "pay_race", amount: input.amount, currency: input.currency });
    };

    const run = await manager.chargeDueSubscriptions();
    expect(run.charged).toHaveLength(1); // the money moved — reported honestly

    const record = await manager.retrieveSubscription("sub_1");
    expect(record.status).toBe("canceled"); // never resurrected
    expect(record.canceledAt).toBeDefined();
    expect(record.currentPeriodEnd).toBe("2026-03-31T10:00:00.000Z"); // paid through what was collected
    expect(record.lastPaymentId).toBe("pay_race");

    clock.now = Date.parse("2026-06-01T00:00:00.000Z");
    expect((await manager.chargeDueSubscriptions()).charged).toHaveLength(0);
  });

  it("a cancel landing during a FAILING charge is not overwritten by dunning", async () => {
    const { manager, adapter, clock } = harness();
    await create(manager);
    clock.now = Date.parse("2026-02-28T10:00:01.000Z");

    adapter.chargeSavedPaymentMethod = async () => {
      await manager.cancelSubscription("sub_1");
      throw new PayFanoutError({ code: "card_declined", message: "Declined.", retryable: false });
    };

    const run = await manager.chargeDueSubscriptions();
    expect(run.failed).toHaveLength(0);
    expect(run.canceled).toHaveLength(0); // the cancel was the host's, not the run's

    const record = await manager.retrieveSubscription("sub_1");
    expect(record.status).toBe("canceled");
    expect(record.failedAttempts).toBe(0); // no past_due ghost
    expect(record.nextRetryAt).toBeUndefined();
  });
});

describe("dunning and catch-up boundaries", () => {
  it("a retry fires at exactly nextRetryAt", async () => {
    const { manager, charges, clock, scriptNext } = harness();
    await create(manager);
    clock.now = Date.parse("2026-02-28T10:00:01.000Z");
    scriptNext("declined");
    await manager.chargeDueSubscriptions();
    const record = await manager.retrieveSubscription("sub_1");

    clock.now = Date.parse(record.nextRetryAt!);
    const run = await manager.chargeDueSubscriptions();
    expect(run.charged).toHaveLength(1);
    expect(charges).toHaveLength(3); // create + failed attempt + boundary retry
  });

  it("a failure mid-catch-up stops the sequence and records partial progress", async () => {
    const { manager, clock, scriptNext } = harness({ catchUpLimit: 12 });
    await create(manager);
    clock.now = Date.parse("2026-05-15T00:00:00.000Z"); // 3 periods overdue

    scriptNext("ok");
    scriptNext("declined");
    const run = await manager.chargeDueSubscriptions();
    expect(run.charged).toHaveLength(1);
    expect(run.failed).toHaveLength(1);

    const record = await manager.retrieveSubscription("sub_1");
    expect(record).toMatchObject({
      status: "past_due",
      failedAttempts: 1,
      currentPeriodStart: "2026-02-28T10:00:00.000Z", // first overdue period collected
      currentPeriodEnd: "2026-03-31T10:00:00.000Z", // second one still owed
    });
  });

  it("a past_due record entering a multi-cycle run recovers, then keeps catching up", async () => {
    const { manager, charges, clock, scriptNext } = harness({ catchUpLimit: 12 });
    await create(manager);
    clock.now = Date.parse("2026-02-28T10:00:01.000Z");
    scriptNext("declined");
    await manager.chargeDueSubscriptions(); // -> past_due, retry in 24h

    clock.now = Date.parse("2026-04-10T00:00:00.000Z"); // backoff long past; 2 periods owed
    const run = await manager.chargeDueSubscriptions();
    expect(run.charged).toHaveLength(2);
    expect(charges.slice(1).map((c) => c.idempotencyKey)).toEqual([
      "payfanout-sub-sub_1-2026-02-28T10:00:00.000Z-a0", // the failed attempt
      "payfanout-sub-sub_1-2026-02-28T10:00:00.000Z-a1", // dunning recovery
      "payfanout-sub-sub_1-2026-03-31T10:00:00.000Z-a0", // catch-up continues on the next period
    ]);
    const record = await manager.retrieveSubscription("sub_1");
    expect(record.status).toBe("active");
    expect(record.currentPeriodEnd).toBe("2026-04-30T10:00:00.000Z");
  });
});

describe("month-end anchor preservation (manager)", () => {
  it("a subscription created Jan 31 walks a full year on true month ends", async () => {
    const { manager, charges, clock } = harness({ catchUpLimit: 12 });
    await create(manager);
    charges.length = 0;
    clock.now = Date.parse("2027-02-15T00:00:00.000Z"); // 12 periods overdue

    const run = await manager.chargeDueSubscriptions();
    expect(run.charged).toHaveLength(12);
    expect(charges.map((c) => c.idempotencyKey)).toEqual(
      [
        "2026-02-28",
        "2026-03-31",
        "2026-04-30",
        "2026-05-31",
        "2026-06-30",
        "2026-07-31",
        "2026-08-31",
        "2026-09-30",
        "2026-10-31",
        "2026-11-30",
        "2026-12-31",
        "2027-01-31",
      ].map((day) => `payfanout-sub-sub_1-${day}T10:00:00.000Z-a0`),
    );
    expect((await manager.retrieveSubscription("sub_1")).currentPeriodEnd).toBe("2027-02-28T10:00:00.000Z");
  });
});

describe("InMemorySubscriptionStore.listDue", () => {
  it("returns due active/trialing/past_due records, ordered by due instant, capped by limit", async () => {
    const store = new InMemorySubscriptionStore();
    await store.save(makeRecord({ id: "active_due" })); // periodEnd Feb 1
    await store.save(makeRecord({ id: "trial_due", status: "trialing", currentPeriodEnd: "2026-01-20T00:00:00.000Z" }));
    await store.save(makeRecord({ id: "retry_due", status: "past_due", nextRetryAt: "2026-01-10T00:00:00.000Z" }));
    await store.save(makeRecord({ id: "retry_cooling", status: "past_due", nextRetryAt: "2026-09-01T00:00:00.000Z" }));
    await store.save(makeRecord({ id: "active_not_due", currentPeriodEnd: "2026-08-01T00:00:00.000Z" }));
    await store.save(makeRecord({ id: "paused_due", status: "paused" }));
    await store.save(makeRecord({ id: "canceled_due", status: "canceled" }));

    const due = await store.listDue({ dueBefore: "2026-03-01T00:00:00.000Z" });
    expect(due.map((r) => r.id)).toEqual(["retry_due", "trial_due", "active_due"]);
    expect(await store.listDue({ dueBefore: "2026-03-01T00:00:00.000Z", limit: 2 })).toHaveLength(2);
    // dueBefore is inclusive — the boundary instant counts as due.
    expect((await store.listDue({ dueBefore: "2026-01-10T00:00:00.000Z" })).map((r) => r.id)).toEqual(["retry_due"]);
  });
});

describe("chargeDueSubscriptions over store.listDue", () => {
  /** Store stub over a plain Map with observable listDue/list calls. */
  function instrumentedStore(): {
    store: SubscriptionStore;
    backing: Map<string, SubscriptionRecord>;
    listDueCalls: Array<{ dueBefore: string; limit?: number }>;
    listFilters: Array<{ pspCustomerId?: string; status?: SubscriptionStatus } | undefined>;
  } {
    const backing = new Map<string, SubscriptionRecord>();
    const listDueCalls: Array<{ dueBefore: string; limit?: number }> = [];
    const listFilters: Array<{ pspCustomerId?: string; status?: SubscriptionStatus } | undefined> = [];
    const store: SubscriptionStore = {
      save: async (record) => void backing.set(record.id, structuredClone(record)),
      get: async (id) => {
        const record = backing.get(id);
        return record ? structuredClone(record) : undefined;
      },
      list: async (filter) => {
        listFilters.push(filter);
        return [...backing.values()]
          .filter((r) => !filter?.status || r.status === filter.status)
          .map((r) => structuredClone(r));
      },
      listDue: async (input) => {
        listDueCalls.push(input);
        const cutoff = Date.parse(input.dueBefore);
        return [...backing.values()]
          .filter(
            (r) =>
              (r.status === "active" || r.status === "trialing" || r.status === "past_due") &&
              Date.parse(r.currentPeriodEnd) <= cutoff,
          )
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, input.limit)
          .map((r) => structuredClone(r));
      },
    };
    return { store, backing, listDueCalls, listFilters };
  }

  it("prefers listDue and pages full batches until a short one", async () => {
    const { store, backing, listDueCalls, listFilters } = instrumentedStore();
    const { manager, charges, clock } = harness({ store });
    for (let i = 0; i < 102; i++) {
      const id = `sub_${String(i).padStart(3, "0")}`;
      backing.set(id, makeRecord({ id }));
    }
    clock.now = Date.parse("2026-02-10T00:00:00.000Z");

    const run = await manager.chargeDueSubscriptions();
    expect(run.charged).toHaveLength(102);
    expect(charges).toHaveLength(102);
    expect(listDueCalls).toEqual([
      { dueBefore: "2026-02-10T00:00:00.000Z", limit: 100 },
      { dueBefore: "2026-02-10T00:00:00.000Z", limit: 100 },
    ]);
    expect(listFilters).toHaveLength(0); // never fell back to full scans
  });

  it("a full batch of still-due leftovers (catchUpLimit reached) ends the run instead of looping", async () => {
    const { store, backing, listDueCalls } = instrumentedStore();
    const { manager, clock } = harness({ store }); // catchUpLimit 1
    for (let i = 0; i < 100; i++) {
      const id = `sub_${String(i).padStart(3, "0")}`;
      backing.set(id, makeRecord({ id })); // several periods overdue
    }
    clock.now = Date.parse("2026-06-15T00:00:00.000Z");

    const run = await manager.chargeDueSubscriptions();
    expect(run.charged).toHaveLength(100); // one period each this run
    expect(listDueCalls).toHaveLength(2); // the second full batch had nothing unseen
  });

  it("re-checks due-ness — records a store wrongly returns are never charged", async () => {
    const { store, backing } = instrumentedStore();
    // A misbehaving listDue that returns EVERYTHING, due or not.
    store.listDue = async () => [...backing.values()].map((r) => structuredClone(r));
    const { manager, charges, clock } = harness({ store });
    backing.set("not_due", makeRecord({ id: "not_due", currentPeriodEnd: "2026-08-01T00:00:00.000Z" }));
    backing.set("cooling", makeRecord({ id: "cooling", status: "past_due", nextRetryAt: "2026-08-01T00:00:00.000Z" }));
    backing.set(
      "frozen",
      makeRecord({
        id: "frozen",
        pendingRenewal: {
          pspPaymentId: "pay_x",
          periodEnd: "2026-02-01T00:00:00.000Z",
          attempt: 0,
          startedAt: "2026-02-01T00:00:00.000Z",
        },
      }),
    );
    backing.set("halted", makeRecord({ id: "halted", status: "paused" }));
    backing.set("ended", makeRecord({ id: "ended", status: "canceled" }));
    clock.now = Date.parse("2026-02-10T00:00:00.000Z");

    const run = await manager.chargeDueSubscriptions();
    expect(charges).toHaveLength(0);
    expect(run.charged).toHaveLength(0);
    expect(run.errors).toHaveLength(0);
  });

  it("falls back to per-status list() scans when the store lacks listDue", async () => {
    const backing = new InMemorySubscriptionStore();
    const listFilters: Array<{ status?: SubscriptionStatus } | undefined> = [];
    const bare: SubscriptionStore = {
      save: (record) => backing.save(record),
      get: (id) => backing.get(id),
      list: (filter) => {
        listFilters.push(filter);
        return backing.list(filter);
      },
    };
    const { manager, charges, clock } = harness({ store: bare });
    await create(manager);
    await create(manager, { id: "sub_trial", startAt: new Date(T0 + 5 * DAY) });
    charges.length = 0;
    clock.now = Date.parse("2026-03-01T00:00:00.000Z");

    const run = await manager.chargeDueSubscriptions();
    expect(run.charged.map((r) => r.id).sort()).toEqual(["sub_1", "sub_trial"]);
    expect(listFilters.map((f) => f?.status)).toEqual(["active", "trialing", "past_due"]);
    expect((await manager.retrieveSubscription("sub_trial")).status).toBe("active");
  });
});

describe("pause / resume", () => {
  it("pauses an active subscription: cron skips it, pausing again is a no-op, canceled cannot pause", async () => {
    const { manager, charges, clock, events } = harness();
    await create(manager);
    charges.length = 0;
    events.length = 0;

    const paused = await manager.pauseSubscription("sub_1");
    expect(paused.status).toBe("paused");
    expect(events.map((e) => e.type)).toEqual(["subscription.paused"]);
    await manager.pauseSubscription("sub_1"); // no-op
    expect(events).toHaveLength(1);

    clock.now = Date.parse("2026-06-01T00:00:00.000Z"); // long overdue — still skipped
    const run = await manager.chargeDueSubscriptions();
    expect(run.charged).toHaveLength(0);
    expect(charges).toHaveLength(0);

    await manager.cancelSubscription("sub_1");
    await expect(manager.pauseSubscription("sub_1")).rejects.toThrowError(/canceled/);
  });

  it("pausing a past_due record clears the retry schedule but keeps the attempt count", async () => {
    const { manager, clock, scriptNext } = harness();
    await create(manager);
    clock.now = Date.parse("2026-02-28T10:00:01.000Z");
    scriptNext("declined");
    await manager.chargeDueSubscriptions();

    const paused = await manager.pauseSubscription("sub_1");
    expect(paused).toMatchObject({ status: "paused", failedAttempts: 1, lastError: { code: "card_declined" } });
    expect(paused.nextRetryAt).toBeUndefined();
  });

  it("resume while still paid through reactivates without charging; the anchor is untouched", async () => {
    const { manager, charges, clock, events } = harness();
    await create(manager);
    await manager.pauseSubscription("sub_1");
    charges.length = 0;
    events.length = 0;

    clock.now = Date.parse("2026-02-10T00:00:00.000Z"); // periodEnd Feb 28 still ahead
    const resumed = await manager.resumeSubscription("sub_1", { idempotencyKey: "resume-key" });
    expect(resumed.status).toBe("active");
    expect(charges).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["subscription.resumed"]);

    clock.now = Date.parse("2026-03-01T00:00:00.000Z");
    expect((await manager.chargeDueSubscriptions()).charged).toHaveLength(1);
    expect((await manager.retrieveSubscription("sub_1")).currentPeriodEnd).toBe("2026-03-31T10:00:00.000Z");
  });

  it("resume after the window lapsed charges immediately and re-anchors at the resume instant", async () => {
    const { manager, charges, clock, events } = harness();
    await create(manager); // anchor day 31
    await manager.pauseSubscription("sub_1");
    charges.length = 0;
    events.length = 0;

    clock.now = Date.parse("2026-04-15T12:00:00.000Z"); // lapsed since Feb 28
    const resumed = await manager.resumeSubscription("sub_1", { idempotencyKey: "resume-key" });
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ occurrence: "recurring", idempotencyKey: "resume-key", amount: 2500 });
    expect(resumed).toMatchObject({
      status: "active",
      currentPeriodStart: "2026-04-15T12:00:00.000Z",
      currentPeriodEnd: "2026-05-15T12:00:00.000Z",
      anchorDay: 15,
      failedAttempts: 0,
    });
    expect(events.map((e) => e.type)).toEqual(["subscription.resumed", "subscription.charged"]);

    const run = await manager.chargeDueSubscriptions(); // skipped window is NOT collected
    expect(run.charged).toHaveLength(0);
    expect(charges).toHaveLength(1);
  });

  it("a failed resume charge stays paused with lastError — no dunning — and throws", async () => {
    const { manager, clock, events, scriptNext } = harness();
    await create(manager);
    await manager.pauseSubscription("sub_1");
    events.length = 0;
    clock.now = Date.parse("2026-04-15T12:00:00.000Z");

    scriptNext("declined");
    await expect(manager.resumeSubscription("sub_1", { idempotencyKey: "resume-key" })).rejects.toMatchObject({
      code: "card_declined",
    });
    const record = await manager.retrieveSubscription("sub_1");
    expect(record).toMatchObject({ status: "paused", failedAttempts: 0, lastError: { code: "card_declined" } });
    expect(record.nextRetryAt).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["subscription.charge_failed"]);

    clock.now = Date.parse("2026-06-01T00:00:00.000Z"); // still paused: the cron never retries
    const run = await manager.chargeDueSubscriptions();
    expect(run.failed).toHaveLength(0);
    expect(run.charged).toHaveLength(0);
  });

  it("a resume charge resolving as processing freezes the paused record; resolve, then resume again", async () => {
    const { manager, charges, clock, scriptNext } = harness();
    await create(manager);
    await manager.pauseSubscription("sub_1");
    clock.now = Date.parse("2026-04-15T12:00:00.000Z");

    scriptNext("processing");
    const frozen = await manager.resumeSubscription("sub_1", { idempotencyKey: "resume-key" });
    expect(frozen.status).toBe("paused");
    expect(frozen.pendingRenewal).toMatchObject({ periodEnd: "2026-04-15T12:00:00.000Z" });

    // Frozen: neither resume nor the cron may charge on top.
    await expect(manager.resumeSubscription("sub_1", { idempotencyKey: "again" })).rejects.toThrowError(
      /unresolved renewal/,
    );
    await manager.chargeDueSubscriptions();
    expect(charges).toHaveLength(2); // create + the frozen resume charge

    const resolved = await manager.resolvePendingRenewal("sub_1", { status: "succeeded" });
    expect(resolved).toMatchObject({
      status: "paused", // resolution never reactivates
      currentPeriodStart: "2026-04-15T12:00:00.000Z",
      currentPeriodEnd: "2026-05-15T12:00:00.000Z",
      anchorDay: 15,
    });
    const resumed = await manager.resumeSubscription("sub_1", { idempotencyKey: "again" });
    expect(resumed.status).toBe("active");
    expect(charges).toHaveLength(2); // paid through by the resolved charge — reactivation is free
  });

  it("resume rejects non-paused records", async () => {
    const { manager } = harness();
    await create(manager);
    await expect(manager.resumeSubscription("sub_1", { idempotencyKey: "k" })).rejects.toThrowError(/not paused/);
  });

  it("a resume charge that resolves without collecting counts as a failure", async () => {
    const { manager, clock, scriptNext } = harness();
    await create(manager);
    await manager.pauseSubscription("sub_1");
    clock.now = Date.parse("2026-04-15T12:00:00.000Z");

    scriptNext("resolved_failed");
    await expect(manager.resumeSubscription("sub_1", { idempotencyKey: "k" })).rejects.toMatchObject({
      code: "processing_error",
    });
    expect(await manager.retrieveSubscription("sub_1")).toMatchObject({
      status: "paused",
      lastError: { code: "processing_error" },
    });
  });

  it("a weekly plan resumes lapsed without recording an anchor day", async () => {
    const { manager, clock } = harness();
    await create(manager, { plan: { amount: 900, currency: "USD", interval: "week" as const } });
    await manager.pauseSubscription("sub_1");
    clock.now = T0 + 30 * DAY; // lapsed since T0 + 7d

    const resumed = await manager.resumeSubscription("sub_1", { idempotencyKey: "k" });
    expect(resumed.status).toBe("active");
    expect(resumed.anchorDay).toBeUndefined();
    expect(resumed.currentPeriodEnd).toBe(new Date(T0 + 37 * DAY).toISOString());
  });

  it("a paused record with a pending RENEWAL resolves without reactivating or re-charging", async () => {
    const { manager, charges, clock, scriptNext } = harness();
    await create(manager);
    clock.now = Date.parse("2026-02-28T10:00:01.000Z");
    scriptNext("processing");
    await manager.chargeDueSubscriptions(); // renewal frozen
    await manager.pauseSubscription("sub_1");

    const resolved = await manager.resolvePendingRenewal("sub_1", { status: "succeeded", pspPaymentId: "pay_2" });
    expect(resolved.status).toBe("paused");
    expect(resolved.currentPeriodEnd).toBe("2026-03-31T10:00:00.000Z"); // money moved -> window advanced
    expect(resolved.pendingRenewal).toBeUndefined();

    clock.now = Date.parse("2026-09-01T00:00:00.000Z");
    await manager.chargeDueSubscriptions();
    expect(charges).toHaveLength(2); // never re-charged while paused
  });

  it("resolve(failed) on a paused record records the error without dunning", async () => {
    const { manager, clock, scriptNext } = harness();
    await create(manager);
    clock.now = Date.parse("2026-02-28T10:00:01.000Z");
    scriptNext("processing");
    await manager.chargeDueSubscriptions();
    await manager.pauseSubscription("sub_1");

    const resolved = await manager.resolvePendingRenewal("sub_1", {
      status: "failed",
      pspPaymentId: "pay_2",
      error: { code: "insufficient_funds", message: "No funds." },
    });
    expect(resolved).toMatchObject({ status: "paused", lastError: { code: "insufficient_funds" } });
    expect(resolved.pendingRenewal).toBeUndefined();
    expect(resolved.nextRetryAt).toBeUndefined();
  });

  it("a pause landing during a SUCCESSFUL renewal charge stands — window advances, status stays paused", async () => {
    const { manager, adapter, clock } = harness();
    await create(manager);
    clock.now = Date.parse("2026-02-28T10:00:01.000Z");

    adapter.chargeSavedPaymentMethod = async (input) => {
      await manager.pauseSubscription("sub_1");
      return makePaymentInfo({ pspName: "fake", pspPaymentId: "pay_race", amount: input.amount, currency: input.currency });
    };

    const run = await manager.chargeDueSubscriptions();
    expect(run.charged).toHaveLength(1); // the money moved — reported honestly

    const record = await manager.retrieveSubscription("sub_1");
    expect(record.status).toBe("paused"); // never resurrected
    expect(record.currentPeriodEnd).toBe("2026-03-31T10:00:00.000Z"); // paid through what was collected
  });

  it("a pause landing during a FAILING renewal charge is not overwritten by dunning", async () => {
    const { manager, adapter, clock } = harness();
    await create(manager);
    clock.now = Date.parse("2026-02-28T10:00:01.000Z");

    adapter.chargeSavedPaymentMethod = async () => {
      await manager.pauseSubscription("sub_1");
      throw new PayFanoutError({ code: "card_declined", message: "Declined.", retryable: false });
    };

    const run = await manager.chargeDueSubscriptions();
    expect(run.failed).toHaveLength(0);

    const record = await manager.retrieveSubscription("sub_1");
    expect(record.status).toBe("paused");
    expect(record.failedAttempts).toBe(0); // no past_due ghost
    expect(record.nextRetryAt).toBeUndefined();
  });

  it("a paused trial resumes to active; the deferred first charge still happens at startAt", async () => {
    const { manager, charges, clock } = harness();
    await create(manager, { startAt: new Date(T0 + 14 * DAY) });
    await manager.pauseSubscription("sub_1");
    clock.now = T0 + 2 * DAY;
    const resumed = await manager.resumeSubscription("sub_1", { idempotencyKey: "k" });
    expect(resumed.status).toBe("active");
    expect(charges).toHaveLength(0);

    clock.now = T0 + 15 * DAY;
    expect((await manager.chargeDueSubscriptions()).charged).toHaveLength(1);
  });
});

describe("trials", () => {
  it("validates the psp eagerly on the trial path — nothing persists on misconfiguration", async () => {
    const vaultless = new FakeAdapter(); // supportsSavedPaymentMethods: false
    const service = new PaymentService({ adapters: [vaultless] });
    const store = new InMemorySubscriptionStore();
    const manager = new SubscriptionManager({ service, store, now: () => T0 });

    const trialInput = {
      pspCustomerId: "cust_1",
      savedPaymentMethodToken: "tok_saved",
      plan: PLAN,
      id: "sub_trial",
      startAt: new Date(T0 + DAY),
      idempotencyKey: "k",
    };
    await expect(manager.createSubscription({ ...trialInput, pspName: "fake" })).rejects.toMatchObject({
      code: "unsupported_operation",
    });
    await expect(manager.createSubscription({ ...trialInput, pspName: "ghost" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(await store.get("sub_trial")).toBeUndefined();
  });

  it("a trial's failed first charge enters dunning like any renewal", async () => {
    const { manager, clock, scriptNext } = harness();
    await create(manager, { startAt: new Date(T0 + DAY) });
    clock.now = T0 + DAY + 1;
    scriptNext("declined");
    const run = await manager.chargeDueSubscriptions();
    expect(run.failed).toHaveLength(1);
    expect((await manager.retrieveSubscription("sub_1")).status).toBe("past_due");
  });
});

describe("subscription.updated and event timestamps", () => {
  it("updateSubscription and the atPeriodEnd flag emit subscription.updated", async () => {
    const { manager, events } = harness();
    await create(manager);
    events.length = 0;
    await manager.updateSubscription("sub_1", { metadata: { tier: "pro" } });
    await manager.cancelSubscription("sub_1", { atPeriodEnd: true });
    expect(events.map((e) => e.type)).toEqual(["subscription.updated", "subscription.updated"]);
  });

  it("every event carries occurredAt from the manager clock", async () => {
    const { manager, clock, events } = harness();
    await create(manager);
    expect(events.map((e) => e.type)).toEqual(["subscription.created", "subscription.charged"]);
    for (const event of events) expect(event.occurredAt).toBe(new Date(T0).toISOString());

    events.length = 0;
    clock.now = Date.parse("2026-03-01T00:00:00.000Z");
    await manager.chargeDueSubscriptions();
    expect(events.map((e) => e.type)).toEqual(["subscription.charged"]);
    expect(events[0]!.occurredAt).toBe("2026-03-01T00:00:00.000Z");
  });
});
