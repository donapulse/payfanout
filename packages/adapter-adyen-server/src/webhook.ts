import {
  constantTimeEqual,
  lowercaseKeys,
  normalizeTime,
  PayFanoutError,
  utf8ToBase64,
  type UnifiedWebhookEvent,
  type UnifiedWebhookEventType,
} from "@payfanout/core";
import { hexToBytes, hmacSha256Base64 } from "./signing.js";

/**
 * Adyen standard webhooks. A delivery is an envelope
 * `{ "live": "false", "notificationItems": [ { "NotificationRequestItem": {…} } ] }`;
 * a JSON delivery carries exactly one item (SOAP deliveries may carry up to
 * six), and the adapter reads the JSON method only: HTTP POST and SOAP bodies
 * are not JSON, so they fail verification. `live` and `success` are the STRINGS
 * "true"/"false" — never booleans, so they are compared to the exact string
 * ("false" is truthy).
 *
 * Verification is HMAC-SHA256 over eight colon-joined field values, base64, sent
 * inside the payload at `additionalData.hmacSignature`. The Customer Area key is
 * HEX and is decoded to bytes before signing.
 */
export interface AdyenNotificationAmount {
  value?: number;
  currency?: string;
}

export interface AdyenNotificationItem {
  additionalData?: Record<string, string>;
  amount?: AdyenNotificationAmount;
  eventCode?: string;
  eventDate?: string;
  merchantAccountCode?: string;
  merchantReference?: string;
  /** On modification and dispute events: the ORIGINAL payment's reference. */
  originalReference?: string;
  paymentMethod?: string;
  pspReference?: string;
  reason?: string;
  /** The STRING "true"/"false". */
  success?: string;
  operations?: string[];
}

export interface AdyenNotification {
  /** The STRING "true"/"false" — live vs test origin. */
  live?: string;
  notificationItems?: Array<{ NotificationRequestItem?: AdyenNotificationItem }>;
}

/** Basic-auth credentials configured on the Adyen webhook endpoint. */
export interface AdyenWebhookBasicAuth {
  username: string;
  password: string;
}

/** Why a delivery failed verification — distinct reasons so hosts can tell a rewritten body from a bad key. */
export type AdyenWebhookVerificationFailure =
  /** No `authorization` header on the delivery. */
  | "missing_credentials"
  /** The `authorization` header matched none of the configured credentials. */
  | "credential_mismatch"
  /**
   * The body is not JSON or not an Adyen notification envelope, or a signed
   * value is missing or lacks the type Adyen's webhook schema documents.
   */
  | "malformed_payload"
  /** No `additionalData.hmacSignature` on an item. */
  | "missing_signature"
  /** A signed value other than `merchantReference` contains the ":" delimiter, so the values could be re-split. */
  | "ambiguous_signed_value"
  | "signature_mismatch";

export type AdyenWebhookVerification = { verified: true } | { verified: false; reason: AdyenWebhookVerificationFailure };

export interface AdyenWebhookVerificationOptions {
  /** Hex HMAC keys from the Customer Area. Several at once during a rotation. */
  hmacKeys: string[];
  /** Basic-auth credentials configured on the endpoint. Several at once during a rotation. */
  basicAuth: AdyenWebhookBasicAuth[];
}

/** The eight signed values, each with the type Adyen's webhook schema gives it. */
interface SignedValues {
  pspReference?: string;
  originalReference?: string;
  merchantAccountCode?: string;
  merchantReference?: string;
  value?: number;
  currency?: string;
  eventCode?: string;
  success?: string;
}

const SIGNED_STRING_FIELDS = [
  "pspReference",
  "originalReference",
  "merchantAccountCode",
  "merchantReference",
  "currency",
  "eventCode",
  "success",
] as const;

/**
 * Schema validation of the signed values, shared by verification and parsing so
 * an event is built from exactly the values the signature covered. The HMAC
 * authenticates the joined strings, not the JSON types carrying them: a boolean
 * `true` and the string "true" join alike, so a value without its documented
 * type (a string, or a safe integer for `amount.value`) makes the item
 * unreadable instead of being coerced.
 */
function readSignedValues(item: AdyenNotificationItem): SignedValues | undefined {
  const fields = item as Record<string, unknown>;
  const rawAmount = fields["amount"];
  if (rawAmount !== undefined && !isRecord(rawAmount)) return undefined;
  const amount: Record<string, unknown> = isRecord(rawAmount) ? rawAmount : {};
  const values: SignedValues = {};
  for (const key of SIGNED_STRING_FIELDS) {
    const field = key === "currency" ? amount["currency"] : fields[key];
    if (field === undefined) continue;
    if (typeof field !== "string") return undefined;
    values[key] = field;
  }
  const value = amount["value"];
  if (value !== undefined) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
    values.value = value;
  }
  return values;
}

/**
 * Required by Adyen's webhook schema. It lists `merchantReference` too, but
 * Adyen's own capture and cancel examples omit it, so it may be absent like
 * `originalReference`.
 */
function hasRequiredSignedValues(values: SignedValues): boolean {
  return (
    values.pspReference !== undefined &&
    values.merchantAccountCode !== undefined &&
    values.value !== undefined &&
    values.currency !== undefined &&
    values.eventCode !== undefined &&
    values.success !== undefined
  );
}

/**
 * `merchantReference` is the one signed value allowed to contain ":". With the
 * other values colon-free and `value` an integer, the joined string splits back
 * into the same eight values one way only: the first three separators and the
 * last four are fixed, and whatever lies between is the merchant reference.
 */
function isUnambiguous(values: SignedValues): boolean {
  return [
    values.pspReference,
    values.originalReference,
    values.merchantAccountCode,
    values.currency,
    values.eventCode,
    values.success,
  ].every((field) => field === undefined || !field.includes(":"));
}

function joinSignedValues(values: SignedValues): string {
  return [
    values.pspReference,
    values.originalReference,
    values.merchantAccountCode,
    values.merchantReference,
    values.value,
    values.currency,
    values.eventCode,
    values.success,
  ]
    .map((field) => (field === undefined ? "" : String(field)))
    .join(":");
}

/**
 * The eight signed values, colon-joined in Adyen's documented order, with an
 * empty string for any absent field:
 *
 *   pspReference:originalReference:merchantAccountCode:merchantReference:value:currency:eventCode:success
 *
 * `value` and `currency` come from the nested `amount` object. Adyen's
 * instructions join the values with ":" and its own validators escape nothing,
 * so a ":" is refused everywhere except in `merchantReference`, where it cannot
 * change how the string splits. Returns `undefined` for an item carrying a ":"
 * elsewhere, or a signed value without its documented type.
 */
export function buildAdyenHmacPayload(item: AdyenNotificationItem): string | undefined {
  const values = readSignedValues(item);
  if (!values || !isUnambiguous(values)) return undefined;
  return joinSignedValues(values);
}

/**
 * Verifies a delivery, with the reason on failure.
 *
 * One requirement sits on top of Adyen's own scheme, deliberately: **the
 * delivery must carry credentials.** Adyen's HMAC authenticates eight field
 * values; everything else in the payload (additionalData, reason, paymentMethod,
 * eventDate — all of which reach hosts through `event.raw`) is unauthenticated.
 * Basic authentication, which Adyen supports on every webhook type and hosts
 * enable in the Customer Area, is what authenticates the channel the rest of the
 * payload arrived on.
 *
 * Each item's signed values are checked against the types Adyen's webhook
 * schema documents before anything is signed: the required ones present, every
 * one a string except `amount.value`, a safe integer. A value of another type is
 * refused as `malformed_payload` rather than coerced into the joined string.
 *
 * A re-encoded body still verifies, and that is correct rather than a gap: the
 * signature covers values, not bytes, which is what
 * `webhookSignatureScope: "field-values"` declares. Refusing a re-encoded body
 * would mean guessing Adyen's wire format, and a wrong guess rejects every
 * legitimate delivery.
 */
export async function verifyAdyenWebhook(
  rawBody: string,
  headers: Record<string, string>,
  options: AdyenWebhookVerificationOptions,
): Promise<AdyenWebhookVerification> {
  const authorization = lowercaseKeys(headers)["authorization"];
  if (typeof authorization !== "string" || authorization.trim().length === 0) {
    return { verified: false, reason: "missing_credentials" };
  }
  if (!matchesBasicAuth(authorization, options.basicAuth)) {
    return { verified: false, reason: "credential_mismatch" };
  }

  let parsed: unknown;
  try {
    parsed = parseBody(rawBody);
  } catch {
    // The raw text is preserved by the caller; a verification answer is a boolean, not an error.
    return { verified: false, reason: "malformed_payload" };
  }
  const items = readItems(parsed);
  if (!items) return { verified: false, reason: "malformed_payload" };

  const keys = options.hmacKeys.map((key) => hexToBytes(key));
  // Every item must verify: a delivery is trusted as a whole or not at all.
  for (const item of items) {
    const provided = item.additionalData?.["hmacSignature"];
    if (typeof provided !== "string" || provided.length === 0) {
      return { verified: false, reason: "missing_signature" };
    }
    const values = readSignedValues(item);
    if (!values || !hasRequiredSignedValues(values)) return { verified: false, reason: "malformed_payload" };
    if (!isUnambiguous(values)) return { verified: false, reason: "ambiguous_signed_value" };
    const payload = joinSignedValues(values);
    let matched = false;
    for (const key of keys) {
      if (constantTimeEqual(provided, await hmacSha256Base64(key, payload))) {
        matched = true;
        break;
      }
    }
    if (!matched) return { verified: false, reason: "signature_mismatch" };
  }
  return { verified: true };
}

export async function verifyAdyenWebhookSignature(
  rawBody: string,
  headers: Record<string, string>,
  options: AdyenWebhookVerificationOptions,
): Promise<boolean> {
  return (await verifyAdyenWebhook(rawBody, headers, options)).verified;
}

/**
 * Adyen event codes onto the unified vocabulary. Refund-shaped events map by the
 * refund's OWN success flag — a failed refund is `payment.refund_failed`, never a
 * misleading `payment.refunded`. Outcomes Adyen has not resolved stay "unknown"
 * rather than being guessed into a terminal state, and so does every code not
 * listed here: Adyen adds event codes over time.
 */
export function mapAdyenEventType(eventCode: string, success: boolean): UnifiedWebhookEventType {
  switch (eventCode) {
    case "AUTHORISATION":
      return success ? "payment.succeeded" : "payment.failed";
    case "CAPTURE":
      // A refused capture request leaves the payment where it was: Adyen's
      // guidance is to review the reason, fix the issue and resubmit the capture.
      return success ? "payment.succeeded" : "unknown";
    case "CAPTURE_FAILED":
      // The scheme rejected a capture Adyen had accepted. Not always final:
      // Adyen re-captures technical failures and reports it with a CAPTURE.
      return "payment.failed";
    case "CANCELLATION":
    case "TECHNICAL_CANCEL":
      // TECHNICAL_CANCEL reports a cancel requested by merchant reference. A
      // cancellation that itself failed says nothing about the payment: the
      // unified vocabulary has no "cancel failed", and payment.failed would
      // report a decline that never happened.
      return success ? "payment.canceled" : "unknown";
    case "REFUND":
      return success ? "payment.refunded" : "payment.refund_failed";
    case "REFUND_FAILED":
      return "payment.refund_failed";
    case "REFUNDED_REVERSED":
      // The refunded amount came back to the merchant, so the money did NOT stay
      // with the shopper — the same net outcome as a failed refund.
      return "payment.refund_failed";
    case "CANCEL_OR_REFUND":
      // Which operation Adyen performed is only stated in
      // additionalData["modification.action"], outside the signed values;
      // reporting a cancel or a refund from it would present an unsigned field
      // as an accounting fact. The adapter never issues reversals, so this only
      // appears for modifications made outside PayFanout.
      return "unknown";
    case "EXPIRE":
    case "OFFER_CLOSED":
      // The authorisation lapsed uncaptured / the shopper never completed the
      // offer. Neither is a decline: the payment simply ends without money moving.
      return "payment.canceled";
    case "NOTIFICATION_OF_CHARGEBACK":
    case "CHARGEBACK":
      return "payment.chargeback";
    case "CHARGEBACK_REVERSED":
      // Defended and the funds returned, but Adyen documents this stage as not
      // final: a later loss (a second chargeback, a lost pre-arbitration) overrides it.
      return "payment.chargeback_won";
    case "ISSUER_RESPONSE_TIMEFRAME_EXPIRED":
    case "PREARBITRATION_WON":
    case "SCHEME_ARBITRATION_WON":
      return "payment.chargeback_won";
    case "SECOND_CHARGEBACK":
    case "PREARBITRATION_LOST":
    case "SCHEME_ARBITRATION_LOST":
    case "DISPUTE_DEFENSE_PERIOD_ENDED":
      return "payment.chargeback_lost";
    default:
      return "unknown";
  }
}

/** Event codes whose `pspReference` is a REFUND's reference rather than the payment's. */
const REFUND_EVENT_CODES = new Set(["REFUND", "REFUND_FAILED", "REFUNDED_REVERSED", "CANCEL_OR_REFUND"]);

/**
 * Event codes whose own `pspReference` is the payment's. Every other code names
 * the payment on `originalReference` — modifications and disputes carry their
 * own reference, and REPORT_AVAILABLE a file name — so an event without one
 * names no payment rather than a wrong one.
 */
const PAYMENT_REFERENCE_EVENT_CODES = new Set(["AUTHORISATION", "EXPIRE", "OFFER_CLOSED"]);

/**
 * One event per delivery — the unified contract. JSON deliveries carry exactly
 * one `NotificationRequestItem`, so a multi-item payload is rejected rather than
 * partially processed; {@link parseAdyenWebhookEvents} fans a multi-item
 * envelope out instead.
 */
export async function parseAdyenWebhookEvent(rawBody: string): Promise<UnifiedWebhookEvent> {
  const events = await parseAdyenWebhookEvents(rawBody);
  if (events.length !== 1) {
    throw invalidPayload("Adyen JSON webhooks carry exactly one notification item", { items: events.length });
  }
  return events[0]!;
}

export async function parseAdyenWebhookEvents(rawBody: string): Promise<UnifiedWebhookEvent[]> {
  let parsed: unknown;
  try {
    parsed = parseBody(rawBody);
  } catch (err) {
    throw invalidPayload("Unparseable Adyen webhook payload", err);
  }
  const items = readItems(parsed);
  if (!items) {
    throw invalidPayload("Adyen webhook payload is not a notificationItems envelope", parsed);
  }
  return items.map((item) => toUnifiedEvent(item));
}

function toUnifiedEvent(item: AdyenNotificationItem): UnifiedWebhookEvent {
  const values = readSignedValues(item);
  if (!values) {
    throw invalidPayload("Adyen notification item carries a signed value without its documented type", item);
  }
  const { eventCode, pspReference, value, currency, success } = values;
  if (!eventCode || !pspReference) {
    throw invalidPayload("Adyen notification item has no eventCode/pspReference", item);
  }
  const pspPaymentId =
    values.originalReference || (PAYMENT_REFERENCE_EVENT_CODES.has(eventCode) ? pspReference : undefined);
  return {
    // Adyen defines a duplicate as a delivery repeating eventCode and
    // pspReference, whatever else differs, and every event of one dispute shares
    // the dispute's pspReference, so the pair is the dedupe key.
    id: `${eventCode}:${pspReference}`,
    pspName: "adyen",
    // Adyen documents success as "true" or "false"; any other value states no outcome.
    type: success === "true" || success === "false" ? mapAdyenEventType(eventCode, success === "true") : "unknown",
    ...(pspPaymentId ? { pspPaymentId } : {}),
    // Adyen prices CLP/CVE/IDR/ISK with a different exponent than ISO 4217,
    // which is what a unified event's amount means. Those payments cannot be
    // created through this adapter, but the same merchant account can carry
    // them — report no amount rather than one off by a factor of 100.
    ...(value !== undefined && !hasAdyenExponentDeviation(currency) ? { amount: value } : {}),
    ...(currency ? { currency: currency.toUpperCase() } : {}),
    ...(REFUND_EVENT_CODES.has(eventCode) ? { refundId: pspReference } : {}),
    occurredAt: normalizeTime(typeof item.eventDate === "string" ? item.eventDate : undefined),
    raw: item,
  };
}

/** Currencies Adyen prices with a different exponent than ISO 4217. */
const EXPONENT_DEVIATION_CURRENCIES = new Set(["CLP", "CVE", "IDR", "ISK"]);

function hasAdyenExponentDeviation(currency: string | undefined): boolean {
  return currency !== undefined && EXPONENT_DEVIATION_CURRENCIES.has(currency.toUpperCase());
}

/** Verification and parsing read the body identically. */
function parseBody(rawBody: string): unknown {
  return JSON.parse(rawBody.trim());
}

/** The delivery's items, or `undefined` unless every entry of a non-empty `notificationItems` is one. */
function readItems(parsed: unknown): AdyenNotificationItem[] | undefined {
  if (!isRecord(parsed)) return undefined;
  const entries = parsed["notificationItems"];
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const items: AdyenNotificationItem[] = [];
  for (const entry of entries) {
    const item: unknown = isRecord(entry) ? entry["NotificationRequestItem"] : undefined;
    if (!isRecord(item)) return undefined;
    items.push(item as AdyenNotificationItem);
  }
  return items;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesBasicAuth(authorization: string, credentials: AdyenWebhookBasicAuth[]): boolean {
  const separator = authorization.indexOf(" ");
  if (separator === -1) return false;
  // The auth scheme is case-insensitive (RFC 9110); the credential half is not.
  if (authorization.slice(0, separator).toLowerCase() !== "basic") return false;
  const provided = authorization.slice(separator + 1).trim();
  let matched = false;
  for (const credential of credentials) {
    // No early exit: every configured credential is compared so the work does not
    // depend on which one matches.
    if (constantTimeEqual(provided, utf8ToBase64(`${credential.username}:${credential.password}`))) {
      matched = true;
    }
  }
  return matched;
}

function invalidPayload(message: string, raw: unknown): PayFanoutError {
  return new PayFanoutError({ code: "invalid_request", message, retryable: false, raw, pspName: "adyen" });
}
