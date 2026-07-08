import { describe, expect, it } from "vitest";
import {
  assertMinorUnitAmount,
  formatMinorUnits,
  fromMinorUnits,
  getCurrencyExponent,
  isPayFanoutError,
  toMinorUnits,
} from "@payfanout/core";

describe("currency exponents", () => {
  it("defaults to 2 decimals", () => {
    expect(getCurrencyExponent("USD")).toBe(2);
    expect(getCurrencyExponent("eur")).toBe(2);
  });

  it("knows zero-decimal currencies", () => {
    expect(getCurrencyExponent("JPY")).toBe(0);
    expect(getCurrencyExponent("KRW")).toBe(0);
  });

  it("knows three-decimal currencies", () => {
    expect(getCurrencyExponent("BHD")).toBe(3);
    expect(getCurrencyExponent("KWD")).toBe(3);
  });

  it("rejects malformed codes", () => {
    expect(() => getCurrencyExponent("US")).toThrowError(/Invalid ISO 4217/);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(getCurrencyExponent(" USD ")).toBe(2);
    expect(getCurrencyExponent("\tjpy\n")).toBe(0);
    expect(toMinorUnits("10.99", " usd")).toBe(1099);
    expect(() => getCurrencyExponent("US D")).toThrowError(/Invalid ISO 4217/);
  });
});

describe("toMinorUnits", () => {
  it("converts 2-decimal amounts", () => {
    expect(toMinorUnits(10.99, "USD")).toBe(1099);
    expect(toMinorUnits("10.99", "USD")).toBe(1099);
    expect(toMinorUnits("10.9", "USD")).toBe(1090);
    expect(toMinorUnits(0, "USD")).toBe(0);
  });

  it("converts zero-decimal amounts (JPY)", () => {
    expect(toMinorUnits(500, "JPY")).toBe(500);
    expect(toMinorUnits("500", "JPY")).toBe(500);
  });

  it("converts three-decimal amounts (BHD)", () => {
    expect(toMinorUnits("1.234", "BHD")).toBe(1234);
    expect(toMinorUnits(1.2, "BHD")).toBe(1200);
  });

  it("avoids IEEE 754 drift on classic float traps", () => {
    expect(toMinorUnits(1.15, "USD")).toBe(115);
    expect(toMinorUnits(19.99, "USD")).toBe(1999);
  });

  it("rejects excess precision for the currency", () => {
    expect(() => toMinorUnits("1.001", "USD")).toThrowError(/more precision/);
    expect(() => toMinorUnits("500.5", "JPY")).toThrowError(/more precision/);
    expect(() => toMinorUnits(0.1 + 0.2, "USD")).toThrowError(/more precision/);
  });

  it("rejects negatives and garbage with PayFanoutError invalid_request", () => {
    for (const bad of [() => toMinorUnits("-1", "USD"), () => toMinorUnits("abc", "USD")]) {
      try {
        bad();
        expect.unreachable();
      } catch (err) {
        expect(isPayFanoutError(err)).toBe(true);
        if (isPayFanoutError(err)) expect(err.code).toBe("invalid_request");
      }
    }
  });
});

describe("toMinorUnits overflow and exotic notation", () => {
  it("rejects amounts that exceed the safe integer range in minor units", () => {
    expect(() => toMinorUnits("9".repeat(20), "USD")).toThrowError(/safe integer range/);
  });

  it("rejects scientific-notation magnitudes it cannot render exactly", () => {
    expect(() => toMinorUnits(1e21, "USD")).toThrowError(/Cannot parse|safe integer/);
    expect(() => toMinorUnits(Number.POSITIVE_INFINITY, "USD")).toThrowError(/finite/);
  });

  it("handles small scientific-notation numbers via exact expansion", () => {
    expect(toMinorUnits(1e-2, "USD")).toBe(1); // String(0.01) is "0.01" — no expansion needed
    // String(1.5e-7) is "1.5e-7": the toFixed expansion path must surface the
    // sub-cent digits so precision validation still rejects them.
    expect(() => toMinorUnits(1.5e-7, "USD")).toThrowError(/more precision/);
  });
});

describe("fromMinorUnits / formatMinorUnits", () => {
  it("round-trips", () => {
    expect(fromMinorUnits(1099, "USD")).toBe(10.99);
    expect(fromMinorUnits(500, "JPY")).toBe(500);
    expect(fromMinorUnits(1234, "BHD")).toBe(1.234);
  });

  it("formats exactly", () => {
    expect(formatMinorUnits(1099, "USD")).toBe("10.99");
    expect(formatMinorUnits(5, "USD")).toBe("0.05");
    expect(formatMinorUnits(500, "JPY")).toBe("500");
    expect(formatMinorUnits(1234, "BHD")).toBe("1.234");
    expect(formatMinorUnits(7, "BHD")).toBe("0.007");
  });

  it("rejects non-integer minor units", () => {
    expect(() => fromMinorUnits(10.5, "USD")).toThrowError(/non-negative integer/);
  });
});

describe("assertMinorUnitAmount", () => {
  it("accepts non-negative safe integers", () => {
    expect(() => assertMinorUnitAmount(0)).not.toThrow();
    expect(() => assertMinorUnitAmount(123456)).not.toThrow();
  });

  it("rejects floats, negatives, NaN, and non-numbers", () => {
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, "100", null, undefined]) {
      expect(() => assertMinorUnitAmount(bad)).toThrowError(/non-negative integer/);
    }
  });
});
