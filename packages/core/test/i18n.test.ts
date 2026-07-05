import { describe, expect, it } from "vitest";
import {
  BUILT_IN_LOCALES,
  getUiLabel,
  registerUiLabels,
  UI_LABEL_KEYS,
} from "../src/index.js";

describe("built-in locales", () => {
  it("ships errors + ui for en/fr/de/es with identical key coverage", () => {
    const errorKeys = Object.keys(BUILT_IN_LOCALES.en.errors).sort();
    for (const [locale, bundle] of Object.entries(BUILT_IN_LOCALES)) {
      expect(Object.keys(bundle.errors).sort(), `${locale} error keys`).toEqual(errorKeys);
      expect(Object.keys(bundle.ui).sort(), `${locale} ui keys`).toEqual([...UI_LABEL_KEYS].sort());
      for (const value of [...Object.values(bundle.errors), ...Object.values(bundle.ui)]) {
        expect(typeof value).toBe("string");
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
    expect(Object.keys(BUILT_IN_LOCALES)).toEqual(["en", "fr", "de", "es"]);
  });
});

describe("getUiLabel (library UI labels)", () => {
  it("returns the English label by default and for unknown locales", () => {
    expect(getUiLabel("pay")).toBe("Pay");
    expect(getUiLabel("pay", "en")).toBe("Pay");
    expect(getUiLabel("pay", "sw")).toBe("Pay"); // unknown -> English
  });

  it("returns the built-in translation for shipped locales, by primary subtag too", () => {
    for (const locale of ["fr", "de", "es"] as const) {
      const label = getUiLabel("pay", locale);
      expect(label).toBeTruthy();
      expect(label).not.toBe("Pay"); // a real translation ships
      expect(getUiLabel("pay", `${locale}-XX`)).toBe(label); // region -> primary subtag
    }
  });

  it("lets hosts register or override UI labels", () => {
    registerUiLabels("zz", { pay: "ZZ-Pay" });
    expect(getUiLabel("pay", "zz")).toBe("ZZ-Pay");
    expect(() => registerUiLabels("  ", { pay: "x" })).toThrowError(/non-empty locale/);
  });
});
