import { getCurrencyExponent, PayFanoutError, type UnifiedErrorCode } from "@payfanout/core";

/**
 * Paysafe's Currency Codes table, its 81 rows grouped by exponent, as
 * published at
 * developer.paysafe.com/en/support/reference-information/codes/#currency-codes
 * (read 2026-09-30). Paysafe reads `amount` in the minor units of this table:
 * the Payments API and Payment Scheduler specs link it from `amount` and
 * `currencyCode`, and the page lists "the currencies ... in which transaction
 * requests are processed". It is not exhaustive: the card payments page lists
 * ISK, which has no row, among the processing currencies, "and many more".
 */
const PAYSAFE_TABLE: Readonly<Record<number, readonly string[]>> = {
  0: ["BYR", "JPY", "KRW", "PYG", "RWF", "VND"],
  2: [
    "AED", "ARS", "AUD", "AZN", "BAM", "BGN", "BOB", "BRL", "CAD", "CHF", "CLP", "CNY", "COP", "CRC",
    "CZK", "DKK", "DOP", "EGP", "ETB", "EUR", "FJD", "GBP", "GEL", "GTQ", "HKD", "HNL", "HRK", "HTG",
    "HUF", "IDR", "ILS", "INR", "JMD", "KES", "KZT", "LBP", "LKR", "LVL", "MAD", "MDL", "MUR", "MWK",
    "MXN", "NGN", "NOK", "NZD", "PAB", "PEN", "PHP", "PKR", "PLN", "QAR", "RON", "RSD", "RUB", "SAR",
    "SEK", "SGD", "SYP", "THB", "TRY", "TTD", "TWD", "UAH", "USD", "UYU", "VEF", "XCD", "ZAR",
  ],
  3: ["BHD", "JOD", "KWD", "LYD", "OMR", "TND"],
};

/** The exponent Paysafe's table gives each code it lists. */
export const PAYSAFE_CURRENCY_EXPONENTS: ReadonlyMap<string, number> = new Map(
  Object.entries(PAYSAFE_TABLE).flatMap(([exponent, codes]) => codes.map((code) => [code, Number(exponent)] as const)),
);

/**
 * ISO 4217 on codes the rule meets that core's getCurrencyExponent does not
 * list, and so reads with its default 2 (SIX, list one of 2026-09-17, list
 * three of 2026-01-01). List one gives UYI the exponent 0: the rule takes it
 * from here until core does. BYR was withdrawn in 2017-01, and list three
 * gives no minor unit; the entry only words its refusal.
 */
const ISO_4217_ON_CORE_DEFAULTS: ReadonlyMap<string, number | "withdrawn"> = new Map<string, number | "withdrawn">([
  ["BYR", "withdrawn"],
  ["UYI", 0],
]);

/** Why the adapter refuses a currency; every refusal's `raw` carries it. */
export interface CurrencyRefusal {
  currency: string;
  /** The exponent Paysafe's table gives the currency; absent when it has no row for it. */
  paysafeExponent?: number;
  /** Core's getCurrencyExponent: the minor units PayFanout amounts are in. */
  payfanoutExponent: number;
  /** ISO 4217's exponent, present only where it is not PayFanout's. */
  isoExponent?: number;
}

/**
 * The refusal for `currency`, or undefined when the adapter sends and reports
 * its amounts unchanged. A currency is refused when Paysafe's table gives it
 * another exponent than PayFanout, or when the table has no row for it and it
 * is not priced in hundredths, by PayFanout or by ISO 4217. A currency the
 * table lacks that is priced in hundredths is sent unchanged, since the table
 * is not exhaustive: the one residual risk, left to the go-live checklist.
 */
export function currencyRefusal(currency: unknown): CurrencyRefusal | undefined {
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(code)) return undefined;
  const payfanoutExponent = getCurrencyExponent(code);
  const paysafeExponent = PAYSAFE_CURRENCY_EXPONENTS.get(code);
  if (paysafeExponent !== undefined) {
    return paysafeExponent === payfanoutExponent ? undefined : { currency: code, paysafeExponent, payfanoutExponent };
  }
  const iso = ISO_4217_ON_CORE_DEFAULTS.get(code);
  const isoExponent = typeof iso === "number" && iso !== payfanoutExponent ? iso : undefined;
  if (payfanoutExponent === 2 && isoExponent === undefined) return undefined;
  return { currency: code, payfanoutExponent, ...(isoExponent !== undefined ? { isoExponent } : {}) };
}

/** Refuses a call that would send, or sign for sending, an amount in a refused currency. */
export function assertSendableCurrency(currency: string): void {
  const refusal = currencyRefusal(currency);
  if (refusal === undefined) return;
  const code = refusal.currency;
  throw refusalError(
    "invalid_request",
    `The Paysafe adapter refuses ${code}: ${reason(refusal)}. Take ${code} payments with another provider`,
    { ...refusal },
  );
}

/**
 * How a call uses a record Paysafe holds in a refused currency: it sends the
 * caller's amount for it (`send`, refused with invalid_request), sends
 * Paysafe's own amounts or none and answers with the record's (`answer`),
 * reports it (`read`), or cancels a subscription already stopped (`stopped`).
 * The last three are refused with unsupported_operation.
 */
export type RecordUse =
  | { kind: "send"; action: string }
  | { kind: "answer"; action: string }
  | { kind: "read" }
  | { kind: "stopped"; status: string };

/** Refuses a call on a record in a refused currency; `subject` names the record ("Payment pay_1"). */
export function assertUsableRecord(currency: unknown, subject: string, record: unknown, use: RecordUse): void {
  const refusal = currencyRefusal(currency);
  if (refusal === undefined) return;
  const code = refusal.currency;
  const why = reason(refusal);
  const raw = { ...refusal, record };
  switch (use.kind) {
    case "send":
      throw refusalError(
        "invalid_request",
        `${subject} is in ${code}, and a ${use.action} amount in PayFanout's minor units cannot be sent for it: ` +
          `${why}. ${capitalized(use.action)} it in the Paysafe portal`,
        raw,
      );
    case "answer":
      throw refusalError(
        "unsupported_operation",
        `${subject} is in ${code}, so the amounts a ${use.action} answers with cannot be reported in PayFanout's ` +
          `minor units: ${why}. ${capitalized(use.action)} it in the Paysafe portal`,
        raw,
      );
    case "read":
      throw refusalError(
        "unsupported_operation",
        `${subject} is in ${code}, so its amounts cannot be reported in PayFanout's minor units: ${why}. ` +
          "Read it in the Paysafe portal",
        raw,
      );
    case "stopped":
      throw refusalError(
        "unsupported_operation",
        `${subject} is already stopped (${use.status}), and it is in ${code}, so its amounts cannot be reported in ` +
          `PayFanout's minor units: ${why}. Read it in the Paysafe portal`,
        raw,
      );
  }
}

/**
 * Refuses a page of records when any is in a refused currency. `raw` names
 * each such record and currency, and carries the `nextCursor` the page would
 * have had, so later pages stay reachable.
 */
export function assertReportablePage(
  records: ReadonlyArray<{ id: string; currency: unknown }>,
  noun: string,
  nextCursor: string | undefined,
): void {
  const refused = records.flatMap(({ id, currency }) => {
    const refusal = currencyRefusal(currency);
    return refusal === undefined ? [] : [{ id, refusal }];
  });
  if (refused.length === 0) return;
  const currencies = [...new Map(refused.map(({ refusal }) => [refusal.currency, refusal])).values()];
  throw refusalError(
    "unsupported_operation",
    `This page lists ${noun}s in currencies the Paysafe adapter refuses ` +
      `(${refused.map(({ id, refusal }) => `${id} in ${refusal.currency}`).join(", ")}), so their amounts cannot be ` +
      `reported in PayFanout's minor units: ${currencies.map(reason).join("; ")}. Read them in the Paysafe portal` +
      (nextCursor !== undefined ? `; the next page starts at cursor ${nextCursor}` : ""),
    {
      currencies,
      records: refused.map(({ id, refusal }) => ({ id, currency: refusal.currency })),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    },
  );
}

function reason(refusal: CurrencyRefusal): string {
  const { currency: code, paysafeExponent, payfanoutExponent, isoExponent } = refusal;
  const withdrawn = ISO_4217_ON_CORE_DEFAULTS.get(code) === "withdrawn" ? ", a code ISO 4217 withdrew," : "";
  const payfanout =
    `PayFanout reads ${code}${withdrawn} with the exponent ${payfanoutExponent}` +
    (isoExponent !== undefined ? `, although ISO 4217 gives it ${isoExponent}` : "");
  return paysafeExponent !== undefined
    ? `Paysafe's currency table gives ${code} the exponent ${paysafeExponent}, while ${payfanout}, and the ` +
        "adapter does not convert between them"
    : `Paysafe's currency table has no row for ${code}, and ${payfanout}: the adapter sends a currency the table ` +
        "lacks only when its exponent is 2";
}

function capitalized(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

function refusalError(code: UnifiedErrorCode, message: string, raw: Record<string, unknown>): PayFanoutError {
  return new PayFanoutError({ code, message, retryable: false, raw, pspName: "paysafe" });
}
