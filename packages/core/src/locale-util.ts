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

/** A mutable family of per-locale catalogs over a fixed key space `K`. */
export interface CatalogStore<K extends string> {
  /** Merges `catalog` into the locale's existing entries (extend, never replace). */
  register(locale: string, catalog: Partial<Record<K, string>>): void;
  /** Per-key match for the locale chain (exact locale, then primary subtag), or undefined. */
  resolve(key: K, locale: string | undefined): string | undefined;
  /** `resolve()` with the English default applied — always defined. */
  get(key: K, locale?: string): string;
}

/**
 * One store per catalog family, seeded with the built-in locales. Resolution
 * is per KEY, not per catalog: a partial region catalog never hides the
 * primary subtag's translation of a key it lacks. Empty-string translations
 * are deliberately treated as missing (a blank entry must not blank UI text).
 */
export function createCatalogStore<K extends string>(
  builtIn: Iterable<readonly [string, Partial<Record<K, string>>]>,
  defaults: Record<K, string>,
  registerName: string,
): CatalogStore<K> {
  const catalogs = new Map(builtIn);

  const resolve = (key: K, locale: string | undefined): string | undefined => {
    const norm = normalizeLocale(locale);
    if (!norm) return undefined;
    const exact = catalogs.get(norm)?.[key];
    if (exact) return exact;
    const primary = norm.split("-")[0];
    if (primary && primary !== norm) {
      const fallback = catalogs.get(primary)?.[key];
      if (fallback) return fallback;
    }
    return undefined;
  };

  return {
    register(locale, catalog) {
      const key = normalizeLocale(locale);
      if (!key) throw new Error(`${registerName} requires a non-empty locale`);
      catalogs.set(key, { ...catalogs.get(key), ...catalog });
    },
    resolve,
    get: (key, locale) => resolve(key, locale) ?? defaults[key],
  };
}
