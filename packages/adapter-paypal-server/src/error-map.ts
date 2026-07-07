import { PayFanoutError, type UnifiedErrorCode } from "@payfanout/core";

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
  PAYER_ACTION_REQUIRED: "authentication_required",
  PAYEE_BLOCKED_TRANSACTION: "fraud_suspected",
  COMPLIANCE_VIOLATION: "fraud_suspected",
  TRANSACTION_REFUSED: "processing_error",
  TRANSACTION_LIMIT_EXCEEDED: "processing_error",
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
  AUTHORIZATION_VOIDED: "invalid_request",
  AUTHORIZATION_EXPIRED: "invalid_request",
  PREVIOUSLY_CAPTURED: "invalid_request",
  MAX_CAPTURE_COUNT_EXCEEDED: "invalid_request",
  MAX_CAPTURE_AMOUNT_EXCEEDED: "invalid_request",
  AUTH_CAPTURE_CURRENCY_MISMATCH: "invalid_request",
};

export function mapPayPalError(httpStatus: number, body: unknown): PayFanoutError {
  const parsed = (typeof body === "object" && body !== null ? body : {}) as PayPalErrorBody;
  const issue = parsed.details?.find((d) => d.issue)?.issue;
  const mappedIssue = issue ? ISSUE_MAP[issue] : undefined;
  let code: UnifiedErrorCode;
  let retryable = false;
  let message: string | undefined;
  if (mappedIssue) {
    code = mappedIssue;
    if (code === "card_declined") {
      // Recovery is a fresh approval on the SAME order: the buyer picks a
      // different funding source in the PayPal window, then pay runs again.
      message = "The payment was declined — choose a different way to pay in the PayPal window and try again.";
    }
  } else if (httpStatus === 401 && parsed.error) {
    code = "invalid_request";
    message =
      "PayPal rejected the API credentials — check clientId/clientSecret and that they match the configured environment.";
  } else if (httpStatus === 429 || parsed.name === "RATE_LIMIT_REACHED") {
    code = "rate_limited";
    retryable = true;
  } else if (httpStatus >= 500 || parsed.name === "INTERNAL_SERVICE_ERROR") {
    code = "psp_unavailable";
    retryable = true;
  } else if (httpStatus === 409) {
    // Conflict: a previous operation (e.g. a refund) is still in progress.
    code = "processing_error";
    retryable = true;
  } else {
    code = "invalid_request";
  }
  return new PayFanoutError({
    code,
    message: message ?? defaultMessageFor(code),
    retryable,
    raw: body,
    pspName: PAYPAL_PSP_NAME,
  });
}

function defaultMessageFor(code: UnifiedErrorCode): string {
  switch (code) {
    case "card_declined":
      return "Your payment was declined.";
    case "authentication_required":
      return "Additional approval is required — return to PayPal to continue.";
    case "fraud_suspected":
      return "The payment was declined.";
    case "rate_limited":
      return "Too many requests — please retry shortly.";
    case "processing_error":
      return "The operation cannot be processed right now — please try again later.";
    case "psp_unavailable":
      return "The payment provider is temporarily unavailable.";
    default:
      return "The payment request was invalid.";
  }
}
