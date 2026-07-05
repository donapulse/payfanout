import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatMinorUnits, fromMinorUnits, getCurrencyExponent, toMinorUnits } from "@payfanout/core";

/**
 * Property-based invariants over the money helpers. Example-based tests prove
 * the cases we thought of; these prove the ones we didn't.
 */
const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "KRW", "BHD", "KWD", "TND", "CLF"] as const;

const arbCurrency = fc.constantFrom(...CURRENCIES);
// Bounded so exact-decimal doubles stay unambiguous (see fromMinorUnits round-trip note).
const arbMinor = fc.integer({ min: 0, max: 2 ** 40 });

describe("currency property invariants", () => {
  it("formatMinorUnits -> toMinorUnits is the identity for every currency exponent", () => {
    fc.assert(
      fc.property(arbMinor, arbCurrency, (minor, currency) => {
        expect(toMinorUnits(formatMinorUnits(minor, currency), currency)).toBe(minor);
      }),
    );
  });

  it("fromMinorUnits -> toMinorUnits is the identity within the safe magnitude bound", () => {
    fc.assert(
      fc.property(arbMinor, arbCurrency, (minor, currency) => {
        expect(toMinorUnits(fromMinorUnits(minor, currency), currency)).toBe(minor);
      }),
    );
  });

  it("formatMinorUnits always renders exactly the currency's exponent digits", () => {
    fc.assert(
      fc.property(arbMinor, arbCurrency, (minor, currency) => {
        const formatted = formatMinorUnits(minor, currency);
        const exponent = getCurrencyExponent(currency);
        const [, frac = ""] = formatted.split(".");
        expect(frac.length).toBe(exponent);
        expect(/^\d+(\.\d+)?$/.test(formatted)).toBe(true);
      }),
    );
  });

  it("toMinorUnits rejects any amount with a non-zero digit past the currency exponent", () => {
    fc.assert(
      fc.property(
        arbMinor,
        arbCurrency,
        fc.integer({ min: 1, max: 9 }),
        (minor, currency, extraDigit) => {
          const tooPrecise = `${formatMinorUnits(minor, currency)}${getCurrencyExponent(currency) === 0 ? "." : ""}${extraDigit}`;
          expect(() => toMinorUnits(tooPrecise, currency)).toThrowError(/more precision/);
        },
      ),
    );
  });

  it("never produces non-integer or negative minor units from valid decimal strings", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 99 }),
        (units, cents) => {
          const minor = toMinorUnits(`${units}.${String(cents).padStart(2, "0")}`, "USD");
          expect(Number.isSafeInteger(minor)).toBe(true);
          expect(minor).toBe(units * 100 + cents);
        },
      ),
    );
  });
});
