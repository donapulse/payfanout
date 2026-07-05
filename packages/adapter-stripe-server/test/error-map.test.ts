import { describe, expect, it } from "vitest";
import type { UnifiedErrorCode } from "@payfanout/core";
import { mapStripeError } from "../src/index.js";

/** Table-driven sweep over every branch of the Stripe error taxonomy mapping. */
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
      name: "3DS required",
      err: { type: "StripeCardError", code: "authentication_required", message: "…" },
      code: "authentication_required",
      retryable: true,
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
      name: "processing error",
      err: { type: "StripeCardError", code: "processing_error", message: "…" },
      code: "processing_error",
      retryable: true,
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
