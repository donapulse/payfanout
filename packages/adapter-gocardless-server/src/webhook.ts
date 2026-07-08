import { PayFanoutError, type UnifiedWebhookEvent, type UnifiedWebhookEventType } from "@payfanout/core";
import { constantTimeEqual, hmacSha256Hex } from "./crypto-utils.js";

/**
 * GoCardless webhook delivery: one HTTP POST carries `{"events": [...]}` with
 * UP TO 250 EVENTS, signed as a whole — `Webhook-Signature` is the lowercase
 * hex HMAC-SHA256 of the exact raw body, keyed with the endpoint's secret.
 * Verify ONCE over the raw bytes, then fan out per event with
 * parseGoCardlessWebhookEvents. The single-event `parseWebhookEvent` contract
 * method (see adapter.ts) refuses multi-event deliveries so no event is ever
 * dropped silently.
 *
 * WebCrypto (async) so this runs on edge runtimes as well as Node.
 */
const SIGNATURE_HEADER = "webhook-signature";

/** Several endpoint secrets may be active at once (rotation) — any match wins. */
export async function verifyGoCardlessWebhookSignature(
  rawBody: string,
  headers: Record<string, string>,
  secrets: string | string[],
): Promise<boolean> {
  const provided = lowercaseKeys(headers)[SIGNATURE_HEADER];
  if (typeof provided !== "string" || provided.length === 0 || rawBody.length === 0) return false;
  const keys = (Array.isArray(secrets) ? secrets : [secrets]).filter(
    (key): key is string => typeof key === "string" && key.length > 0,
  );
  for (const key of keys) {
    const expected = await hmacSha256Hex(key, rawBody);
    if (constantTimeEqual(provided.trim().toLowerCase(), expected)) return true;
  }
  return false;
}

/** Structural shape of one event inside a GoCardless webhook delivery / events list. */
export interface GoCardlessEventLike {
  id?: string;
  created_at?: string;
  resource_type?: string;
  action?: string;
  links?: Record<string, string | undefined>;
  details?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Parses a full GoCardless delivery into normalized events, order preserved.
 * Verify the signature FIRST (verifyGoCardlessWebhookSignature) — this only
 * parses. Throws PayFanoutError (invalid_request) on unparseable payloads;
 * an empty `events` array parses to an empty result.
 */
export function parseGoCardlessWebhookEvents(rawBody: string): UnifiedWebhookEvent[] {
  let body: { events?: unknown };
  try {
    body = JSON.parse(rawBody) as { events?: unknown };
  } catch (err) {
    throw new PayFanoutError({
      code: "invalid_request",
      message: "Unparseable GoCardless webhook payload",
      retryable: false,
      raw: err,
      pspName: "gocardless",
    });
  }
  if (body === null || typeof body !== "object" || !Array.isArray(body.events)) {
    throw new PayFanoutError({
      code: "invalid_request",
      message: 'GoCardless webhook payload is not an {"events": [...]} delivery',
      retryable: false,
      raw: body,
      pspName: "gocardless",
    });
  }
  return body.events.map((event) => normalizeGoCardlessEvent(event as GoCardlessEventLike));
}

/** Shared normalizer: webhook deliveries and GET /events map identically. */
export function normalizeGoCardlessEvent(event: GoCardlessEventLike): UnifiedWebhookEvent {
  const links = event.links ?? {};
  const refundId = links["refund"];
  return {
    // GoCardless event ids (EV...) are globally unique — THE dedupe key. The
    // fallback hash keeps ids stable across parses if one is ever missing.
    id: event.id ?? `gocardless_${fnv1aHex(JSON.stringify(event))}`,
    pspName: "gocardless",
    type: mapEventType(event.resource_type ?? "", event.action ?? ""),
    pspPaymentId: links["payment"] ?? links["payment_request_payment"],
    // No amount/currency: GoCardless events carry links + details only, never
    // money fields — money truth stays on retrievePayment/retrieveRefund.
    ...(refundId ? { refundId } : {}),
    occurredAt: normalizeTime(event.created_at),
    raw: event,
  };
}

function mapEventType(resourceType: string, action: string): UnifiedWebhookEventType {
  if (resourceType === "payments") {
    switch (action) {
      case "confirmed":
        return "payment.succeeded";
      // late_failure_settled: a confirmed/paid-out payment can flip to failed
      // days later on bank debit rails — consumers must handle succeeded -> failed.
      case "failed":
      case "customer_approval_denied":
      case "late_failure_settled":
        return "payment.failed";
      case "cancelled":
        return "payment.canceled";
      case "created":
      case "submitted":
      case "customer_approval_granted":
      case "resubmission_requested":
        return "payment.processing";
      case "charged_back":
        return "payment.chargeback";
      // The bank withdrew the chargeback — the closest GoCardless has to a
      // merchant win (direct debit chargebacks have no merchant dispute flow).
      case "chargeback_cancelled":
        return "payment.chargeback_won";
      // paid_out / chargeback_settled / surcharge_fee_debited are payout
      // accounting, not payer-state changes.
      default:
        return "unknown";
    }
  }
  if (resourceType === "refunds") {
    switch (action) {
      case "paid":
        return "payment.refunded";
      // funds_returned: the refund never reached the payer and the money came
      // back — the customer was NOT refunded.
      case "failed":
      case "bounced":
      case "funds_returned":
        return "payment.refund_failed";
      // created/refund_settled are non-terminal/accounting — hosts poll
      // retrieveRefund for interim state.
      default:
        return "unknown";
    }
  }
  if (resourceType === "billing_requests") {
    // fulfilled = the payer completed the hosted authorisation and the
    // payment now exists (links.payment_request_payment carries its id) —
    // the earliest "money is underway" signal on this rail. Other billing
    // request actions are session lifecycle, not payer-state changes.
    return action === "fulfilled" ? "payment.processing" : "unknown";
  }
  // mandates / future resources — surfaced, never dropped.
  return "unknown";
}

function normalizeTime(value: string | undefined): string {
  const parsed = value ? Date.parse(value) : Number.NaN;
  // Deterministic fallback: a missing timestamp is the PSP's omission, not ours.
  return Number.isNaN(parsed) ? "1970-01-01T00:00:00.000Z" : new Date(parsed).toISOString();
}

/** FNV-1a in pure JS: deterministic, dependency-free id fallback (not security-sensitive). */
function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) out[key.toLowerCase()] = value;
  return out;
}
