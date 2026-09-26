import { describe, expect, it } from "vitest";
import type { UnifiedErrorCode } from "@payfanout/core";
import { mapStripeError } from "../src/index.js";

/** Table-driven sweep over every branch of the Stripe error taxonomy mapping. */
describe("Stripe idempotency refusals", () => {
  it("marks a reused-key refusal outcomeUnknown: the key's first request may have gone through", () => {
    const refused = mapStripeError({
      type: "StripeIdempotencyError",
      statusCode: 400,
      message: "Keys for idempotent requests can only be used with the same parameters they were first used with.",
    });
    expect(refused).toMatchObject({ code: "invalid_request", retryable: false, outcomeUnknown: true });
    expect(mapStripeError({ type: "StripeInvalidRequestError", statusCode: 400, message: "No such customer." }).outcomeUnknown).toBeUndefined();
  });
});

describe("mapStripeError", () => {
  const cases: Array<{
    name: string;
    err: object;
    code: UnifiedErrorCode;
    retryable: boolean;
  }> = [
    { name: "rate limit by type", err: { type: "StripeRateLimitError" }, code: "rate_limited", retryable: true },
    { name: "rate limit by status", err: { statusCode: 429 }, code: "rate_limited", retryable: true },
    { name: "connection error", err: { type: "StripeConnectionError" }, code: "psp_unavailable", retryable: true },
    { name: "API 5xx", err: { type: "StripeAPIError", statusCode: 500 }, code: "psp_unavailable", retryable: true },
    // The SDK reports a response body cut off mid-transfer this way: no status code at all.
    { name: "API error without a status", err: { type: "StripeAPIError" }, code: "psp_unavailable", retryable: true },
    { name: "bad API key", err: { type: "StripeAuthenticationError" }, code: "invalid_request", retryable: false },
    {
      name: "insufficient funds decline",
      err: { type: "StripeCardError", code: "card_declined", decline_code: "insufficient_funds", message: "…" },
      code: "insufficient_funds",
      retryable: false,
    },
    {
      name: "expired card",
      err: { type: "StripeCardError", code: "expired_card", message: "…" },
      code: "expired_card",
      retryable: false,
    },
    {
      // Payment-method-agnostic spelling of expired_card (2026-08-26.dahlia).
      name: "expired payment method",
      err: { type: "StripeCardError", code: "expired_payment_method", message: "…" },
      code: "expired_card",
      retryable: false,
    },
    {
      name: "bad CVC",
      err: { type: "StripeCardError", code: "incorrect_cvc", message: "…" },
      code: "invalid_card_data",
      retryable: false,
    },
    {
      name: "bad number",
      err: { type: "StripeCardError", code: "invalid_number", message: "…" },
      code: "invalid_card_data",
      retryable: false,
    },
    {
      // Payment-method-agnostic spelling of incorrect_zip (2026-08-26.dahlia).
      name: "incorrect postal code",
      err: { type: "StripeCardError", code: "incorrect_postal_code", message: "…" },
      code: "invalid_card_data",
      retryable: false,
    },
    {
      name: "incorrect address",
      err: { type: "StripeCardError", code: "incorrect_address", message: "…" },
      code: "invalid_card_data",
      retryable: false,
    },
    {
      // Resolved by bringing the customer back on-session — never by replay.
      name: "3DS required",
      err: { type: "StripeCardError", code: "authentication_required", message: "…" },
      code: "authentication_required",
      retryable: false,
    },
    {
      // A failed 3-D Secure, as the browser adapter and the other adapters map it (docs/decisions.md).
      name: "failed authentication",
      err: { type: "StripeCardError", code: "authentication_failure", message: "…" },
      code: "authentication_required",
      retryable: false,
    },
    {
      name: "failed PaymentIntent authentication, before dahlia",
      err: { type: "StripeCardError", code: "payment_intent_authentication_failure", message: "…" },
      code: "authentication_required",
      retryable: false,
    },
    {
      name: "failed SetupIntent authentication, before dahlia",
      err: { type: "StripeCardError", code: "setup_intent_authentication_failure", message: "…" },
      code: "authentication_required",
      retryable: false,
    },
    {
      // A fraud decline code still wins over the authentication failure.
      name: "failed authentication on a card reported stolen",
      err: { type: "StripeCardError", code: "authentication_failure", decline_code: "stolen_card", message: "…" },
      code: "fraud_suspected",
      retryable: false,
    },
    {
      name: "fraud decline",
      err: { type: "StripeCardError", code: "card_declined", decline_code: "fraudulent", message: "…" },
      code: "fraud_suspected",
      retryable: false,
    },
    {
      name: "stolen card decline",
      err: { type: "StripeCardError", code: "card_declined", decline_code: "stolen_card", message: "…" },
      code: "fraud_suspected",
      retryable: false,
    },
    {
      name: "restricted payment method",
      err: { type: "StripeCardError", code: "payment_method_restricted", message: "…" },
      code: "card_declined",
      retryable: false,
    },
    {
      // Stripe does not say whether a decline code accompanies this code; when one names a
      // lost or stolen card, it still decides.
      name: "restricted payment method reported lost",
      err: { type: "StripeCardError", code: "payment_method_restricted", decline_code: "lost_card", message: "…" },
      code: "fraud_suspected",
      retryable: false,
    },
    {
      name: "processing error",
      err: { type: "StripeCardError", code: "processing_error", message: "…" },
      code: "processing_error",
      retryable: true,
    },
    // The issuer's decline codes that repeat an error code map as that code does.
    {
      name: "issuer decline naming a wrong CVC",
      err: { type: "StripeCardError", code: "card_declined", decline_code: "incorrect_cvc", message: "…" },
      code: "invalid_card_data",
      retryable: false,
    },
    {
      name: "issuer decline naming a wrong postal code",
      err: { type: "StripeCardError", code: "card_declined", decline_code: "incorrect_zip", message: "…" },
      code: "invalid_card_data",
      retryable: false,
    },
    {
      name: "issuer decline naming a wrong address",
      err: { type: "StripeCardError", code: "card_declined", decline_code: "incorrect_address", message: "…" },
      code: "invalid_card_data",
      retryable: false,
    },
    {
      // In the card-data step, so it comes before a fraud decline code on the same error.
      name: "a wrong address with a fraud decline code",
      err: { type: "StripeCardError", code: "incorrect_address", decline_code: "fraudulent", message: "…" },
      code: "invalid_card_data",
      retryable: false,
    },
    {
      name: "issuer decline for an expired card",
      err: { type: "StripeCardError", code: "card_declined", decline_code: "expired_card", message: "…" },
      code: "expired_card",
      retryable: false,
    },
    {
      name: "issuer decline for a processing error",
      err: { type: "StripeCardError", code: "card_declined", decline_code: "processing_error", message: "…" },
      code: "processing_error",
      retryable: true,
    },
    {
      // A required authentication comes before a fraud decline code, as in the browser.
      name: "authentication required on a card reported fraudulent",
      err: { type: "StripeCardError", code: "authentication_required", decline_code: "fraudulent", message: "…" },
      code: "authentication_required",
      retryable: false,
    },
    ...["incorrect_number", "invalid_cvc", "invalid_expiry_month", "invalid_expiry_year"].map((declineCode) => ({
      name: `issuer decline code ${declineCode}`,
      err: { type: "StripeCardError", code: "card_declined", decline_code: declineCode, message: "…" },
      code: "invalid_card_data" as UnifiedErrorCode,
      retryable: false,
    })),
    {
      name: "issuer decline requiring authentication",
      err: { type: "StripeCardError", code: "card_declined", decline_code: "authentication_required", message: "…" },
      code: "authentication_required",
      retryable: false,
    },
    {
      name: "issuer decline after a skipped authentication",
      err: { type: "StripeCardError", code: "card_declined", decline_code: "authentication_not_handled", message: "…" },
      code: "authentication_required",
      retryable: false,
    },
    {
      // Read in the required-authentication step, so a processing error cannot make it retryable.
      name: "skipped authentication with a processing error",
      err: { type: "StripeCardError", code: "processing_error", decline_code: "authentication_not_handled", message: "…" },
      code: "authentication_required",
      retryable: false,
    },
    {
      // Stripe lists authentication_not_handled as a decline code only.
      name: "authentication_not_handled as an error code",
      err: { type: "StripeCardError", code: "authentication_not_handled", message: "…" },
      code: "card_declined",
      retryable: false,
    },
    {
      // Card data the customer can correct comes before the skipped authentication.
      name: "a wrong CVC with a skipped authentication",
      err: { type: "StripeCardError", code: "incorrect_cvc", decline_code: "authentication_not_handled", message: "…" },
      code: "invalid_card_data",
      retryable: false,
    },
    {
      name: "a local payment method reported lost or stolen",
      err: { type: "StripeCardError", code: "card_declined", decline_code: "lost_or_stolen_card", message: "…" },
      code: "fraud_suspected",
      retryable: false,
    },
    {
      name: "a decline code no list holds",
      err: { type: "StripeCardError", code: "card_declined", decline_code: "constructor", message: "…" },
      code: "card_declined",
      retryable: false,
    },
    {
      name: "generic decline",
      err: { type: "StripeCardError", code: "card_declined", message: "…" },
      code: "card_declined",
      retryable: false,
    },
    {
      name: "invalid request by type",
      err: { type: "StripeInvalidRequestError" },
      code: "invalid_request",
      retryable: false,
    },
    { name: "404", err: { statusCode: 404 }, code: "invalid_request", retryable: false },
    { name: "unrecognized shape", err: { weird: true }, code: "unknown", retryable: false },
  ];

  for (const { name, err, code, retryable } of cases) {
    it(`maps ${name} -> ${code}`, () => {
      const mapped = mapStripeError(err);
      expect(mapped.code).toBe(code);
      expect(mapped.retryable).toBe(retryable);
      expect(mapped.raw).toBe(err); // untouched original, always
      expect(mapped.pspName).toBe("stripe");
      expect(mapped.message.length).toBeGreaterThan(0);
    });
  }

  it("keeps Stripe's user-safe message for card errors, replaces it for fraud", () => {
    const declined = mapStripeError({
      type: "StripeCardError",
      code: "card_declined",
      message: "Your card has insufficient funds.",
      decline_code: "insufficient_funds",
    });
    expect(declined.message).toBe("Your card has insufficient funds.");
    const fraud = mapStripeError({
      type: "StripeCardError",
      code: "card_declined",
      decline_code: "stolen_card",
      message: "Card reported stolen.", // never shown to the cardholder
    });
    expect(fraud.message).toBe("Your card was declined.");
  });

  it("passes existing PayFanoutErrors through untouched", () => {
    const original = mapStripeError({ statusCode: 429 });
    expect(mapStripeError(original)).toBe(original);
  });

  it("handles null/undefined without crashing", () => {
    expect(mapStripeError(null).code).toBe("unknown");
    expect(mapStripeError(undefined).code).toBe("unknown");
  });
});
