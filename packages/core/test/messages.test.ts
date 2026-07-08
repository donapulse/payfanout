import { describe, expect, it } from "vitest";
import {
  BUILT_IN_LOCALES,
  getUserMessage,
  localizeError,
  PayFanoutError,
  registerErrorMessages,
  type UnifiedErrorCode,
} from "../src/index.js";

const ERROR_CODES = Object.keys(BUILT_IN_LOCALES.en.errors) as UnifiedErrorCode[];

describe("error message catalogs (i18n seam)", () => {
  it("always has an English message for every code", () => {
    expect(getUserMessage("card_declined")).toBe("Your card was declined.");
    expect(getUserMessage("unknown")).toMatch(/try again/i);
    expect(getUserMessage("card_declined", "en")).toBe("Your card was declined.");
  });

  it("ships built-in fr/de/es messages for every code, distinct from English", () => {
    for (const locale of ["fr", "de", "es"] as const) {
      for (const code of ERROR_CODES) {
        const msg = getUserMessage(code, locale);
        expect(msg, `${locale}.${code}`).toBeTruthy();
        expect(typeof msg).toBe("string");
      }
      // A translated catalog must not simply echo English for the flagship code.
      expect(getUserMessage("card_declined", locale)).not.toBe(getUserMessage("card_declined", "en"));
      // Region subtags resolve to the shipped primary-subtag catalog.
      expect(getUserMessage("card_declined", `${locale}-XX`)).toBe(getUserMessage("card_declined", locale));
    }
  });

  it("host catalogs win; missing codes fall back to English", () => {
    // A brand-new locale with only one code registered.
    registerErrorMessages("zz", { card_declined: "ZZ: declined." });
    expect(getUserMessage("card_declined", "zz")).toBe("ZZ: declined.");
    // Not translated in "zz" -> English fallback, never undefined.
    expect(getUserMessage("rate_limited", "zz")).toBe("Too many requests — please retry shortly.");
    // Unknown locale entirely -> English.
    expect(getUserMessage("card_declined", "sw")).toBe("Your card was declined.");
  });

  it("matches locales case-insensitively and by primary subtag", () => {
    registerErrorMessages("xq", { expired_card: "XQ: expired." });
    expect(getUserMessage("expired_card", "XQ")).toBe("XQ: expired.");
    expect(getUserMessage("expired_card", "xq-Region")).toBe("XQ: expired.");
  });

  it("region-specific registrations override the primary subtag", () => {
    registerErrorMessages("pt", { card_declined: "O seu cartão foi recusado." });
    registerErrorMessages("pt-BR", { card_declined: "Seu cartão foi recusado." });
    expect(getUserMessage("card_declined", "pt-BR")).toBe("Seu cartão foi recusado.");
    expect(getUserMessage("card_declined", "pt-PT")).toBe("O seu cartão foi recusado.");
  });

  it("registering over a built-in locale extends, not replaces, it", () => {
    const before = getUserMessage("card_declined", "de");
    registerErrorMessages("de", { rate_limited: "Zu viele Anfragen – benutzerdefiniert." });
    // The override lands...
    expect(getUserMessage("rate_limited", "de")).toBe("Zu viele Anfragen – benutzerdefiniert.");
    // ...and the rest of the built-in German catalog is untouched.
    expect(getUserMessage("card_declined", "de")).toBe(before);
  });

  it("rejects empty locales", () => {
    expect(() => registerErrorMessages("  ", {})).toThrowError(/non-empty locale/);
  });

  it("localizeError resolves per code through the region -> primary -> own-message chain", () => {
    // A region catalog holding a single code must not hide the primary
    // subtag's translations of every other code.
    registerErrorMessages("qp", { rate_limited: "QP: too many requests." });
    registerErrorMessages("qp-BR", { card_declined: "QP-BR: declined." });
    const declined = new PayFanoutError({ code: "card_declined", message: "Card declined.", retryable: false });
    const limited = new PayFanoutError({ code: "rate_limited", message: "Rate limited upstream.", retryable: true });
    const unknown = new PayFanoutError({ code: "unknown", message: "Something specific happened.", retryable: false });

    expect(localizeError(declined, "qp-BR")).toBe("QP-BR: declined.");
    // Missing in qp-BR: falls back per code to qp — and agrees with getUserMessage.
    expect(localizeError(limited, "qp-BR")).toBe("QP: too many requests.");
    expect(localizeError(limited, "qp-BR")).toBe(getUserMessage("rate_limited", "qp-BR"));
    // Missing in both: the error's own user-safe message.
    expect(localizeError(unknown, "qp-BR")).toBe("Something specific happened.");
  });

  it("treats an empty-string translation as missing", () => {
    // Deliberate: a blank catalog entry must never blank user-facing text,
    // so lookups skip falsy values and keep falling back.
    registerErrorMessages("qe", { card_declined: "" });
    expect(getUserMessage("card_declined", "qe")).toBe(getUserMessage("card_declined"));
    const declined = new PayFanoutError({ code: "card_declined", message: "Own message.", retryable: false });
    expect(localizeError(declined, "qe")).toBe("Own message.");
  });

  it("localizeError prefers the catalog but keeps the error's own message otherwise", () => {
    const declined = new PayFanoutError({
      code: "insufficient_funds",
      message: "Your card has insufficient funds.",
      retryable: false,
    });
    // A shipped locale localizes by code.
    expect(localizeError(declined, "fr")).toBe(getUserMessage("insufficient_funds", "fr"));
    expect(localizeError(declined, "fr")).not.toBe(declined.message);
    // English (or no locale): the adapter's own user-safe message wins —
    // it can be more specific than the generic catalog entry.
    expect(localizeError(declined)).toBe("Your card has insufficient funds.");
    expect(localizeError(declined, "en-US")).toBe("Your card has insufficient funds.");
    // Locale without any catalog: fall back to the error's message.
    expect(localizeError(declined, "xx")).toBe("Your card has insufficient funds.");
    // Region falls back to primary subtag.
    expect(localizeError(declined, "fr-CA")).toBe(getUserMessage("insufficient_funds", "fr"));
  });
});
