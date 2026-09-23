import {
  bytesToBase64,
  constantTimeEqual,
  hmacSha256,
  lowercaseKeys,
  normalizeTime,
  PayFanoutError,
  sha256Hex,
  type UnifiedWebhookEvent,
  type UnifiedWebhookEventType,
} from "@payfanout/core";

/**
 * Worldline Direct webhook verification: `X-GCS-Signature` carries
 * base64(HMAC-SHA256(webhookSecret, rawBody)), and `X-GCS-KeyId` names which
 * webhook key produced it. Verification MUST hash the exact raw body bytes.
 *
 * Several keys may be active at once (rotation): the key matching `X-GCS-KeyId`
 * is tried first, then the rest — any active key verifying wins, so a rotation
 * needs no cutover.
 *
 * WebCrypto (async) so this runs on edge runtimes as well as Node.
 */
export interface WorldlineWebhookKey {
  keyId: string;
  secretKey: string;
}

const SIGNATURE_HEADER = "x-gcs-signature";
const KEY_ID_HEADER = "x-gcs-keyid";

export async function verifyWorldlineWebhookSignature(
  rawBody: string,
  headers: Record<string, string>,
  keys: WorldlineWebhookKey[],
): Promise<boolean> {
  const lower = lowercaseKeys(headers);
  const provided = lower[SIGNATURE_HEADER];
  if (typeof provided !== "string" || provided.length === 0) return false;
  const keyId = lower[KEY_ID_HEADER];
  // Prefer the key named by X-GCS-KeyId, then fall back to the rest so a
  // rotated-in key still verifies before its X-GCS-KeyId is known everywhere.
  const ordered = keyId ? [...keys].sort((a, b) => Number(b.keyId === keyId) - Number(a.keyId === keyId)) : keys;
  for (const key of ordered) {
    if (!key.secretKey) continue;
    const expected = bytesToBase64(await hmacSha256(key.secretKey, rawBody));
    if (constantTimeEqual(provided.trim(), expected)) return true;
  }
  return false;
}

/**
 * Worldline event-type strings map onto the unified vocabulary. Only genuinely
 * terminal captures/refunds become success/refund outcomes; every non-terminal
 * payment state is `payment.processing`, and recognized-but-non-terminal refund
 * requests are deliberately NOT forced into a terminal refund type (see below).
 */
const EVENT_TYPE_MAP: Record<string, UnifiedWebhookEventType> = {
  "payment.captured": "payment.succeeded",
  "payment.refunded": "payment.refunded",
  "payment.rejected": "payment.failed",
  "payment.rejected_capture": "payment.failed",
  "payment.cancelled": "payment.canceled",
  "payment.redirected": "payment.requires_action",
  // Underway payment states — the terminal event follows later.
  "payment.created": "payment.processing",
  "payment.authorization_requested": "payment.processing",
  "payment.capture_requested": "payment.processing",
  "payment.pending_capture": "payment.processing",
  "payment.pending_approval": "payment.processing",
  "payment.pending_completion": "payment.processing",
  // Everything below is NOT on the documented webhook event list (which ends at
  // payment.refunded / refund.refund_requested) — tolerated here in case a
  // contract variant delivers them, but hosts must not subscribe to or rely on
  // them (the onboarding descriptor lists only the documented set).
  "payment.paid": "payment.succeeded",
  "payment.pending_fraud_approval": "payment.processing",
  "refund.refunded": "payment.refunded",
  "refund.rejected": "payment.refund_failed",
  "refund.cancelled": "payment.refund_failed",
  // refund.refund_requested is intentionally absent — see mapEventType.
};

interface WorldlineMoney {
  amount?: number;
  currencyCode?: string;
}

interface WorldlineWebhookResource {
  id?: string;
  paymentOutput?: { amountOfMoney?: WorldlineMoney };
  refundOutput?: { amountOfMoney?: WorldlineMoney };
}

interface WorldlineWebhookBody {
  id?: string;
  created?: string;
  type?: string;
  payment?: WorldlineWebhookResource;
  refund?: WorldlineWebhookResource;
}

const TEST_EVENT_TYPE = "payment.test";

/**
 * Worldline documents only `payment.id` and `type` as identical across
 * duplicate deliveries. Any other field, the envelope `id` or `operationOutput`
 * included, may differ on a redelivery, so putting it in the key could let a
 * duplicate past a host's dedupe store; the Adyen adapter keys on its
 * documented pair alone for the same reason. The price is stated on the same
 * page: "The payment.id can change after each maintenance operation following
 * an incremental logic. However, as this is not the case in some specific
 * scenarios, we strongly recommend not building your business operations
 * around it." Two events of one type on one payment.id therefore share an id,
 * which is why hosts re-read refunds on every refund-type delivery, whether or
 * not its id was already seen. A refund resource stands in for a missing
 * payment; half a pair falls back to the envelope id rather than merging
 * distinct events. The envelope id also keys payment-link events (the link
 * resource has no `id`, and its `paymentLinkId` repeats across a reusable
 * link's payments) and test messages, which all carry the documented
 * payment.id "9999_9".
 */
async function deriveEventId(body: WorldlineWebhookBody, rawType: string, rawBody: string): Promise<string> {
  if (rawType !== "" && rawType !== TEST_EVENT_TYPE) {
    const resourceId = nonEmptyString(body.payment?.id) ?? nonEmptyString(body.refund?.id);
    if (resourceId !== undefined) return `worldline:${rawType}:${resourceId}`;
  }
  const envelopeId = nonEmptyString(body.id);
  if (envelopeId !== undefined) return envelopeId;
  // Nothing to key on: hash the exact raw bytes, stable across parses.
  return `worldline_${await sha256Hex(rawBody)}`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * One event per delivery, but the envelope is ambiguous in the official
 * material: the webhooks page's example body is an ARRAY while the platform's
 * own webhooks helper JSON-parses a single object. Both single-event shapes are
 * accepted (a one-element array is unwrapped); a multi-event array is rejected
 * (invalid_request) rather than partially processed — silently dropping
 * trailing events is never acceptable.
 *
 * Event id: `worldline:<type>:<payment.id>` (or `refund.id` without a payment),
 * the pair Worldline documents as identical across duplicates: two events of
 * one type on one payment id share an id. `payment.test`, payment-link events
 * and deliveries without the pair keep the envelope `id`, else a body hash.
 */
export async function parseWorldlineWebhookEvent(rawBody: string): Promise<UnifiedWebhookEvent> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    throw new PayFanoutError({
      code: "invalid_request",
      message: "Unparseable Worldline webhook payload",
      retryable: false,
      raw: err,
      pspName: "worldline",
    });
  }
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) {
      throw new PayFanoutError({
        code: "invalid_request",
        message: "Worldline webhook payload is a batched array — Worldline delivers one event per request",
        retryable: false,
        raw: parsed,
        pspName: "worldline",
      });
    }
    parsed = parsed[0];
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new PayFanoutError({
      code: "invalid_request",
      message: "Worldline webhook payload is not a JSON object",
      retryable: false,
      raw: parsed,
      pspName: "worldline",
    });
  }

  const body = parsed as WorldlineWebhookBody;
  const rawType = (body.type ?? "").toLowerCase();
  const type = mapEventType(rawType);
  const resource = body.payment ?? body.refund;
  const money = resource?.paymentOutput?.amountOfMoney ?? resource?.refundOutput?.amountOfMoney;
  const amount = money?.amount;
  const currency = money?.currencyCode;
  const isRefundResource = body.refund !== undefined || rawType.startsWith("refund.");

  return {
    id: await deriveEventId(body, rawType, rawBody),
    pspName: "worldline",
    ...(resource?.id ? { pspPaymentId: resource.id } : {}),
    type,
    ...(typeof amount === "number" && Number.isSafeInteger(amount) ? { amount } : {}),
    ...(typeof currency === "string" && currency !== "" ? { currency: currency.toUpperCase() } : {}),
    ...(isRefundResource && body.refund?.id ? { refundId: body.refund.id } : {}),
    occurredAt: normalizeTime(body.created),
    raw: body,
  };
}

function mapEventType(rawType: string): UnifiedWebhookEventType {
  const direct = EVENT_TYPE_MAP[rawType];
  if (direct) return direct;
  // Disputes surface as chargeback.* on Worldline.
  if (rawType.startsWith("dispute.") || rawType.includes("chargeback")) {
    if (rawType.includes("won")) return "payment.chargeback_won";
    if (rawType.includes("lost")) return "payment.chargeback_lost";
    return "payment.chargeback";
  }
  // refund.refund_requested is recognized but NON-terminal: the unified
  // vocabulary has no in-flight refund state, and emitting payment.refunded
  // (funds returned) or payment.refund_failed here would fabricate a terminal
  // outcome that has not happened. It maps to "unknown"; the terminal result
  // arrives as refund.refunded/refund.rejected or is polled via retrieveRefund.
  return "unknown";
}
