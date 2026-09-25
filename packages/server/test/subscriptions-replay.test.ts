import { describe, expect, it } from "vitest";
import { PayFanoutError, type ChargeSavedPaymentMethodInput, type PaymentInfo } from "@payfanout/core";
import {
  InMemorySubscriptionStore,
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

  it("a spent replay run counts as one failed attempt, and replays go on at the dunning pace", async () => {
    const h = pspHarness({ replayDelaysMinutes: [5] });
    await create(h);
    h.script.push("down", "down", "down", "ok");
    await runAt(h, DUE);
    const spentAt = DUE + 5 * MINUTE;
    await runAt(h, spentAt);
    expect(await record(h)).toMatchObject({
      failedAttempts: 1,
      nextRetryAt: new Date(spentAt + 24 * HOUR).toISOString(),
      renewalAttempt: { attempt: 0, replay: { idempotencyKey: renewalKey(0), uncertainAnswers: 0 } },
    });

    const dunningAt = spentAt + 24 * HOUR;
    await runAt(h, dunningAt); // a new replay run starts at the dunning retry
    expect(await record(h)).toMatchObject({
      failedAttempts: 1,
      nextRetryAt: new Date(dunningAt + 5 * MINUTE).toISOString(),
      renewalAttempt: { replay: { uncertainAnswers: 1 } },
    });
    expect((await runAt(h, dunningAt + 5 * MINUTE)).charged).toHaveLength(1);
    expect(new Set(h.renewalKeys())).toEqual(new Set([renewalKey(0)]));
  });

  it("an empty replay schedule counts the first uncertain answer at once and keeps the key", async () => {
    const h = pspHarness({ replayDelaysMinutes: [] });
    await create(h);
    h.script.push("down");
    await runAt(h, DUE);
    expect(await record(h)).toMatchObject({
      failedAttempts: 1,
      nextRetryAt: new Date(DUE + 24 * HOUR).toISOString(),
      renewalAttempt: { attempt: 0, replay: { uncertainAnswers: 0 } },
    });
    await runAt(h, DUE + 24 * HOUR);
    expect(h.renewalKeys()).toEqual([renewalKey(0), renewalKey(0)]);
  });

  it("exhausting dunning while pinned cancels, keeps the pin, and it can still be settled", async () => {
    const h = pspHarness({ retryDelaysHours: [24], replayDelaysMinutes: [] });
    await create(h);
    h.events.length = 0;
    h.script.push("down", "down");
    await runAt(h, DUE);
    const final = await runAt(h, DUE + 24 * HOUR);
    expect(final.canceled).toHaveLength(1);
    const canceled = await record(h);
    expect(canceled).toMatchObject({
      status: "canceled",
      failedAttempts: 2,
      renewalAttempt: { attempt: 0, replay: { idempotencyKey: renewalKey(0) } },
    });
    expect(h.events.map((e) => e.type)).toEqual([
      "subscription.charge_failed",
      "subscription.past_due",
      "subscription.charge_failed",
      "subscription.canceled",
    ]);

    const settled = await h.manager.resolvePendingRenewal("sub_1", {
      status: "succeeded",
      pspPaymentId: "pay_found",
      idempotencyKey: renewalKey(0),
    });
    expect(settled).toMatchObject({ status: "canceled", currentPeriodEnd: NEXT_PERIOD_END, lastPaymentId: "pay_found" });
    expect(settled.renewalAttempt).toBeUndefined();
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
    expect(updated.nextRetryAt).toBeUndefined();

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
    expect(afterReplay.nextRetryAt).toBeUndefined();

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

  it("settled as failed, the key is retired and the dunning schedule in place stands", async () => {
    const h = await pinned();
    const before = await record(h);
    const settled = await h.manager.resolvePendingRenewal("sub_1", {
      status: "failed",
      idempotencyKey: renewalKey(0),
      error: { code: "card_declined", message: "Not found at the PSP." },
    });
    expect(settled).toMatchObject({
      status: "past_due",
      failedAttempts: 0,
      nextRetryAt: before.nextRetryAt,
      renewalAttempt: { periodEnd: PERIOD_END, attempt: 1 },
      lastError: { code: "card_declined", message: "Not found at the PSP." },
    });
    expect(settled.renewalAttempt?.replay).toBeUndefined();
    expect(h.events.map((e) => e.type)).toEqual(["subscription.charge_failed"]);

    await runAt(h, Date.parse(before.nextRetryAt!));
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

    // A new card while the charge is pending: the dunning count restarts.
    await h.manager.updateSubscription("sub_1", { savedPaymentMethodToken: "tok_new" });
    const failed = await h.manager.resolvePendingRenewal("sub_1", { status: "failed", pspPaymentId: "pay_async" });
    expect(failed).toMatchObject({
      status: "past_due",
      failedAttempts: 1,
      renewalAttempt: { periodEnd: PERIOD_END, attempt: 2 },
    });

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
