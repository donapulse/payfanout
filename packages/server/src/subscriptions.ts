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
 * Paysafe has no equivalent, and an abstraction over one PSP is not an
 * abstraction. This engine gives BOTH PSPs identical subscription behavior.
 */
export type SubscriptionStatus = "active" | "past_due" | "canceled";

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
  /** Attempt counter the charge's idempotency key was derived from. */
  attempt: number;
  startedAt: string;
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
  cancelAtPeriodEnd: boolean;
  /** Consecutive failed renewal attempts for the CURRENT period (dunning). */
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
}

export interface SubscriptionEvent {
  type:
    | "subscription.created"
    | "subscription.charged"
    | "subscription.charge_pending"
    | "subscription.charge_failed"
    | "subscription.past_due"
    | "subscription.canceled";
  subscription: SubscriptionRecord;
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
  /** Renewals that failed this run (now past_due, retry scheduled). */
  failed: SubscriptionRecord[];
  /** Ended this run: dunning exhausted or cancelAtPeriodEnd reached. */
  canceled: SubscriptionRecord[];
  /** Charges resolved as "processing" — frozen until resolvePendingRenewal. */
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
   * Dunning policy: hours to wait before each renewal retry. The Nth failure
   * schedules a retry after retryDelaysHours[N-1]; failing with the schedule
   * exhausted cancels the subscription. Default [24, 72] (3 attempts total).
   */
  retryDelaysHours?: number[];
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
   * the same transition — dedupe on (subscription.id, type, currentPeriodEnd)
   * if exactly-once matters to the host.
   */
  onEvent?: (event: SubscriptionEvent) => void | Promise<void>;
  /** Injected clock (ms since epoch) for tests. */
  now?: () => number;
  /** Injected id generator; defaults to crypto.randomUUID. */
  generateId?: () => string;
}

export class SubscriptionManager {
  private readonly service: PaymentService;
  private readonly store: SubscriptionStore;
  private readonly retryDelaysHours: number[];
  private readonly catchUpLimit: number;
  private readonly onEvent?: SubscriptionManagerOptions["onEvent"];
  private readonly now: () => number;
  private readonly generateId: () => string;

  constructor(options: SubscriptionManagerOptions) {
    this.service = options.service;
    this.store = options.store;
    this.retryDelaysHours = options.retryDelaysHours ?? [24, 72];
    this.catchUpLimit = options.catchUpLimit ?? 1;
    this.onEvent = options.onEvent;
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? (() => globalThis.crypto.randomUUID());
    if (this.catchUpLimit < 1) {
      throw PayFanoutError.invalidRequest("SubscriptionManager catchUpLimit must be >= 1");
    }
    if (this.retryDelaysHours.some((h) => !(h > 0))) {
      throw PayFanoutError.invalidRequest("SubscriptionManager retryDelaysHours must all be > 0");
    }
  }

  /**
   * Starts a subscription. Immediate start charges the first period NOW
   * (customer-present, credential-on-file "initial") — a failed first charge
   * throws and persists nothing, so hosts never hold a subscription that
   * never collected. A future startAt begins a trial window instead.
   */
  async createSubscription(
    input: CreateSubscriptionInput,
  ): Promise<{ subscription: SubscriptionRecord; payment?: PaymentInfo }> {
    const plan = normalizePlan(input.plan);
    const nowIso = new Date(this.now()).toISOString();
    const id = input.id ?? this.generateId();
    if (await this.store.get(id)) {
      throw PayFanoutError.invalidRequest(`Subscription "${id}" already exists`);
    }

    const startMs = input.startAt === undefined ? this.now() : toEpochMs(input.startAt, "startAt");
    const trial = startMs > this.now();

    let payment: PaymentInfo | undefined;
    let periodStart: string;
    let periodEnd: string;
    if (trial) {
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
      periodEnd = addInterval(nowIso, plan.interval, plan.intervalCount);
    }

    const subscription: SubscriptionRecord = {
      id,
      pspName: input.pspName,
      pspCustomerId: input.pspCustomerId,
      savedPaymentMethodToken: input.savedPaymentMethodToken,
      plan,
      status: "active",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
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
   * a fresh card deserves a fresh chance at the next renewal.
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
    if (updates.savedPaymentMethodToken) delete updated.nextRetryAt;
    await this.store.save(updated);
    return updated;
  }

  /**
   * Immediate cancel stops everything now (the rest of the paid window is
   * forfeit — no refund is initiated; use refundPayment separately if owed).
   * atPeriodEnd lets the paid window run out, then ends without charging.
   */
  async cancelSubscription(id: string, options: { atPeriodEnd?: boolean } = {}): Promise<SubscriptionRecord> {
    const record = await this.retrieveSubscription(id);
    if (record.status === "canceled") return record;
    if (options.atPeriodEnd) {
      const updated: SubscriptionRecord = { ...record, cancelAtPeriodEnd: true };
      await this.store.save(updated);
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
   * THE cron entry point — run it every few minutes/hours from the host's
   * scheduler. Idempotent and crash-safe: renewal idempotency keys are
   * derived from (subscription id, period, attempt), so a crashed run that
   * re-charges after the store missed an update dedupes at the PSP.
   *
   * Concurrent runs are safe for MONEY (charges converge at the PSP) but not
   * for events (at-least-once, see onEvent) — hosts wanting single-run
   * semantics should hold a lock around this call.
   */
  async chargeDueSubscriptions(at?: string | Date): Promise<ChargeDueResult> {
    const nowMs = at === undefined ? this.now() : toEpochMs(at, "at");
    const result: ChargeDueResult = { charged: [], failed: [], canceled: [], pending: [], errors: [] };

    const candidates = [
      ...(await this.store.list({ status: "active" })),
      ...(await this.store.list({ status: "past_due" })),
    ];
    for (const candidate of candidates) {
      try {
        let record = candidate;
        for (let cycle = 0; cycle < this.catchUpLimit; cycle++) {
          if (record.status === "canceled") break;
          if (record.pendingRenewal) break; // unresolved outcome — never charge on top of it
          if (Date.parse(record.currentPeriodEnd) > nowMs) break; // paid through — not due
          if (record.status === "past_due" && record.nextRetryAt && Date.parse(record.nextRetryAt) > nowMs) {
            break; // dunning backoff still cooling down
          }
          if (record.cancelAtPeriodEnd) {
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
    return result;
  }

  /**
   * Applies the final outcome of a renewal charge that resolved as
   * "processing" (async rails). Wire it to the host's payment webhook ingress
   * (payment.succeeded / payment.failed with a matching pspPaymentId) — until
   * it runs, the subscription is frozen: chargeDueSubscriptions never charges
   * on top of an unresolved renewal. Replay-safe: re-resolving an
   * already-applied success is a no-op.
   */
  async resolvePendingRenewal(
    id: string,
    outcome: {
      status: "succeeded" | "failed";
      /** From the webhook — guards against applying a different payment's outcome. */
      pspPaymentId?: string;
      error?: { code?: UnifiedErrorCode; message?: string };
    },
  ): Promise<SubscriptionRecord> {
    const record = await this.retrieveSubscription(id);
    const pending = record.pendingRenewal;
    if (!pending) {
      if (outcome.status === "succeeded" && outcome.pspPaymentId !== undefined && record.lastPaymentId === outcome.pspPaymentId) {
        return record; // replayed webhook — outcome already applied
      }
      throw PayFanoutError.invalidRequest(`Subscription "${id}" has no pending renewal to resolve`);
    }
    if (outcome.pspPaymentId !== undefined && outcome.pspPaymentId !== pending.pspPaymentId) {
      throw PayFanoutError.invalidRequest(
        `Pending renewal for "${id}" awaits payment "${pending.pspPaymentId}", not "${outcome.pspPaymentId}"`,
      );
    }
    if (outcome.status === "succeeded") {
      const updated: SubscriptionRecord = {
        ...record,
        status: record.status === "canceled" ? "canceled" : "active",
        currentPeriodStart: pending.periodEnd,
        currentPeriodEnd: addInterval(pending.periodEnd, record.plan.interval, record.plan.intervalCount),
        failedAttempts: 0,
        lastPaymentId: pending.pspPaymentId,
      };
      delete updated.nextRetryAt;
      delete updated.lastError;
      delete updated.pendingRenewal;
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
    if (record.status === "canceled") {
      // Already ended — record the failure, never dunning a dead record.
      const updated: SubscriptionRecord = { ...record, lastError: { code: error.code, message: error.message } };
      delete updated.pendingRenewal;
      await this.store.save(updated);
      await this.emit({ type: "subscription.charge_failed", subscription: updated, error });
      return updated;
    }
    const sink: ChargeDueResult = { charged: [], failed: [], canceled: [], pending: [], errors: [] };
    return this.recordRenewalFailure({ ...record, failedAttempts: pending.attempt }, this.now(), error, sink);
  }

  /** One renewal attempt for the period ending at record.currentPeriodEnd. */
  private async renew(
    record: SubscriptionRecord,
    nowMs: number,
    result: ChargeDueResult,
  ): Promise<SubscriptionRecord> {
    // Deterministic per (id, period, attempt): a replayed run can never
    // double-charge, and a RETRY is a genuinely new PSP request (replaying the
    // failed attempt's key would just replay its cached failure).
    const idempotencyKey = `payfanout-sub-${record.id}-${record.currentPeriodEnd}-a${record.failedAttempts}`;
    let payment: PaymentInfo;
    // Only the charge itself may enter the dunning path. A bookkeeping failure
    // AFTER a successful charge must propagate instead: dunning would retry
    // under a fresh attempt key — a second real charge for a period the PSP
    // already collected. Propagating keeps the attempt key unchanged, so the
    // next run replays the PSP's cached success and only redoes bookkeeping.
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
        idempotencyKey,
      });
    } catch (err) {
      return this.recordRenewalFailure(record, nowMs, PayFanoutError.wrap(err, { pspName: record.pspName }), result);
    }

    if (payment.status === "succeeded") {
      // Advance from the PERIOD END, not from "now": billing anchors must not
      // drift later with every cron delay. Re-read before writing so a cancel
      // or update that landed while the charge was in flight is not clobbered.
      const fresh = (await this.store.get(record.id)) ?? record;
      const updated: SubscriptionRecord = {
        ...fresh,
        // A mid-flight cancel stands: the paid-through window still advances
        // (the money moved), the status does not resurrect.
        status: fresh.status === "canceled" ? "canceled" : "active",
        currentPeriodStart: record.currentPeriodEnd,
        currentPeriodEnd: addInterval(record.currentPeriodEnd, record.plan.interval, record.plan.intervalCount),
        failedAttempts: 0,
        lastPaymentId: payment.pspPaymentId,
      };
      delete updated.nextRetryAt;
      delete updated.lastError;
      delete updated.pendingRenewal;
      await this.store.save(updated);
      await this.emit({ type: "subscription.charged", subscription: updated, payment });
      result.charged.push(updated);
      return updated;
    }

    if (payment.status === "processing") {
      // Async rails: the outcome is genuinely unknown. Freeze the record until
      // the host's webhook ingress calls resolvePendingRenewal.
      const fresh = (await this.store.get(record.id)) ?? record;
      const updated: SubscriptionRecord = {
        ...fresh,
        pendingRenewal: {
          pspPaymentId: payment.pspPaymentId,
          periodEnd: record.currentPeriodEnd,
          attempt: record.failedAttempts,
          startedAt: new Date(nowMs).toISOString(),
        },
      };
      await this.store.save(updated);
      await this.emit({ type: "subscription.charge_pending", subscription: updated, payment });
      result.pending.push(updated);
      return updated;
    }

    // Resolved but not collected (failed / canceled / requires_*): a renewal
    // has no customer present, so anything short of money is a failed attempt.
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
    );
  }

  /** Dunning bookkeeping for a renewal attempt that did not collect. */
  private async recordRenewalFailure(
    record: SubscriptionRecord,
    nowMs: number,
    error: PayFanoutError,
    result: ChargeDueResult,
  ): Promise<SubscriptionRecord> {
    const fresh = (await this.store.get(record.id)) ?? record;
    if (fresh.status === "canceled") {
      // Canceled while the charge was failing — dunning would resurrect a
      // past_due ghost on a record that already ended.
      return fresh;
    }
    // Attempt count follows the attempt that actually ran (record), while the
    // rest of the state merges onto the freshest read.
    const attempts = record.failedAttempts + 1;
    const retryDelayHours = this.retryDelaysHours[attempts - 1];
    const exhausted = retryDelayHours === undefined;
    const updated: SubscriptionRecord = {
      ...fresh,
      failedAttempts: attempts,
      lastError: { code: error.code, message: error.message },
      ...(exhausted
        ? { status: "canceled" as const, canceledAt: new Date(nowMs).toISOString() }
        : {
            status: "past_due" as const,
            nextRetryAt: new Date(nowMs + retryDelayHours * 3_600_000).toISOString(),
          }),
    };
    if (exhausted) delete updated.nextRetryAt;
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

  private async emit(event: SubscriptionEvent): Promise<void> {
    try {
      await this.onEvent?.(event);
    } catch {
      // Observability must never break billing.
    }
  }
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
 */
export function addInterval(fromIso: string, interval: SubscriptionInterval, count: number): string {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) {
    throw PayFanoutError.invalidRequest(`Invalid period start "${fromIso}"`);
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
  const day = Math.min(from.getUTCDate(), lastDayOfTarget);
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
