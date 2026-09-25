import { describe, expect, it } from "vitest";
import { PayFanoutError, type ChargeSavedPaymentMethodInput, type PaymentInfo } from "@payfanout/core";
import {
  InMemorySubscriptionStore,
  parseRenewalIdempotencyKey,
  PaymentService,
  SubscriptionManager,
  type SubscriptionEvent,
  type SubscriptionManagerOptions,
  type SubscriptionRecord,
} from "../src/index.js";
import { FakeAdapter, makePaymentInfo } from "./fake-adapter.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-01-31T10:00:00.000Z");
const PERIOD_END = "2026-02-28T10:00:00.000Z";
const NEXT_PERIOD_END = "2026-03-31T10:00:00.000Z";
const DUE = Date.parse(PERIOD_END) + 1000;

const renewalKey = (attempt: number, periodEnd = PERIOD_END): string =>
  `payfanout-sub-sub_1-${periodEnd}-a${attempt}`;

/**
 * What the PSP does with a charge under a key it has not seen:
 * - ok / declined / processing_error: processed, and the answer is kept for the key;
 * - lost: processed and charged, but the answer never arrives;
 * - down / rate_limited: refused before processing, nothing is kept;
 * - unknown_outcome: the adapter cannot tell and says so (outcomeUnknown), nothing is kept;
 * - crash: the adapter throws something that is not a PayFanoutError.
 */
type PspOutcome = "ok" | "declined" | "processing_error" | "lost" | "down" | "rate_limited" | "unknown_outcome" | "crash";

interface KeptAnswer {
  fingerprint: string;
  payment?: PaymentInfo;
  error?: PayFanoutError;
}

/**
 * A PSP with an idempotency layer: a key replays its kept answer, and a
 * reused key carrying other parameters is refused.
 */
function pspHarness(options: Partial<SubscriptionManagerOptions> = {}) {
  const adapter = new FakeAdapter({ capabilities: { supportsSavedPaymentMethods: true } });
  const kept = new Map<string, KeptAnswer>();
  const script: PspOutcome[] = [];
  const charges: ChargeSavedPaymentMethodInput[] = [];
  let sequence = 0;
  const psp = async (input: ChargeSavedPaymentMethodInput): Promise<PaymentInfo> => {
    charges.push(input);
    const fingerprint = JSON.stringify([
      input.savedPaymentMethodToken,
      input.amount,
      input.currency,
      input.metadata ?? null,
      input.billingDetails ?? null,
    ]);
    const answer = kept.get(input.idempotencyKey);
    if (answer) {
      if (answer.fingerprint !== fingerprint) {
        throw new PayFanoutError({ code: "invalid_request", message: "Key reused with other parameters.", retryable: false });
      }
      if (answer.error) throw answer.error;
      return answer.payment!;
    }
    const outcome = script.shift() ?? "ok";
    const payment = makePaymentInfo({
      pspName: "fake",
      pspPaymentId: `pay_${++sequence}`,
      amount: input.amount,
      currency: input.currency,
    });
    switch (outcome) {
      case "ok":
        kept.set(input.idempotencyKey, { fingerprint, payment });
        return payment;
      case "lost":
        kept.set(input.idempotencyKey, { fingerprint, payment });
        throw new PayFanoutError({ code: "psp_unavailable", message: "Timed out.", retryable: true });
      case "declined": {
        const error = new PayFanoutError({ code: "card_declined", message: "Declined.", retryable: false });
        kept.set(input.idempotencyKey, { fingerprint, error });
        throw error;
      }
      case "processing_error": {
        const error = new PayFanoutError({ code: "processing_error", message: "Try again.", retryable: true });
        kept.set(input.idempotencyKey, { fingerprint, error });
        throw error;
      }
      case "down":
        throw new PayFanoutError({ code: "psp_unavailable", message: "Down.", retryable: true });
      case "rate_limited":
        throw new PayFanoutError({ code: "rate_limited", message: "Slow down.", retryable: true });
      case "unknown_outcome":
        throw new PayFanoutError({ code: "processing_error", message: "Unanswered.", retryable: false, outcomeUnknown: true });
      case "crash":
        throw new TypeError("adapter bug");
    }
  };
  adapter.chargeSavedPaymentMethod = psp;
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
    ...options,
  });
  return {
    manager,
    adapter,
    psp,
    store,
    clock,
    events,
    charges,
    script,
    /** Charges that moved money: the first charge plus every collected renewal. */
    collected: () => [...kept.values()].filter((answer) => answer.payment !== undefined).length,
    renewalKeys: () => charges.slice(1).map((c) => c.idempotencyKey),
  };
}

type Harness = ReturnType<typeof pspHarness>;

const create = (h: Harness) =>
  h.manager.createSubscription({
    pspName: "fake",
    pspCustomerId: "cust_1",
    savedPaymentMethodToken: "tok_saved",
    plan: { amount: 2500, currency: "usd", interval: "month" },
    id: "sub_1",
    idempotencyKey: "first-charge-key",
  });

const record = (h: Harness): Promise<SubscriptionRecord> => h.manager.retrieveSubscription("sub_1");

/** Advance the clock and run the cron once. */
async function runAt(h: Harness, at: number) {
  h.clock.now = at;
  return h.manager.chargeDueSubscriptions();
}

describe("renewal charges without a definitive answer are replayed under their key", () => {
  it("a lost answer is replayed as sent: the period is collected once", async () => {
    const h = pspHarness();
    await create(h);
    h.events.length = 0;

    h.script.push("lost");
    const first = await runAt(h, DUE);
    expect(first.failed).toHaveLength(1);
    expect(await record(h)).toMatchObject({
      status: "past_due",
      failedAttempts: 0, // nothing is known to have failed
      nextRetryAt: new Date(DUE + 5 * MINUTE).toISOString(),
      lastError: { code: "psp_unavailable" },
      renewalAttempt: {
        periodEnd: PERIOD_END,
        attempt: 0,
        replay: {
          idempotencyKey: renewalKey(0),
          request: { savedPaymentMethodToken: "tok_saved", amount: 2500, currency: "USD" },
          uncertainAnswers: 1,
          afterProcessingError: false,
        },
      },
    });
    expect(h.events.map((e) => e.type)).toEqual(["subscription.charge_failed", "subscription.past_due"]);

    await runAt(h, DUE + 4 * MINUTE); // still cooling down
    expect(h.charges).toHaveLength(2);

    const replay = await runAt(h, DUE + 5 * MINUTE);
    expect(replay.charged).toHaveLength(1);
    expect(h.renewalKeys()).toEqual([renewalKey(0), renewalKey(0)]);
    expect(h.collected()).toBe(2); // the first charge and ONE renewal
    const renewed = await record(h);
    expect(renewed).toMatchObject({
      status: "active",
      currentPeriodEnd: NEXT_PERIOD_END,
      failedAttempts: 0,
      lastPaymentId: "pay_2", // the charge whose answer was lost
    });
    expect(renewed.renewalAttempt).toBeUndefined();
    expect(renewed.nextRetryAt).toBeUndefined();
  });

  it.each([
    ["down", "psp_unavailable"],
    ["rate_limited", "rate_limited"],
    ["unknown_outcome", "processing_error"],
    ["crash", "unknown"],
  ] as const)("%s keeps the key and replays the request unchanged", async (outcome, code) => {
    const h = pspHarness();
    await create(h);
    h.script.push(outcome);
    await runAt(h, DUE);
    expect(await record(h)).toMatchObject({ lastError: { code }, renewalAttempt: { attempt: 0, replay: { uncertainAnswers: 1 } } });

    const replay = await runAt(h, DUE + 5 * MINUTE);
    expect(replay.charged).toHaveLength(1);
    expect(h.renewalKeys()).toEqual([renewalKey(0), renewalKey(0)]);
    expect(h.charges[2]).toEqual(h.charges[1]); // the replay is the same request
  });

  it("a decline after an uncertain answer settles the attempt: the retry uses a new key", async () => {
    const h = pspHarness();
    await create(h);
    h.script.push("down", "declined");
    await runAt(h, DUE);
    const declinedAt = DUE + 5 * MINUTE;
    await runAt(h, declinedAt);
    const declined = await record(h);
    expect(declined).toMatchObject({
      status: "past_due",
      failedAttempts: 1,
      nextRetryAt: new Date(declinedAt + 24 * HOUR).toISOString(),
      renewalAttempt: { periodEnd: PERIOD_END, attempt: 1 },
      lastError: { code: "card_declined" },
    });
    expect(declined.renewalAttempt?.replay).toBeUndefined();

    const retry = await runAt(h, declinedAt + 24 * HOUR);
    expect(retry.charged).toHaveLength(1);
    expect(h.renewalKeys()).toEqual([renewalKey(0), renewalKey(0), renewalKey(1)]);
  });

  it("a processing_error is replayed once, then counts as the attempt's own failure", async () => {
    const h = pspHarness();
    await create(h);
    h.script.push("processing_error");
    await runAt(h, DUE);
    expect(await record(h)).toMatchObject({
      failedAttempts: 0,
      renewalAttempt: { attempt: 0, replay: { afterProcessingError: true, uncertainAnswers: 1 } },
    });

    const repliedAt = DUE + 5 * MINUTE;
    await runAt(h, repliedAt); // the PSP replays the kept processing_error
    expect(await record(h)).toMatchObject({
      failedAttempts: 1,
      nextRetryAt: new Date(repliedAt + 24 * HOUR).toISOString(),
      renewalAttempt: { attempt: 1 },
    });

    expect((await runAt(h, repliedAt + 24 * HOUR)).charged).toHaveLength(1);
    expect(h.renewalKeys()).toEqual([renewalKey(0), renewalKey(0), renewalKey(1)]);
    expect(h.collected()).toBe(2);
  });

  it("an error marked outcomeUnknown keeps its key however often it repeats", async () => {
    const h = pspHarness();
    await create(h);
    h.script.push("unknown_outcome", "unknown_outcome", "unknown_outcome", "ok");
    await runAt(h, DUE);
    await runAt(h, DUE + 5 * MINUTE);
    expect(await record(h)).toMatchObject({
      failedAttempts: 0,
      nextRetryAt: new Date(DUE + 35 * MINUTE).toISOString(),
      renewalAttempt: { attempt: 0, replay: { uncertainAnswers: 2, afterProcessingError: false } },
    });
    await runAt(h, DUE + 35 * MINUTE);
    const collected = await runAt(h, DUE + 155 * MINUTE);
    expect(collected.charged).toHaveLength(1);
    expect(h.renewalKeys()).toEqual([renewalKey(0), renewalKey(0), renewalKey(0), renewalKey(0)]);
  });

  it("outcomeUnknown wins over a code that would otherwise settle the attempt", async () => {
    const h = pspHarness();
    await create(h);
    h.adapter.chargeSavedPaymentMethod = async (input) => {
      h.charges.push(input);
      throw new PayFanoutError({ code: "invalid_request", message: "Refused on replay.", outcomeUnknown: true });
    };
    await runAt(h, DUE);
    expect(await record(h)).toMatchObject({
      failedAttempts: 0,
      lastError: { code: "invalid_request" },
      renewalAttempt: { attempt: 0, replay: { idempotencyKey: renewalKey(0), afterProcessingError: false } },
    });
    h.adapter.chargeSavedPaymentMethod = h.psp;
    await runAt(h, DUE + 5 * MINUTE);
    expect(h.charges.map((c) => c.idempotencyKey)).toEqual(["first-charge-key", renewalKey(0), renewalKey(0)]);
  });

  it("a pin that outlives its replays is frozen: nothing more is sent until it is settled", async () => {
    const h = pspHarness({ replayDelaysMinutes: [5] });
    await create(h);
    h.events.length = 0;
    h.script.push("down", "down");
    await runAt(h, DUE);
    const frozenAt = DUE + 5 * MINUTE;
    const run = await runAt(h, frozenAt);
    expect(run.pending).toHaveLength(1);
    const frozen = await record(h);
    expect(frozen).toMatchObject({
      status: "past_due",
      failedAttempts: 0, // an unsettled charge never counts for dunning
      renewalAttempt: { attempt: 0, replay: { idempotencyKey: renewalKey(0), uncertainAnswers: 2, frozen: true } },
    });
    expect(frozen.nextRetryAt).toBeUndefined();
    expect(h.events.map((e) => e.type)).toEqual([
      "subscription.charge_failed",
      "subscription.past_due",
      "subscription.charge_failed",
      "subscription.charge_pending",
    ]);

    await runAt(h, frozenAt + 5 * MINUTE); // still inside the window, but the schedule is spent
    await runAt(h, frozenAt + 30 * 24 * HOUR);
    expect(h.renewalKeys()).toEqual([renewalKey(0), renewalKey(0)]); // never replayed past the schedule

    const settled = await h.manager.resolvePendingRenewal("sub_1", {
      status: "succeeded",
      pspPaymentId: "pay_found",
      idempotencyKey: renewalKey(0),
    });
    expect(settled).toMatchObject({ status: "active", currentPeriodEnd: NEXT_PERIOD_END, lastPaymentId: "pay_found" });
    expect(settled.renewalAttempt).toBeUndefined();
  });

  it("an empty replay schedule freezes the charge at its first uncertain answer", async () => {
    const h = pspHarness({ replayDelaysMinutes: [] });
    await create(h);
    h.script.push("down");
    const run = await runAt(h, DUE);
    expect(run.pending).toHaveLength(1);
    expect(await record(h)).toMatchObject({
      failedAttempts: 0,
      renewalAttempt: { attempt: 0, replay: { uncertainAnswers: 1, frozen: true } },
    });
    await runAt(h, DUE + 48 * HOUR);
    expect(h.renewalKeys()).toEqual([renewalKey(0)]);
  });

  it("a replay is never scheduled past the replay window", async () => {
    const h = pspHarness({ replayDelaysMinutes: [5, 600], replayWindowHours: 2 });
    await create(h);
    h.script.push("down", "down");
    await runAt(h, DUE);
    expect(await record(h)).toMatchObject({ nextRetryAt: new Date(DUE + 5 * MINUTE).toISOString() });
    await runAt(h, DUE + 5 * MINUTE); // the next delay (10 hours) would land past the 2-hour window
    const frozen = await record(h);
    expect(frozen.renewalAttempt?.replay?.frozen).toBe(true);
    expect(frozen.nextRetryAt).toBeUndefined();
  });

  it("a cron run later than the window freezes the pin instead of replaying it", async () => {
    const h = pspHarness();
    await create(h);
    h.script.push("down");
    await runAt(h, DUE);
    const late = await runAt(h, DUE + 25 * HOUR); // the scheduled 5-minute replay never ran in time
    expect(late.pending).toHaveLength(1);
    expect(h.renewalKeys()).toEqual([renewalKey(0)]); // nothing sent: the PSP may no longer hold the key
    expect((await record(h)).renewalAttempt?.replay).toMatchObject({ frozen: true, uncertainAnswers: 1 });
  });

  it("settling a frozen pin as failed is a failed attempt: dunning resumes under a new key, and exhaustion still cancels", async () => {
    const h = pspHarness({ retryDelaysHours: [24], replayDelaysMinutes: [] });
    await create(h);
    h.script.push("down", "declined");
    await runAt(h, DUE);
    const settledAt = DUE + 3 * HOUR;
    h.clock.now = settledAt;
    const failed = await h.manager.resolvePendingRenewal("sub_1", { status: "failed", idempotencyKey: renewalKey(0) });
    expect(failed).toMatchObject({
      status: "past_due",
      failedAttempts: 1,
      nextRetryAt: new Date(settledAt + 24 * HOUR).toISOString(),
      renewalAttempt: { periodEnd: PERIOD_END, attempt: 1 },
    });
    expect(failed.renewalAttempt?.replay).toBeUndefined();

    const final = await runAt(h, settledAt + 24 * HOUR);
    expect(final.canceled).toHaveLength(1);
    expect(h.renewalKeys()).toEqual([renewalKey(0), renewalKey(1)]);
  });

  it("exhausting dunning on a definitive failure leaves no attempt state behind", async () => {
    const h = pspHarness({ retryDelaysHours: [] });
    await create(h);
    h.script.push("declined");
    await runAt(h, DUE);
    const canceled = await record(h);
    expect(canceled.status).toBe("canceled");
    expect(canceled.renewalAttempt).toBeUndefined();
  });
});

describe("attempt numbers are never reused for another request", () => {
  it("a new card is charged under a key the period has not used", async () => {
    const h = pspHarness();
    await create(h);
    h.script.push("declined");
    await runAt(h, DUE);
    const updated = await h.manager.updateSubscription("sub_1", { savedPaymentMethodToken: "tok_new" });
    expect(updated).toMatchObject({ failedAttempts: 0, renewalAttempt: { periodEnd: PERIOD_END, attempt: 1 } });
    // Due at once, and still visible to a store that filters on nextRetryAt.
    expect(updated.nextRetryAt).toBe(new Date(h.clock.now).toISOString());

    const run = await h.manager.chargeDueSubscriptions();
    expect(run.charged).toHaveLength(1);
    expect(h.charges.slice(1).map((c) => [c.idempotencyKey, c.savedPaymentMethodToken])).toEqual([
      [renewalKey(0), "tok_saved"],
      [renewalKey(1), "tok_new"],
    ]);
  });

  it("a token change on a fresh period stores no attempt state", async () => {
    const h = pspHarness();
    await create(h);
    const updated = await h.manager.updateSubscription("sub_1", { savedPaymentMethodToken: "tok_new" });
    expect(updated.renewalAttempt).toBeUndefined();
    await runAt(h, DUE);
    expect(h.renewalKeys()).toEqual([renewalKey(0)]);
  });

  it("records written before renewalAttempt existed derive the attempt from failedAttempts, and a token change carries it on", async () => {
    const h = pspHarness();
    const legacy: SubscriptionRecord = {
      id: "sub_1",
      pspName: "fake",
      pspCustomerId: "cust_1",
      savedPaymentMethodToken: "tok_saved",
      plan: { amount: 2500, currency: "USD", interval: "month", intervalCount: 1 },
      status: "past_due",
      currentPeriodStart: "2026-01-31T10:00:00.000Z",
      currentPeriodEnd: PERIOD_END,
      anchorDay: 31,
      cancelAtPeriodEnd: false,
      failedAttempts: 2,
      nextRetryAt: new Date(DUE).toISOString(),
      lastError: { code: "card_declined", message: "Declined." },
      createdAt: "2026-01-31T10:00:00.000Z",
    };
    await h.store.save(legacy);
    const updated = await h.manager.updateSubscription("sub_1", { savedPaymentMethodToken: "tok_new" });
    expect(updated).toMatchObject({ failedAttempts: 0, renewalAttempt: { periodEnd: PERIOD_END, attempt: 2 } });
    await runAt(h, DUE);
    expect(h.charges.map((c) => [c.idempotencyKey, c.savedPaymentMethodToken])).toEqual([[renewalKey(2), "tok_new"]]);

    const untouched = pspHarness();
    await untouched.store.save({ ...legacy, id: "sub_1" });
    await runAt(untouched, DUE);
    expect(untouched.charges.map((c) => c.idempotencyKey)).toEqual([renewalKey(2)]);
  });

  it("a replaced card's unsettled charge is replayed first; its decline lets the new card go on the next run", async () => {
    const h = pspHarness();
    await create(h);
    h.events.length = 0;
    h.script.push("down");
    await runAt(h, DUE);
    const updated = await h.manager.updateSubscription("sub_1", { savedPaymentMethodToken: "tok_new" });
    expect(updated.renewalAttempt?.replay?.request.savedPaymentMethodToken).toBe("tok_saved");

    h.script.push("declined");
    const replay = await h.manager.chargeDueSubscriptions();
    expect(replay.failed).toHaveLength(1);
    const afterReplay = await record(h);
    expect(afterReplay).toMatchObject({
      status: "past_due",
      failedAttempts: 0, // the replaced card's decline costs the new card nothing
      renewalAttempt: { attempt: 1 },
      lastError: { code: "card_declined" },
    });
    expect(afterReplay.nextRetryAt).toBe(new Date(DUE).toISOString()); // the new card is due at once

    const next = await h.manager.chargeDueSubscriptions();
    expect(next.charged).toHaveLength(1);
    expect(h.charges.slice(1).map((c) => [c.idempotencyKey, c.savedPaymentMethodToken])).toEqual([
      [renewalKey(0), "tok_saved"],
      [renewalKey(0), "tok_saved"],
      [renewalKey(1), "tok_new"],
    ]);
    expect(h.events.map((e) => e.type)).toEqual([
      "subscription.charge_failed",
      "subscription.past_due",
      "subscription.updated",
      "subscription.charge_failed",
      "subscription.charged",
    ]);
  });

  it("a replaced card's charge that did go through pays the period: the new card is not charged for it", async () => {
    const h = pspHarness();
    await create(h);
    h.script.push("lost");
    await runAt(h, DUE);
    await h.manager.updateSubscription("sub_1", { savedPaymentMethodToken: "tok_new" });
    const replay = await h.manager.chargeDueSubscriptions();
    expect(replay.charged).toHaveLength(1);
    expect(h.collected()).toBe(2);
    expect(h.charges.slice(1).map((c) => c.savedPaymentMethodToken)).toEqual(["tok_saved", "tok_saved"]);

    await runAt(h, Date.parse(NEXT_PERIOD_END) + 1000);
    expect(h.charges.at(-1)).toMatchObject({ savedPaymentMethodToken: "tok_new", idempotencyKey: renewalKey(0, NEXT_PERIOD_END) });
  });

  it("a plan or metadata change while pinned replays the original request", async () => {
    const h = pspHarness();
    await create(h);
    h.script.push("lost");
    await runAt(h, DUE);
    await h.manager.updateSubscription("sub_1", {
      plan: { amount: 4900, currency: "USD", interval: "month" },
      metadata: { tier: "pro" },
    });
    const replay = await runAt(h, DUE + 5 * MINUTE);
    expect(replay.charged).toHaveLength(1);
    expect(h.charges[2]).toEqual(h.charges[1]);
    expect(h.charges[2]).toMatchObject({ amount: 2500, metadata: { payfanout_subscription_id: "sub_1" } });

    await runAt(h, Date.parse(NEXT_PERIOD_END) + 1000);
    expect(h.charges.at(-1)).toMatchObject({ amount: 4900, metadata: { tier: "pro", payfanout_subscription_id: "sub_1" } });
  });
});

describe("settling a renewal charge without a definitive answer", () => {
  async function pinned(): Promise<Harness> {
    const h = pspHarness();
    await create(h);
    h.script.push("down");
    await runAt(h, DUE);
    h.events.length = 0;
    return h;
  }

  it("needs the pinned idempotency key, and a new payment id to settle as succeeded", async () => {
    const h = await pinned();
    const expectedKey = renewalKey(0);
    await expect(
      h.manager.resolvePendingRenewal("sub_1", { status: "succeeded", pspPaymentId: "pay_x" }),
    ).rejects.toThrowError(new RegExp(`settles only with idempotencyKey "${expectedKey}"`));
    await expect(
      h.manager.resolvePendingRenewal("sub_1", { status: "failed", idempotencyKey: renewalKey(1) }),
    ).rejects.toThrowError(/no pending renewal/);
    await expect(
      h.manager.resolvePendingRenewal("sub_1", { status: "succeeded", idempotencyKey: expectedKey }),
    ).rejects.toThrowError(/requires its pspPaymentId/);
    await expect(
      h.manager.resolvePendingRenewal("sub_1", { status: "succeeded", idempotencyKey: expectedKey, pspPaymentId: "pay_1" }),
    ).rejects.toThrowError(/already paid the previous period/);
    expect(h.events).toHaveLength(0);

    const settled = await h.manager.resolvePendingRenewal("sub_1", {
      status: "succeeded",
      idempotencyKey: expectedKey,
      pspPaymentId: "pay_found",
    });
    expect(settled).toMatchObject({
      status: "active",
      currentPeriodStart: PERIOD_END,
      currentPeriodEnd: NEXT_PERIOD_END,
      failedAttempts: 0,
      lastPaymentId: "pay_found",
    });
    expect(settled.renewalAttempt).toBeUndefined();
    expect(settled.nextRetryAt).toBeUndefined();
    expect(settled.lastError).toBeUndefined();
    expect(h.events.map((e) => e.type)).toEqual(["subscription.charged"]);

    // A re-delivered success is a no-op; the cron does not charge the settled period.
    await h.manager.resolvePendingRenewal("sub_1", { status: "succeeded", pspPaymentId: "pay_found" });
    expect(h.events).toHaveLength(1);
    await runAt(h, DUE + HOUR);
    expect(h.charges).toHaveLength(2);
  });

  it("settled as failed, the key is retired and the attempt counts for dunning", async () => {
    const h = await pinned();
    const settled = await h.manager.resolvePendingRenewal("sub_1", {
      status: "failed",
      idempotencyKey: renewalKey(0),
      error: { code: "card_declined", message: "Not found at the PSP." },
    });
    expect(settled).toMatchObject({
      status: "past_due",
      failedAttempts: 1,
      nextRetryAt: new Date(DUE + 24 * HOUR).toISOString(),
      renewalAttempt: { periodEnd: PERIOD_END, attempt: 1 },
      lastError: { code: "card_declined", message: "Not found at the PSP." },
    });
    expect(settled.renewalAttempt?.replay).toBeUndefined();
    expect(h.events.map((e) => e.type)).toEqual(["subscription.charge_failed", "subscription.past_due"]);

    // A re-delivered failure for the spent key changes nothing.
    await h.manager.resolvePendingRenewal("sub_1", { status: "failed", idempotencyKey: renewalKey(0) });
    expect(h.events).toHaveLength(2);

    await runAt(h, DUE + 24 * HOUR);
    expect(h.renewalKeys()).toEqual([renewalKey(0), renewalKey(1)]);

    const defaults = await pinned();
    const plain = await defaults.manager.resolvePendingRenewal("sub_1", { status: "failed", idempotencyKey: renewalKey(0) });
    expect(plain.lastError).toEqual({ code: "processing_error", message: "The renewal charge was not collected." });
  });

  it("resume refuses while a charge awaits a definitive answer; settling it unblocks resume", async () => {
    const h = await pinned();
    const paused = await h.manager.pauseSubscription("sub_1");
    expect(paused.renewalAttempt?.replay?.idempotencyKey).toBe(renewalKey(0));

    h.clock.now = DUE + 24 * HOUR;
    await expect(h.manager.resumeSubscription("sub_1", { idempotencyKey: "resume-key" })).rejects.toThrowError(
      new RegExp(`without a definitive answer .*"${renewalKey(0)}"`),
    );
    await h.manager.chargeDueSubscriptions(); // paused: never replayed by the cron
    expect(h.charges).toHaveLength(2);

    await h.manager.resolvePendingRenewal("sub_1", { status: "failed", idempotencyKey: renewalKey(0) });
    const resumed = await h.manager.resumeSubscription("sub_1", { idempotencyKey: "resume-key" });
    expect(resumed.status).toBe("active");
    expect(resumed.renewalAttempt).toBeUndefined();
    expect(h.charges.at(-1)).toMatchObject({ idempotencyKey: "resume-key", savedPaymentMethodToken: "tok_saved" });
  });

  it("a paused record settled as succeeded is paid through, so resume charges nothing", async () => {
    const h = await pinned();
    await h.manager.pauseSubscription("sub_1");
    const settled = await h.manager.resolvePendingRenewal("sub_1", {
      status: "succeeded",
      idempotencyKey: renewalKey(0),
      pspPaymentId: "pay_found",
    });
    expect(settled).toMatchObject({ status: "paused", currentPeriodEnd: NEXT_PERIOD_END });
    h.clock.now = DUE + 24 * HOUR;
    const resumed = await h.manager.resumeSubscription("sub_1", { idempotencyKey: "resume-key" });
    expect(resumed.status).toBe("active");
    expect(h.charges).toHaveLength(2);
  });
});

describe("guards around replays", () => {
  it("a replay the service can no longer send keeps the pin and moves no money", async () => {
    const h = pspHarness();
    await create(h);
    h.script.push("down");
    await runAt(h, DUE);

    const capabilities = h.adapter.getCapabilities();
    h.adapter.getCapabilities = () => ({ ...capabilities, supportsSavedPaymentMethods: false });
    await runAt(h, DUE + 5 * MINUTE);
    expect(h.charges).toHaveLength(2);
    expect(await record(h)).toMatchObject({
      failedAttempts: 0,
      lastError: { code: "unsupported_operation" },
      renewalAttempt: { attempt: 0, replay: { idempotencyKey: renewalKey(0), uncertainAnswers: 2 } },
    });

    h.adapter.getCapabilities = () => {
      throw new Error("adapter misconfigured");
    };
    await runAt(h, DUE + 35 * MINUTE);
    expect(h.charges).toHaveLength(2);
    expect(await record(h)).toMatchObject({ lastError: { code: "unknown" }, renewalAttempt: { replay: { uncertainAnswers: 3 } } });

    h.adapter.getCapabilities = () => capabilities;
    expect((await runAt(h, DUE + 155 * MINUTE)).charged).toHaveLength(1);
    expect(h.renewalKeys()).toEqual([renewalKey(0), renewalKey(0)]);
  });

  it("an answer overtaken by a concurrent run that collected the period is dropped", async () => {
    const h = pspHarness();
    await create(h);
    let overtaken = false;
    h.adapter.chargeSavedPaymentMethod = async (input) => {
      if (!overtaken) {
        overtaken = true;
        await h.manager.chargeDueSubscriptions(); // a concurrent run collects under the same key
        throw new PayFanoutError({ code: "psp_unavailable", message: "Timed out.", retryable: true });
      }
      return h.psp(input);
    };
    const slow = await runAt(h, DUE);
    expect(slow.failed).toHaveLength(0);
    const renewed = await record(h);
    expect(renewed).toMatchObject({ status: "active", currentPeriodEnd: NEXT_PERIOD_END });
    expect(renewed.renewalAttempt).toBeUndefined();
    expect(renewed.lastError).toBeUndefined();
  });

  it("a stale uncertain answer never rewinds an attempt a concurrent run settled", async () => {
    const h = pspHarness();
    await create(h);
    let overtaken = false;
    h.adapter.chargeSavedPaymentMethod = async (input) => {
      if (!overtaken) {
        overtaken = true;
        h.script.push("declined");
        await h.manager.chargeDueSubscriptions(); // a concurrent run gets the decline
        throw new PayFanoutError({ code: "psp_unavailable", message: "Timed out.", retryable: true });
      }
      return h.psp(input);
    };
    await runAt(h, DUE);
    const settled = await record(h);
    expect(settled).toMatchObject({ failedAttempts: 1, renewalAttempt: { attempt: 1 }, lastError: { code: "card_declined" } });
    expect(settled.renewalAttempt?.replay).toBeUndefined();
  });

  it("a pause landing during an uncertain charge keeps the pin and records the error", async () => {
    const h = pspHarness();
    await create(h);
    h.events.length = 0;
    h.adapter.chargeSavedPaymentMethod = async () => {
      await h.manager.pauseSubscription("sub_1");
      throw new PayFanoutError({ code: "psp_unavailable", message: "Timed out.", retryable: true });
    };
    const run = await runAt(h, DUE);
    expect(run.failed).toHaveLength(0);
    const paused = await record(h);
    expect(paused).toMatchObject({
      status: "paused",
      failedAttempts: 0,
      lastError: { code: "psp_unavailable" },
      renewalAttempt: { attempt: 0, replay: { idempotencyKey: renewalKey(0) } },
    });
    expect(paused.nextRetryAt).toBeUndefined();
    expect(h.events.map((e) => e.type)).toEqual(["subscription.paused", "subscription.charge_failed"]);
    await expect(h.manager.resumeSubscription("sub_1", { idempotencyKey: "k" })).rejects.toThrowError(/definitive answer/);
  });
});

describe("pending renewals keep their own attempt numbers", () => {
  it("a failed pending renewal moves to the next key without overwriting the dunning count", async () => {
    const h = pspHarness();
    await create(h);
    h.script.push("declined");
    await runAt(h, DUE);
    // The retry lands on async rails and awaits its webhook.
    h.adapter.chargeSavedPaymentMethod = async (input) => {
      h.charges.push(input);
      return makePaymentInfo({ pspName: "fake", pspPaymentId: "pay_async", amount: input.amount, currency: input.currency, status: "processing" });
    };
    const pendingAt = DUE + 24 * HOUR;
    await runAt(h, pendingAt);
    expect(await record(h)).toMatchObject({
      pendingRenewal: { pspPaymentId: "pay_async", attempt: 1 },
      renewalAttempt: { attempt: 1 },
      failedAttempts: 1,
    });

    // A new card while the charge is pending: the dunning count restarts, and
    // the old card's failure costs the new card nothing.
    await h.manager.updateSubscription("sub_1", { savedPaymentMethodToken: "tok_new" });
    const failed = await h.manager.resolvePendingRenewal("sub_1", { status: "failed", pspPaymentId: "pay_async" });
    expect(failed).toMatchObject({
      status: "past_due",
      failedAttempts: 0,
      nextRetryAt: new Date(pendingAt).toISOString(),
      renewalAttempt: { periodEnd: PERIOD_END, attempt: 2 },
    });
    expect(failed.pendingRenewal).toBeUndefined();

    h.adapter.chargeSavedPaymentMethod = h.psp;
    await runAt(h, Date.parse(failed.nextRetryAt!));
    expect(h.charges.slice(1).map((c) => [c.idempotencyKey, c.savedPaymentMethodToken])).toEqual([
      [renewalKey(0), "tok_saved"],
      [renewalKey(1), "tok_saved"],
      [renewalKey(2), "tok_new"],
    ]);
  });

  it("a replay answered as processing resolves the pin into a pending renewal", async () => {
    const h = pspHarness();
    await create(h);
    h.script.push("down");
    await runAt(h, DUE);
    h.adapter.chargeSavedPaymentMethod = async (input) => {
      h.charges.push(input);
      return makePaymentInfo({ pspName: "fake", pspPaymentId: "pay_async", amount: input.amount, currency: input.currency, status: "processing" });
    };
    const run = await runAt(h, DUE + 5 * MINUTE);
    expect(run.pending).toHaveLength(1);
    const pending = await record(h);
    expect(pending).toMatchObject({
      pendingRenewal: { pspPaymentId: "pay_async", attempt: 0 },
      renewalAttempt: { periodEnd: PERIOD_END, attempt: 0 },
    });
    expect(pending.renewalAttempt?.replay).toBeUndefined();
  });

  it("a failed resume charge that was pending leaves the renewal numbering alone", async () => {
    const h = pspHarness();
    await create(h);
    await h.manager.pauseSubscription("sub_1");
    h.adapter.chargeSavedPaymentMethod = async (input) => {
      h.charges.push(input);
      return makePaymentInfo({ pspName: "fake", pspPaymentId: "pay_resume", amount: input.amount, currency: input.currency, status: "processing" });
    };
    h.clock.now = Date.parse("2026-04-15T12:00:00.000Z");
    await h.manager.resumeSubscription("sub_1", { idempotencyKey: "resume-key" });
    const failed = await h.manager.resolvePendingRenewal("sub_1", { status: "failed", pspPaymentId: "pay_resume" });
    expect(failed.status).toBe("paused");
    expect(failed.pendingRenewal).toBeUndefined();
    expect(failed.renewalAttempt).toBeUndefined();
  });
});

describe("the renewal key rides every charge", () => {
  it("stamps payfanout_renewal_key into the metadata, identical on a replay", async () => {
    const h = pspHarness();
    await create(h);
    h.script.push("down");
    await runAt(h, DUE);
    await runAt(h, DUE + 5 * MINUTE);
    expect(h.charges[1]!.metadata).toEqual({ payfanout_subscription_id: "sub_1", payfanout_renewal_key: renewalKey(0) });
    expect(h.charges[2]).toEqual(h.charges[1]);
  });

  it("a late failure webhook for an earlier attempt cannot retire the current pin", async () => {
    const h = pspHarness();
    await create(h);
    h.script.push("declined", "lost");
    await runAt(h, DUE); // a0 declined
    await runAt(h, DUE + 24 * HOUR); // a1 charged, its answer lost
    expect((await record(h)).renewalAttempt?.replay?.idempotencyKey).toBe(renewalKey(1));

    // The a0 decline's webhook arrives late; its metadata names a0, not the pin.
    const late = await h.manager.resolvePendingRenewal("sub_1", {
      status: "failed",
      pspPaymentId: "pay_2",
      idempotencyKey: h.charges[1]!.metadata!["payfanout_renewal_key"],
    });
    expect(late.renewalAttempt?.replay?.idempotencyKey).toBe(renewalKey(1));

    // The a1 success webhook settles the pin; the period is collected once.
    await h.manager.resolvePendingRenewal("sub_1", {
      status: "succeeded",
      pspPaymentId: "pay_3",
      idempotencyKey: h.charges[2]!.metadata!["payfanout_renewal_key"],
    });
    await runAt(h, DUE + 48 * HOUR);
    expect(h.collected()).toBe(2);
    expect(h.renewalKeys()).toEqual([renewalKey(0), renewalKey(1)]);
  });
});

describe("definitive answers move on at once", () => {
  it.each(["invalid_request", "session_expired", "unsupported_operation"] as const)(
    "%s settles the attempt",
    async (code) => {
      const h = pspHarness();
      await create(h);
      h.adapter.chargeSavedPaymentMethod = async (input) => {
        h.charges.push(input);
        throw new PayFanoutError({ code, message: "Refused.", retryable: false });
      };
      await runAt(h, DUE);
      const settled = await record(h);
      expect(settled).toMatchObject({ failedAttempts: 1, renewalAttempt: { attempt: 1 } });
      expect(settled.renewalAttempt?.replay).toBeUndefined();
    },
  );

  it("a processing_error replay that meets an outage first still counts the second processing_error", async () => {
    const h = pspHarness();
    await create(h);
    let calls = 0;
    h.adapter.chargeSavedPaymentMethod = async (input) => {
      h.charges.push(input);
      calls += 1;
      if (calls === 2) throw new PayFanoutError({ code: "psp_unavailable", message: "Down.", retryable: true });
      throw new PayFanoutError({ code: "processing_error", message: "Try again.", retryable: true });
    };
    await runAt(h, DUE);
    await runAt(h, DUE + 5 * MINUTE);
    expect((await record(h)).renewalAttempt?.replay?.afterProcessingError).toBe(true);
    await runAt(h, DUE + 35 * MINUTE);
    expect(await record(h)).toMatchObject({ failedAttempts: 1, renewalAttempt: { attempt: 1 } });
  });

  it("an in-flight decline of a card replaced meanwhile costs the new card nothing", async () => {
    const h = pspHarness();
    await create(h);
    h.adapter.chargeSavedPaymentMethod = async (input) => {
      h.charges.push(input);
      await h.manager.updateSubscription("sub_1", { savedPaymentMethodToken: "tok_new" });
      throw new PayFanoutError({ code: "card_declined", message: "Declined.", retryable: false });
    };
    await runAt(h, DUE);
    const after = await record(h);
    expect(after).toMatchObject({ failedAttempts: 0, renewalAttempt: { attempt: 1 }, savedPaymentMethodToken: "tok_new" });
    h.adapter.chargeSavedPaymentMethod = h.psp;
    await h.manager.chargeDueSubscriptions();
    expect(h.charges.at(-1)).toMatchObject({ idempotencyKey: renewalKey(1), savedPaymentMethodToken: "tok_new" });
  });
});

describe("answers that arrive after the period moved on", () => {
  it("a success after the period was settled does not advance it twice", async () => {
    const h = pspHarness();
    await create(h);
    let first = true;
    h.adapter.chargeSavedPaymentMethod = async (input) => {
      const payment = await h.psp(input);
      if (first) {
        first = false;
        await h.manager.chargeDueSubscriptions(); // an overlapping run collects under the same key
      }
      return payment;
    };
    h.events.length = 0;
    const outer = await runAt(h, DUE);
    expect((await record(h)).currentPeriodEnd).toBe(NEXT_PERIOD_END);
    expect(outer.charged).toHaveLength(0); // the overlapping run reported it
    expect(h.events.filter((e) => e.type === "subscription.charged")).toHaveLength(1);
  });

  it("a processing answer after the period was collected freezes nothing", async () => {
    const h = pspHarness();
    await create(h);
    let first = true;
    h.adapter.chargeSavedPaymentMethod = async (input) => {
      if (first) {
        first = false;
        h.adapter.chargeSavedPaymentMethod = h.psp;
        await h.manager.chargeDueSubscriptions(); // an overlapping run collects the period
        return makePaymentInfo({ pspName: "fake", pspPaymentId: "pay_late", amount: input.amount, currency: input.currency, status: "processing" });
      }
      return h.psp(input);
    };
    const outer = await runAt(h, DUE);
    expect(outer.pending).toHaveLength(0);
    const after = await record(h);
    expect(after.currentPeriodEnd).toBe(NEXT_PERIOD_END);
    expect(after.pendingRenewal).toBeUndefined();
  });

  it("a stale uncertain answer never clears a pending renewal of the same attempt", async () => {
    const h = pspHarness();
    await create(h);
    let first = true;
    h.adapter.chargeSavedPaymentMethod = async (input) => {
      h.charges.push(input);
      if (first) {
        first = false;
        const slow = makePaymentInfo({ pspName: "fake", pspPaymentId: "pay_async", amount: input.amount, currency: input.currency, status: "processing" });
        h.adapter.chargeSavedPaymentMethod = async () => slow;
        await h.manager.chargeDueSubscriptions(); // an overlapping run gets "processing"
        throw new PayFanoutError({ code: "psp_unavailable", message: "Timed out.", retryable: true });
      }
      throw new Error("unexpected");
    };
    await runAt(h, DUE);
    const after = await record(h);
    expect(after.pendingRenewal).toMatchObject({ pspPaymentId: "pay_async", attempt: 0 });
    expect(after.renewalAttempt?.replay).toBeUndefined();
    const resolved = await h.manager.resolvePendingRenewal("sub_1", { status: "succeeded", pspPaymentId: "pay_async" });
    expect(resolved.currentPeriodEnd).toBe(NEXT_PERIOD_END);
  });

  it("a replay answered as processing after the pin was settled as failed still resolves", async () => {
    const h = pspHarness();
    await create(h);
    h.script.push("down");
    await runAt(h, DUE);
    h.adapter.chargeSavedPaymentMethod = async (input) => {
      h.charges.push(input);
      // The host settles the pin as failed while the replay is in flight.
      await h.manager.resolvePendingRenewal("sub_1", { status: "failed", idempotencyKey: renewalKey(0) });
      return makePaymentInfo({ pspName: "fake", pspPaymentId: "pay_async", amount: input.amount, currency: input.currency, status: "processing" });
    };
    await runAt(h, DUE + 5 * MINUTE);
    const pending = await record(h);
    expect(pending.pendingRenewal).toMatchObject({ pspPaymentId: "pay_async", attempt: 0 });
    expect(pending.renewalAttempt).toMatchObject({ attempt: 1 });

    const failed = await h.manager.resolvePendingRenewal("sub_1", { status: "failed", pspPaymentId: "pay_async" });
    expect(failed.pendingRenewal).toBeUndefined();
    expect(failed.renewalAttempt).toMatchObject({ attempt: 1 });
  });
});

describe("stores that drop renewalAttempt", () => {
  it("fall back to counting uncertain failures for dunning instead of replaying forever", async () => {
    const h = pspHarness({ retryDelaysHours: [24] });
    const save = h.store.save.bind(h.store);
    h.store.save = async (record) => {
      const { renewalAttempt: _dropped, ...rest } = record;
      return save(rest as SubscriptionRecord);
    };
    await create(h);
    h.script.push("down", "down", "down");
    await runAt(h, DUE); // pinned in memory, dropped by the store
    await runAt(h, DUE + 5 * MINUTE); // the last answer was uncertain, no pin survived
    expect(await record(h)).toMatchObject({ status: "past_due", failedAttempts: 1 });
    await runAt(h, DUE + 5 * MINUTE + 24 * HOUR);
    expect((await record(h)).status).toBe("canceled");
    expect(h.charges.length - 1).toBe(3); // bounded, as before pins existed
  });
});

describe("cancelAtPeriodEnd over an unsettled charge", () => {
  it("replays the charge first: a charge that went through keeps the subscription to its new end", async () => {
    const h = pspHarness();
    await create(h);
    h.script.push("lost");
    await runAt(h, DUE);
    await h.manager.cancelSubscription("sub_1", { atPeriodEnd: true });
    const replay = await runAt(h, DUE + 5 * MINUTE);
    expect(replay.charged).toHaveLength(1);
    expect(await record(h)).toMatchObject({ status: "active", currentPeriodEnd: NEXT_PERIOD_END });
    expect(h.collected()).toBe(2);

    const ended = await runAt(h, Date.parse(NEXT_PERIOD_END) + 1000);
    expect(ended.canceled).toHaveLength(1);
    expect(h.renewalKeys()).toEqual([renewalKey(0), renewalKey(0)]); // never charged for the period after
  });

  it("ends the subscription without a new charge once the replay is declined", async () => {
    const h = pspHarness();
    await create(h);
    h.script.push("down", "declined");
    await runAt(h, DUE);
    await h.manager.cancelSubscription("sub_1", { atPeriodEnd: true });
    await runAt(h, DUE + 5 * MINUTE); // the replay is declined: nothing was paid
    const ended = await runAt(h, DUE + 5 * MINUTE + 24 * HOUR);
    expect(ended.canceled).toHaveLength(1);
    expect(h.renewalKeys()).toEqual([renewalKey(0), renewalKey(0)]);
  });

  it("waits for a frozen charge to be settled", async () => {
    const h = pspHarness({ replayDelaysMinutes: [] });
    await create(h);
    h.script.push("down");
    await runAt(h, DUE);
    await h.manager.cancelSubscription("sub_1", { atPeriodEnd: true });
    await runAt(h, DUE + 48 * HOUR);
    expect((await record(h)).status).toBe("past_due");
    await h.manager.resolvePendingRenewal("sub_1", { status: "failed", idempotencyKey: renewalKey(0) });
    const ended = await runAt(h, DUE + 96 * HOUR);
    expect(ended.canceled).toHaveLength(1);
  });
});

describe("parseRenewalIdempotencyKey", () => {
  it("reads back the subscription, period and attempt, and nothing from another key", () => {
    expect(parseRenewalIdempotencyKey(renewalKey(3))).toEqual({ subscriptionId: "sub_1", periodEnd: PERIOD_END, attempt: 3 });
    const uuid = "7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
    expect(parseRenewalIdempotencyKey(`payfanout-sub-${uuid}-${PERIOD_END}-a0`)?.subscriptionId).toBe(uuid);
    expect(parseRenewalIdempotencyKey("first-charge-key")).toBeUndefined();
    expect(parseRenewalIdempotencyKey(`payfanout-sub-sub_1-${PERIOD_END}-a`)).toBeUndefined();
  });
});

describe("replay window validation", () => {
  it("rejects a window that schedules nothing", () => {
    expect(() => pspHarness({ replayWindowHours: 0 })).toThrowError(/replayWindowHours/);
    expect(() => pspHarness({ replayWindowHours: Number.POSITIVE_INFINITY })).toThrowError(/replayWindowHours/);
  });
});
