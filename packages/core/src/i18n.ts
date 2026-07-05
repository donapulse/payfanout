import { lookupLocalized, normalizeLocale } from "./locale-util.js";
import { BUILT_IN_LOCALES } from "./locales/index.js";

/**
 * Keys for the (small) set of strings the library itself renders. The React
 * `<PayButton>` uses `pay` as its default label; hosts that pass their own
 * button text never touch this. Kept deliberately tiny — PayFanout renders
 * almost no text of its own (the host owns the checkout copy).
 */
export type UiLabelKey = "pay";

/** Every UI-label key the library ships translations for. */
export const UI_LABEL_KEYS: readonly UiLabelKey[] = ["pay"] as const;

export type UiLabelCatalog = Partial<Record<UiLabelKey, string>>;

const EN: Record<UiLabelKey, string> = BUILT_IN_LOCALES.en.ui;

const catalogs = new Map<string, UiLabelCatalog>(
  Object.entries(BUILT_IN_LOCALES).map(([locale, bundle]) => [locale, bundle.ui]),
);

/**
 * Registers (or extends) the UI-label catalog for a locale, mirroring
 * `registerErrorMessages`. Locale keys match case-insensitively and by primary
 * subtag ("de-AT" falls back to "de").
 */
export function registerUiLabels(locale: string, catalog: UiLabelCatalog): void {
  const key = normalizeLocale(locale);
  if (!key) throw new Error("registerUiLabels requires a non-empty locale");
  catalogs.set(key, { ...catalogs.get(key), ...catalog });
}

/** The library UI label for `key` in the given locale (en fallback, always defined). */
export function getUiLabel(key: UiLabelKey, locale?: string): string {
  return lookupLocalized(catalogs, key, locale, EN);
}
