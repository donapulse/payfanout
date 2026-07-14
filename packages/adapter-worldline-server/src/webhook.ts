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
  "payment.paid": "payment.succeeded",
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
  "payment.pending_fraud_approval": "payment.processing",
  // Terminal refund outcomes, when Worldline emits a discrete refund result.
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

/**
 * One event per delivery. A batched/array payload is rejected (invalid_request)
 * rather than partially processed — Worldline does not batch its webhooks, so an
 * array is a sign of a mis-wired ingress, and silently dropping trailing events
 * is never acceptable.
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
    throw new PayFanoutError({
      code: "invalid_request",
      message: "Worldline webhook payload is a batched array — Worldline delivers one event per request",
      retryable: false,
      raw: parsed,
      pspName: "worldline",
    });
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
    // Stable dedupe key even if Worldline omits an event id: hash of the exact raw bytes.
    id: body.id ?? `worldline_${await sha256Hex(rawBody)}`,
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
