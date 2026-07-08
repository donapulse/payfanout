import {
  constantTimeEqual,
  hmacSha256Hex,
  lowercaseKeys,
  normalizeTime,
  PayFanoutError,
  sha256Hex,
  type UnifiedWebhookEvent,
  type UnifiedWebhookEventType,
} from "@payfanout/core";

/**
 * PayZen notifications (IPN) and browser returns both deliver the same five
 * `kr-*` fields, POSTed as `application/x-www-form-urlencoded`. The signature
 * (`kr-hash`) is a lowercase-hex HMAC-SHA-256 computed over the **raw
 * `kr-answer` JSON string** — NOT over the whole delivery envelope. The
 * signing key family is announced by `kr-hash-key`:
 *
 *   - `"password"`     → the shop's REST API password (IPN deliveries)
 *   - `"sha256_hmac"`  → the shop's HMAC-SHA-256 return key (browser returns)
 *
 * This adapter's rawBody contract is therefore the kr-answer string itself,
 * with the kr-hash fields supplied via headers. For convenience the full
 * urlencoded IPN body is ALSO accepted: when rawBody is a form containing a
 * `kr-answer` field, the kr-answer and hash fields are extracted from it
 * (URLSearchParams decodes exactly what PayZen encoded, byte-faithfully).
 */
interface KrFields {
  krAnswer?: string;
  hash?: string;
  algorithm?: string;
  hashKey?: string;
}

export function resolveKrFields(rawBody: string, headers: Record<string, string>): KrFields {
  const h = lowercaseKeys(headers);
  const fields: KrFields = {
    hash: h["kr-hash"],
    algorithm: h["kr-hash-algorithm"],
    hashKey: h["kr-hash-key"],
  };
  // A kr-answer JSON string always starts with "{"; a urlencoded IPN body
  // never does — the leading-brace check keeps metadata that happens to
  // contain "kr-answer=" from triggering the form path.
  if (!rawBody.trimStart().startsWith("{") && /(?:^|&)kr-answer=/.test(rawBody)) {
    const params = new URLSearchParams(rawBody);
    fields.krAnswer = params.get("kr-answer") ?? undefined;
    fields.hash ??= params.get("kr-hash") ?? undefined;
    fields.algorithm ??= params.get("kr-hash-algorithm") ?? undefined;
    fields.hashKey ??= params.get("kr-hash-key") ?? undefined;
  } else if (rawBody.length > 0) {
    fields.krAnswer = rawBody;
  }
  return fields;
}

export interface PayZenWebhookKeys {
  /** REST API password(s) — validate `kr-hash-key: "password"` (IPN). */
  passwords: string[];
  /** HMAC-SHA-256 return key(s) — validate `kr-hash-key: "sha256_hmac"` (browser). */
  hmacKeys: string[];
}

/**
 * Hashes the exact kr-answer string as received — never parse + re-serialize
 * first (the conformance suite proves this breaks). Several keys may be active
 * at once per family (rotation) — any match wins. Unknown `kr-hash-key`
 * families (the legacy "sd" included) and non-sha256_hmac algorithms fail
 * verification rather than guessing.
 */
export async function verifyPayZenWebhookSignature(
  rawBody: string,
  headers: Record<string, string>,
  keys: PayZenWebhookKeys,
): Promise<boolean> {
  const { krAnswer, hash, algorithm, hashKey } = resolveKrFields(rawBody, headers);
  if (!krAnswer || !hash) return false;
  if (algorithm !== "sha256_hmac") return false;
  const candidates =
    hashKey === "password" ? keys.passwords : hashKey === "sha256_hmac" ? keys.hmacKeys : [];
  for (const key of candidates) {
    const expected = await hmacSha256Hex(key, krAnswer);
    if (constantTimeEqual(hash.trim().toLowerCase(), expected)) return true;
  }
  return false;
}

/** Structural subset of the kr-answer `V4/Payment` object. */
export interface PayZenKrAnswerTransactionLike {
  uuid?: string;
  amount?: number;
  currency?: string;
  operationType?: string;
  detailedStatus?: string;
  status?: string;
  creationDate?: string;
  errorCode?: string | null;
  detailedErrorCode?: string | null;
  transactionDetails?: { parentTransactionUuid?: string | null };
}

export interface PayZenKrAnswerLike {
  shopId?: string;
  orderStatus?: string;
  orderCycle?: string;
  serverDate?: string;
  orderDetails?: { orderId?: string | null; metadata?: Record<string, string> | null };
  transactions?: PayZenKrAnswerTransactionLike[];
}

const SUCCEEDED_STATUSES = new Set(["AUTHORISED", "CAPTURED", "ACCEPTED", "PRE_AUTHORISED"]);
const FAILED_STATUSES = new Set(["REFUSED", "ERROR", "CAPTURE_FAILED"]);
const CANCELED_STATUSES = new Set(["CANCELLED", "EXPIRED"]);
const PROCESSING_STATUSES = new Set([
  "WAITING_AUTHORISATION",
  "WAITING_FOR_PAYMENT",
  "UNDER_VERIFICATION",
]);

/**
 * PayZen IPNs carry a state snapshot of the order, not an event type — the
 * normalized type derives from the newest transaction. Chargebacks never
 * arrive here (Back-Office reports only), so payment.chargeback* is
 * unreachable for this adapter — documented limitation.
 */
export async function parsePayZenWebhookEvent(
  rawBody: string,
  headers: Record<string, string>,
): Promise<UnifiedWebhookEvent> {
  const { krAnswer } = resolveKrFields(rawBody, headers);
  let body: PayZenKrAnswerLike;
  try {
    body = JSON.parse(krAnswer ?? "") as PayZenKrAnswerLike;
  } catch (err) {
    throw new PayFanoutError({
      code: "invalid_request",
      message: "Unparseable PayZen notification payload",
      retryable: false,
      raw: err,
      pspName: "payzen",
    });
  }
  if (body === null || typeof body !== "object") {
    throw new PayFanoutError({
      code: "invalid_request",
      message: "PayZen kr-answer is not a JSON object",
      retryable: false,
      raw: body,
      pspName: "payzen",
    });
  }

  const tx = latestTransaction(body.transactions);
  return {
    // No event id exists and kr-hash regenerates on every redelivery. The
    // stable dedupe key is uuid + detailedStatus: a redelivery of the SAME
    // state dedupes, while a redelivery carrying a CHANGED detailedStatus
    // (PayZen updates it between retries) must surface as a new fact.
    id: tx?.uuid ? `${tx.uuid}:${tx.detailedStatus ?? "UNKNOWN"}` : `payzen_${await sha256Hex(krAnswer!)}`,
    pspName: "payzen",
    type: mapEventType(tx),
    ...(pspPaymentIdOf(tx) !== undefined ? { pspPaymentId: pspPaymentIdOf(tx) } : {}),
    // Money facts ride the notified transaction: on a CREDIT the amount is the
    // refunded amount and the credit's own uuid is the refund id.
    ...(typeof tx?.amount === "number" ? { amount: tx.amount } : {}),
    ...(tx?.currency ? { currency: tx.currency.toUpperCase() } : {}),
    ...(tx?.operationType === "CREDIT" && tx.uuid ? { refundId: tx.uuid } : {}),
    occurredAt: normalizeTime(body.serverDate ?? tx?.creationDate),
    raw: body,
  };
}

/** Snapshots list every attempt on the order — the newest one is the fact being notified. */
function latestTransaction(
  transactions: PayZenKrAnswerTransactionLike[] | undefined,
): PayZenKrAnswerTransactionLike | undefined {
  if (!transactions?.length) return undefined;
  return [...transactions].sort(
    (a, b) => (Date.parse(a.creationDate ?? "") || 0) - (Date.parse(b.creationDate ?? "") || 0),
  )[transactions.length - 1];
}

/** A CREDIT transaction's pspPaymentId is its parent payment, when reported. */
function pspPaymentIdOf(tx: PayZenKrAnswerTransactionLike | undefined): string | undefined {
  if (!tx?.uuid) return undefined;
  if (tx.operationType === "CREDIT") return tx.transactionDetails?.parentTransactionUuid ?? tx.uuid;
  return tx.uuid;
}

function mapEventType(tx: PayZenKrAnswerTransactionLike | undefined): UnifiedWebhookEventType {
  if (!tx) return "unknown";
  const status = (tx.detailedStatus ?? "").toUpperCase();
  if (tx.operationType === "CREDIT") {
    // Refund IPNs map by the credit's OWN status — a failed credit means the
    // funds never returned, so payment.refunded would be a lie.
    if (SUCCEEDED_STATUSES.has(status)) return "payment.refunded";
    if (FAILED_STATUSES.has(status) || CANCELED_STATUSES.has(status)) return "payment.refund_failed";
    return "unknown"; // REFUND_TO_RETRY / in-flight credits — not terminal either way
  }
  if (tx.operationType && tx.operationType !== "DEBIT") return "unknown"; // VERIFICATION etc.
  if (SUCCEEDED_STATUSES.has(status)) return "payment.succeeded";
  if (FAILED_STATUSES.has(status)) return "payment.failed";
  if (CANCELED_STATUSES.has(status)) return "payment.canceled";
  if (PROCESSING_STATUSES.has(status)) return "payment.processing";
  // AUTHORISED_TO_VALIDATE etc.: awaiting a MERCHANT action, not a customer
  // one — payment.requires_action would misdirect hosts, so stay honest.
  return "unknown";
}
