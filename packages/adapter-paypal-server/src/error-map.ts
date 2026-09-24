import { classifyHttpFallback, getUserMessage, PayFanoutError, type UnifiedErrorCode } from "@payfanout/core";

export const PAYPAL_PSP_NAME = "paypal";

/**
 * Standard PayPal REST error body: `{ name, message, debug_id, details:
 * [{ issue, description, … }] }`. OAuth-layer failures use the alternate
 * `{ error, error_description }` shape. Matching order: details[].issue
 * first, then name, then HTTP status.
 */
interface PayPalErrorBody {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: Array<{ issue?: string; description?: string; field?: string }>;
  error?: string;
  error_description?: string;
}

const ISSUE_MAP: Record<string, UnifiedErrorCode> = {
  // The branded flow reports no granular decline reason (no
  // insufficient_funds/expired_card split) — a funding failure is a decline.
  INSTRUMENT_DECLINED: "card_declined",
  REDIRECT_PAYER_FOR_ALTERNATE_FUNDING: "card_declined",
  // The payer's account, not a funding source, is refused: another method is needed.
  PAYMENT_DENIED: "card_declined",
  PAYER_CANNOT_PAY: "card_declined",
  PAYER_ACCOUNT_RESTRICTED: "card_declined",
  PAYER_ACCOUNT_LOCKED_OR_CLOSED: "card_declined",
  MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED: "card_declined",
  PAYER_ACTION_REQUIRED: "authentication_required",
  PAYEE_BLOCKED_TRANSACTION: "fraud_suspected",
  TRANSACTION_BLOCKED_BY_PAYEE: "fraud_suspected",
  COMPLIANCE_VIOLATION: "fraud_suspected",
  TRANSACTION_REFUSED: "processing_error",
  TRANSACTION_LIMIT_EXCEEDED: "processing_error",
  TRANSACTION_RECEIVING_LIMIT_EXCEEDED: "processing_error",
  REFUND_FAILED_INSUFFICIENT_FUNDS: "processing_error",
  // Caller/state problems — never retryable, the router must not cascade them.
  ORDER_NOT_APPROVED: "invalid_request",
  ORDER_ALREADY_CAPTURED: "invalid_request",
  ORDER_ALREADY_AUTHORIZED: "invalid_request",
  ORDER_EXPIRED: "invalid_request",
  DUPLICATE_INVOICE_ID: "invalid_request",
  INVALID_CURRENCY_CODE: "invalid_request",
  DECIMAL_PRECISION: "invalid_request",
  MAX_VALUE_EXCEEDED: "invalid_request",
  REFUND_AMOUNT_EXCEEDED: "invalid_request",
  CAPTURE_FULLY_REFUNDED: "invalid_request",
  MAX_NUMBER_OF_REFUNDS_EXCEEDED: "invalid_request",
  REFUND_TIME_LIMIT_EXCEEDED: "invalid_request",
  REFUND_NOT_ALLOWED: "invalid_request",
  PENDING_CAPTURE: "invalid_request",
  AUTHORIZATION_ALREADY_CAPTURED: "invalid_request",
  AUTHORIZATION_DENIED: "invalid_request",
  AUTHORIZATION_VOIDED: "invalid_request",
  AUTHORIZATION_EXPIRED: "invalid_request",
  PREVIOUSLY_CAPTURED: "invalid_request",
  MAX_CAPTURE_COUNT_EXCEEDED: "invalid_request",
  MAX_CAPTURE_AMOUNT_EXCEEDED: "invalid_request",
  AUTH_CAPTURE_CURRENCY_MISMATCH: "invalid_request",
};

/**
 * Declines of the payer's account rather than of one funding source: choosing
 * another source in the PayPal window does not help (PayPal's troubleshooting
 * advice for MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED is to use a different
 * payment method).
 */
const ACCOUNT_DECLINES: ReadonlySet<string> = new Set([
  "PAYMENT_DENIED",
  "PAYER_CANNOT_PAY",
  "PAYER_ACCOUNT_RESTRICTED",
  "PAYER_ACCOUNT_LOCKED_OR_CLOSED",
  "MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED",
]);

/** The first details[].issue of a PayPal error body, e.g. ORDER_ALREADY_CAPTURED. */
export function payPalErrorIssue(body: unknown): string | undefined {
  const details = typeof body === "object" && body !== null ? (body as PayPalErrorBody).details : undefined;
  if (!Array.isArray(details)) return undefined;
  return (details as Array<{ issue?: string } | null>).find((detail) => detail?.issue)?.issue;
}

export function mapPayPalError(httpStatus: number, body: unknown): PayFanoutError {
  const parsed = (typeof body === "object" && body !== null ? body : {}) as PayPalErrorBody;
  const issue = payPalErrorIssue(body);
  const mappedIssue = issue ? ISSUE_MAP[issue] : undefined;
  let code: UnifiedErrorCode;
  let retryable = false;
  let message: string | undefined;
  const fallback = classifyHttpFallback(httpStatus);
  if (mappedIssue) {
    code = mappedIssue;
    if (code === "card_declined" && ACCOUNT_DECLINES.has(issue!)) {
      message = "PayPal declined this payment — choose another payment method.";
    } else if (code === "card_declined") {
      // Recovery is a fresh approval on the SAME order: the buyer picks a
      // different funding source in the PayPal window, then pay runs again.
      message = "The payment was declined — choose a different way to pay in the PayPal window and try again.";
    } else if (code === "authentication_required") {
      // PSP-specific recovery detail the generic catalog cannot carry.
      message = "Additional approval is required — return to PayPal to continue.";
    }
  } else if (httpStatus === 401 && parsed.error) {
    code = "invalid_request";
    message =
      "PayPal rejected the API credentials — check clientId/clientSecret and that they match the configured environment.";
  } else if (fallback.code === "rate_limited" || parsed.name === "RATE_LIMIT_REACHED") {
    code = "rate_limited";
    retryable = true;
  } else if (
    fallback.code === "psp_unavailable" ||
    parsed.name === "INTERNAL_SERVER_ERROR" ||
    parsed.name === "INTERNAL_SERVICE_ERROR"
  ) {
    // INTERNAL_SERVER_ERROR is PayPal's documented name; INTERNAL_SERVICE_ERROR stays accepted.
    code = "psp_unavailable";
    retryable = true;
  } else if (httpStatus === 409) {
    // Conflict: a previous operation (e.g. a refund) is still in progress.
    code = "processing_error";
    retryable = true;
  } else {
    ({ code, retryable } = fallback);
  }
  return new PayFanoutError({
    code,
    message: message ?? getUserMessage(code),
    retryable,
    raw: body,
    pspName: PAYPAL_PSP_NAME,
  });
}
