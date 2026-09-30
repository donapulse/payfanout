import { getCurrencyExponent, PayFanoutError, type MinorUnitAmount, type UnifiedErrorCode } from "@payfanout/core";

/**
 * The decimals Stripe's API reads a currency's `amount` with, where they
 * differ from the ISO 4217 minor units core's getCurrencyExponent gives
 * PayFanout amounts in. Stripe's currencies page (docs.stripe.com/currencies,
 * read 2026-09-30) says "All API requests expect `amount` values in the
 * currency's minor unit" and "Currencies are two-decimal currencies unless
 * otherwise specified", then departs from ISO 4217 for two currencies it
 * accepts:
 *
 * - ISK (0 decimals in ISO 4217): "ISK transitioned to a zero-decimal
 *   currency, but backward compatibility requires you to represent it as a
 *   two-decimal value, where the decimal amount is always `00`."
 * - MGA (2 decimals in ISO 4217): on the page's zero-decimal list, for which
 *   "the charge and the amount are the same, without requiring
 *   multiplication".
 */
const STRIPE_EXPONENTS: Readonly<Record<string, number>> = { ISK: 2, MGA: 0 };

/**
 * UGX is on the same zero-decimal list, and the page's special cases give it
 * ISK's two-decimal text ("to charge 5 UGX, provide an `amount` value of
 * `500`"). With both units documented, the adapter neither sends nor reports
 * UGX amounts.
 */
const CONTRADICTED: ReadonlySet<string> = new Set(["UGX"]);

/** A currency's units on either side; every refusal's `raw` carries them. */
export interface CurrencyUnits {
  /** Uppercase ISO 4217 code. */
  currency: string;
  /** Core's getCurrencyExponent: the minor units PayFanout amounts are in. */
  payfanoutExponent: number;
  /** The decimals of Stripe's `amount`; absent for UGX, which Stripe's page gives both 0 and 2. */
  stripeExponent?: number;
}

/** The units of `currency`, or undefined for a value that is no currency code, whose amounts pass unchanged. */
export function currencyUnits(currency: unknown): CurrencyUnits | undefined {
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(code)) return undefined;
  const payfanoutExponent = getCurrencyExponent(code);
  if (CONTRADICTED.has(code)) return { currency: code, payfanoutExponent };
  return { currency: code, payfanoutExponent, stripeExponent: STRIPE_EXPONENTS[code] ?? payfanoutExponent };
}

/** What a send refusal names besides the amount. */
export interface SendTarget {
  /** How the message names the amount: the request field (`amount_to_capture`), or a phrase. */
  label: string;
  /** The record the call read to learn the currency, having been given none. */
  record?: RecordTarget;
  /**
   * Set on a call an earlier release sent unconverted, when the adapter cannot
   * tell that nothing moved under the same key: it names what that release may
   * already have done ("a charge", "a capture"). The refusals that release
   * would not have made, UGX and an amount that is not whole in Stripe's
   * units, then leave the outcome open, and ask the host to look for it under
   * the key in the Stripe Dashboard before sending another.
   */
  sentBefore?: string;
}

/** A record read first; the refusal of an amount for a UGX one names it. */
export interface RecordTarget {
  /** How messages name it: "PaymentIntent pi_1". */
  subject: string;
  /** The record itself, carried on the refusal's `raw.record`. */
  raw: unknown;
  /** The call, as the refusal names it: "capture". */
  action: string;
  /** How that refusal ends: what to check in the Stripe Dashboard before acting on the record another way. */
  remedy: string;
  /**
   * Whether that refusal leaves the outcome open: an earlier release sent the
   * call unconverted, and the record does not show that nothing moved.
   */
  outcomeUnknown: boolean;
}

const SENT_BEFORE = ". An earlier release sent such requests unconverted";

/**
 * Refuses a call that would send an amount in `currency`, before any request:
 * UGX, whose unit Stripe's page leaves unknown.
 */
export function assertSendableCurrency(currency: string, target: SendTarget): void {
  sendableUnits(currency, target);
}

/**
 * The `amount` to send Stripe for a PayFanout amount in `currency`. Throws a
 * non-retryable invalid_request, for the call to reject before the request
 * that would carry it, when Stripe cannot be sent the amount: any UGX amount;
 * an MGA amount that is not whole ariary (a multiple of 100); and an ISK
 * amount that leaves the safe integer range once multiplied by 100. See
 * `SendTarget` for the refusals that leave the outcome open.
 */
export function toStripeAmount(amount: MinorUnitAmount, currency: string, target: SendTarget): number {
  const units = sendableUnits(currency, target);
  if (units === undefined) return amount;
  const { currency: code, payfanoutExponent, stripeExponent } = units;
  const raw = { ...units, amount, ...(target.record ? { record: target.record.raw } : {}) };
  const shift = stripeExponent - payfanoutExponent;
  if (shift > 0) {
    const stripeAmount = amount * 10 ** shift;
    if (!Number.isSafeInteger(stripeAmount)) {
      throw refusal(
        "invalid_request",
        `Stripe takes ${code} amounts with ${stripeExponent} decimals where PayFanout has ${payfanoutExponent}, and ` +
          `${target.label} ${amount} leaves the safe integer range once multiplied by ${10 ** shift}`,
        raw,
      );
    }
    return stripeAmount;
  }
  if (shift < 0) {
    const divisor = 10 ** -shift;
    if (amount % divisor !== 0) {
      throw refusal(
        "invalid_request",
        `Stripe takes ${code} amounts with ${stripeExponent} decimals where PayFanout has ${payfanoutExponent}, so ` +
          `${target.label} must be a multiple of ${divisor} minor units, got ${amount}${sentBefore(target)}`,
        raw,
        target.sentBefore !== undefined,
      );
    }
    return amount / divisor;
  }
  return amount;
}

/**
 * Refuses a three-decimal amount that is not a multiple of 10, a rule from an
 * earlier version of Stripe's currencies page, which no longer covers
 * three-decimal currencies. It applies where the adapter applied it before it
 * converted amounts: session creation, an update naming both amount and
 * currency, saved-method charges and native subscriptions.
 */
export function assertThreeDecimalRule(amount: MinorUnitAmount, currency: string): void {
  const units = currencyUnits(currency);
  if (units?.stripeExponent !== 3 || amount % 10 === 0) return;
  throw refusal(
    "invalid_request",
    `Stripe requires three-decimal ${units.currency} amounts to be a multiple of 10 minor units, got ${amount}`,
    { ...units, amount },
  );
}

function sendableUnits(currency: string, target: SendTarget): Required<CurrencyUnits> | undefined {
  const units = currencyUnits(currency);
  if (units === undefined) return undefined;
  const { stripeExponent } = units;
  if (stripeExponent !== undefined) return { ...units, stripeExponent };
  const why = contradiction(units.currency);
  if (target.record) {
    const { subject, raw, action, remedy, outcomeUnknown } = target.record;
    throw refusal(
      "invalid_request",
      `${subject} is in ${units.currency}, so no amount can be sent for its ${action}: ${why}` +
        `${outcomeUnknown ? SENT_BEFORE : ""}. ${remedy}`,
      { ...units, record: raw },
      outcomeUnknown,
    );
  }
  throw refusal(
    "invalid_request",
    `The Stripe adapter refuses ${units.currency}: ${why}. Take ${units.currency} payments with another provider` +
      sentBefore(target),
    { ...units },
    target.sentBefore !== undefined,
  );
}

function sentBefore(target: SendTarget): string {
  return target.sentBefore === undefined
    ? ""
    : `${SENT_BEFORE}, so check the Stripe Dashboard for ${target.sentBefore} under this idempotency key before ` +
        "sending another";
}

type Reading = { amount: number; reason?: undefined } | { amount?: undefined; reason: string };

/** One Stripe amount in PayFanout's minor units, or why it cannot be reported. */
function read(stripeAmount: number, units: CurrencyUnits | undefined): Reading {
  if (units === undefined) return { amount: stripeAmount };
  const { currency: code, payfanoutExponent, stripeExponent } = units;
  if (stripeExponent === undefined) return { reason: contradiction(code) };
  const shift = stripeExponent - payfanoutExponent;
  if (shift === 0) return { amount: stripeAmount };
  if (!Number.isSafeInteger(stripeAmount)) {
    return { reason: `Stripe reported the ${code} amount ${stripeAmount}, which is not an integer` };
  }
  if (shift > 0) {
    const divisor = 10 ** shift;
    return stripeAmount % divisor === 0
      ? { amount: stripeAmount / divisor }
      : {
          reason:
            `Stripe gives ${code} amounts ${stripeExponent} decimals that are always 0 where PayFanout has ` +
            `${payfanoutExponent}, and ${stripeAmount} is not a multiple of ${divisor}`,
        };
  }
  const amount = stripeAmount * 10 ** -shift;
  return Number.isSafeInteger(amount)
    ? { amount }
    : { reason: `the ${code} amount ${stripeAmount} leaves the safe integer range in PayFanout's minor units` };
}

/**
 * A Stripe amount in PayFanout's minor units, or undefined when it cannot be
 * reported, which webhook events then omit. A `currency` that is no currency
 * code leaves the amount unchanged.
 */
export function fromStripeAmount(stripeAmount: number, currency: unknown): number | undefined {
  return read(stripeAmount, currencyUnits(currency)).amount;
}

/** One record as Stripe returned it. */
export interface StripeRecord {
  /** How messages name it, by its Stripe object and id: "PaymentIntent pi_1". */
  subject: string;
  /** The record's own `currency`, lowercase as Stripe reports it. */
  currency: unknown;
  /** The record itself; refusals carry it on `raw.record`. */
  raw: unknown;
}

/**
 * How a call uses the amounts it reads: it reports a record (`read`),
 * answers with the record a mutating call returned (`answer`, whose `action`
 * names the call), or keeps the record's amount across a currency change
 * (`keep`).
 */
export type RecordUse = { kind: "read" } | { kind: "answer"; action: string } | { kind: "keep" };

/**
 * `amounts`, Stripe's, in PayFanout's minor units under the same keys; an
 * absent one stays absent. Throws when the record's amounts cannot be
 * reported: every UGX record, and any amount in another currency that does
 * not convert. A read or an answer rejects with unsupported_operation, the
 * answer marked outcomeUnknown as the call it answers went through; `keep`
 * rejects with invalid_request, as the caller can send the amount instead.
 */
export function readStripeAmounts<T extends Record<string, number | undefined>>(
  record: StripeRecord,
  amounts: T,
  use: RecordUse,
): T {
  const units = currencyUnits(record.currency);
  if (units === undefined) return amounts;
  if (units.stripeExponent === undefined) {
    throw unreportable(record, units, undefined, contradiction(units.currency), use);
  }
  const out: Record<string, number | undefined> = {};
  for (const [key, value] of Object.entries(amounts)) {
    if (value === undefined) continue;
    const reading = read(value, units);
    if (reading.reason !== undefined) throw unreportable(record, units, value, reading.reason, use);
    out[key] = reading.amount;
  }
  return out as T;
}

/**
 * Refuses a page of records when any record's amounts cannot be reported.
 * `raw.records` names each such record with its currency and the reason, and
 * `raw.nextCursor` carries the cursor the page would have had, so later pages
 * stay reachable.
 */
export function assertReportablePage(
  records: ReadonlyArray<{ id: string; currency: unknown; amounts: ReadonlyArray<number | undefined> }>,
  noun: string,
  nextCursor: string | undefined,
): void {
  const refused = records.flatMap(({ id, currency, amounts }) => {
    const units = currencyUnits(currency);
    if (units === undefined) return [];
    const reason = amounts.reduce<string | undefined>(
      (found, amount) => found ?? (amount === undefined ? undefined : read(amount, units).reason),
      units.stripeExponent === undefined ? contradiction(units.currency) : undefined,
    );
    return reason === undefined ? [] : [{ id, currency: units.currency, reason }];
  });
  if (refused.length === 0) return;
  throw refusal(
    "unsupported_operation",
    `This page lists ${noun}s whose amounts cannot be reported in PayFanout's minor units ` +
      `(${refused.map(({ id, currency }) => `${id} in ${currency}`).join(", ")}): ` +
      `${[...new Set(refused.map(({ reason }) => reason))].join("; ")}. Read them in the Stripe Dashboard` +
      (nextCursor !== undefined ? `; the next page starts at cursor ${nextCursor}` : ""),
    { records: refused, ...(nextCursor !== undefined ? { nextCursor } : {}) },
  );
}

function unreportable(
  record: StripeRecord,
  units: CurrencyUnits,
  stripeAmount: number | undefined,
  reason: string,
  use: RecordUse,
): PayFanoutError {
  const raw = { ...units, ...(stripeAmount !== undefined ? { stripeAmount } : {}), record: record.raw };
  const { subject } = record;
  const cannot = `cannot be reported in PayFanout's minor units: ${reason}`;
  switch (use.kind) {
    case "read":
      return refusal(
        "unsupported_operation",
        `${subject} is in ${units.currency}, and its amounts ${cannot}. Read it in the Stripe Dashboard`,
        raw,
      );
    case "answer":
      return refusal(
        "unsupported_operation",
        `Stripe answered the ${use.action} with ${subject}, which is in ${units.currency}, and its amounts ${cannot}. ` +
          `The ${use.action} may have taken effect: check ${subject} in the Stripe Dashboard`,
        raw,
        true,
      );
    case "keep":
      return refusal(
        "invalid_request",
        `${subject} is in ${units.currency}, so the amount a currency change keeps ${cannot}. ` +
          "Send the amount with the currency",
        raw,
      );
  }
}

function contradiction(code: string): string {
  return (
    `Stripe's currencies page lists ${code} as a zero-decimal currency and also asks for ${code} amounts as ` +
    "two-decimal values ending in 00, so the unit it reads them in is unknown"
  );
}

function refusal(
  code: UnifiedErrorCode,
  message: string,
  raw: Record<string, unknown>,
  outcomeUnknown = false,
): PayFanoutError {
  return new PayFanoutError({ code, message, retryable: false, raw, pspName: "stripe", outcomeUnknown });
}
