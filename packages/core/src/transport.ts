import { isPayFanoutError, type UnifiedErrorCode } from "./errors.js";

/**
 * REST transport primitives shared by the fetch-based server adapters. These
 * are deliberately NOT a client: authentication, request envelopes, and error
 * mapping stay in each adapter — only the transport mechanics (one timeout
 * covering headers AND body, transient-only retries with backoff, tolerant
 * JSON parsing) live here.
 */
export interface TransportRequestOptions {
  /** The fetch to use — adapters expose an injectable `config.fetch` for tests. */
  fetch: typeof fetch;
  /**
   * Abort the whole exchange after this many milliseconds. The timer stays
   * armed until the BODY is read — a response can stall after its headers
   * arrive, and `response.text()` would otherwise wait forever.
   */
  timeoutMs: number;
  /** Optional external cancellation, linked to the same internal abort. */
  signal?: AbortSignal;
  /**
   * Builds the error thrown on transport failure. `timedOut` is true when the
   * exchange was aborted (timeout or external signal) rather than failing on
   * its own — adapters use it to keep their exact user-facing messages
   * ("X did not respond within Nms." vs "Could not reach X.").
   */
  onFailure: (timedOut: boolean, cause: unknown) => Error;
}

/**
 * Performs one fetch exchange — request, response headers, AND body read —
 * under a single abort timer, so a hung PSP connection can never hang the
 * host's request handler. Any failure (abort or network) is mapped through
 * `onFailure`; an HTTP error status is NOT a failure here — the caller maps
 * `response.ok` itself.
 */
export async function requestWithTimeout(
  options: TransportRequestOptions,
  url: string,
  init: RequestInit,
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const abortExternally = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abortExternally, { once: true });
  try {
    const response = await options.fetch(url, { ...init, signal: controller.signal });
    const text = await readBodyWithSignal(response, controller.signal);
    return { response, text };
  } catch (err) {
    throw options.onFailure(controller.signal.aborted, err);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortExternally);
  }
}

/**
 * Reads the response body under the request's abort signal. Native fetch
 * bodies reject on abort by themselves; the explicit race also bounds
 * injected transports whose Responses are not tied to the signal.
 */
function readBodyWithSignal(response: Response, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Response body read aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("Response body read aborted")), {
      once: true,
    });
    response.text().then(resolve, reject);
  });
}

/**
 * Transport-level trouble only: network failure/timeout (psp_unavailable) or
 * rate limiting. Deliberately NOT `error.retryable` — e.g. Paysafe 3406
 * (unbatched settlement) is retryable *hours* later, not milliseconds, and
 * must not spin a transport retry loop.
 */
export function isTransportRetryable(error: unknown): boolean {
  return isPayFanoutError(error) && (error.code === "rate_limited" || error.code === "psp_unavailable");
}

export interface TransportRetryOptions {
  /** Total attempts — adapters pass `1 + maxNetworkRetries`. */
  attempts: number;
  /** Injected backoff sleep for retry tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Which failures may replay; defaults to {@link isTransportRetryable}. */
  isRetryable?: (error: unknown) => boolean;
}

/**
 * Runs `fn` up to `attempts` times with exponential backoff (250ms doubling,
 * capped at 2s). Only failures the predicate accepts are retried — business
 * rejections must surface on the first attempt. Callers are responsible for
 * only retrying operations that are idempotent at the PSP.
 */
export async function withTransportRetries<T>(
  fn: () => Promise<T>,
  options: TransportRetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isRetryable = options.isRetryable ?? isTransportRetryable;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= options.attempts) throw err;
      await sleep(Math.min(2000, 250 * 2 ** (attempt - 1)));
    }
  }
}

/** `JSON.parse` that answers undefined for non-JSON (proxies answer HTML; the raw text still rides errors). */
export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The taxonomy tail every HTTP error mapper shares once PSP-specific codes
 * are exhausted: 429 → rate_limited (retryable), 5xx → psp_unavailable
 * (retryable), anything else → invalid_request (caller-side, never retried).
 */
export function classifyHttpFallback(status: number): { code: UnifiedErrorCode; retryable: boolean } {
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status >= 500) return { code: "psp_unavailable", retryable: true };
  return { code: "invalid_request", retryable: false };
}
