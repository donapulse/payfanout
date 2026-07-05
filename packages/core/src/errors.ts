/**
 * Unified error taxonomy. Every rejection from any adapter method rejects with
 * PayFanoutError — never a raw PSP error. The original PSP error is always
 * preserved untouched on `raw` for logs/support.
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
   * anything else becomes `code: "unknown"` with the original value on `raw`.
   */
  static wrap(err: unknown, fallback?: Partial<PayFanoutErrorInit>): PayFanoutError {
    if (err instanceof PayFanoutError) return err;
    const message =
      fallback?.message ??
      (err instanceof Error ? err.message : "Payment operation failed");
    return new PayFanoutError({
      code: fallback?.code ?? "unknown",
      message,
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

export function isPayFanoutError(err: unknown): err is PayFanoutError {
  return err instanceof PayFanoutError;
}
