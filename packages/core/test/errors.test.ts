import { describe, expect, it } from "vitest";
import { getUserMessage, isPayFanoutError, PayFanoutError } from "@payfanout/core";

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

  it("wrap() normalizes unknown values to the user-safe catalog message, preserving them on raw", () => {
    const cause = new TypeError("ECONNREFUSED 10.0.0.7:443 (internal detail)");
    const wrapped = PayFanoutError.wrap(cause, { pspName: "paysafe" });
    expect(isPayFanoutError(wrapped)).toBe(true);
    expect(wrapped.code).toBe("unknown");
    // The thrown error's own text never reaches the user-facing message —
    // it stays available on raw for logs/support.
    expect(wrapped.message).toBe(getUserMessage("unknown"));
    expect(wrapped.message).not.toContain("ECONNREFUSED");
    expect(wrapped.raw).toBe(cause);
    expect(wrapped.pspName).toBe("paysafe");

    const wrappedString = PayFanoutError.wrap("plain failure");
    expect(wrappedString.raw).toBe("plain failure");
    expect(wrappedString.message).toBe(getUserMessage("unknown"));
  });

  it("wrap() derives the default message from the fallback code, and an explicit message wins", () => {
    const coded = PayFanoutError.wrap(new Error("socket hang up"), { code: "psp_unavailable" });
    expect(coded.message).toBe(getUserMessage("psp_unavailable"));

    const explicit = PayFanoutError.wrap(new Error("socket hang up"), {
      code: "psp_unavailable",
      message: "Provider offline.",
    });
    expect(explicit.message).toBe("Provider offline.");
  });

  it("toJSON omits raw (may hold huge/circular PSP payloads) but keeps taxonomy fields", () => {
    const err = PayFanoutError.wrap(new Error("x"), { code: "psp_unavailable", retryable: true });
    const json = err.toJSON();
    expect(json).toEqual({
      name: "PayFanoutError",
      code: "psp_unavailable",
      message: getUserMessage("psp_unavailable"),
      retryable: true,
    });
    expect("raw" in json).toBe(false);
  });

  it("toJSON includes pspName when present", () => {
    const err = new PayFanoutError({
      code: "card_declined",
      message: "Your card was declined.",
      pspName: "stripe",
      raw: { decline_code: "generic_decline" },
    });
    expect(err.toJSON()).toEqual({
      name: "PayFanoutError",
      code: "card_declined",
      message: "Your card was declined.",
      retryable: false,
      pspName: "stripe",
    });
  });
});

describe("isPayFanoutError", () => {
  it("accepts a structurally matching error from a duplicated copy of core", () => {
    // A host's node_modules can hold two copies of core; instanceof fails
    // across them, so shape is the contract.
    const foreign = {
      name: "PayFanoutError",
      code: "card_declined",
      message: "Your card was declined.",
      retryable: false,
      raw: { decline_code: "generic_decline" },
    };
    expect(isPayFanoutError(foreign)).toBe(true);
    // wrap() honors the structural match too — no double-wrapping.
    expect(PayFanoutError.wrap(foreign)).toBe(foreign);
  });

  it("rejects near-misses", () => {
    expect(isPayFanoutError(new Error("boom"))).toBe(false); // name is "Error"
    expect(isPayFanoutError(null)).toBe(false);
    expect(isPayFanoutError(undefined)).toBe(false);
    expect(isPayFanoutError("PayFanoutError")).toBe(false);
    expect(isPayFanoutError({ name: "PayFanoutError", code: "unknown", retryable: false })).toBe(false);
    expect(isPayFanoutError({ name: "PayFanoutError", code: 7, retryable: false, message: "m" })).toBe(false);
    expect(isPayFanoutError({ name: "PayFanoutError", code: "unknown", retryable: "no", message: "m" })).toBe(false);
    expect(isPayFanoutError({ name: "payfanouterror", code: "unknown", retryable: false, message: "m" })).toBe(false);
  });
});
