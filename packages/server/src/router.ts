import {
  normalizeCurrency,
  PayFanoutError,
  screenSessionInput,
  type CreatePaymentSessionInput,
  type PaymentSession,
  type UnifiedPaymentMethodType,
} from "@payfanout/core";
import type { PaymentService } from "./payment-service.js";

/**
 * Smart routing / failover across PSPs — the flagship reason to run multi-PSP.
 *
 * Scope is session creation only: once a session exists it lives
 * on exactly one PSP, and every later call (completePayment, capture, refund…)
 * goes through PaymentService with the pspName the routed result reported.
 * Mid-payment failover is not a thing — a decline on PSP A is a fact about
 * that attempt, and creating a fresh session on PSP B is a NEW attempt the
 * host initiates (usually after the customer retries).
 */
export interface RoutingConditions {
  /** ISO 4217 codes, matched case-insensitively. */
  currency?: string[];
  /** ISO 3166-1 alpha-2 codes, matched case-insensitively against input.country. */
  country?: string[];
  /**
   * Matches when the session restricts itself to payment method types and at
   * least one of them is listed here. A session with NO restriction (PSP
   * chooses) does not match a method-conditioned rule.
   */
  paymentMethodType?: UnifiedPaymentMethodType[];
}

export interface RoutingRule {
  /** All present conditions must hold (AND); each condition's list is an OR. Empty/absent = match-all. */
  when?: RoutingConditions;
  /** Ordered candidate chain: first is the primary, the rest are failover. */
  use: string[];
}

export interface RoutedAttempt {
  pspName: string;
  /** Why this candidate did not produce the session. */
  error: PayFanoutError;
  /** True when the candidate was skipped up front (capability mismatch), false when the PSP call failed. */
  skipped: boolean;
}

export interface RoutedSessionResult {
  session: PaymentSession;
  /** The PSP that won — pin all follow-up calls (complete/capture/refund/…) to it. */
  pspName: string;
  /** Candidates tried before the winner, in order. Empty on a first-try success. */
  attempts: RoutedAttempt[];
}

/**
 * Outage memory. Without it, a dead PSP gets retried first on EVERY checkout —
 * each customer pays the failed attempt's latency for the whole outage. The
 * breaker skips a PSP after `failureThreshold` consecutive transient failures,
 * lets one probe through after `cooldownMs` (half-open), and closes again on
 * any response that proves the PSP alive (success OR business rejection).
 */
export interface CircuitBreakerOptions {
  /** Consecutive transient failures before the circuit opens. Default 5. */
  failureThreshold?: number;
  /** How long an open circuit skips its PSP before allowing a probe. Default 30_000ms. */
  cooldownMs?: number;
  /** Injected clock for tests. */
  now?: () => number;
}

export interface PaymentRouterOptions {
  service: PaymentService;
  /** First matching rule wins. No match -> defaultChain. */
  rules?: RoutingRule[];
  /** Fallback candidate chain; defaults to the service's registration order. */
  defaultChain?: string[];
  /**
   * Decides whether a failed candidate cascades to the next one. Default:
   * transient PSP-side trouble only (err.retryable, psp_unavailable,
   * rate_limited, processing_error). Business rejections (invalid_request,
   * card_declined, …) abort the cascade — retrying them elsewhere would
   * produce surprise duplicate sessions for a request that is simply wrong.
   * The circuit breaker counts exactly the failures this predicate cascades
   * on, so a custom predicate also redefines what the breaker treats as
   * transient (anything else closes the circuit as proof of life).
   */
  shouldFailover?: (error: PayFanoutError) => boolean;
  /**
   * Observability: called once per failed/skipped candidate and once for the
   * winner (error absent). Exceptions it throws are swallowed — routing always
   * wins over observability, so never rely on this hook for control flow.
   */
  onAttempt?: (attempt: { pspName: string; ok: boolean; skipped?: boolean; error?: PayFanoutError }) => void;
  /**
   * Observability: fired when a PSP's circuit opens (starts being skipped) or
   * closes (a response proved it alive). A failed half-open probe restarts the
   * cooldown without re-firing "opened" — the circuit never closed in between.
   * Exception-isolated like onAttempt.
   */
  onBreakerStateChange?: (event: { pspName: string; state: "opened" | "closed" }) => void;
  /** On by default; pass `false` to disable outage memory entirely. */
  circuitBreaker?: CircuitBreakerOptions | false;
}

const DEFAULT_FAILOVER_CODES = new Set(["psp_unavailable", "rate_limited", "processing_error"]);

export function defaultShouldFailover(error: PayFanoutError): boolean {
  return error.retryable || DEFAULT_FAILOVER_CODES.has(error.code);
}

interface BreakerState {
  consecutiveFailures: number;
  openedAt?: number;
}

export class PaymentRouter {
  private readonly service: PaymentService;
  private readonly rules: RoutingRule[];
  private readonly defaultChain: string[];
  private readonly shouldFailover: (error: PayFanoutError) => boolean;
  private readonly onAttempt?: PaymentRouterOptions["onAttempt"];
  private readonly onBreakerStateChange?: PaymentRouterOptions["onBreakerStateChange"];
  private readonly breaker: Required<CircuitBreakerOptions> | undefined;
  private readonly breakerState = new Map<string, BreakerState>();

  constructor(options: PaymentRouterOptions) {
    this.service = options.service;
    this.rules = options.rules ?? [];
    this.defaultChain = options.defaultChain ?? options.service.listPsps();
    this.shouldFailover = options.shouldFailover ?? defaultShouldFailover;
    this.onAttempt = options.onAttempt;
    this.onBreakerStateChange = options.onBreakerStateChange;
    this.breaker =
      options.circuitBreaker === false
        ? undefined
        : {
            failureThreshold: options.circuitBreaker?.failureThreshold ?? 5,
            cooldownMs: options.circuitBreaker?.cooldownMs ?? 30_000,
            now: options.circuitBreaker?.now ?? Date.now,
          };

    if (this.defaultChain.length === 0) {
      throw PayFanoutError.invalidRequest("PaymentRouter needs at least one PSP in its default chain");
    }
    // Misrouting to an unregistered PSP is a config bug — fail at construction, not checkout.
    const registered = new Set(options.service.listPsps());
    for (const chain of [this.defaultChain, ...this.rules.map((r) => r.use)]) {
      if (chain.length === 0) {
        throw PayFanoutError.invalidRequest("PaymentRouter rules must name at least one PSP in `use`");
      }
      for (const psp of chain) {
        if (!registered.has(psp)) {
          throw PayFanoutError.invalidRequest(
            `PaymentRouter references psp "${psp}" which is not registered (registered: ${[...registered].join(", ")})`,
          );
        }
      }
    }
  }

  /** The ordered candidate chain the rules produce for this input — exposed for tests/dry runs. */
  selectChain(input: CreatePaymentSessionInput): string[] {
    for (const rule of this.rules) {
      if (matches(rule.when, input)) return [...rule.use];
    }
    return [...this.defaultChain];
  }

  /**
   * Creates the session on the first candidate able to serve it, cascading on
   * transient failures. Capability mismatches (manual capture, zero-amount
   * verification, unsupported method types) skip the candidate up front —
   * no PSP round-trip is spent on a call that cannot succeed.
   */
  async createPaymentSession(input: CreatePaymentSessionInput): Promise<RoutedSessionResult> {
    const chain = this.selectChain(input);
    const attempts: RoutedAttempt[] = [];

    // Desperation rule: when EVERY capability-eligible candidate has an open
    // circuit, skipping them all would turn an outage into a self-inflicted
    // hard-down — ignore the breaker for this request and try them anyway.
    const eligibleCandidates = chain.filter((psp) => !this.eligibilityError(psp, input));
    const honorBreaker = eligibleCandidates.some((psp) => !this.isCircuitOpen(psp));

    for (const pspName of chain) {
      const ineligible = this.eligibilityError(pspName, input);
      if (ineligible) {
        attempts.push({ pspName, error: ineligible, skipped: true });
        this.emitAttempt({ pspName, ok: false, skipped: true, error: ineligible });
        continue;
      }
      if (honorBreaker && this.isCircuitOpen(pspName)) {
        const error = new PayFanoutError({
          code: "psp_unavailable",
          message: `"${pspName}" is skipped by the circuit breaker (recent consecutive failures) — retrying after cooldown`,
          retryable: true,
          pspName,
        });
        attempts.push({ pspName, error, skipped: true });
        this.emitAttempt({ pspName, ok: false, skipped: true, error });
        continue;
      }
      try {
        const session = await this.service.createPaymentSession(pspName, input);
        this.recordOutcome(pspName, undefined);
        this.emitAttempt({ pspName, ok: true });
        return { session, pspName, attempts };
      } catch (err) {
        const error = PayFanoutError.wrap(err, { pspName });
        this.recordOutcome(pspName, error);
        attempts.push({ pspName, error, skipped: false });
        this.emitAttempt({ pspName, ok: false, skipped: false, error });
        const isLast = pspName === chain[chain.length - 1];
        if (!isLast && this.shouldFailover(error)) continue;
        throw withAttemptTrail(error, attempts);
      }
    }

    // Every candidate was skipped (ineligible or circuit-open).
    throw new PayFanoutError({
      code: attempts.some((a) => a.error.code === "psp_unavailable") ? "psp_unavailable" : "invalid_request",
      message: `No PSP in the routing chain [${chain.join(", ")}] can serve this payment`,
      retryable: attempts.some((a) => a.error.retryable),
      raw: attempts.map((a) => ({ pspName: a.pspName, code: a.error.code, message: a.error.message })),
    });
  }

  /**
   * Read-only breaker snapshot for dashboards/health endpoints, keyed by
   * pspName. Only PSPs with recorded consecutive failures appear. `open` means
   * "currently skipped"; `openUntil` (present once the circuit has opened) is
   * when the current cooldown ends — in the past, the circuit is half-open and
   * the next request probes the PSP.
   */
  getBreakerState(): Record<string, { consecutiveFailures: number; open: boolean; openUntil?: string }> {
    const snapshot: Record<string, { consecutiveFailures: number; open: boolean; openUntil?: string }> = {};
    for (const [pspName, state] of this.breakerState) {
      snapshot[pspName] = {
        consecutiveFailures: state.consecutiveFailures,
        open: this.isCircuitOpen(pspName),
        ...(this.breaker && state.openedAt !== undefined
          ? { openUntil: new Date(state.openedAt + this.breaker.cooldownMs).toISOString() }
          : {}),
      };
    }
    return snapshot;
  }

  /** Open = threshold reached and still inside the cooldown window (after it: half-open, probe allowed). */
  private isCircuitOpen(pspName: string): boolean {
    if (!this.breaker) return false;
    const state = this.breakerState.get(pspName);
    if (!state || state.consecutiveFailures < this.breaker.failureThreshold || state.openedAt === undefined) {
      return false;
    }
    return this.breaker.now() - state.openedAt < this.breaker.cooldownMs;
  }

  /**
   * Success or business rejection = the PSP answered = circuit closes.
   * Transient failure increments; hitting the threshold (re)opens — including
   * a failed half-open probe, which restarts the cooldown.
   */
  private recordOutcome(pspName: string, error: PayFanoutError | undefined): void {
    if (!this.breaker) return;
    // "Open" for transition purposes = openedAt set: half-open still counts,
    // so a recovered probe fires "closed" and a failed one repeats nothing.
    const wasOpen = this.breakerState.get(pspName)?.openedAt !== undefined;
    if (error === undefined || !this.shouldFailover(error)) {
      this.breakerState.delete(pspName);
      if (wasOpen) this.emitBreakerChange(pspName, "closed");
      return;
    }
    const state = this.breakerState.get(pspName) ?? { consecutiveFailures: 0 };
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.breaker.failureThreshold) {
      state.openedAt = this.breaker.now();
    }
    this.breakerState.set(pspName, state);
    if (!wasOpen && state.openedAt !== undefined) this.emitBreakerChange(pspName, "opened");
  }

  private emitBreakerChange(pspName: string, state: "opened" | "closed"): void {
    try {
      this.onBreakerStateChange?.({ pspName, state });
    } catch {
      // Observability must never break routing.
    }
  }

  /**
   * Static capability screening — core's screenSessionInput, the same
   * predicate PaymentService enforces, so a skipped candidate is exactly one
   * the service would have rejected without spending a PSP call. Vault
   * sessions therefore skip candidates without supportsSavedPaymentMethods —
   * but note a vault session is inherently pinned to the PSP holding the
   * customer/token, so route such traffic with single-PSP rules.
   */
  private eligibilityError(pspName: string, input: CreatePaymentSessionInput): PayFanoutError | undefined {
    const issue = screenSessionInput(this.service.getCapabilities(pspName), input);
    return issue ? ineligible(pspName, issue) : undefined;
  }

  private emitAttempt(attempt: Parameters<NonNullable<PaymentRouterOptions["onAttempt"]>>[0]): void {
    try {
      this.onAttempt?.(attempt);
    } catch {
      // Observability must never break routing.
    }
  }
}

/**
 * The error a host catches after a cascade must keep the audit trail of the
 * candidates tried before the final one. The trail nests into `raw` in the
 * same per-candidate shape the all-skipped diagnostic uses, with the failing
 * candidate's own raw preserved under `pspError`. A failure with no earlier
 * attempts rethrows untouched so the adapter's raw shape survives.
 */
function withAttemptTrail(error: PayFanoutError, attempts: RoutedAttempt[]): PayFanoutError {
  if (attempts.length <= 1) return error;
  const trailed = new PayFanoutError({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    pspName: error.pspName,
    raw: {
      pspError: error.raw,
      attempts: attempts.map((a) => ({ pspName: a.pspName, code: a.error.code, message: a.error.message })),
    },
  });
  trailed.stack = error.stack;
  return trailed;
}

function ineligible(pspName: string, message: string): PayFanoutError {
  return new PayFanoutError({ code: "unsupported_operation", message, retryable: false, pspName });
}

function matches(when: RoutingConditions | undefined, input: CreatePaymentSessionInput): boolean {
  if (!when) return true;
  if (when.currency && when.currency.length > 0) {
    const currency = safeNormalizeCurrency(input.currency);
    if (!when.currency.some((c) => safeNormalizeCurrency(c) === currency)) return false;
  }
  if (when.country && when.country.length > 0) {
    const country = (input.country ?? "").trim().toUpperCase();
    if (!country || !when.country.some((c) => c.trim().toUpperCase() === country)) return false;
  }
  if (when.paymentMethodType && when.paymentMethodType.length > 0) {
    const requested = input.paymentMethodTypes ?? [];
    if (!requested.some((t) => when.paymentMethodType!.includes(t))) return false;
  }
  return true;
}

/** Rule matching must never throw on weird input — an unmatchable value simply doesn't match. */
function safeNormalizeCurrency(value: string): string {
  try {
    return normalizeCurrency(value);
  } catch {
    return value.trim().toUpperCase();
  }
}
