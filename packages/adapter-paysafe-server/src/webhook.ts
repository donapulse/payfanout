import {
  bytesToBase64,
  constantTimeEqual,
  hmacSha256,
  normalizeSecrets,
  normalizeTime,
  PayFanoutError,
  sha256Hex,
  type UnifiedWebhookEvent,
  type UnifiedWebhookEventType,
} from "@payfanout/core";

/**
 * Paysafe webhook signature: base64(HMAC_SHA256(hmacKey, rawJsonBody)) carried
 * in a signature header. Verification MUST hash the exact raw body bytes.
 * Paysafe retries effectively forever until it sees a success response — ack
 * fast, process async (see @payfanout/server's handler contract).
 *
 * WebCrypto (async) so this runs on edge runtimes as well as Node.
 */
const SIGNATURE_HEADER_CANDIDATES = ["signature", "x-signature", "x-paysafe-signature"];

/** Several HMAC keys may be active at once (rotation) — any match wins. */
export async function verifyPaysafeWebhookSignature(
  rawBody: string,
  headers: Record<string, string>,
  hmacKeys: string | string[],
): Promise<boolean> {
  const provided = SIGNATURE_HEADER_CANDIDATES.map((name) => headers[name]).find(
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
 * Event-type mapping. Paysafe event names arrive as e.g. "PAYMENT.COMPLETED" /
 * "PAYMENT_COMPLETED" depending on product — normalized before lookup.
 * Unknown-but-valid types map to "unknown" rather than throwing.
 */
const EVENT_TYPE_MAP: Record<string, UnifiedWebhookEventType> = {
  PAYMENT_COMPLETED: "payment.succeeded",
  PAYMENT_FAILED: "payment.failed",
  PAYMENT_DECLINED: "payment.failed",
  PAYMENT_CANCELLED: "payment.canceled",
  PAYMENT_EXPIRED: "payment.canceled",
  PAYMENT_AUTHENTICATION_REQUIRED: "payment.requires_action",
  // Async/underway states — the terminal event follows later.
  PAYMENT_PROCESSING: "payment.processing",
  PAYMENT_PENDING: "payment.processing",
  PAYMENT_RECEIVED: "payment.processing",
  PAYMENT_HELD: "payment.processing", // risk review — funds not moving yet
  // Bank-debit rails: "Failed payment reported by the bank" AFTER completion —
  // the late-failure flip. Paysafe's own pages spell it both ways (the event
  // tables say RETURNED, every payload example sends eventName
  // PAYMENT_RETURN_COMPLETED); mapping both costs nothing, while missing the
  // wire spelling would downgrade a bank-reported failure to "unknown".
  // SETTLEMENT_* stays unmapped like PAYMENT_HANDLE_PAYABLE: those payloads
  // carry settlement ids, not payment ids.
  PAYMENT_RETURN_COMPLETED: "payment.failed",
  PAYMENT_RETURNED_COMPLETED: "payment.failed",
  REFUND_COMPLETED: "payment.refunded",
  // Async refund that did not go through — funds never returned to the customer.
  REFUND_FAILED: "payment.refund_failed",
  REFUND_DECLINED: "payment.refund_failed",
  REFUND_ERROR: "payment.refund_failed",
};

interface PaysafeWebhookBody {
  id?: string;
  /** Real Payments-API deliveries carry the event here; `eventType`/`event` are legacy/synthetic shapes. */
  eventName?: string;
  eventType?: string;
  event?: string;
  resourceId?: string;
  txnTime?: string;
  eventDate?: string;
  payload?: {
    id?: string;
    status?: string;
    txnTime?: string;
    merchantRefNum?: string;
    /** Integer minor units, as everywhere in the Paysafe API. */
    amount?: number;
    currencyCode?: string;
  };
}

export async function parsePaysafeWebhookEvent(rawBody: string): Promise<UnifiedWebhookEvent> {
  let body: PaysafeWebhookBody;
  try {
    body = JSON.parse(rawBody) as PaysafeWebhookBody;
  } catch (err) {
    throw new PayFanoutError({
      code: "invalid_request",
      message: "Unparseable Paysafe webhook payload",
      retryable: false,
      raw: err,
      pspName: "paysafe",
    });
  }
  if (body === null || typeof body !== "object") {
    throw new PayFanoutError({
      code: "invalid_request",
      message: "Paysafe webhook payload is not a JSON object",
      retryable: false,
      raw: body,
      pspName: "paysafe",
    });
  }

  // Real Paysafe Payments-API deliveries carry the event in `eventName`; older/synthetic
  // payloads used `eventType`/`event`. The top-level `type` is the resource CATEGORY
  // ("PAYMENT"), not the event name, so it is deliberately never consulted here.
  const rawType = (body.eventName ?? body.eventType ?? body.event ?? "").toUpperCase().replace(/[.\s-]/g, "_");
  const type = mapEventType(rawType);
  const amount = body.payload?.amount;
  const currency = body.payload?.currencyCode;
  // On refund events the payload IS the refund object, so its id is the refund id.
  const isRefundEvent = type === "payment.refunded" || type === "payment.refund_failed";

  return {
    // Stable dedupe key even if Paysafe omits an event id: hash of the exact raw bytes.
    id: body.id ?? `paysafe_${await sha256Hex(rawBody)}`,
    pspName: "paysafe",
    type,
    pspPaymentId: body.payload?.id ?? body.resourceId,
    ...(typeof amount === "number" && Number.isSafeInteger(amount) ? { amount } : {}),
    ...(typeof currency === "string" && currency !== "" ? { currency: currency.toUpperCase() } : {}),
    ...(isRefundEvent && body.payload?.id ? { refundId: body.payload.id } : {}),
    occurredAt: normalizeTime(body.txnTime ?? body.eventDate ?? body.payload?.txnTime),
    raw: body,
  };
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
