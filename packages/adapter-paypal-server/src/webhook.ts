import { PayFanoutError, type UnifiedWebhookEvent, type UnifiedWebhookEventType } from "@payfanout/core";
import { sha256Hex } from "./crypto-utils.js";
import { PAYPAL_PSP_NAME } from "./error-map.js";

/**
 * PayPal webhook verification is a postback: the adapter POSTs the delivery
 * headers plus the raw event back to /v1/notifications/verify-webhook-signature
 * and PayPal answers SUCCESS/FAILURE. No local X.509 handling — edge-clean.
 */
export const PAYPAL_WEBHOOK_HEADER_NAMES = [
  "paypal-transmission-id",
  "paypal-transmission-time",
  "paypal-cert-url",
  "paypal-auth-algo",
  "paypal-transmission-sig",
] as const;

/**
 * Builds the verify-webhook-signature request body, or undefined when it
 * cannot be verified at all (missing headers / empty body / no webhook id) —
 * callers must answer `false` without a network call in that case.
 *
 * The raw body is spliced in VERBATIM as the `webhook_event` value: PayPal
 * verifies the exact delivered bytes, and parsing + re-stringifying (different
 * key order / whitespace) makes verification fail. Hence string concatenation
 * instead of JSON.stringify over a parsed object.
 */
export function buildWebhookVerificationBody(
  rawBody: string,
  headers: Record<string, string>,
  webhookId: string | undefined,
): string | undefined {
  if (!webhookId || !rawBody || rawBody.trim().length === 0) return undefined;
  const lower = lowercaseKeys(headers);
  const values: Record<string, string> = {};
  for (const name of PAYPAL_WEBHOOK_HEADER_NAMES) {
    const value = lower[name];
    if (typeof value !== "string" || value.length === 0) return undefined;
    values[name] = value;
  }
  return (
    `{"transmission_id":${JSON.stringify(values["paypal-transmission-id"]!)},` +
    `"transmission_time":${JSON.stringify(values["paypal-transmission-time"]!)},` +
    `"cert_url":${JSON.stringify(values["paypal-cert-url"]!)},` +
    `"auth_algo":${JSON.stringify(values["paypal-auth-algo"]!)},` +
    `"transmission_sig":${JSON.stringify(values["paypal-transmission-sig"]!)},` +
    `"webhook_id":${JSON.stringify(webhookId)},` +
    `"webhook_event":${rawBody}}`
  );
}

interface PayPalLink {
  href?: string;
  rel?: string;
}

export interface PayPalEventBody {
  id?: string;
  event_type?: string;
  create_time?: string;
  resource_type?: string;
  summary?: string;
  resource?: {
    id?: string;
    status?: string;
    create_time?: string;
    links?: PayPalLink[];
    supplementary_data?: { related_ids?: { order_id?: string } };
    disputed_transactions?: Array<{ seller_transaction_id?: string }>;
    dispute_outcome?: { outcome_code?: string };
  };
}

const EVENT_TYPE_MAP: Record<string, UnifiedWebhookEventType> = {
  "PAYMENT.CAPTURE.COMPLETED": "payment.succeeded",
  "PAYMENT.CAPTURE.PENDING": "payment.processing",
  // The docs render this event name both ways — accept either string.
  "PAYMENT.CAPTURE.DENIED": "payment.failed",
  "PAYMENT.CAPTURE.DECLINED": "payment.failed",
  "PAYMENT.CAPTURE.REFUNDED": "payment.refunded",
  // A reversal is PayPal-initiated (dispute outcome): the funds are gone.
  "PAYMENT.CAPTURE.REVERSED": "payment.chargeback_lost",
  // Async refund that did not go through — funds never returned to the buyer.
  "PAYMENT.REFUND.FAILED": "payment.refund_failed",
  "PAYMENT.AUTHORIZATION.VOIDED": "payment.canceled",
  "CHECKOUT.PAYMENT-APPROVAL.REVERSED": "payment.canceled",
  "CUSTOMER.DISPUTE.CREATED": "payment.chargeback",
  "CUSTOMER.DISPUTE.UPDATED": "payment.chargeback",
};

/**
 * Normalizes a PayPal event body — shared by parseWebhookEvent and
 * fetchEvents so delivered and polled events dedupe identically by id.
 */
export async function payPalEventBodyToUnified(
  body: PayPalEventBody,
  rawForFallbackId?: string,
): Promise<UnifiedWebhookEvent> {
  const eventType = (body.event_type ?? "").toUpperCase();
  return {
    // Real PayPal events always carry an id — that is the dedupe key. The
    // hash fallback differs by ingress (delivered raw bytes vs re-serialized
    // polled body), so an id-less event would not dedupe across the two paths.
    id: body.id ?? `paypal_${await sha256Hex(rawForFallbackId ?? JSON.stringify(body))}`,
    pspName: PAYPAL_PSP_NAME,
    type: mapEventType(eventType, body),
    pspPaymentId: extractPspPaymentId(eventType, body.resource),
    occurredAt: normalizeTime(body.create_time ?? body.resource?.create_time),
    raw: body,
  };
}

export async function parsePayPalWebhookEvent(rawBody: string): Promise<UnifiedWebhookEvent> {
  let body: PayPalEventBody;
  try {
    body = JSON.parse(rawBody) as PayPalEventBody;
  } catch (err) {
    throw new PayFanoutError({
      code: "invalid_request",
      message: "Unparseable PayPal webhook payload",
      retryable: false,
      raw: err,
      pspName: PAYPAL_PSP_NAME,
    });
  }
  if (body === null || typeof body !== "object") {
    throw new PayFanoutError({
      code: "invalid_request",
      message: "PayPal webhook payload is not a JSON object",
      retryable: false,
      raw: body,
      pspName: PAYPAL_PSP_NAME,
    });
  }
  return payPalEventBodyToUnified(body, rawBody);
}

function mapEventType(eventType: string, body: PayPalEventBody): UnifiedWebhookEventType {
  const direct = EVENT_TYPE_MAP[eventType];
  if (direct) return direct;
  if (eventType === "CUSTOMER.DISPUTE.RESOLVED") {
    const outcome = (body.resource?.dispute_outcome?.outcome_code ?? "").toUpperCase();
    if (outcome.includes("SELLER_FAVOUR")) return "payment.chargeback_won";
    if (outcome.includes("BUYER_FAVOUR")) return "payment.chargeback_lost";
    // RESOLVED_WITH_PAYOUT / CANCELED_BY_BUYER / … — direction not derivable, never guessed.
    return "unknown";
  }
  // CHECKOUT.ORDER.* and anything unrecognized — surfaced, never dropped silently.
  return "unknown";
}

function extractPspPaymentId(eventType: string, resource: PayPalEventBody["resource"]): string | undefined {
  if (!resource) return undefined;
  if (eventType.startsWith("CUSTOMER.DISPUTE.")) {
    // Dispute payloads carry the CAPTURE id as seller_transaction_id.
    return resource.disputed_transactions?.find((t) => t.seller_transaction_id)?.seller_transaction_id;
  }
  if (
    eventType === "PAYMENT.CAPTURE.REFUNDED" ||
    eventType === "PAYMENT.CAPTURE.REVERSED" ||
    eventType.startsWith("PAYMENT.REFUND.")
  ) {
    // The resource here is refund-shaped: resource.id is the REFUND id — the
    // parent capture (our canonical pspPaymentId) rides the links[rel=up] href.
    return captureIdFromLinks(resource.links) ?? resource.id;
  }
  if (eventType.startsWith("PAYMENT.AUTHORIZATION.")) {
    // Pre-capture the canonical PayFanout id is the ORDER id.
    return resource.supplementary_data?.related_ids?.order_id ?? resource.id;
  }
  // Capture events: resource.id IS the capture id — the canonical post-capture id.
  return resource.id;
}

export function captureIdFromLinks(links: PayPalLink[] | undefined): string | undefined {
  for (const link of links ?? []) {
    if ((link.rel ?? "").toLowerCase() !== "up") continue;
    const match = /\/v2\/payments\/captures\/([^/?#]+)/.exec(link.href ?? "");
    if (match) return match[1];
  }
  return undefined;
}

function normalizeTime(value: string | undefined): string {
  const parsed = value ? Date.parse(value) : Number.NaN;
  // Deterministic fallback: a missing timestamp is the PSP's omission, not ours.
  return Number.isNaN(parsed) ? "1970-01-01T00:00:00.000Z" : new Date(parsed).toISOString();
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) out[key.toLowerCase()] = value;
  return out;
}
