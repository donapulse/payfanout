import { describe, expect, it } from "vitest";
import {
  formatMinorUnits,
  fromMinorUnits,
  getCurrencyExponent,
  listNonDefaultCurrencyExponents,
  toMinorUnits,
} from "@payfanout/core";

/**
 * ISO 4217 list one (SIX, published 2026-09-17): every active code with its
 * minor units. The codes whose minor units the list gives as "N.A." (XAG, XAU,
 * XBA, XBB, XBC, XBD, XDR, XPD, XPT, XSU, XTS, XUA, XXX) are left out.
 */
const ISO_4217_MINOR_UNITS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [
    0,
    [
      "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI",
      "VND", "VUV", "XAF", "XOF", "XPF",
    ],
  ],
  [
    2,
    [
      "AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT",
      "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF",
      "CHE", "CHF", "CHW", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DKK", "DOP",
      "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD",
      "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IRR", "JMD", "KES",
      "KGS", "KHR", "KPW", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "MAD", "MDL",
      "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR",
      "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "PAB", "PEN", "PGK", "PHP", "PKR",
      "PLN", "QAR", "RON", "RSD", "RUB", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP",
      "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TOP",
      "TRY", "TTD", "TWD", "TZS", "UAH", "USD", "USN", "UYU", "UZS", "VED", "VES", "WST",
      "XAD", "XCD", "XCG", "YER", "ZAR", "ZMW", "ZWG",
    ],
  ],
  [
    3,
    [
      "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
    ],
  ],
  [
    4,
    [
      "CLF", "UYW",
    ],
  ],
];

describe("currency exponents against ISO 4217 list one", () => {
  it("gives every active ISO 4217 code the minor units the list gives it", () => {
    const wrong = ISO_4217_MINOR_UNITS.flatMap(([units, codes]) =>
      codes.filter((code) => getCurrencyExponent(code) !== units).map((code) => `${code}: ISO ${units}, core ${getCurrencyExponent(code)}`),
    );
    expect(wrong).toEqual([]);
  });

  it("reads UYI, the Uruguay peso in indexed units, with the exponent 0, in every money helper", () => {
    expect(getCurrencyExponent("UYI")).toBe(0);
    expect(toMinorUnits("12", "UYI")).toBe(12);
    expect(() => toMinorUnits("12.34", "UYI")).toThrowError(/more precision/);
    expect(fromMinorUnits(12, "UYI")).toBe(12);
    expect(formatMinorUnits(12, "UYI")).toBe("12");
  });

  it("reads the codes ISO gives no minor units as 2, as it reads any code outside its table", () => {
    for (const code of ["XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XDR", "XPD", "XPT", "XSU", "XTS", "XUA", "XXX"]) {
      expect(getCurrencyExponent(code), code).toBe(2);
    }
  });

  it("lists exactly the codes list one gives other minor units than 2, in code order", () => {
    const expected = ISO_4217_MINOR_UNITS.filter(([units]) => units !== 2)
      .flatMap(([units, codes]) => codes.map((code): [string, number] => [code, units]))
      .sort(([a], [b]) => (a < b ? -1 : 1));
    const listed = listNonDefaultCurrencyExponents();
    expect(listed).toEqual(expected);
    for (const [code, exponent] of listed) expect(getCurrencyExponent(code), code).toBe(exponent);
  });

  it("hands out a list whose changes reach nothing else", () => {
    const listed = listNonDefaultCurrencyExponents();
    const [code, exponent] = listed[0]!;
    listed[0]![1] = 7;
    listed.push(["USD", 0]);
    expect(getCurrencyExponent(code)).toBe(exponent);
    expect(listNonDefaultCurrencyExponents()[0]).toEqual([code, exponent]);
    expect(getCurrencyExponent("USD")).toBe(2);
    expect(listNonDefaultCurrencyExponents()).not.toContainEqual(["USD", 0]);
  });
});
