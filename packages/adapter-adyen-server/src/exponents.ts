/**
 * Currencies Adyen prices with a different number of fractional digits than
 * ISO 4217, which is core's minor-unit contract. Adyen documents its own table
 * as leading, so passing core minor units through would silently shift the
 * decimal point (100 ISK in core minor units is 1.00 ISK, but Adyen would read
 * 100 ISK). The adapter refuses them rather than mis-charge, declares them in
 * `unsupportedCurrencies` so the router skips Adyen for them, and reports no
 * webhook amount in them: the same shape as the PayZen CNY/KHR exclusion.
 */
export const ADYEN_EXPONENT_DEVIATIONS: ReadonlyMap<string, number> = new Map<string, number>([
  ["CLP", 2],
  ["CVE", 0],
  ["IDR", 0],
  ["ISK", 2],
]);
