import type { UnifiedErrorCode } from "../errors.js";
import type { UiLabelKey } from "../i18n.js";
import { en } from "./en.js";
import { fr } from "./fr.js";
import { de } from "./de.js";
import { es } from "./es.js";

/**
 * One locale's built-in translations. Typing `errors` and `ui` as full records
 * (not `Partial`) makes the compiler reject any locale that forgets a code or a
 * label — completeness is enforced at build time, not discovered at runtime.
 */
export interface LocaleBundle {
  /** User-safe message per unified error code. */
  errors: Record<UnifiedErrorCode, string>;
  /** Text the library itself renders (e.g. the default Pay button label). */
  ui: Record<UiLabelKey, string>;
}

/**
 * The locales PayFanout ships translated error + UI catalogs for out of the
 * box. Hosts extend or override any of them at the edge via
 * `registerErrorMessages` / `registerUiLabels`, and add entirely new locales
 * the same way — these are just the batteries included.
 */
export const BUILT_IN_LOCALES = { en, fr, de, es } as const satisfies Record<string, LocaleBundle>;

/** A locale code PayFanout ships translations for. */
export type BuiltInLocale = keyof typeof BUILT_IN_LOCALES;
