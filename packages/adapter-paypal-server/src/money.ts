import {
  assertMinorUnitAmount,
  formatMinorUnits,
  getCurrencyExponent,
  normalizeCurrency,
  PayFanoutError,
  type MinorUnitAmount,
} from "@payfanout/core";

/**
 * The currencies PayPal checkout accepts (REST currency-codes reference).
 * Everything else — including every 3-decimal ISO currency (BHD, KWD, …) —
 * is rejected locally before any API call.
 */
export const PAYPAL_SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set([
  "AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD", "HUF", "ILS",
  "JPY", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN", "RUB", "SEK", "SGD", "THB", "TWD", "USD",
]);

/**
 * PayPal accepts whole units only for these ("does not support decimals").
 * JPY is ISO 0-decimal anyway; HUF and TWD are ISO 2-decimal, so the
 * whole-unit rule is a PayPal quirk their minor-unit amounts must satisfy.
 */
const WHOLE_UNIT_CURRENCIES: ReadonlySet<string> = new Set(["HUF", "JPY", "TWD"]);

export function assertPayPalCurrency(currency: string): string {
  const code = normalizeCurrency(currency);
  if (!PAYPAL_SUPPORTED_CURRENCIES.has(code)) {
    throw PayFanoutError.invalidRequest(`PayPal does not support the currency ${code}`, { currency: code });
  }
  return code;
}

/** Integer minor units -> PayPal decimal string. Pure string/integer math — no floats. */
export function toPayPalValue(minor: MinorUnitAmount, currency: string): string {
  const code = assertPayPalCurrency(currency);
  assertMinorUnitAmount(minor, "amount");
  if (!WHOLE_UNIT_CURRENCIES.has(code)) return formatMinorUnits(minor, code);
  const exponent = getCurrencyExponent(code);
  if (exponent === 0) return String(minor);
  // HUF/TWD: ISO 2-decimal, but PayPal rejects any decimal point — sub-unit
  // amounts are unrepresentable, so they fail locally (mirrors the precedent
  // of Stripe's 3-decimal multiple-of-10 rule staying inside its adapter).
  const factor = 10 ** exponent;
  if (minor % factor !== 0) {
    throw PayFanoutError.invalidRequest(
      `PayPal accepts whole ${code} units only — the minor-unit amount must be a multiple of ${factor}, got ${minor}`,
      { currency: code, amount: minor },
    );
  }
  return String(minor / factor);
}

/** PayPal decimal string -> integer minor units, per-currency exponent table. */
export function fromPayPalValue(value: string, currency: string): MinorUnitAmount {
  const code = assertPayPalCurrency(currency);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    throw PayFanoutError.invalidRequest(`Cannot parse PayPal amount "${value}" for ${code}`, { value, currency: code });
  }
  const isoExponent = getCurrencyExponent(code);
  const paypalExponent = WHOLE_UNIT_CURRENCIES.has(code) ? 0 : isoExponent;
  const units = match[1]!;
  const frac = match[2] ?? "";
  if (frac.length > paypalExponent && /[1-9]/.test(frac.slice(paypalExponent))) {
    throw PayFanoutError.invalidRequest(`PayPal amount "${value}" has more precision than ${code} supports`, {
      value,
      currency: code,
    });
  }
  const scaled = Number(`${units}${frac.slice(0, paypalExponent).padEnd(paypalExponent, "0")}`);
  const minor = scaled * 10 ** (isoExponent - paypalExponent);
  if (!Number.isSafeInteger(minor)) {
    throw PayFanoutError.invalidRequest(`PayPal amount "${value}" exceeds the safe integer range in minor units`, {
      value,
      currency: code,
    });
  }
  return minor;
}
