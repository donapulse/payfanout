import { describe, expect, it } from "vitest";
import { PAYMENT_METHOD_FLOWS, PAYMENT_METHOD_TYPES, type PaymentMethodCapability } from "@payfanout/core";
import { validateDeclarationShapes, type DeclaredShapes } from "../src/declaration-shapes.js";

const CARD: PaymentMethodCapability = { type: "card", flow: "embedded", supported: true };
const BACS: PaymentMethodCapability = {
  type: "bacs_debit",
  flow: "redirect",
  supported: true,
  currencies: ["GBP"],
  countries: ["GB"],
};

/** Well-formed on every rule, with every list present, so a case can break exactly one thing. */
function wellFormed(): DeclaredShapes {
  return {
    paymentMethods: [CARD, BACS],
    supportedCurrencies: ["EUR", "GBP", "JPY", "BHD"],
    unsupportedCurrencies: ["XTS"],
  };
}

const CURRENCY = {
  form: "three uppercase letters",
  code: "EUR",
  malformed: ["eur", "Eur", " EUR", "EUR ", "EUR\n", "EU", "EURO", "E1R", ""],
};
const COUNTRY = {
  form: "two uppercase letters",
  code: "GB",
  malformed: ["gb", "Gb", " GB", "GB ", "GB\n", "G", "GBR", "G1", ""],
};

/**
 * Every code list the suite checks. The bad entry lands at index 1, after a
 * well-formed one, and the method lists on the second method, so a check that
 * reads only the first entry or the first method fails as well.
 */
const CODE_LISTS = [
  {
    field: "supportedCurrencies",
    ...CURRENCY,
    declare: (entry: unknown): DeclaredShapes => ({ ...wellFormed(), supportedCurrencies: ["EUR", entry as string] }),
  },
  {
    field: "unsupportedCurrencies",
    ...CURRENCY,
    declare: (entry: unknown): DeclaredShapes => ({ ...wellFormed(), unsupportedCurrencies: ["XTS", entry as string] }),
  },
  {
    field: "paymentMethods[1].currencies",
    ...CURRENCY,
    declare: (entry: unknown): DeclaredShapes => ({
      ...wellFormed(),
      paymentMethods: [CARD, { ...BACS, currencies: ["GBP", entry as string] }],
    }),
  },
  {
    field: "paymentMethods[1].countries",
    ...COUNTRY,
    declare: (entry: unknown): DeclaredShapes => ({
      ...wellFormed(),
      paymentMethods: [CARD, { ...BACS, countries: ["GB", entry as string] }],
    }),
  },
];

describe("validateDeclarationShapes", () => {
  it("accepts a well-formed declaration", () => {
    expect(validateDeclarationShapes("fake", wellFormed())).toEqual([]);
  });

  it("accepts absent and empty optional lists", () => {
    expect(validateDeclarationShapes("fake", { paymentMethods: [CARD] })).toEqual([]);
    expect(
      validateDeclarationShapes("fake", {
        paymentMethods: [{ ...CARD, currencies: [], countries: [] }],
        supportedCurrencies: [],
        unsupportedCurrencies: [],
      }),
    ).toEqual([]);
  });

  it("accepts every payment method type and flow core defines, supported or not", () => {
    const paymentMethods = PAYMENT_METHOD_TYPES.map((type, index) => ({
      type,
      flow: PAYMENT_METHOD_FLOWS[index % PAYMENT_METHOD_FLOWS.length]!,
      supported: index % 2 === 0,
    }));
    expect(validateDeclarationShapes("fake", { paymentMethods })).toEqual([]);
  });

  it("rejects an empty pspName", () => {
    expect(validateDeclarationShapes("", wellFormed())).toEqual(["pspName is empty"]);
  });

  it("rejects a declaration without payment methods", () => {
    expect(validateDeclarationShapes("fake", { ...wellFormed(), paymentMethods: [] })).toEqual([
      "paymentMethods is empty",
    ]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["type core does not define", { type: "cash" }, 'paymentMethods[1].type "cash" is not in PAYMENT_METHOD_TYPES'],
    ["type is in another case", { type: "Card" }, 'paymentMethods[1].type "Card" is not in PAYMENT_METHOD_TYPES'],
    ["flow core does not define", { flow: "iframe" }, 'paymentMethods[1].flow "iframe" is not in PAYMENT_METHOD_FLOWS'],
    ["supported flag is a string", { supported: "true" }, 'paymentMethods[1].supported "true" is not a boolean'],
    ["supported flag is absent", { supported: undefined }, "paymentMethods[1].supported undefined is not a boolean"],
  ])("rejects a method whose %s", (_label, override, message) => {
    const paymentMethods = [CARD, { ...BACS, ...override } as PaymentMethodCapability];
    expect(validateDeclarationShapes("fake", { ...wellFormed(), paymentMethods })).toEqual([message]);
  });

  describe.each(CODE_LISTS)("$field", ({ field, form, code, malformed, declare }) => {
    it.each(malformed)("rejects %j", (entry) => {
      expect(validateDeclarationShapes("fake", declare(entry))).toEqual([
        `${field}[1] ${JSON.stringify(entry)} is not ${form}`,
      ]);
    });

    // The first two print as a well-formed code, so only the string check
    // stands between them and the pattern.
    it.each<[string, unknown]>([
      ["an array holding a code", [code]],
      ["a String object", new String(code)],
      ["a number", 978],
      ["null", null],
      ["undefined", undefined],
    ])("rejects %s", (_label, entry) => {
      expect(validateDeclarationShapes("fake", declare(entry))).toEqual([`${field}[1] is not a string`]);
    });
  });
});
