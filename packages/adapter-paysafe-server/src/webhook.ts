import {
  bytesToBase64,
  constantTimeEqual,
  hmacSha256,
  lowercaseKeys,
  normalizeSecrets,
  normalizeTime,
  PayFanoutError,
  sha256Hex,
  type UnifiedWebhookEvent,
  type UnifiedWebhookEventType,
} from "@payfanout/core";

/**
 * Paysafe webhook signature: base64(HMAC_SHA256(hmacKey, rawJsonBody)) carried
 * in the `Signature` header. Verification MUST hash the exact raw body bytes.
 * Paysafe counts only a 200 or 202 as received, makes at most three attempts
 * in all, and raises no alert once they fail — ack fast, process async (see
 * @payfanout/server's handler contract), and reconcile with retrievePayment.
 *
 * WebCrypto (async) so this runs on edge runtimes as well as Node.
 */
// `signature` is the documented header; the other two are tolerated aliases.
const SIGNATURE_HEADER_CANDIDATES = ["signature", "x-signature", "x-paysafe-signature"];

/**
 * Verifies a delivery against one or several HMAC keys (rotation — any match
 * wins). Header names match case-insensitively.
 */
export async function verifyPaysafeWebhookSignature(
  rawBody: string,
  headers: Record<string, string>,
  hmacKeys: string | string[],
): Promise<boolean> {
  const lower = lowercaseKeys(headers);
  const provided = SIGNATURE_HEADER_CANDIDATES.map((name) => lower[name]).find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (!provided) return false;
  for (const key of normalizeSecrets(hmacKeys)) {
    const expected = bytesToBase64(await hmacSha256(key, rawBody));
    if (constantTimeEqual(provided.trim(), expected)) return true;
  }
  return false;
}

/**
 * The event names Paysafe documents, mapped onto the unified vocabulary; the
 * onboarding descriptor advertises exactly these. SETTLEMENT_* and
 * PAYMENT_HANDLE_* stay unmapped: they describe a settlement or a handle, not
 * the payment.
 */
const DOCUMENTED_EVENT_TYPES: Record<string, UnifiedWebhookEventType> = {
  PAYMENT_COMPLETED: "payment.succeeded",
  PAYMENT_FAILED: "payment.failed",
  // An error other than a 402 decline (Interac e-Transfer page).
  PAYMENT_ERRORED: "payment.failed",
  PAYMENT_CANCELLED: "payment.canceled",
  // Async/underway states — the terminal event follows later.
  PAYMENT_PROCESSING: "payment.processing",
  PAYMENT_RECEIVED: "payment.processing",
  PAYMENT_PENDING: "payment.processing",
  PAYMENT_HELD: "payment.processing", // risk review — funds not moving yet
  // Bank-debit rails: "Failed payment reported by the bank" AFTER completion —
  // the late-failure flip. The event tables say RETURNED, every payload example
  // sends RETURN; missing the wire spelling would downgrade a bank-reported
  // failure to "unknown".
  PAYMENT_RETURN_COMPLETED: "payment.failed",
  PAYMENT_RETURNED_COMPLETED: "payment.failed",
  REFUND_COMPLETED: "payment.refunded",
  // Refunds that ended without the funds going back to the customer.
  REFUND_FAILED: "payment.refund_failed",
  REFUND_CANCELLED: "payment.refund_failed",
  REFUND_ERRORED: "payment.refund_failed",
};

/** On no Paysafe page: parsed if a variant ever sends them, never advertised. */
const TOLERATED_EVENT_TYPES: Record<string, UnifiedWebhookEventType> = {
  PAYMENT_DECLINED: "payment.failed",
  PAYMENT_EXPIRED: "payment.canceled",
  PAYMENT_AUTHENTICATION_REQUIRED: "payment.requires_action",
  REFUND_DECLINED: "payment.refund_failed",
  REFUND_ERROR: "payment.refund_failed",
};

const EVENT_TYPE_MAP: Record<string, UnifiedWebhookEventType> = {
  ...TOLERATED_EVENT_TYPES,
  ...DOCUMENTED_EVENT_TYPES,
};

/** Documented event names, in map order: the onboarding descriptor's subscribe list. */
export const PAYSAFE_DOCUMENTED_WEBHOOK_EVENTS: readonly string[] = Object.keys(DOCUMENTED_EVENT_TYPES);

type JsonObject = Record<string, unknown>;

/**
 * Parses a Paysafe webhook delivery into a UnifiedWebhookEvent. Call it only
 * after {@link verifyPaysafeWebhookSignature} accepted the same raw body.
 *
 * The envelope is read where Paysafe documents it: top-level `payload`,
 * `eventName`, `resourceId` and `eventDate`, or the same fields nested under
 * `variables`, as the Bacs page shows them. The older `eventType`/`event`
 * name fields are still read; the top-level `type` is the resource category
 * ("PAYMENT"), never the event name.
 *
 * `pspPaymentId` names a payment and nothing else:
 * - a bank return (`type` "PAYMENT_RETURN", or a PAYMENT_RETURN… /
 *   PAYMENT_RETURNED… event) reports the returned payment from
 *   `payload.paymentId`, never the return's own `payload.id`;
 * - other payment events report `payload.id`, else `resourceId`;
 * - refund events report the refund as `refundId` and no `pspPaymentId`, since
 *   the refund payload names no payment;
 * - handle, settlement and every other resource leave it unset (correlate those
 *   by the payload `merchantRefNum` on `raw`).
 *
 * `id` survives Paysafe's redeliveries. Paysafe sends no event id and repeats a
 * notification with the next `attemptNumber` ("1", "2", "3"), so a hash of the
 * raw bytes would give every attempt its own id. The id is `paysafe_` + the
 * SHA-256 hex of the JSON array `[name, resourceId, status, time]`: the
 * normalized event name, the resource id (`payload.id`, else `resourceId`), the
 * payload `status`, and the payload `statusTime`, else its `txnTime`, else the
 * envelope `eventDate`. Distinct notifications agreeing on all four share an id
 * (card and refund payloads carry no `statusTime`), so a host that must see
 * every transition re-reads with `retrievePayment` / `retrieveRefund` whether or
 * not the id was seen. A top-level `id` is ignored — Paysafe's webhook page
 * shows the resource's own id there — and a body naming no resource hashes its
 * key-sorted JSON without `attemptNumber`.
 */
export async function parsePaysafeWebhookEvent(rawBody: string): Promise<UnifiedWebhookEvent> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    throw new PayFanoutError({
      code: "invalid_request",
      message: "Unparseable Paysafe webhook payload",
      retryable: false,
      raw: err,
      pspName: "paysafe",
    });
  }
  const body = asObject(parsed);
  if (!body) {
    throw new PayFanoutError({
      code: "invalid_request",
      message: "Paysafe webhook payload is not a JSON object",
      retryable: false,
      raw: parsed,
      pspName: "paysafe",
    });
  }

  const nested = asObject(body.variables);
  const payload = asObject(body.payload) ?? asObject(nested?.payload);
  const name = (
    asText(body.eventName) ??
    asText(body.eventType) ??
    asText(body.event) ??
    asText(nested?.eventName) ??
    ""
  )
    .toUpperCase()
    .replace(/[.\s-]/g, "_");
  const category = (asText(body.type) ?? asText(nested?.type) ?? "").toUpperCase();
  const eventDate = asText(body.eventDate) ?? asText(nested?.eventDate);
  const resourceId = asText(payload?.id) ?? asText(body.resourceId) ?? asText(nested?.resourceId);
  const resource = resourceOf(category, name);
  const pspPaymentId =
    resource === "return" ? asText(payload?.paymentId) : resource === "payment" ? resourceId : undefined;
  const amount = payload?.amount;
  const currency = payload?.currencyCode;

  return {
    id: await deriveEventId(body, name, resourceId, payload, eventDate),
    pspName: "paysafe",
    type: mapEventType(name),
    ...(pspPaymentId !== undefined ? { pspPaymentId } : {}),
    ...(typeof amount === "number" && Number.isSafeInteger(amount) ? { amount } : {}),
    ...(typeof currency === "string" && currency !== "" ? { currency: currency.toUpperCase() } : {}),
    ...(resource === "refund" && resourceId !== undefined ? { refundId: resourceId } : {}),
    occurredAt: normalizeTime(asText(body.txnTime) ?? eventDate ?? asText(payload?.txnTime)),
    raw: body,
  };
}

// Never hashes attemptNumber; the derivation is documented on parsePaysafeWebhookEvent.
async function deriveEventId(
  body: JsonObject,
  name: string,
  resourceId: string | undefined,
  payload: JsonObject | undefined,
  eventDate: string | undefined,
): Promise<string> {
  if (resourceId === undefined) return `paysafe_${await sha256Hex(canonicalJson(body))}`;
  const status = scalar(payload?.status) ?? null;
  const time = scalar(payload?.statusTime) ?? scalar(payload?.txnTime) ?? eventDate ?? null;
  return `paysafe_${await sha256Hex(JSON.stringify([name, resourceId, status, time]))}`;
}

type PaysafeResource = "payment" | "return" | "refund" | "other";

/**
 * What the payload describes: the event-name family, else the envelope `type`.
 * A return is recognized from either, so its own id never passes for the
 * payment's.
 */
function resourceOf(category: string, name: string): PaysafeResource {
  if (name.startsWith("PAYMENT_RETURN") || category.startsWith("PAYMENT_RETURN")) return "return";
  const family = name || category;
  if (family.startsWith("PAYMENT_HANDLE")) return "other";
  if (family.startsWith("REFUND")) return "refund";
  // Dispute names are undocumented for the Payments API; they keep reporting payload.id.
  if (family.startsWith("PAYMENT") || family.includes("CHARGEBACK") || family.includes("DISPUTE")) return "payment";
  return "other";
}

function mapEventType(rawType: string): UnifiedWebhookEventType {
  const direct = EVENT_TYPE_MAP[rawType];
  if (direct) return direct;
  // Dispute names vary per product ("CHARGEBACK_*", "DISPUTE_*") — pattern-match
  // the family, then the outcome. Unrecognized outcomes stay "opened".
  if (rawType.includes("CHARGEBACK") || rawType.includes("DISPUTE")) {
    if (rawType.includes("WON")) return "payment.chargeback_won";
    if (rawType.includes("LOST")) return "payment.chargeback_lost";
    return "payment.chargeback";
  }
  return "unknown";
}

/** Key-sorted JSON without `attemptNumber`, so every attempt of one notification hashes alike. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = asObject(value);
  if (!object) return JSON.stringify(value);
  const members = Object.keys(object)
    .filter((key) => key !== "attemptNumber")
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${members.join(",")}}`;
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function scalar(value: unknown): string | number | undefined {
  return typeof value === "number" ? value : asText(value);
}
