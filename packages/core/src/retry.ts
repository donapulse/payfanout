import { isPayFanoutError } from "./errors.js";

/**
 * Backoff machinery for the `PayFanoutError.retryable` flag. Every mutating
 * PayFanout call requires an idempotency key, so retrying a transient failure
 * (PSP down, rate limited, network timeout) can never double-charge — this
 * helper is the missing piece that turns the flag into behavior:
 *
 *   const info = await withRetry(() => payments.capturePayment("stripe", id, amt, key));
 *
 * Retries only errors the default predicate accepts (PayFanoutError with
 * retryable: true). Anything else — business rejections, declines, bugs —
 * rethrows immediately.
 */
export interface RetryPolicy {
  /** Additional attempts after the first (default 2 → at most 3 calls). */
  retries?: number;
  /** First backoff delay in ms (default 200). Doubles per attempt. */
  minDelayMs?: number;
  /** Backoff ceiling in ms (default 5000) — a hard cap, jitter included. */
  maxDelayMs?: number;
  /** Adds 0–25% random jitter to each delay (default true) to avoid thundering herds. */
  jitter?: boolean;
  /**
   * Cancels waiting: an aborted signal stops before the next attempt and
   * rejects with the signal's reason (the in-flight attempt itself is the
   * caller's to abort — thread the same signal into it).
   */
  signal?: AbortSignal;
  /** Which errors to retry. Default: isPayFanoutError(err) && err.retryable. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Observability: called before each backoff sleep. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Test seam; defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for jitter; defaults to Math.random. */
  random?: () => number;
}

export function defaultShouldRetry(error: unknown): boolean {
  return isPayFanoutError(error) && error.retryable;
}

export async function withRetry<T>(fn: () => Promise<T>, policy: RetryPolicy = {}): Promise<T> {
  const retries = policy.retries ?? 2;
  const minDelayMs = policy.minDelayMs ?? 200;
  const maxDelayMs = policy.maxDelayMs ?? 5000;
  const shouldRetry = policy.shouldRetry ?? defaultShouldRetry;
  const sleep = policy.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = policy.random ?? Math.random;

  let attempt = 0;
  while (true) {
    if (policy.signal?.aborted) throw abortReason(policy.signal);
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt > retries || !shouldRetry(error, attempt)) throw error;
      if (policy.signal?.aborted) throw abortReason(policy.signal);
      const base = Math.min(maxDelayMs, minDelayMs * 2 ** (attempt - 1));
      const jittered = policy.jitter === false ? base : Math.round(base * (1 + random() * 0.25));
      const delayMs = Math.min(maxDelayMs, jittered); // maxDelayMs is a hard ceiling, jitter included
      policy.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Retry aborted");
}
