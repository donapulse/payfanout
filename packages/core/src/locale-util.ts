/**
 * Shared locale resolution for PayFanout's built-in i18n catalogs (user-facing
 * error messages and library UI labels). Matching is case-insensitive and
 * falls back by primary subtag ("fr-CA" -> "fr"); a region-specific catalog,
 * when registered, wins over its primary subtag. English is the always-present
 * default, so every lookup resolves to a defined string.
 */
export function normalizeLocale(locale: string | undefined): string {
  return (locale ?? "").trim().toLowerCase();
}

/**
 * Resolve `key` against the locale's catalog, then its primary-subtag catalog,
 * then the built-in English `defaults` — the result is always defined.
 */
export function lookupLocalized<K extends string>(
  catalogs: ReadonlyMap<string, Partial<Record<K, string>>>,
  key: K,
  locale: string | undefined,
  defaults: Record<K, string>,
): string {
  const norm = normalizeLocale(locale);
  if (norm) {
    const exact = catalogs.get(norm)?.[key];
    if (exact) return exact;
    const primary = norm.split("-")[0];
    if (primary && primary !== norm) {
      const fallback = catalogs.get(primary)?.[key];
      if (fallback) return fallback;
    }
  }
  return defaults[key];
}
