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
 * JSON deliveries carry exactly one item (only the legacy SOAP transport batched
 * up to six), and both `live` and `success` are the STRINGS "true"/"false" —
 * never booleans, so they are compared to the exact string ("false" is truthy).
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
  /** On modification events (capture/cancel/refund): the ORIGINAL payment's reference. */
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
  /** The body is not JSON, or not an Adyen notification envelope. */
  | "malformed_payload"
  /** No `additionalData.hmacSignature` on an item. */
  | "missing_signature"
  /** A signed value contains the delimiter, so the signed payload is ambiguous. */
  | "ambiguous_signed_value"
  | "signature_mismatch";

export type AdyenWebhookVerification = { verified: true } | { verified: false; reason: AdyenWebhookVerificationFailure };

export interface AdyenWebhookVerificationOptions {
  /** Hex HMAC keys from the Customer Area. Several at once during a rotation. */
  hmacKeys: string[];
  /** Basic-auth credentials configured on the endpoint. Several at once during a rotation. */
  basicAuth: AdyenWebhookBasicAuth[];
}

/**
 * The eight signed values, colon-joined in Adyen's documented order, with an
 * empty string for any absent field:
 *
 *   pspReference:originalReference:merchantAccountCode:merchantReference:value:currency:eventCode:success
 *
 * `value` and `currency` come from the nested `amount` object. Adyen documents no
 * escaping rule for values that themselves contain the delimiter, so a value
 * carrying ":" or "\" makes the signed payload ambiguous: two different item sets
 * can produce the same string, which is exactly what a signature must exclude.
 * Such a delivery is refused (never silently accepted, never escaped by a rule
 * Adyen would not apply on its side).
 */
export function buildAdyenHmacPayload(item: AdyenNotificationItem): string | undefined {
  const values = [
    item.pspReference,
    item.originalReference,
    item.merchantAccountCode,
    item.merchantReference,
    item.amount?.value,
    item.amount?.currency,
    item.eventCode,
    item.success,
  ].map((value) => (value === undefined || value === null ? "" : String(value)));
  if (values.some((value) => value.includes(":") || value.includes("\\"))) return undefined;
  return values.join(":");
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

  const body = rawBody.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // The raw text is preserved by the caller; a verification answer is a boolean, not an error.
    return { verified: false, reason: "malformed_payload" };
  }
  const items = readItems(parsed);
  if (items.length === 0) return { verified: false, reason: "malformed_payload" };

  const keys = options.hmacKeys.map((key) => hexToBytes(key));
  // Every item must verify: a delivery is trusted as a whole or not at all.
  for (const item of items) {
    const provided = item.additionalData?.["hmacSignature"];
    if (typeof provided !== "string" || provided.length === 0) {
      return { verified: false, reason: "missing_signature" };
    }
    const payload = buildAdyenHmacPayload(item);
    if (payload === undefined) return { verified: false, reason: "ambiguous_signed_value" };
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
 * rather than being guessed into a terminal state.
 */
export function mapAdyenEventType(eventCode: string, success: boolean): UnifiedWebhookEventType {
  switch (eventCode) {
    case "AUTHORISATION":
      return success ? "payment.succeeded" : "payment.failed";
    case "CAPTURE":
      return success ? "payment.succeeded" : "payment.failed";
    case "CAPTURE_FAILED":
      return "payment.failed";
    case "CANCELLATION":
      // A cancellation that itself failed says nothing about the payment: the
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
      // One event covers both outcomes and the payload does not say which one
      // Adyen performed; emitting either would fabricate an accounting fact. The
      // adapter never issues reversals, so this only appears for modifications
      // made outside PayFanout.
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
      // The disputed amount was transferred back to the merchant. Adyen documents
      // this as defended-but-not-final: a SECOND_CHARGEBACK can still follow.
      return "payment.chargeback_won";
    case "SECOND_CHARGEBACK":
      // The issuer declined the defense material; Adyen marks the dispute "Lost".
      return "payment.chargeback_lost";
    default:
      return "unknown";
  }
}

/** Event codes whose `pspReference` is a REFUND's reference rather than the payment's. */
const REFUND_EVENT_CODES = new Set(["REFUND", "REFUND_FAILED", "REFUNDED_REVERSED", "CANCEL_OR_REFUND"]);

/**
 * One event per delivery — the unified contract. JSON deliveries carry exactly
 * one `NotificationRequestItem`, so a multi-item payload is rejected rather than
 * partially processed; {@link parseAdyenWebhookEvents} fans one out when a host
 * ingests the legacy batched transport.
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
    parsed = JSON.parse(rawBody);
  } catch (err) {
    throw invalidPayload("Unparseable Adyen webhook payload", err);
  }
  const items = readItems(parsed);
  if (items.length === 0) {
    throw invalidPayload("Adyen webhook payload carries no notificationItems", parsed);
  }
  return items.map((item) => toUnifiedEvent(item));
}

function toUnifiedEvent(item: AdyenNotificationItem): UnifiedWebhookEvent {
  const eventCode = item.eventCode;
  const pspReference = item.pspReference;
  if (!eventCode || !pspReference) {
    throw invalidPayload("Adyen notification item has no eventCode/pspReference", item);
  }
  const success = item.success === "true";
  const isRefundEvent = REFUND_EVENT_CODES.has(eventCode);
  const amount = item.amount?.value;
  const currency = item.amount?.currency;
  return {
    // pspReference alone repeats across event types for one payment (an
    // AUTHORISATION and its CAPTURE share nothing but the payment), so the stable
    // dedupe key is the PAIR: a redelivery repeats both, a different event
    // cannot collide with it.
    id: `${eventCode}:${pspReference}`,
    pspName: "adyen",
    type: mapAdyenEventType(eventCode, success),
    // Modification events report the payment on originalReference; their own
    // pspReference identifies the capture/refund.
    pspPaymentId: item.originalReference ?? pspReference,
    // Adyen prices CLP/CVE/IDR/ISK with a different exponent than ISO 4217,
    // which is what a unified event's amount means. Those payments cannot be
    // created through this adapter, but the same merchant account can carry
    // them — report no amount rather than one off by a factor of 100.
    ...(typeof amount === "number" && Number.isSafeInteger(amount) && !hasAdyenExponentDeviation(currency)
      ? { amount }
      : {}),
    ...(typeof currency === "string" && currency !== "" ? { currency: currency.toUpperCase() } : {}),
    ...(isRefundEvent ? { refundId: pspReference } : {}),
    occurredAt: normalizeTime(item.eventDate),
    raw: item,
  };
}

/** Currencies Adyen prices with a different exponent than ISO 4217. */
const EXPONENT_DEVIATION_CURRENCIES = new Set(["CLP", "CVE", "IDR", "ISK"]);

function hasAdyenExponentDeviation(currency: unknown): boolean {
  return typeof currency === "string" && EXPONENT_DEVIATION_CURRENCIES.has(currency.toUpperCase());
}

function readItems(parsed: unknown): AdyenNotificationItem[] {
  if (parsed === null || typeof parsed !== "object") return [];
  const envelope = parsed as AdyenNotification;
  if (!Array.isArray(envelope.notificationItems)) return [];
  return envelope.notificationItems
    .map((entry) => entry?.NotificationRequestItem)
    .filter((item): item is AdyenNotificationItem => Boolean(item) && typeof item === "object");
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
