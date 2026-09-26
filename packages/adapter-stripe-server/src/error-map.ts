import { isPayFanoutError, PayFanoutError, type UnifiedErrorCode } from "@payfanout/core";

interface StripeErrorLike {
  type?: string;
  code?: string;
  decline_code?: string;
  statusCode?: number;
  message?: string;
}

const INVALID_CARD_DATA_CODES = new Set([
  "incorrect_number",
  "invalid_number",
  "incorrect_cvc",
  "invalid_cvc",
  "invalid_expiry_month",
  "invalid_expiry_year",
  "incorrect_address",
  "incorrect_zip",
  "incorrect_postal_code",
]);

// The last is a local payment method's decline code, with the same instruction.
const FRAUD_DECLINE_CODES = new Set(["fraudulent", "stolen_card", "lost_card", "merchant_blacklist", "lost_or_stolen_card"]);

/** A failed 3-D Secure: the general code 2026-08-26.dahlia added and the intent-specific forms before it. */
const AUTHENTICATION_FAILURE_CODES = new Set([
  "authentication_failure",
  "payment_intent_authentication_failure",
  "setup_intent_authentication_failure",
]);

/** Maps any Stripe SDK error onto the unified taxonomy, preserving the original on `raw`. */
export function mapStripeError(err: unknown): PayFanoutError {
  if (isPayFanoutError(err)) return err;
  const e = (err ?? {}) as StripeErrorLike;
  const { code, retryable, message, outcomeUnknown } = classify(e);
  return new PayFanoutError({
    code,
    message,
    retryable,
    raw: err,
    pspName: "stripe",
    ...(outcomeUnknown ? { outcomeUnknown } : {}),
  });
}

function classify(e: StripeErrorLike): {
  code: UnifiedErrorCode;
  retryable: boolean;
  message: string;
  outcomeUnknown?: true;
} {
  if (e.type === "StripeRateLimitError" || e.statusCode === 429) {
    return { code: "rate_limited", retryable: true, message: "Too many requests — please retry shortly." };
  }
  if (e.type === "StripeConnectionError" || e.type === "StripeAPIError" || (e.statusCode ?? 0) >= 500) {
    return { code: "psp_unavailable", retryable: true, message: "The payment provider is temporarily unavailable." };
  }
  if (e.type === "StripeIdempotencyError") {
    // The key was already used, by a request whose result Stripe keeps: that
    // request may have gone through, so only the same key may follow.
    return { code: "invalid_request", retryable: false, message: "The payment request was invalid.", outcomeUnknown: true };
  }
  if (e.type === "StripeAuthenticationError") {
    return { code: "invalid_request", retryable: false, message: "Payment configuration error." };
  }
  if (e.type === "StripeCardError") {
    // Stripe card-error messages are written to be end-user safe.
    const userMessage = e.message ?? "Your card was declined.";
    if (e.decline_code === "insufficient_funds" || e.code === "insufficient_funds") {
      return { code: "insufficient_funds", retryable: false, message: userMessage };
    }
    // The issuer's decline code counts like the error code wherever Stripe uses the
    // same word for both, as the browser adapter reads it.
    if (e.code === "expired_card" || e.code === "expired_payment_method" || e.decline_code === "expired_card") {
      return { code: "expired_card", retryable: false, message: userMessage };
    }
    if ((e.code && INVALID_CARD_DATA_CODES.has(e.code)) || (e.decline_code && INVALID_CARD_DATA_CODES.has(e.decline_code))) {
      return { code: "invalid_card_data", retryable: false, message: userMessage };
    }
    if (
      e.code === "authentication_required" ||
      e.decline_code === "authentication_required" ||
      // Only a decline code: the issuer declines again when the required authentication was skipped.
      e.decline_code === "authentication_not_handled"
    ) {
      // Resolved by bringing the customer back on-session, never by replaying the call.
      return { code: "authentication_required", retryable: false, message: userMessage };
    }
    if (e.decline_code && FRAUD_DECLINE_CODES.has(e.decline_code)) {
      return { code: "fraud_suspected", retryable: false, message: "Your card was declined." };
    }
    if (e.code && AUTHENTICATION_FAILURE_CODES.has(e.code)) {
      // Mapped as the browser adapter maps these codes and the other adapters map
      // their failed 3-D Secure.
      return { code: "authentication_required", retryable: false, message: userMessage };
    }
    if (e.code === "processing_error" || e.decline_code === "processing_error") {
      return { code: "processing_error", retryable: true, message: userMessage };
    }
    return { code: "card_declined", retryable: false, message: userMessage };
  }
  if (e.type === "StripeInvalidRequestError" || e.statusCode === 400 || e.statusCode === 404) {
    return { code: "invalid_request", retryable: false, message: "The payment request was invalid." };
  }
  return { code: "unknown", retryable: false, message: "Payment operation failed." };
}
