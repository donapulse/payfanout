import { getUserMessage } from "./messages.js";

/**
 * Unified error taxonomy. Every rejection from any adapter method rejects with
 * PayFanoutError — never a raw PSP error. The original PSP error is always
 * preserved untouched on `raw` for logs/support.
 *
 * `retryable` semantics adapters must honor (conformance asserts them):
 * `rate_limited` and `psp_unavailable` are always retryable;
 * `authentication_required` is NEVER retryable — resolving it means bringing
 * the customer back on-session, not replaying the call.
 */
export type UnifiedErrorCode =
  | "card_declined"
  | "insufficient_funds"
  | "expired_card"
  | "invalid_card_data"
  | "authentication_required"
  | "fraud_suspected"
  | "processing_error"
  | "rate_limited"
  | "psp_unavailable"
  | "invalid_request"
  /** A stateless session/token outlived its expiry — recover by creating a fresh session. */
  | "session_expired"
  /** The adapter/PSP cannot perform the requested operation (capability guard). */
  | "unsupported_operation"
  | "unknown";

export interface UnifiedError {
  code: UnifiedErrorCode;
  /** Safe to show to end users. */
  message: string;
  retryable: boolean;
  /** Untouched original PSP error, for logs/support — never dropped. */
  raw: unknown;
}

export interface PayFanoutErrorInit {
  code: UnifiedErrorCode;
  message: string;
  retryable?: boolean;
  raw?: unknown;
  /** Which adapter produced the error, when known. */
  pspName?: string;
}

export class PayFanoutError extends Error implements UnifiedError {
  readonly code: UnifiedErrorCode;
  readonly retryable: boolean;
  readonly raw: unknown;
  readonly pspName?: string;

  constructor(init: PayFanoutErrorInit) {
    super(init.message);
    this.name = "PayFanoutError";
    this.code = init.code;
    this.retryable = init.retryable ?? false;
    this.raw = init.raw;
    if (init.pspName !== undefined) this.pspName = init.pspName;
  }

  /**
   * Normalizes any thrown value into a PayFanoutError. Existing PayFanoutErrors
   * pass through unchanged (so `raw` and `code` set close to the PSP win);
   * anything else becomes `code: "unknown"` (unless the fallback says
   * otherwise) with the original value on `raw`. The wrapped error's own
   * message is never copied into `message` — it is user-facing and arbitrary
   * error text can leak internals — so absent `fallback.message` the built-in
   * user-safe catalog message for the code is used instead.
   */
  static wrap(err: unknown, fallback?: Partial<PayFanoutErrorInit>): PayFanoutError {
    if (isPayFanoutError(err)) return err;
    const code = fallback?.code ?? "unknown";
    return new PayFanoutError({
      code,
      message: fallback?.message ?? getUserMessage(code),
      retryable: fallback?.retryable ?? false,
      raw: err,
      pspName: fallback?.pspName,
    });
  }

  static invalidRequest(message: string, raw?: unknown): PayFanoutError {
    return new PayFanoutError({ code: "invalid_request", message, retryable: false, raw });
  }

  toJSON(): { name: string; code: UnifiedErrorCode; message: string; retryable: boolean; pspName?: string } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.pspName !== undefined ? { pspName: this.pspName } : {}),
    };
  }
}

/**
 * True for PayFanoutError instances and structural matches. The structural
 * fallback matters because a host's node_modules can hold duplicated copies of
 * core — `instanceof` fails across copies, so the unified shape is the contract.
 */
export function isPayFanoutError(err: unknown): err is PayFanoutError {
  if (err instanceof PayFanoutError) return true;
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as Record<string, unknown>;
  return (
    candidate["name"] === "PayFanoutError" &&
    typeof candidate["code"] === "string" &&
    typeof candidate["retryable"] === "boolean" &&
    typeof candidate["message"] === "string"
  );
}
