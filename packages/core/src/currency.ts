import { PayFanoutError } from "./errors.js";

/**
 * Money is always integer minor units at the core boundary. Minor units are
 * currency-dependent (JPY: 0 decimals, BHD: 3). Adapters convert to/from
 * whatever their PSP's API expects using these helpers — quirks (e.g. Stripe's
 * zero-decimal handling) live in the adapter, never at the core boundary.
 */
export type MinorUnitAmount = number;

/** ISO 4217 currencies whose exponent is not the default 2. */
const CURRENCY_EXPONENT_OVERRIDES: Readonly<Record<string, number>> = {
  // 0-decimal
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // 3-decimal
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // 4-decimal
  CLF: 4, UYW: 4,
};

export function getCurrencyExponent(currency: string): number {
  const code = normalizeCurrency(currency);
  return CURRENCY_EXPONENT_OVERRIDES[code] ?? 2;
}

export function normalizeCurrency(currency: string): string {
  const code = currency?.trim?.().toUpperCase?.();
  if (typeof code !== "string" || !/^[A-Z]{3}$/.test(code)) {
    throw PayFanoutError.invalidRequest(`Invalid ISO 4217 currency code: ${String(currency)}`);
  }
  return code;
}

/** Throws unless `amount` is a non-negative safe integer (minor units). */
export function assertMinorUnitAmount(amount: unknown, context = "amount"): asserts amount is MinorUnitAmount {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
    throw PayFanoutError.invalidRequest(
      `${context} must be a non-negative integer in minor units, got: ${String(amount)}`,
    );
  }
}

/**
 * Converts a major-unit amount (e.g. 10.99 or "10.99") to integer minor units.
 * Rejects amounts with more precision than the currency supports.
 */
export function toMinorUnits(major: number | string, currency: string): MinorUnitAmount {
  const exponent = getCurrencyExponent(currency);
  const str = typeof major === "number" ? formatNumberExact(major) : major.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(str);
  if (!match) {
    throw PayFanoutError.invalidRequest(`Cannot parse amount "${String(major)}"`);
  }
  const [, sign, intPart, fracPart = ""] = match;
  if (sign === "-") {
    throw PayFanoutError.invalidRequest("Amounts must be non-negative");
  }
  if (fracPart.length > exponent && /[1-9]/.test(fracPart.slice(exponent))) {
    throw PayFanoutError.invalidRequest(
      `Amount ${str} has more precision than ${normalizeCurrency(currency)} supports (${exponent} decimals)`,
    );
  }
  const frac = fracPart.slice(0, exponent).padEnd(exponent, "0");
  const minor = Number(`${intPart}${frac}`);
  if (!Number.isSafeInteger(minor)) {
    throw PayFanoutError.invalidRequest(`Amount ${str} exceeds the safe integer range in minor units`);
  }
  return minor;
}

/** Converts integer minor units to a major-unit number (beware IEEE 754 for display — prefer formatMinorUnits). */
export function fromMinorUnits(minor: MinorUnitAmount, currency: string): number {
  assertMinorUnitAmount(minor);
  return minor / 10 ** getCurrencyExponent(currency);
}

/** Exact decimal-string rendering of a minor-unit amount, e.g. (10990, "USD") -> "109.90", (500, "JPY") -> "500". */
export function formatMinorUnits(minor: MinorUnitAmount, currency: string): string {
  assertMinorUnitAmount(minor);
  const exponent = getCurrencyExponent(currency);
  if (exponent === 0) return String(minor);
  const digits = String(minor).padStart(exponent + 1, "0");
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/** Renders a JS number without scientific notation, preserving its exact decimal digits. */
function formatNumberExact(value: number): string {
  if (!Number.isFinite(value)) {
    throw PayFanoutError.invalidRequest(`Amount must be finite, got: ${String(value)}`);
  }
  const str = String(value);
  if (!str.includes("e") && !str.includes("E")) return str;
  // Fall back to fixed notation for exotic inputs; 20 digits is the max toFixed supports.
  return value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Splits an integer minor-unit amount across weights with no lost or invented
 * cents: results sum exactly to `amount`, remainders distribute by the
 * largest-remainder method (ties to the earliest position). The safe way to
 * compute fee shares and tax splits — never float math on money.
 *
 *   allocate(1000, [1, 1, 1]) -> [334, 333, 333]
 */
export function allocate(amount: MinorUnitAmount, weights: number[]): MinorUnitAmount[] {
  assertMinorUnitAmount(amount, "amount");
  if (weights.length === 0) {
    throw PayFanoutError.invalidRequest("allocate needs at least one weight");
  }
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw PayFanoutError.invalidRequest("allocate weights must be finite and >= 0");
  }
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total === 0) {
    throw PayFanoutError.invalidRequest("allocate weights must not all be zero");
  }
  const shares = weights.map((w) => (amount * w) / total);
  const floors = shares.map(Math.floor);
  let remainder = amount - floors.reduce((sum, f) => sum + f, 0);
  // Hand the leftover units to the largest fractional parts, earliest first on ties.
  const order = shares
    .map((share, index) => ({ index, fraction: share - Math.floor(share) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of order) {
    if (remainder === 0) break;
    floors[index]! += 1;
    remainder -= 1;
  }
  return floors;
}
