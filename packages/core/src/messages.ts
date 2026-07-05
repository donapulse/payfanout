import type { UnifiedError, UnifiedErrorCode } from "./errors.js";
import { lookupLocalized, normalizeLocale } from "./locale-util.js";
import { BUILT_IN_LOCALES } from "./locales/index.js";

/**
 * i18n seam for user-facing error text. Adapters keep producing English
 * `PayFanoutError.message`s (they are user-safe); to show other locales,
 * translate at the edge by CODE, not by string-matching messages:
 *
 *   localizeError(err, "fr");            // -> « Votre carte a été refusée. »
 *   getUserMessage("card_declined", "de"); // -> „Ihre Karte wurde abgelehnt."
 *
 * PayFanout ships built-in en/fr/de/es catalogs (see `BUILT_IN_LOCALES`). A
 * host catalog only needs the codes it wants to override — anything missing
 * falls back to the locale's primary subtag, then to English, so partial
 * translations stay safe.
 */
export type ErrorMessageCatalog = Partial<Record<UnifiedErrorCode, string>>;

const EN: Record<UnifiedErrorCode, string> = BUILT_IN_LOCALES.en.errors;

const catalogs = new Map<string, ErrorMessageCatalog>(
  Object.entries(BUILT_IN_LOCALES).map(([locale, bundle]) => [locale, bundle.errors]),
);

/**
 * Registers (or extends) the catalog for a locale. Locale keys are matched
 * case-insensitively and by primary subtag ("fr-CA" falls back to "fr").
 * Use this to override a built-in locale or add a new one.
 */
export function registerErrorMessages(locale: string, catalog: ErrorMessageCatalog): void {
  const key = normalizeLocale(locale);
  if (!key) throw new Error("registerErrorMessages requires a non-empty locale");
  catalogs.set(key, { ...catalogs.get(key), ...catalog });
}

/** The user-safe message for a code in the given locale (en fallback, always defined). */
export function getUserMessage(code: UnifiedErrorCode, locale?: string): string {
  return lookupLocalized(catalogs, code, locale, EN);
}

/**
 * Localizes any UnifiedError/PayFanoutError for display: the locale's message
 * for its code when one is registered, otherwise the error's own (English,
 * user-safe) message. For English (or no locale) the error's own message wins —
 * it can be more specific than the generic catalog entry.
 */
export function localizeError(error: Pick<UnifiedError, "code" | "message">, locale?: string): string {
  const key = normalizeLocale(locale);
  if (!key || key === "en" || key.startsWith("en-")) return error.message;
  const catalog = catalogs.get(key) ?? catalogs.get(key.split("-")[0] ?? "");
  return catalog?.[error.code] ?? error.message;
}
