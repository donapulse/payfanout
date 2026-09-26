import { getCurrencyExponent, PayFanoutError, type UnifiedErrorCode } from "@payfanout/core";

/**
 * Currencies whose Paysafe minor units are not the ISO 4217 minor units
 * PayFanout amounts are in (core's getCurrencyExponent), each with the
 * exponent Paysafe documents for it, or undefined where it documents none.
 * Paysafe reads `amount` in the minor units of its Currency Codes table
 * (developer.paysafe.com/en/support/reference-information/codes/#currency-codes,
 * which the Payments API and Payment Scheduler specs link from `amount`):
 * - CLP has the exponent 2 there and 0 in ISO 4217, so CLP 10,000, sent as
 *   10000, would be charged as CLP 100.00;
 * - BYR has 0 there, and 2 in core, which does not know the code (ISO 4217
 *   withdrew it in 2017);
 * - ISK is one of the card processing currencies
 *   (developer.paysafe.com/en/api-docs/payments-api/add-payment-methods/cards/about-card-payments/)
 *   but has no row in the table; ISO 4217 gives it 0.
 * The adapter sends and reports no amount in these currencies, and converts
 * none: no sandbox run has confirmed the table, and a conversion built on a
 * wrong entry would charge a hundred times the amount.
 */
const EXCLUDED_CURRENCIES: ReadonlyMap<string, number | undefined> = new Map([
  ["BYR", 0],
  ["CLP", 2],
  ["ISK", undefined],
]);

/** `currency`, uppercased, when the adapter excludes it. */
export function excludedCurrency(currency: unknown): string | undefined {
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : undefined;
  return code !== undefined && EXCLUDED_CURRENCIES.has(code) ? code : undefined;
}

/** Refuses a call that would send, or sign for sending, an amount in an excluded currency. */
export function assertSendableCurrency(currency: string): void {
  const code = excludedCurrency(currency);
  if (code === undefined) return;
  throw exclusionError(
    "invalid_request",
    `The Paysafe adapter refuses ${code}: ${exclusionReason(code)}. Take ${code} payments with another provider`,
    code,
  );
}

/**
 * Refuses a call on a record Paysafe holds in an excluded currency, before
 * anything is sent for it: `action` is what to do in the Paysafe portal
 * instead, and `code` is invalid_request unless the call would send no amount.
 */
export function assertActionableRecord(
  currency: unknown,
  subject: string,
  action: string,
  record: unknown,
  code: UnifiedErrorCode = "invalid_request",
): void {
  const excluded = excludedCurrency(currency);
  if (excluded === undefined) return;
  throw exclusionError(
    code,
    `${subject} is in ${excluded}, which the Paysafe adapter refuses: ${exclusionReason(excluded)}. ` +
      `${action} it in the Paysafe portal`,
    excluded,
    record,
  );
}

/** Refuses to report a record whose amounts are in an excluded currency. */
export function assertReportableRecord(currency: unknown, subject: string, record: unknown): void {
  const excluded = excludedCurrency(currency);
  if (excluded === undefined) return;
  throw exclusionError(
    "unsupported_operation",
    `${subject} is in ${excluded}, so its amounts cannot be reported in ISO 4217 minor units: ` +
      `${exclusionReason(excluded)}. Read it in the Paysafe portal`,
    excluded,
    record,
  );
}

/** assertReportableRecord for a page of records, naming every one in an excluded currency. */
export function assertReportableRecords(
  records: ReadonlyArray<{ id: string; currency: unknown }>,
  noun: string,
  page: unknown,
): void {
  const excluded = records.flatMap(({ id, currency }) => {
    const code = excludedCurrency(currency);
    return code === undefined ? [] : [{ id, code }];
  });
  const first = excluded[0];
  if (first === undefined) return;
  const codes = [...new Set(excluded.map(({ code }) => code))];
  throw exclusionError(
    "unsupported_operation",
    `This page lists ${noun}s in currencies the Paysafe adapter refuses ` +
      `(${excluded.map(({ id, code }) => `${id} in ${code}`).join(", ")}), so their amounts cannot be reported in ` +
      `ISO 4217 minor units: ${codes.map(exclusionReason).join("; ")}. Read them in the Paysafe portal`,
    first.code,
    page,
  );
}

function exclusionReason(code: string): string {
  const paysafe = EXCLUDED_CURRENCIES.get(code);
  const documented =
    paysafe === undefined
      ? `Paysafe documents no exponent for ${code}`
      : `Paysafe's currency table gives ${code} the exponent ${paysafe}`;
  return (
    `${documented}, while PayFanout amounts are ISO 4217 minor units, exponent ${getCurrencyExponent(code)} ` +
    `for ${code}, and the adapter does not convert between them`
  );
}

function exclusionError(code: UnifiedErrorCode, message: string, currency: string, record?: unknown): PayFanoutError {
  const paysafeExponent = EXCLUDED_CURRENCIES.get(currency);
  return new PayFanoutError({
    code,
    message,
    retryable: false,
    raw: {
      currency,
      ...(paysafeExponent !== undefined ? { paysafeExponent } : {}),
      isoExponent: getCurrencyExponent(currency),
      ...(record !== undefined ? { record } : {}),
    },
    pspName: "paysafe",
  });
}
