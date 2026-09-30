import { describe, expect, it } from "vitest";
import { getCurrencyExponent } from "@payfanout/core";

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

  it("reads UYI, the Uruguay peso in indexed units, with the exponent 0", () => {
    expect(getCurrencyExponent("UYI")).toBe(0);
  });
});
