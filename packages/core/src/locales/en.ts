import type { LocaleBundle } from "./index.js";

/**
 * English — the source of truth. Adapters produce these user-safe messages
 * directly; other locales translate by CODE, never by string-matching English.
 */
export const en: LocaleBundle = {
  errors: {
    card_declined: "Your card was declined.",
    insufficient_funds: "Your card has insufficient funds.",
    expired_card: "Your card has expired.",
    invalid_card_data: "The card details are invalid.",
    authentication_required: "Additional authentication is required to complete this payment.",
    fraud_suspected: "Your card was declined.",
    processing_error: "The payment could not be processed — please try again.",
    rate_limited: "Too many requests — please retry shortly.",
    psp_unavailable: "The payment provider is temporarily unavailable.",
    invalid_request: "The payment request was invalid.",
    unknown: "Payment failed. Please try again or use a different payment method.",
  },
  ui: {
    pay: "Pay",
  },
};
