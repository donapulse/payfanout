import { describe, expect, it } from "vitest";
import { isPayFanoutError, PayFanoutError } from "@payfanout/core";

describe("PayFanoutError", () => {
  it("is a real Error subclass carrying the unified shape", () => {
    const raw = { psp: "says no" };
    const err = new PayFanoutError({
      code: "card_declined",
      message: "Your card was declined.",
      retryable: false,
      raw,
      pspName: "stripe",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PayFanoutError");
    expect(err.code).toBe("card_declined");
    expect(err.raw).toBe(raw); // untouched, never dropped
    expect(err.pspName).toBe("stripe");
    expect(err.retryable).toBe(false);
  });

  it("wrap() passes PayFanoutErrors through unchanged", () => {
    const original = PayFanoutError.invalidRequest("bad input", { field: "amount" });
    expect(PayFanoutError.wrap(original)).toBe(original);
  });

  it("wrap() normalizes unknown values, preserving them on raw", () => {
    const cause = new TypeError("boom");
    const wrapped = PayFanoutError.wrap(cause, { pspName: "paysafe" });
    expect(isPayFanoutError(wrapped)).toBe(true);
    expect(wrapped.code).toBe("unknown");
    expect(wrapped.raw).toBe(cause);
    expect(wrapped.pspName).toBe("paysafe");

    const wrappedString = PayFanoutError.wrap("plain failure");
    expect(wrappedString.raw).toBe("plain failure");
    expect(wrappedString.message).toBe("Payment operation failed");
  });

  it("toJSON omits raw (may hold huge/circular PSP payloads) but keeps taxonomy fields", () => {
    const err = PayFanoutError.wrap(new Error("x"), { code: "psp_unavailable", retryable: true });
    const json = err.toJSON();
    expect(json).toEqual({
      name: "PayFanoutError",
      code: "psp_unavailable",
      message: "x",
      retryable: true,
    });
    expect("raw" in json).toBe(false);
  });
});
