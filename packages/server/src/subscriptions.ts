import {
  assertMinorUnitAmount,
  normalizeCurrency,
  PayFanoutError,
  type MinorUnitAmount,
  type PaymentInfo,
  type UnifiedErrorCode,
} from "@payfanout/core";
import type { PaymentService } from "./payment-service.js";

/**
 * Recurring payments on top of the vault primitives. The design honors the
 * library's one hard rule — PayFanout persists nothing — by INJECTING the
 * storage: the host hands over a SubscriptionStore (its database) and a cron
 * trigger (`chargeDueSubscriptions`), and this manager supplies everything
 * else: period math, off-session charging with deterministic idempotency,
 * retry/dunning policy, and status transitions.
 *
 *   host cron ──> manager.chargeDueSubscriptions() ──> service.chargeSavedPaymentMethod()
 *                        │                                        │
 *                  host's SubscriptionStore                 PSP vault token
 *
 * PSP-native billing products (Stripe Billing) are NOT wrapped —
 * most PSPs have no equivalent, and an abstraction over one PSP is not an
 * abstraction. This engine gives every vaulting-capable PSP identical
 * subscription behavior.
 */
export type SubscriptionStatus = "active" | "trialing" | "past_due" | "paused" | "canceled";

export type SubscriptionInterval = "day" | "week" | "month" | "year";

export interface SubscriptionPlan {
  /** Integer minor units, like every amount in PayFanout. */
  amount: MinorUnitAmount;
  currency: string;
  interval: SubscriptionInterval;
  /** e.g. every 3 months -> interval "month", intervalCount 3. Default 1. */
  intervalCount?: number;
}

/**
 * A renewal charge that resolved as "processing" (async rails): the money
 * outcome is unknown, so the period has NOT advanced and the cron will not
 * charge again until resolvePendingRenewal applies the final outcome.
 */
export interface PendingRenewal {
  /** The charge whose outcome is awaited. */
  pspPaymentId: string;
  /** The period end the charge was renewing — the next window anchors here. */
  periodEnd: string;
  /**
   * Attempt number in the renewal idempotency key the charge used. A resume
   * charge runs under the caller's key instead; its entry repeats the
   * dunning count of the time.
   */
  attempt: number;
  startedAt: string;
  /** The card the charge used; a failure then costs nothing to a card set since. */
  savedPaymentMethodToken?: string;
}

/** A renewal charge exactly as sent, kept so that a replay repeats it unchanged. */
export interface RenewalRequest {
  savedPaymentMethodToken: string;
  amount: MinorUnitAmount;
  currency: string;
  billingDetails?: SubscriptionRecord["billingDetails"];
  /** The record's metadata at charge time; payfanout_subscription_id is added when sending. */
  metadata?: Record<string, string>;
}

/**
 * A renewal charge that ended without a definitive answer, so the money may
 * have moved: the PSP was unreachable or rate limiting, the error was unknown
 * or marked outcomeUnknown, or it was a first processing_error. Until an
 * answer settles it, every charge for the period replays this request under
 * this key. A PSP that keeps the key's result (Stripe, for a request that
 * began executing) then answers with the original instead of charging again;
 * one that refuses a reused key needs its adapter to read the original back
 * and to mark what it cannot read back outcomeUnknown. The request is kept as
 * sent because a PSP refuses a reused key carrying other parameters, or
 * answers it with the original's result.
 *
 * Replays run on replayDelaysMinutes and only within replayWindowHours of
 * the first send: past that a PSP may no longer hold the key, and a replay
 * could charge again. A pin that runs out of replays is `frozen` and waits
 * for resolvePendingRenewal, like a pending renewal.
 */
export interface RenewalReplay {
  /** The key the original charge used; every replay reuses it. */
  idempotencyKey: string;
  request: RenewalRequest;
  /** ISO 8601 — when the original charge was sent. */
  firstSentAt: string;
  /** Uncertain answers this request has had so far. */
  uncertainAnswers: number;
  /**
   * A processing_error not marked outcomeUnknown already answered this
   * request, so the next one is taken as the attempt's definitive failure.
   */
  afterProcessingError: boolean;
  /**
   * No replay can be sent safely any more: the schedule is spent, or the next
   * replay would fall outside replayWindowHours. The cron leaves the period
   * alone until resolvePendingRenewal settles the charge.
   */
  frozen?: boolean;
  /**
   * An overlapping run sent another request under this key (a card or plan
   * set while this charge was in flight). The PSP holds whichever reached it
   * first, and a failure may be its refusal of the other one, so a failure
   * freezes the pin instead of settling the attempt; a success still settles
   * it.
   */
  contested?: boolean;
}

/**
 * Where the renewal charges of one period stand. Renewal keys are
 * `payfanout-sub-<id>-<periodEnd>-a<attempt>`, and no attempt number serves
 * two different requests: a definitive failure (a decline) moves on to the
 * next number, and a charge without a definitive answer is replayed under
 * its own key (see RenewalReplay).
 */
export interface RenewalAttempt {
  /** The period end being renewed (the record's currentPeriodEnd at charge time). */
  periodEnd: string;
  /** Attempt number the next charge for this period uses. */
  attempt: number;
  /** Set while the charge under `attempt` awaits a definitive answer. */
  replay?: RenewalReplay;
}

export interface SubscriptionRecord {
  id: string;
  pspName: string;
  pspCustomerId: string;
  savedPaymentMethodToken: string;
  plan: Required<SubscriptionPlan>;
  status: SubscriptionStatus;
  /** ISO 8601 — the paid-through window. The next charge is due at currentPeriodEnd. */
  currentPeriodStart: string;
  currentPeriodEnd: string;
  /**
   * Day-of-month (1-31) the billing cycle anchors on — recorded at creation
   * and on a lapsed resume when the interval is month/year. Advancement clamps
   * it per target month WITHOUT eroding it: Jan 31 -> Feb 28 -> Mar 31.
   * Records predating this field keep the clamped-forward behavior.
   */
  anchorDay?: number;
  cancelAtPeriodEnd: boolean;
  /**
   * Consecutive failed renewal attempts for the CURRENT period (dunning). A
   * charge without a definitive answer does not count until it is settled.
   */
  failedAttempts: number;
  /** ISO 8601 — when past_due, the earliest instant the next retry may run. */
  nextRetryAt?: string;
  /** pspPaymentId of the latest successful charge. */
  lastPaymentId?: string;
  lastError?: { code: string; message: string };
  /**
   * AVS data forwarded on every charge — some PSPs (Paysafe) demand a zip on
   * stored-token charges when the vaulted handle carries no billing data
   * (browser-tokenized cards). Persisted with the record so renewals have it.
   */
  billingDetails?: { name?: string; email?: string; address?: { line1?: string; city?: string; postalCode?: string; country?: string } };
  metadata?: Record<string, string>;
  /** Money-safety state — stores MUST persist this field; dropping it re-charges unresolved renewals. */
  pendingRenewal?: PendingRenewal;
  /**
   * Money-safety state — stores MUST persist this field; dropping it lets a
   * retry charge a period whose earlier charge may have gone through. Written
   * by the manager only. Records without it derive the next attempt from
   * failedAttempts, as earlier releases did.
   */
  renewalAttempt?: RenewalAttempt;
  createdAt: string;
  canceledAt?: string;
}

/**
 * The persistence seam — implemented by the HOST over its own database.
 * `save` upserts by record.id. Implementations must persist every field
 * verbatim; the manager treats the store as the single source of truth.
 */
export interface SubscriptionStore {
  save(record: SubscriptionRecord): Promise<void>;
  get(id: string): Promise<SubscriptionRecord | undefined>;
  list(filter?: { pspCustomerId?: string; status?: SubscriptionStatus }): Promise<SubscriptionRecord[]>;
  /**
   * Optional scale path for chargeDueSubscriptions: return records that are
   * due — active/trialing with `currentPeriodEnd <= dueBefore`, or past_due
   * with `nextRetryAt <= dueBefore` — never canceled or paused ones, in a
   * stable order, at most `limit` of them. Leave out records that only
   * resolvePendingRenewal moves on: those with a `pendingRenewal`, or whose
   * `renewalAttempt` for the current period holds a `frozen` replay. The cron
   * does nothing for them, and a full batch of them would hold back every due
   * record after it. Push the predicate into a database index; the manager
   * pages until a short batch and still re-checks due-ness per record, so
   * this filter is an optimization, not a trust boundary.
   * Without it the manager falls back to per-status list() scans.
   */
  listDue?(input: { dueBefore: string; limit?: number }): Promise<SubscriptionRecord[]>;
}

/** Dev/test/demo store. NOT for production — it forgets everything on restart. */
export class InMemorySubscriptionStore implements SubscriptionStore {
  private readonly records = new Map<string, SubscriptionRecord>();

  async save(record: SubscriptionRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async get(id: string): Promise<SubscriptionRecord | undefined> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async list(filter?: { pspCustomerId?: string; status?: SubscriptionStatus }): Promise<SubscriptionRecord[]> {
    return [...this.records.values()]
      .filter((r) => !filter?.pspCustomerId || r.pspCustomerId === filter.pspCustomerId)
      .filter((r) => !filter?.status || r.status === filter.status)
      .map((r) => structuredClone(r));
  }

  async listDue(input: { dueBefore: string; limit?: number }): Promise<SubscriptionRecord[]> {
    const cutoff = Date.parse(input.dueBefore);
    const due = [...this.records.values()]
      .filter((r) => {
        if (r.pendingRenewal || pinnedReplay(r)?.frozen) return false; // waits for resolvePendingRenewal
        if (r.status === "past_due") return Date.parse(r.nextRetryAt ?? r.currentPeriodEnd) <= cutoff;
        return (r.status === "active" || r.status === "trialing") && Date.parse(r.currentPeriodEnd) <= cutoff;
      })
      .sort((a, b) => dueInstant(a) - dueInstant(b));
    return due.slice(0, Math.max(0, input.limit ?? due.length)).map((r) => structuredClone(r));
  }
}

function dueInstant(record: SubscriptionRecord): number {
  return Date.parse(
    record.status === "past_due" ? (record.nextRetryAt ?? record.currentPeriodEnd) : record.currentPeriodEnd,
  );
}

export interface SubscriptionEvent {
  type:
    | "subscription.created"
    | "subscription.updated"
    | "subscription.charged"
    | "subscription.charge_pending"
    | "subscription.charge_failed"
    | "subscription.past_due"
    | "subscription.paused"
    | "subscription.resumed"
    | "subscription.canceled";
  subscription: SubscriptionRecord;
  /** ISO 8601 — when the manager emitted this delivery (manager clock; differs per re-delivery). */
  occurredAt: string;
  payment?: PaymentInfo;
  error?: PayFanoutError;
}

export interface CreateSubscriptionInput {
  pspName: string;
  pspCustomerId: string;
  /** SavedPaymentMethod.token / PaymentInfo.savedPaymentMethodToken. */
  savedPaymentMethodToken: string;
  plan: SubscriptionPlan;
  /** Host-app id; defaults to a generated UUID. */
  id?: string;
  /**
   * Future instant = trial / delayed start: nothing is charged now, the first
   * charge happens when chargeDueSubscriptions crosses it. Omitted = charge
   * the first period immediately (customer-present "initial" charge).
   */
  startAt?: string | Date;
  /**
   * AVS data carried on the record and forwarded on EVERY charge (first and
   * renewals) — some PSPs (Paysafe) demand a zip on stored-token charges of
   * browser-tokenized cards.
   */
  billingDetails?: { name?: string; email?: string; address?: { line1?: string; city?: string; postalCode?: string; country?: string } };
  metadata?: Record<string, string>;
  /** Idempotency for the FIRST charge (renewals derive their own keys). */
  idempotencyKey: string;
}

export interface ChargeDueResult {
  charged: SubscriptionRecord[];
  /** Renewals that did not collect this run (now past_due, retry or replay scheduled). */
  failed: SubscriptionRecord[];
  /** Ended this run: dunning exhausted or cancelAtPeriodEnd reached. */
  canceled: SubscriptionRecord[];
  /**
   * Frozen until resolvePendingRenewal: charges resolved as "processing", and
   * charges without a definitive answer that no replay can safely follow.
   */
  pending: SubscriptionRecord[];
  /**
   * Candidates abandoned by an unexpected error (typically storage). Their
   * records keep the attempt key already used, so the next run replays the
   * PSP's cached response instead of charging again.
   */
  errors: Array<{ subscriptionId: string; error: PayFanoutError }>;
}

export interface SubscriptionManagerOptions {
  service: PaymentService;
  store: SubscriptionStore;
  /**
   * Dunning policy: hours to wait before each renewal retry. The Nth failed
   * attempt schedules a retry after retryDelaysHours[N-1]; failing with the
   * schedule exhausted cancels the subscription. Default [24, 72] (3 attempts
   * total). Only definitive failures count: a charge without a definitive
   * answer is replayed (replayDelaysMinutes) and counts once it is settled
   * as failed, or at once on a store that does not persist renewalAttempt.
   */
  retryDelaysHours?: number[];
  /**
   * Minutes to wait before each replay of a renewal charge that ended without
   * a definitive answer (see RenewalReplay). Default [5, 30, 120, 360, 720],
   * about 20.5 hours in all. Once the schedule is spent, or when the next
   * replay would fall outside replayWindowHours, the charge is frozen until
   * resolvePendingRenewal settles it; [] freezes it at the first uncertain
   * answer.
   */
  replayDelaysMinutes?: number[];
  /**
   * How long after the first send a replay may still go out. A replay
   * dedupes only while the PSP holds the idempotency key: Stripe lets clients
   * retry "within 24 hours" and may prune a key after that. Default 24.
   */
  replayWindowHours?: number;
  /**
   * How many overdue periods one chargeDueSubscriptions run may collect per
   * subscription. Default 1 — a long-dead cron must not surprise-charge a
   * customer several periods in one instant.
   */
  catchUpLimit?: number;
  /**
   * Observability: fired on every lifecycle transition. Errors are swallowed.
   * Delivery is at-least-once: concurrent chargeDueSubscriptions runs converge
   * on charges at the PSP (deterministic idempotency keys) but may each emit
   * the same transition — dedupe on (subscription.id, type, currentPeriodEnd),
   * never on occurredAt (it differs per delivery), if exactly-once matters to
   * the host.
   */
  onEvent?: (event: SubscriptionEvent) => void | Promise<void>;
  /** Injected clock (ms since epoch) for tests. */
  now?: () => number;
  /** Injected id generator; defaults to crypto.randomUUID. */
  generateId?: () => string;
}

/** Page size chargeDueSubscriptions asks store.listDue for. */
const LIST_DUE_BATCH_SIZE = 100;

const DEFAULT_REPLAY_DELAYS_MINUTES = [5, 30, 120, 360, 720];
const DEFAULT_REPLAY_WINDOW_HOURS = 24;

export class SubscriptionManager {
  private readonly service: PaymentService;
  private readonly store: SubscriptionStore;
  private readonly retryDelaysHours: number[];
  private readonly replayDelaysMinutes: number[];
  private readonly replayWindowMs: number;
  private readonly catchUpLimit: number;
  private readonly onEvent?: SubscriptionManagerOptions["onEvent"];
  private readonly now: () => number;
  private readonly generateId: () => string;

  constructor(options: SubscriptionManagerOptions) {
    this.service = options.service;
    this.store = options.store;
    this.retryDelaysHours = options.retryDelaysHours ?? [24, 72];
    this.replayDelaysMinutes = options.replayDelaysMinutes ?? DEFAULT_REPLAY_DELAYS_MINUTES;
    const replayWindowHours = options.replayWindowHours ?? DEFAULT_REPLAY_WINDOW_HOURS;
    this.replayWindowMs = replayWindowHours * 3_600_000;
    this.catchUpLimit = options.catchUpLimit ?? 1;
    this.onEvent = options.onEvent;
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? (() => globalThis.crypto.randomUUID());
    if (this.catchUpLimit < 1) {
      throw PayFanoutError.invalidRequest("SubscriptionManager catchUpLimit must be >= 1");
    }
    // An infinite delay would not schedule anything: it has no ISO instant.
    if (this.retryDelaysHours.some((h) => !(h > 0 && Number.isFinite(h)))) {
      throw PayFanoutError.invalidRequest("SubscriptionManager retryDelaysHours must all be finite and > 0");
    }
    if (this.replayDelaysMinutes.some((m) => !(m > 0 && Number.isFinite(m)))) {
      throw PayFanoutError.invalidRequest("SubscriptionManager replayDelaysMinutes must all be finite and > 0");
    }
    if (!(replayWindowHours > 0 && Number.isFinite(replayWindowHours))) {
      throw PayFanoutError.invalidRequest("SubscriptionManager replayWindowHours must be finite and > 0");
    }
  }

  /**
   * Starts a subscription. Immediate start charges the first period NOW
   * (customer-present, credential-on-file "initial") — a failed first charge
   * throws and persists nothing, so hosts never hold a subscription that
   * never collected. A future startAt begins a trial window instead: the
   * record is "trialing" until the first charge collects.
   */
  async createSubscription(
    input: CreateSubscriptionInput,
  ): Promise<{ subscription: SubscriptionRecord; payment?: PaymentInfo }> {
    const plan = normalizePlan(input.plan);
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const id = input.id ?? this.generateId();
    if (await this.store.get(id)) {
      throw PayFanoutError.invalidRequest(`Subscription "${id}" already exists`);
    }

    const startMs = input.startAt === undefined ? nowMs : toEpochMs(input.startAt, "startAt");
    const trial = startMs > nowMs;
    // Billing anchors where the first PAID period starts: startAt for trials,
    // now otherwise (a past startAt charges immediately and anchors at now).
    const anchorMs = trial ? startMs : nowMs;
    const anchorDay =
      plan.interval === "month" || plan.interval === "year" ? new Date(anchorMs).getUTCDate() : undefined;

    let payment: PaymentInfo | undefined;
    let periodStart: string;
    let periodEnd: string;
    if (trial) {
      // The first charge is deferred to the cron, so a misconfigured psp must
      // fail NOW, not at startAt: registered, and able to charge stored tokens.
      if (!this.service.getCapabilities(input.pspName).supportsSavedPaymentMethods) {
        throw new PayFanoutError({
          code: "unsupported_operation",
          message: `"${input.pspName}" does not support saved payment methods — subscription charges need them`,
          retryable: false,
          pspName: input.pspName,
        });
      }
      // Paid-through window is empty until startAt; the first charge is a
      // normal renewal once the cron crosses it.
      periodStart = nowIso;
      periodEnd = new Date(startMs).toISOString();
    } else {
      payment = await this.service.chargeSavedPaymentMethod(input.pspName, {
        pspCustomerId: input.pspCustomerId,
        savedPaymentMethodToken: input.savedPaymentMethodToken,
        amount: plan.amount,
        currency: plan.currency,
        id,
        occurrence: "initial",
        ...(input.billingDetails ? { billingDetails: input.billingDetails } : {}),
        metadata: { ...input.metadata, payfanout_subscription_id: id },
        idempotencyKey: input.idempotencyKey,
      });
      if (payment.status !== "succeeded") {
        // The first charge either collects synchronously or no record exists.
        // A "processing" rail converges: re-creating with the same
        // idempotencyKey replays the same PSP charge once it lands.
        throw new PayFanoutError({
          code: payment.status === "requires_action" ? "authentication_required" : "processing_error",
          message: `The first subscription charge did not complete synchronously (status "${payment.status}").`,
          retryable: false,
          raw: payment,
          pspName: input.pspName,
        });
      }
      periodStart = nowIso;
      periodEnd = addInterval(nowIso, plan.interval, plan.intervalCount, anchorDay);
    }

    const subscription: SubscriptionRecord = {
      id,
      pspName: input.pspName,
      pspCustomerId: input.pspCustomerId,
      savedPaymentMethodToken: input.savedPaymentMethodToken,
      plan,
      status: trial ? "trialing" : "active",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      ...(anchorDay !== undefined ? { anchorDay } : {}),
      cancelAtPeriodEnd: false,
      failedAttempts: 0,
      ...(payment ? { lastPaymentId: payment.pspPaymentId } : {}),
      ...(input.billingDetails ? { billingDetails: input.billingDetails } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: nowIso,
    };
    await this.store.save(subscription);
    await this.emit({ type: "subscription.created", subscription });
    if (payment) await this.emit({ type: "subscription.charged", subscription, payment });
    return { subscription, ...(payment ? { payment } : {}) };
  }

  async retrieveSubscription(id: string): Promise<SubscriptionRecord> {
    const record = await this.store.get(id);
    if (!record) throw PayFanoutError.invalidRequest(`Unknown subscription "${id}"`);
    return record;
  }

  async listSubscriptions(filter?: {
    pspCustomerId?: string;
    status?: SubscriptionStatus;
  }): Promise<SubscriptionRecord[]> {
    return this.store.list(filter);
  }

  /**
   * Plan/instrument changes apply from the NEXT period (no proration — the
   * already-paid window stands). Changing the token also clears dunning:
   * a fresh card deserves a fresh chance at the next renewal. The period's
   * attempt numbers carry on, so the new card is charged under a key the
   * period has not used, and a renewal charge still awaiting a definitive
   * answer (renewalAttempt.replay) is replayed with its original card and
   * amount before the new ones are charged.
   * Emits "subscription.updated" (renewals never do).
   */
  async updateSubscription(
    id: string,
    updates: {
      plan?: SubscriptionPlan;
      savedPaymentMethodToken?: string;
      metadata?: Record<string, string>;
    },
  ): Promise<SubscriptionRecord> {
    const record = await this.retrieveSubscription(id);
    if (record.status === "canceled") {
      throw PayFanoutError.invalidRequest(`Subscription "${id}" is canceled and cannot be updated`);
    }
    const updated: SubscriptionRecord = {
      ...record,
      ...(updates.plan ? { plan: normalizePlan(updates.plan) } : {}),
      ...(updates.savedPaymentMethodToken
        ? { savedPaymentMethodToken: updates.savedPaymentMethodToken, failedAttempts: 0 }
        : {}),
      ...(updates.metadata ? { metadata: updates.metadata } : {}),
    };
    if (updates.savedPaymentMethodToken) {
      // A fresh card is retried at the next run. A past_due record keeps a
      // due instant, so a store querying nextRetryAt still finds it; a frozen
      // charge still waits for its settlement.
      if (updated.status === "past_due" && pinnedReplay(record)?.frozen !== true) {
        updated.nextRetryAt = new Date(this.now()).toISOString();
      } else {
        delete updated.nextRetryAt;
      }
      // failedAttempts no longer tells which attempt numbers the period used.
      const next = nextRenewalAttempt(record);
      if (next.attempt > 0 || next.replay) updated.renewalAttempt = next;
      else delete updated.renewalAttempt;
    }
    await this.store.save(updated);
    await this.emit({ type: "subscription.updated", subscription: updated });
    return updated;
  }

  /**
   * Immediate cancel stops everything now (the rest of the paid window is
   * forfeit — no refund is initiated; use refundPayment separately if owed).
   * atPeriodEnd lets the paid window run out, then ends without charging.
   * A renewal charge still awaiting a definitive answer stays on the
   * canceled record (renewalAttempt.replay) for reconciliation.
   */
  async cancelSubscription(id: string, options: { atPeriodEnd?: boolean } = {}): Promise<SubscriptionRecord> {
    const record = await this.retrieveSubscription(id);
    if (record.status === "canceled") return record;
    if (options.atPeriodEnd) {
      const updated: SubscriptionRecord = { ...record, cancelAtPeriodEnd: true };
      await this.store.save(updated);
      await this.emit({ type: "subscription.updated", subscription: updated });
      return updated;
    }
    const canceled: SubscriptionRecord = {
      ...record,
      status: "canceled",
      canceledAt: new Date(this.now()).toISOString(),
    };
    delete canceled.nextRetryAt;
    await this.store.save(canceled);
    await this.emit({ type: "subscription.canceled", subscription: canceled });
    return canceled;
  }

  /**
   * Halts billing without ending the subscription: the cron skips paused
   * records and dunning stops (nextRetryAt is cleared; failedAttempts, any
   * pendingRenewal and any renewalAttempt survive untouched — an unresolved
   * renewal still resolves via resolvePendingRenewal, but a paused record is
   * never re-charged). Pausing a paused record is a no-op; canceled records
   * cannot pause.
   */
  async pauseSubscription(id: string): Promise<SubscriptionRecord> {
    const record = await this.retrieveSubscription(id);
    if (record.status === "canceled") {
      throw PayFanoutError.invalidRequest(`Subscription "${id}" is canceled and cannot be paused`);
    }
    if (record.status === "paused") return record;
    const updated: SubscriptionRecord = { ...record, status: "paused" };
    delete updated.nextRetryAt;
    await this.store.save(updated);
    await this.emit({ type: "subscription.paused", subscription: updated });
    return updated;
  }

  /**
   * Reactivates a paused subscription. Still paid through -> just "active",
   * nothing is charged. Lapsed -> ONE immediate charge (occurrence
   * "recurring", the caller's idempotencyKey — retry a storage failure with
   * the SAME key so the PSP replays instead of re-charging) re-anchors the
   * billing cycle at the resume instant. A failed charge leaves the record
   * paused with lastError — no dunning — and throws. A charge resolving as
   * "processing" freezes the still-paused record under pendingRenewal:
   * resolve it, then resume again (paid through by then, so no second charge).
   * A record paused over a renewal charge without a definitive answer
   * (renewalAttempt.replay) cannot resume until resolvePendingRenewal settles
   * it: that charge may have paid the period, and a replay long after the
   * fact may reach a PSP that no longer holds its key.
   */
  async resumeSubscription(id: string, options: { idempotencyKey: string }): Promise<SubscriptionRecord> {
    const record = await this.retrieveSubscription(id);
    if (record.status !== "paused") {
      throw PayFanoutError.invalidRequest(`Subscription "${id}" is not paused (status "${record.status}")`);
    }
    if (record.pendingRenewal) {
      throw PayFanoutError.invalidRequest(
        `Subscription "${id}" has an unresolved renewal — apply its outcome with resolvePendingRenewal before resuming`,
      );
    }
    const unsettled = pinnedReplay(record);
    if (unsettled) {
      throw PayFanoutError.invalidRequest(
        `Subscription "${id}" has a renewal charge without a definitive answer — settle it with resolvePendingRenewal ` +
          `(idempotencyKey "${unsettled.idempotencyKey}") before resuming`,
      );
    }
    const nowMs = this.now();
    if (Date.parse(record.currentPeriodEnd) > nowMs) {
      const updated: SubscriptionRecord = { ...record, status: "active" };
      await this.store.save(updated);
      await this.emit({ type: "subscription.resumed", subscription: updated });
      return updated;
    }

    const nowIso = new Date(nowMs).toISOString();
    const anchorDay =
      record.plan.interval === "month" || record.plan.interval === "year"
        ? new Date(nowMs).getUTCDate()
        : undefined;
    let payment: PaymentInfo;
    // Money-safety discipline of renew(): only the charge itself may take the
    // failure path — a bookkeeping failure after a successful charge
    // propagates, so the retried resume replays the PSP's cached success.
    try {
      payment = await this.service.chargeSavedPaymentMethod(record.pspName, {
        pspCustomerId: record.pspCustomerId,
        savedPaymentMethodToken: record.savedPaymentMethodToken,
        amount: record.plan.amount,
        currency: record.plan.currency,
        id: record.id,
        occurrence: "recurring",
        ...(record.billingDetails ? { billingDetails: record.billingDetails } : {}),
        metadata: { ...record.metadata, payfanout_subscription_id: record.id },
        idempotencyKey: options.idempotencyKey,
      });
    } catch (err) {
      throw await this.recordResumeFailure(record, PayFanoutError.wrap(err, { pspName: record.pspName }));
    }

    if (payment.status === "succeeded") {
      const fresh = (await this.store.get(record.id)) ?? record;
      const updated: SubscriptionRecord = {
        ...fresh,
        // A mid-flight cancel stands; everything else reactivates.
        status: fresh.status === "canceled" ? "canceled" : "active",
        currentPeriodStart: nowIso,
        currentPeriodEnd: addInterval(nowIso, record.plan.interval, record.plan.intervalCount, anchorDay),
        failedAttempts: 0,
        lastPaymentId: payment.pspPaymentId,
        ...(anchorDay !== undefined ? { anchorDay } : {}),
      };
      if (anchorDay === undefined) delete updated.anchorDay;
      delete updated.nextRetryAt;
      delete updated.lastError;
      delete updated.pendingRenewal;
      delete updated.renewalAttempt;
      await this.store.save(updated);
      await this.emit({ type: "subscription.resumed", subscription: updated });
      await this.emit({ type: "subscription.charged", subscription: updated, payment });
      return updated;
    }

    if (payment.status === "processing") {
      const fresh = (await this.store.get(record.id)) ?? record;
      const updated: SubscriptionRecord = {
        ...fresh,
        // periodEnd anchors the resolved window at the RESUME instant (re-anchor).
        pendingRenewal: {
          pspPaymentId: payment.pspPaymentId,
          periodEnd: nowIso,
          attempt: fresh.failedAttempts,
          startedAt: nowIso,
        },
        ...(anchorDay !== undefined ? { anchorDay } : {}),
      };
      if (anchorDay === undefined) delete updated.anchorDay;
      await this.store.save(updated);
      await this.emit({ type: "subscription.charge_pending", subscription: updated, payment });
      return updated;
    }

    throw await this.recordResumeFailure(
      record,
      new PayFanoutError({
        code: payment.status === "requires_action" ? "authentication_required" : "processing_error",
        message: `The resume charge did not complete (status "${payment.status}").`,
        retryable: false,
        raw: payment,
        pspName: record.pspName,
      }),
    );
  }

  /** Resume failures stay paused — no dunning schedule may wake a paused record. */
  private async recordResumeFailure(record: SubscriptionRecord, error: PayFanoutError): Promise<PayFanoutError> {
    const fresh = (await this.store.get(record.id)) ?? record;
    if (fresh.status !== "canceled") {
      const updated: SubscriptionRecord = { ...fresh, lastError: { code: error.code, message: error.message } };
      await this.store.save(updated);
      await this.emit({ type: "subscription.charge_failed", subscription: updated, error });
    }
    return error;
  }

  /**
   * THE cron entry point — run it every few minutes/hours from the host's
   * scheduler. Idempotent and crash-safe: renewal idempotency keys are
   * derived from (subscription id, period, attempt), so a crashed run that
   * re-charges after the store missed an update dedupes at the PSP.
   *
   * Prefers store.listDue (host-indexed batches) when implemented, falling
   * back to per-status list() scans (active, trialing, past_due); either way
   * every candidate's due-ness is re-checked here before any charge.
   *
   * Concurrent runs are safe for MONEY (charges converge at the PSP) but not
   * for events (at-least-once, see onEvent) — hosts wanting single-run
   * semantics should hold a lock around this call.
   */
  async chargeDueSubscriptions(at?: string | Date): Promise<ChargeDueResult> {
    const nowMs = at === undefined ? this.now() : toEpochMs(at, "at");
    const result: ChargeDueResult = { charged: [], failed: [], canceled: [], pending: [], errors: [] };

    if (this.store.listDue) {
      const dueBefore = new Date(nowMs).toISOString();
      const processed = new Set<string>();
      for (;;) {
        const batch = await this.store.listDue({ dueBefore, limit: LIST_DUE_BATCH_SIZE });
        const fresh = batch.filter((record) => !processed.has(record.id));
        for (const candidate of fresh) {
          processed.add(candidate.id);
          await this.processCandidate(candidate, nowMs, result);
        }
        // A short batch = the store ran out; a full batch with nothing unseen
        // = only still-due leftovers (catchUpLimit reached) are coming back.
        if (batch.length < LIST_DUE_BATCH_SIZE || fresh.length === 0) break;
      }
      return result;
    }

    const candidates = [
      ...(await this.store.list({ status: "active" })),
      ...(await this.store.list({ status: "trialing" })),
      ...(await this.store.list({ status: "past_due" })),
    ];
    for (const candidate of candidates) {
      await this.processCandidate(candidate, nowMs, result);
    }
    return result;
  }

  /** One candidate's catch-up cycle, error-isolated from the rest of the run. */
  private async processCandidate(
    candidate: SubscriptionRecord,
    nowMs: number,
    result: ChargeDueResult,
  ): Promise<void> {
    try {
      let record = candidate;
      for (let cycle = 0; cycle < this.catchUpLimit; cycle++) {
        if (record.status === "canceled" || record.status === "paused") break;
        if (record.pendingRenewal) break; // unresolved outcome — never charge on top of it
        if (pinnedReplay(record)?.frozen) break; // no safe replay left — waits for its settlement
        if (Date.parse(record.currentPeriodEnd) > nowMs) break; // paid through — not due
        if (record.status === "past_due" && record.nextRetryAt && Date.parse(record.nextRetryAt) > nowMs) {
          break; // dunning backoff still cooling down
        }
        // An unsettled charge may already have paid the next window, which
        // moves the period end: it is replayed first, and only a period left
        // unpaid ends here.
        if (record.cancelAtPeriodEnd && !pinnedReplay(record)) {
          record = {
            ...record,
            status: "canceled",
            canceledAt: new Date(nowMs).toISOString(),
          };
          delete record.nextRetryAt;
          await this.store.save(record);
          await this.emit({ type: "subscription.canceled", subscription: record });
          result.canceled.push(record);
          break;
        }
        record = await this.renew(record, nowMs, result);
        if (record.status !== "active" || record.pendingRenewal) break;
      }
    } catch (err) {
      // One subscription's storage trouble must not abandon the rest of the
      // run — and must NOT enter dunning (see renew): the record keeps its
      // attempt key, so the eventual re-charge replays the PSP's response.
      result.errors.push({ subscriptionId: candidate.id, error: PayFanoutError.wrap(err) });
    }
  }

  /**
   * Applies the final outcome of a renewal charge whose result the manager
   * does not know. Two kinds exist:
   *
   * - A charge that resolved as "processing" (async rails, `pendingRenewal`).
   *   Wire it to the host's payment webhook ingress (payment.succeeded /
   *   payment.failed with a matching pspPaymentId). Until it runs the
   *   subscription is frozen: chargeDueSubscriptions never charges on top of
   *   an unresolved renewal.
   * - A charge that ended without a definitive answer
   *   (`renewalAttempt.replay`). The cron replays it by itself while that is
   *   safe, then leaves it `frozen`. Settle it with the key the charge was
   *   sent under: every renewal charge carries it in its metadata as
   *   `payfanout_renewal_key`, so a payment webhook names its own attempt. A
   *   failure webhook without that key cannot settle a pin: the payment it
   *   names may be an earlier attempt's.
   *
   * Replay-safe: re-resolving an already-applied outcome is a no-op. A settled
   * failure counts as a failed attempt for dunning. Resolving never
   * reactivates: a record paused (or canceled) in the meantime keeps its
   * status — a success still advances the paid-through window (the money
   * moved), a failure is recorded without entering dunning.
   */
  async resolvePendingRenewal(
    id: string,
    outcome: {
      status: "succeeded" | "failed";
      /**
       * From the webhook — guards against applying a different payment's
       * outcome. Required to settle a charge without a definitive answer as
       * succeeded: it becomes lastPaymentId, and is taken on trust.
       */
      pspPaymentId?: string;
      error?: { code?: UnifiedErrorCode; message?: string };
      /**
       * The renewal key the charge was sent under (its `payfanout_renewal_key`
       * metadata). Settles a charge without a definitive answer when it equals
       * renewalAttempt.replay.idempotencyKey. Not consulted while a
       * pendingRenewal is awaited — pspPaymentId guards that one.
       */
      idempotencyKey?: string;
    },
  ): Promise<SubscriptionRecord> {
    const record = await this.retrieveSubscription(id);
    const pending = record.pendingRenewal;
    if (!pending) {
      const tracked = record.renewalAttempt;
      if (
        tracked?.replay &&
        tracked.periodEnd === record.currentPeriodEnd &&
        outcome.idempotencyKey === tracked.replay.idempotencyKey
      ) {
        return this.settleReplay(record, tracked, tracked.replay, outcome);
      }
      if (outcome.status === "succeeded" && outcome.pspPaymentId !== undefined && record.lastPaymentId === outcome.pspPaymentId) {
        return record; // replayed webhook — outcome already applied
      }
      if (outcome.status === "failed" && outcome.idempotencyKey !== undefined && isSpentRenewalKey(record, outcome.idempotencyKey)) {
        return record; // an attempt of this period that already failed
      }
      const unsettled = pinnedReplay(record);
      throw PayFanoutError.invalidRequest(
        unsettled
          ? `Subscription "${id}" has no pending renewal to resolve; its renewal charge without a definitive answer ` +
              `settles only with idempotencyKey "${unsettled.idempotencyKey}"`
          : `Subscription "${id}" has no pending renewal to resolve`,
      );
    }
    if (outcome.pspPaymentId !== undefined && outcome.pspPaymentId !== pending.pspPaymentId) {
      throw PayFanoutError.invalidRequest(
        `Pending renewal for "${id}" awaits payment "${pending.pspPaymentId}", not "${outcome.pspPaymentId}"`,
      );
    }
    if (outcome.status === "succeeded") {
      const updated: SubscriptionRecord = {
        ...record,
        status: record.status === "canceled" || record.status === "paused" ? record.status : "active",
        currentPeriodStart: pending.periodEnd,
        currentPeriodEnd: addInterval(
          pending.periodEnd,
          record.plan.interval,
          record.plan.intervalCount,
          record.anchorDay,
        ),
        failedAttempts: 0,
        lastPaymentId: pending.pspPaymentId,
      };
      delete updated.nextRetryAt;
      delete updated.lastError;
      delete updated.pendingRenewal;
      delete updated.renewalAttempt;
      await this.store.save(updated);
      await this.emit({ type: "subscription.charged", subscription: updated });
      return updated;
    }
    const error = new PayFanoutError({
      code: outcome.error?.code ?? "processing_error",
      message: outcome.error?.message ?? "The renewal charge failed after processing.",
      retryable: false,
      pspName: record.pspName,
    });
    if (pending.periodEnd !== record.currentPeriodEnd) {
      // A resume charge: it ran under the caller's key, and its periodEnd is
      // the resume instant. The record stays paused; dunning never wakes it.
      const updated: SubscriptionRecord = { ...record, lastError: { code: error.code, message: error.message } };
      delete updated.pendingRenewal;
      await this.store.save(updated);
      await this.emit({ type: "subscription.charge_failed", subscription: updated, error });
      return updated;
    }
    const sink: ChargeDueResult = { charged: [], failed: [], canceled: [], pending: [], errors: [] };
    return this.recordRenewalFailure(
      record,
      this.now(),
      error,
      sink,
      {
        periodEnd: pending.periodEnd,
        attempt: pending.attempt,
        ...(pending.savedPaymentMethodToken !== undefined ? { token: pending.savedPaymentMethodToken } : {}),
      },
      { verdict: "definitive", settled: true },
    );
  }

  /**
   * Settles a renewal charge that had no definitive answer, from what the
   * PSP shows of it: succeeded pays the period; failed is that attempt's
   * definitive failure, and the next charge is a new attempt under dunning.
   */
  private async settleReplay(
    record: SubscriptionRecord,
    tracked: RenewalAttempt,
    replay: RenewalReplay,
    outcome: { status: "succeeded" | "failed"; pspPaymentId?: string; error?: { code?: UnifiedErrorCode; message?: string } },
  ): Promise<SubscriptionRecord> {
    const key = replay.idempotencyKey;
    if (outcome.status === "succeeded") {
      if (outcome.pspPaymentId === undefined) {
        throw PayFanoutError.invalidRequest(`Settling the renewal charged under "${key}" as succeeded requires its pspPaymentId`);
      }
      if (outcome.pspPaymentId === record.lastPaymentId) {
        throw PayFanoutError.invalidRequest(
          `Payment "${outcome.pspPaymentId}" already paid the previous period of "${record.id}" — it cannot settle "${key}"`,
        );
      }
      const updated: SubscriptionRecord = {
        ...record,
        status: record.status === "canceled" || record.status === "paused" ? record.status : "active",
        currentPeriodStart: record.currentPeriodEnd,
        currentPeriodEnd: addInterval(
          record.currentPeriodEnd,
          record.plan.interval,
          record.plan.intervalCount,
          record.anchorDay,
        ),
        failedAttempts: 0,
        lastPaymentId: outcome.pspPaymentId,
      };
      delete updated.nextRetryAt;
      delete updated.lastError;
      delete updated.renewalAttempt;
      await this.store.save(updated);
      await this.emit({ type: "subscription.charged", subscription: updated });
      return updated;
    }
    const error = new PayFanoutError({
      code: outcome.error?.code ?? "processing_error",
      message: outcome.error?.message ?? "The renewal charge was not collected.",
      retryable: false,
      pspName: record.pspName,
    });
    const sink: ChargeDueResult = { charged: [], failed: [], canceled: [], pending: [], errors: [] };
    return this.recordRenewalFailure(
      record,
      this.now(),
      error,
      sink,
      { periodEnd: tracked.periodEnd, attempt: tracked.attempt, token: replay.request.savedPaymentMethodToken },
      { verdict: "definitive", settled: true },
    );
  }

  /** One renewal attempt for the period ending at record.currentPeriodEnd. */
  private async renew(
    record: SubscriptionRecord,
    nowMs: number,
    result: ChargeDueResult,
  ): Promise<SubscriptionRecord> {
    // Deterministic per (id, period, attempt): a replayed run can never
    // double-charge. A definitive failure moves on to a new attempt (its key
    // would only replay the cached failure); a charge without a definitive
    // answer is replayed exactly as sent, under its own key.
    const next = nextRenewalAttempt(record);
    const nowIso = new Date(nowMs).toISOString();
    const sent: RenewalSent = next.replay
      ? {
          idempotencyKey: next.replay.idempotencyKey,
          request: next.replay.request,
          firstSentAt: next.replay.firstSentAt,
          replayed: next.replay,
        }
      : {
          idempotencyKey: renewalIdempotencyKey(record.id, record.currentPeriodEnd, next.attempt),
          request: renewalRequestOf(record),
          firstSentAt: nowIso,
        };
    const tried: RenewalTry = {
      periodEnd: record.currentPeriodEnd,
      attempt: next.attempt,
      token: sent.request.savedPaymentMethodToken,
      sent,
    };
    if (next.replay) {
      if (nowMs - Date.parse(next.replay.firstSentAt) > this.replayWindowMs) {
        // A late run: the PSP may no longer hold the key, so a replay could
        // charge again. Nothing is sent.
        return this.freezeReplay(record, next.replay, result);
      }
      // A replay the service cannot send says nothing about the original.
      const blocked = this.replayBlocker(record.pspName);
      if (blocked) return this.recordRenewalFailure(record, nowMs, blocked, result, tried, { verdict: "uncertain" });
    }
    let payment: PaymentInfo;
    // Only the charge itself may enter the dunning path. A bookkeeping failure
    // AFTER a successful charge must propagate instead: dunning would retry
    // under a fresh attempt key — a second real charge for a period the PSP
    // already collected. Propagating keeps the attempt key unchanged, so the
    // next run replays the PSP's cached success and only redoes bookkeeping.
    try {
      payment = await this.service.chargeSavedPaymentMethod(record.pspName, {
        pspCustomerId: record.pspCustomerId,
        savedPaymentMethodToken: sent.request.savedPaymentMethodToken,
        amount: sent.request.amount,
        currency: sent.request.currency,
        id: record.id,
        occurrence: "recurring",
        ...(sent.request.billingDetails ? { billingDetails: sent.request.billingDetails } : {}),
        // The key rides the charge so a payment webhook names its own attempt;
        // derived from the key, it keeps a replay identical to the original.
        metadata: {
          ...sent.request.metadata,
          payfanout_subscription_id: record.id,
          payfanout_renewal_key: sent.idempotencyKey,
        },
        idempotencyKey: sent.idempotencyKey,
      });
    } catch (err) {
      return this.recordRenewalFailure(record, nowMs, PayFanoutError.wrap(err, { pspName: record.pspName }), result, tried);
    }

    if (payment.status === "succeeded") {
      // Advance from the PERIOD END, not from "now": billing anchors must not
      // drift later with every cron delay. Re-read before writing so a cancel
      // or update that landed while the charge was in flight is not clobbered.
      const fresh = (await this.store.get(record.id)) ?? record;
      if (fresh.currentPeriodEnd !== record.currentPeriodEnd) {
        // An overlapping run or a settlement already collected this period
        // under the same key: the same charge, nothing more to record.
        return fresh;
      }
      const updated: SubscriptionRecord = {
        ...fresh,
        // A mid-flight cancel or pause stands: the paid-through window still
        // advances (the money moved), the status does not resurrect.
        status: fresh.status === "canceled" || fresh.status === "paused" ? fresh.status : "active",
        currentPeriodStart: record.currentPeriodEnd,
        currentPeriodEnd: addInterval(
          record.currentPeriodEnd,
          record.plan.interval,
          record.plan.intervalCount,
          record.anchorDay,
        ),
        failedAttempts: 0,
        lastPaymentId: payment.pspPaymentId,
      };
      delete updated.nextRetryAt;
      delete updated.lastError;
      delete updated.pendingRenewal;
      delete updated.renewalAttempt;
      await this.store.save(updated);
      await this.emit({ type: "subscription.charged", subscription: updated, payment });
      result.charged.push(updated);
      return updated;
    }

    if (payment.status === "processing") {
      // Async rails: the outcome is genuinely unknown. Freeze the record until
      // the host's webhook ingress calls resolvePendingRenewal. The attempt
      // number stays reserved by the pending charge, which a replay answered
      // too: nothing is left to replay.
      const fresh = (await this.store.get(record.id)) ?? record;
      if (fresh.currentPeriodEnd !== record.currentPeriodEnd) return fresh;
      const tracked = fresh.renewalAttempt?.periodEnd === record.currentPeriodEnd ? fresh.renewalAttempt : undefined;
      const updated: SubscriptionRecord = {
        ...fresh,
        pendingRenewal: {
          pspPaymentId: payment.pspPaymentId,
          periodEnd: record.currentPeriodEnd,
          attempt: next.attempt,
          startedAt: nowIso,
          savedPaymentMethodToken: sent.request.savedPaymentMethodToken,
        },
        // A charge settled meanwhile as failed has already moved the number on.
        renewalAttempt: {
          periodEnd: record.currentPeriodEnd,
          attempt: Math.max(next.attempt, tracked?.attempt ?? next.attempt),
        },
      };
      await this.store.save(updated);
      await this.emit({ type: "subscription.charge_pending", subscription: updated, payment });
      result.pending.push(updated);
      return updated;
    }

    // Resolved but not collected (failed / canceled / requires_*): a renewal
    // has no customer present, so anything short of money is a failed
    // attempt, and a definitive one: the PSP answered.
    return this.recordRenewalFailure(
      record,
      nowMs,
      new PayFanoutError({
        code: payment.status === "requires_action" ? "authentication_required" : "processing_error",
        message: `The renewal charge did not complete (status "${payment.status}").`,
        retryable: false,
        raw: payment,
        pspName: record.pspName,
      }),
      result,
      tried,
      { verdict: "definitive" },
    );
  }

  /**
   * Why a pinned replay cannot be sent now, if it cannot: a service that lost
   * the adapter, or its vault support, has learned nothing about the original
   * charge, so the pin must stay.
   */
  private replayBlocker(pspName: string): PayFanoutError | undefined {
    try {
      if (this.service.getCapabilities(pspName).supportsSavedPaymentMethods) return undefined;
    } catch (err) {
      return PayFanoutError.wrap(err, { pspName });
    }
    return new PayFanoutError({
      code: "unsupported_operation",
      message: `"${pspName}" no longer supports saved payment methods, so the unsettled renewal charge cannot be replayed`,
      retryable: false,
      pspName,
    });
  }

  /**
   * Leaves a pinned charge to its settlement: the cron sends nothing more for
   * it. The record is read again first, so a cancel, pause, card change or
   * settlement since the batch read stands; only the pin changes.
   */
  private async freezeReplay(
    record: SubscriptionRecord,
    replay: RenewalReplay,
    result: ChargeDueResult,
  ): Promise<SubscriptionRecord> {
    const fresh = (await this.store.get(record.id)) ?? record;
    const tracked = fresh.renewalAttempt;
    if (
      fresh.currentPeriodEnd !== record.currentPeriodEnd ||
      tracked?.periodEnd !== fresh.currentPeriodEnd ||
      tracked.replay?.idempotencyKey !== replay.idempotencyKey ||
      tracked.replay.frozen === true
    ) {
      return fresh; // settled, overtaken, or frozen by an overlapping run meanwhile
    }
    const updated: SubscriptionRecord = { ...fresh, renewalAttempt: { ...tracked, replay: { ...tracked.replay, frozen: true } } };
    delete updated.nextRetryAt;
    await this.store.save(updated);
    await this.emit({ type: "subscription.charge_pending", subscription: updated });
    result.pending.push(updated);
    return updated;
  }

  /**
   * Bookkeeping for a renewal attempt that did not collect. A definitive
   * failure moves the period on to its next attempt number and into dunning.
   * An uncertain one pins the request for replay (see RenewalReplay), or
   * freezes it once no replay can safely follow; it never counts for dunning,
   * except on a store that drops the pin. `settled` marks an outcome the host
   * applied, which is authoritative for its attempt; any other answer that an
   * overlapping run or a settlement has overtaken is dropped, and so is an
   * answer to another request sent under the pinned key.
   */
  private async recordRenewalFailure(
    record: SubscriptionRecord,
    nowMs: number,
    error: PayFanoutError,
    result: ChargeDueResult,
    tried: RenewalTry,
    options: { verdict?: RenewalVerdict; settled?: boolean } = {},
  ): Promise<SubscriptionRecord> {
    const fresh = (await this.store.get(record.id)) ?? record;
    const tracked = fresh.renewalAttempt?.periodEnd === tried.periodEnd ? fresh.renewalAttempt : undefined;
    if (fresh.currentPeriodEnd !== tried.periodEnd) return fresh; // the period was collected meanwhile
    if (options.settled !== true && (fresh.pendingRenewal || (tracked && tracked.attempt > tried.attempt))) {
      return fresh; // an overlapping run or a settlement got further with this attempt
    }
    const sent = tried.sent;
    if (
      tracked?.replay &&
      sent?.idempotencyKey === tracked.replay.idempotencyKey &&
      !sameRequest(tracked.replay.request, sent.request)
    ) {
      return this.contest(fresh, tracked, tracked.replay);
    }
    const replayed = tracked?.replay ?? sent?.replayed;
    const verdict = options.verdict ?? classifyRenewalFailure(error, replayed);
    // A contested pin settles only by a success or by the host: the failure
    // may be the PSP refusing the other request sent under its key.
    const doubted = sent !== undefined && replayed?.contested === true && verdict === "definitive";
    const pinned = sent !== undefined && (verdict === "uncertain" || doubted);
    const nextAttempt = Math.max(tried.attempt + 1, tracked?.attempt ?? 0);
    const lastError = { code: error.code, message: error.message };

    if (fresh.status === "canceled" || fresh.status === "paused") {
      // Ended or halted while the charge was failing: dunning would resurrect
      // a past_due ghost, but the attempt state stays — a pin must survive
      // to be settled, and resume refuses to start a period over it.
      const renewalAttempt: RenewalAttempt =
        pinned && sent
          ? { periodEnd: tried.periodEnd, attempt: tried.attempt, replay: pinFor(sent, replayed, error, doubted || undefined) }
          : { periodEnd: tried.periodEnd, attempt: nextAttempt };
      const updated: SubscriptionRecord = { ...fresh, renewalAttempt, lastError };
      delete updated.pendingRenewal;
      await this.store.save(updated);
      await this.emit({ type: "subscription.charge_failed", subscription: updated, error });
      return updated;
    }

    if (pinned && sent) {
      const answers = (replayed?.uncertainAnswers ?? 0) + 1;
      const delayMinutes = this.replayDelaysMinutes[answers - 1];
      const replayAtMs = delayMinutes === undefined ? undefined : nowMs + delayMinutes * 60_000;
      const withinWindow =
        !doubted &&
        replayAtMs !== undefined &&
        replayAtMs - Date.parse(replayed?.firstSentAt ?? sent.firstSentAt) <= this.replayWindowMs;
      const pin = pinFor(sent, replayed, error, withinWindow ? undefined : true);
      const updated: SubscriptionRecord = {
        ...fresh,
        status: "past_due",
        lastError,
        renewalAttempt: { periodEnd: tried.periodEnd, attempt: tried.attempt, replay: pin },
      };
      delete updated.pendingRenewal;
      if (withinWindow && replayAtMs !== undefined) updated.nextRetryAt = new Date(replayAtMs).toISOString();
      else delete updated.nextRetryAt;
      await this.store.save(updated);
      const kept = await this.store.get(record.id);
      if (kept && droppedPin(kept, updated)) {
        // The store does not persist renewalAttempt, so no pin can bound the
        // replays: the attempt counts for dunning under a new key, as it did
        // before pins existed.
        return this.enterDunning(record, kept, nowMs, error, result, { periodEnd: tried.periodEnd, attempt: nextAttempt });
      }
      await this.emit({ type: "subscription.charge_failed", subscription: updated, error });
      if (fresh.status !== "past_due") await this.emit({ type: "subscription.past_due", subscription: updated, error });
      if (withinWindow) {
        result.failed.push(updated);
      } else {
        await this.emit({ type: "subscription.charge_pending", subscription: updated, error });
        result.pending.push(updated);
      }
      return updated;
    }

    const renewalAttempt: RenewalAttempt = { periodEnd: tried.periodEnd, attempt: nextAttempt };
    if (tried.token !== undefined && tried.token !== fresh.savedPaymentMethodToken) {
      // The charge used a card the host has since replaced: its failure costs
      // the new card nothing, which is charged on the next run.
      const updated: SubscriptionRecord = {
        ...fresh,
        lastError,
        renewalAttempt,
        ...(fresh.status === "past_due" ? { nextRetryAt: new Date(nowMs).toISOString() } : {}),
      };
      delete updated.pendingRenewal;
      await this.store.save(updated);
      await this.emit({ type: "subscription.charge_failed", subscription: updated, error });
      result.failed.push(updated);
      return updated;
    }
    return this.enterDunning(record, fresh, nowMs, error, result, renewalAttempt);
  }

  /**
   * An answer to another request than the pinned one under the same key: an
   * overlapping run charged a card or plan set while the pinned charge was in
   * flight. It says nothing of the pinned charge, but its failures are no
   * longer trusted from now on (see RenewalReplay.contested).
   */
  private async contest(fresh: SubscriptionRecord, tracked: RenewalAttempt, replay: RenewalReplay): Promise<SubscriptionRecord> {
    const updated: SubscriptionRecord = { ...fresh, renewalAttempt: { ...tracked, replay: { ...replay, contested: true } } };
    await this.store.save(updated);
    return updated;
  }

  /** A failed attempt for dunning: past_due with the next retry scheduled, or canceled once exhausted. */
  private async enterDunning(
    record: SubscriptionRecord,
    fresh: SubscriptionRecord,
    nowMs: number,
    error: PayFanoutError,
    result: ChargeDueResult,
    renewalAttempt: RenewalAttempt,
  ): Promise<SubscriptionRecord> {
    // Attempt count follows the attempt that actually ran (record), while the
    // rest of the state merges onto the freshest read.
    const attempts = record.failedAttempts + 1;
    const retryDelayHours = this.retryDelaysHours[attempts - 1];
    const exhausted = retryDelayHours === undefined;
    const updated: SubscriptionRecord = {
      ...fresh,
      failedAttempts: attempts,
      lastError: { code: error.code, message: error.message },
      renewalAttempt,
      ...(exhausted
        ? { status: "canceled" as const, canceledAt: new Date(nowMs).toISOString() }
        : {
            status: "past_due" as const,
            nextRetryAt: new Date(nowMs + retryDelayHours * 3_600_000).toISOString(),
          }),
    };
    if (exhausted) {
      delete updated.nextRetryAt;
      delete updated.renewalAttempt; // nothing is charged any more
    }
    delete updated.pendingRenewal;
    await this.store.save(updated);
    await this.emit({ type: "subscription.charge_failed", subscription: updated, error });
    if (exhausted) {
      await this.emit({ type: "subscription.canceled", subscription: updated, error });
      result.canceled.push(updated);
    } else {
      await this.emit({ type: "subscription.past_due", subscription: updated, error });
      result.failed.push(updated);
    }
    return updated;
  }

  private async emit(event: Omit<SubscriptionEvent, "occurredAt">): Promise<void> {
    try {
      await this.onEvent?.({ ...event, occurredAt: new Date(this.now()).toISOString() });
    } catch {
      // Observability must never break billing.
    }
  }
}

/** A renewal charge as sent: its key and request, and the pin it replayed, if it was a replay. */
interface RenewalSent {
  idempotencyKey: string;
  request: RenewalRequest;
  /** When the key was first sent — now for a new attempt, the pin's time for a replay. */
  firstSentAt: string;
  replayed?: RenewalReplay;
}

/** The attempt a failed renewal charge ran under. */
interface RenewalTry {
  periodEnd: string;
  attempt: number;
  /** The card the charge used, when known. */
  token?: string;
  /** Absent for a settled charge: nothing of it is ever replayed. */
  sent?: RenewalSent;
}

type RenewalVerdict = "definitive" | "uncertain";

/** Failures that settle their attempt: the PSP answered, and no money moved. */
const DEFINITIVE_FAILURE_CODES: ReadonlySet<UnifiedErrorCode> = new Set<UnifiedErrorCode>([
  "card_declined",
  "insufficient_funds",
  "expired_card",
  "invalid_card_data",
  "authentication_required",
  "fraud_suspected",
  "invalid_request",
  "session_expired",
  "unsupported_operation",
]);

/**
 * Whether a failed renewal charge settled its attempt. An error marked
 * outcomeUnknown never does, nor does an unreachable or rate-limiting PSP,
 * an unknown error, or a code added to the taxonomy later. A processing_error
 * is replayed once: the same request answered by it twice is taken as the
 * attempt's own failure.
 */
function classifyRenewalFailure(error: PayFanoutError, replayed: RenewalReplay | undefined): RenewalVerdict {
  if (error.outcomeUnknown === true) return "uncertain";
  if (DEFINITIVE_FAILURE_CODES.has(error.code)) return "definitive";
  if (error.code === "processing_error" && replayed?.afterProcessingError === true) return "definitive";
  return "uncertain";
}

function renewalIdempotencyKey(id: string, periodEnd: string, attempt: number): string {
  return `payfanout-sub-${id}-${periodEnd}-a${attempt}`;
}

const RENEWAL_KEY = /^payfanout-sub-(.+)-([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z)-a([0-9]+)$/;

/**
 * Reads a renewal idempotency key back into the subscription, period and
 * attempt it names, or undefined for any other key. For PSPs that store no
 * metadata but echo the key (Paysafe's `merchantRefNum` is the key), this
 * is how a payment webhook finds the subscription to settle.
 */
export function parseRenewalIdempotencyKey(
  key: string,
): { subscriptionId: string; periodEnd: string; attempt: number } | undefined {
  const match = RENEWAL_KEY.exec(key);
  if (!match) return undefined;
  return { subscriptionId: match[1]!, periodEnd: match[2]!, attempt: Number(match[3]) };
}

/** The pin for a request whose latest answer was uncertain. */
function pinFor(
  sent: RenewalSent,
  replayed: RenewalReplay | undefined,
  error: PayFanoutError,
  frozen: true | undefined,
): RenewalReplay {
  return {
    idempotencyKey: sent.idempotencyKey,
    // A replay repeats the request first pinned under the key, whatever the record says now.
    request: replayed?.request ?? sent.request,
    firstSentAt: replayed?.firstSentAt ?? sent.firstSentAt,
    uncertainAnswers: (replayed?.uncertainAnswers ?? 0) + 1,
    afterProcessingError:
      replayed?.afterProcessingError === true || (error.code === "processing_error" && error.outcomeUnknown !== true),
    ...(replayed?.contested === true ? { contested: true } : {}),
    ...(frozen ? { frozen } : {}),
  };
}

/**
 * Whether a record read back right after `saved` was written with its pin is
 * that write without the pin, as a store that does not persist
 * renewalAttempt returns it. Only fields older than renewalAttempt are
 * compared. Any other write landing in between proves nothing, and keeps the
 * pin's key.
 */
function droppedPin(kept: SubscriptionRecord, saved: SubscriptionRecord): boolean {
  return (
    kept.renewalAttempt?.replay === undefined &&
    kept.pendingRenewal === undefined &&
    kept.status === saved.status &&
    kept.currentPeriodEnd === saved.currentPeriodEnd &&
    kept.failedAttempts === saved.failedAttempts &&
    kept.lastError?.code === saved.lastError?.code
  );
}

/** Whether two renewal requests are the same charge, however a store orders their fields. */
function sameRequest(a: RenewalRequest, b: RenewalRequest): boolean {
  return (
    a.savedPaymentMethodToken === b.savedPaymentMethodToken &&
    a.amount === b.amount &&
    a.currency === b.currency &&
    sameValue(a.billingDetails, b.billingDetails) &&
    sameValue(a.metadata, b.metadata)
  );
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b || ((a === null || a === undefined) && (b === null || b === undefined))) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) => sameValue(left[key], right[key]));
}

/** A key of this period's attempts that already ended, so a failure naming it is old news. */
function isSpentRenewalKey(record: SubscriptionRecord, key: string): boolean {
  const next = nextRenewalAttempt(record);
  for (let attempt = 0; attempt < next.attempt; attempt++) {
    if (renewalIdempotencyKey(record.id, record.currentPeriodEnd, attempt) === key) return true;
  }
  return false;
}

/** The attempt the next renewal charge of record.currentPeriodEnd uses. */
function nextRenewalAttempt(record: SubscriptionRecord): RenewalAttempt {
  const tracked = record.renewalAttempt;
  if (tracked && tracked.periodEnd === record.currentPeriodEnd) return tracked;
  // Untracked: a fresh period, or a record written before renewalAttempt
  // existed, whose attempts 0..failedAttempts-1 each ended in a failure.
  return { periodEnd: record.currentPeriodEnd, attempt: record.failedAttempts };
}

/** The current period's renewal charge awaiting a definitive answer, if any. */
function pinnedReplay(record: SubscriptionRecord): RenewalReplay | undefined {
  const tracked = record.renewalAttempt;
  return tracked?.periodEnd === record.currentPeriodEnd ? tracked.replay : undefined;
}

function renewalRequestOf(record: SubscriptionRecord): RenewalRequest {
  return {
    savedPaymentMethodToken: record.savedPaymentMethodToken,
    amount: record.plan.amount,
    currency: record.plan.currency,
    ...(record.billingDetails ? { billingDetails: record.billingDetails } : {}),
    ...(record.metadata ? { metadata: record.metadata } : {}),
  };
}

function normalizePlan(plan: SubscriptionPlan): Required<SubscriptionPlan> {
  assertMinorUnitAmount(plan.amount, "plan.amount");
  if (plan.amount === 0) throw PayFanoutError.invalidRequest("plan.amount must be positive");
  const intervalCount = plan.intervalCount ?? 1;
  if (!Number.isInteger(intervalCount) || intervalCount < 1) {
    throw PayFanoutError.invalidRequest(`plan.intervalCount must be a positive integer, got ${String(plan.intervalCount)}`);
  }
  if (!["day", "week", "month", "year"].includes(plan.interval)) {
    throw PayFanoutError.invalidRequest(`plan.interval must be day|week|month|year, got "${String(plan.interval)}"`);
  }
  return { amount: plan.amount, currency: normalizeCurrency(plan.currency), interval: plan.interval, intervalCount };
}

/**
 * Calendar-safe period math (UTC). Month/year arithmetic clamps the day to
 * the target month's length: Jan 31 + 1 month = Feb 28 (29 in leap years) —
 * monthly subscriptions anchored on the 31st must not skip February.
 * `anchorDay` (1-31, month/year only) computes the target day as
 * min(anchorDay, month length) so a clamped month never erodes the anchor
 * (Feb 28 with anchor 31 -> Mar 31, not Mar 28); omitted, the day advances
 * from `fromIso`'s own day, clamped forward.
 */
export function addInterval(
  fromIso: string,
  interval: SubscriptionInterval,
  count: number,
  anchorDay?: number,
): string {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) {
    throw PayFanoutError.invalidRequest(`Invalid period start "${fromIso}"`);
  }
  if (anchorDay !== undefined && (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31)) {
    throw PayFanoutError.invalidRequest(`anchorDay must be an integer in 1-31, got ${String(anchorDay)}`);
  }
  if (interval === "day" || interval === "week") {
    const days = interval === "week" ? count * 7 : count;
    return new Date(from.getTime() + days * 86_400_000).toISOString();
  }
  const monthsToAdd = interval === "year" ? count * 12 : count;
  const totalMonths = from.getUTCFullYear() * 12 + from.getUTCMonth() + monthsToAdd;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths % 12;
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(anchorDay ?? from.getUTCDate(), lastDayOfTarget);
  const result = new Date(
    Date.UTC(year, month, day, from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds()),
  );
  return result.toISOString();
}

function toEpochMs(value: string | Date, field: string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(ms)) {
    throw PayFanoutError.invalidRequest(`${field} must be a Date or an ISO 8601 string, got "${String(value)}"`);
  }
  return ms;
}
