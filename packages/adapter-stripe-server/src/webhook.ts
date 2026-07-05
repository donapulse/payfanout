import { createHmac, timingSafeEqual } from "node:crypto";
import { PayFanoutError, type UnifiedWebhookEvent, type UnifiedWebhookEventType } from "@payfanout/core";

/**
 * Stripe webhook signature scheme: `Stripe-Signature: t=<ts>,v1=<hex>,...`
 * where v1 = HMAC-SHA256(signingSecret, `${t}.${rawBody}`). Verification MUST
 * run over the exact raw body bytes; the timestamp tolerance prevents replay.
 * Several signing secrets may be active at once (rotation) — any match wins.
 */
export function verifyStripeWebhookSignature(
  rawBody: string,
  headers: Record<string, string>,
  signingSecrets: string | string[],
  toleranceSeconds: number,
  nowMs: number,
): boolean {
  const header = headers["stripe-signature"];
  if (!header) return false;

  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = Number(value);
    else if (key === "v1") signatures.push(value);
  }
  if (timestamp === undefined || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - timestamp) > toleranceSeconds) return false;

  const secrets = Array.isArray(signingSecrets) ? signingSecrets : [signingSecrets];
  return secrets.some((secret) => {
    const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
    return signatures.some((candidate) => constantTimeEqualHex(candidate, expected));
  });
}

function constantTimeEqualHex(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    // Re-encoding catches inputs that were not valid hex of the same length.
    if (bufA.length !== bufB.length || bufA.toString("hex") !== a.toLowerCase()) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

const EVENT_TYPE_MAP: Record<string, UnifiedWebhookEventType> = {
  "payment_intent.succeeded": "payment.succeeded",
  "payment_intent.payment_failed": "payment.failed",
  "payment_intent.requires_action": "payment.requires_action",
  // Async rails (SEPA/ACH/…): underway, terminal event follows days later.
  "payment_intent.processing": "payment.processing",
  "payment_intent.canceled": "payment.canceled",
  "charge.refunded": "payment.refunded",
  "charge.dispute.created": "payment.chargeback",
};

/**
 * Refund-object events carry the refund's own status — an async refund that
 * later FAILS arrives as charge.refund.updated / refund.updated with
 * status "failed", and must NOT surface as payment.refunded (the money never
 * moved back). Anything non-terminal maps to "unknown": the raw event is
 * preserved and the terminal event follows later.
 */
const REFUND_OBJECT_EVENTS = new Set([
  "charge.refund.updated",
  "refund.created",
  "refund.updated",
  "refund.failed",
]);

interface StripeEventBody {
  id?: string;
  type?: string;
  created?: number;
  data?: {
    object?: {
      object?: string;
      id?: string;
      status?: string;
      payment_intent?: string | { id?: string };
    };
  };
}

/** Shared by webhook ingress and fetchEvents (the Events API returns identical shapes). */
export function stripeEventBodyToUnified(body: StripeEventBody): UnifiedWebhookEvent {
  if (typeof body?.id !== "string" || typeof body?.type !== "string") {
    throw new PayFanoutError({
      code: "invalid_request",
      message: "Stripe webhook payload is missing id/type",
      retryable: false,
      raw: body,
      pspName: "stripe",
    });
  }

  const object = body.data?.object;
  let pspPaymentId: string | undefined;
  if (object?.object === "payment_intent" && typeof object.id === "string") {
    pspPaymentId = object.id;
  } else if (typeof object?.payment_intent === "string") {
    pspPaymentId = object.payment_intent;
  } else if (object?.payment_intent && typeof object.payment_intent === "object") {
    pspPaymentId = object.payment_intent.id;
  }

  return {
    id: body.id, // Stripe event ids are globally unique — the stable dedupe key
    pspName: "stripe",
    type: mapEventType(body),
    pspPaymentId,
    occurredAt: new Date((body.created ?? 0) * 1000).toISOString(),
    raw: body,
  };
}

function mapEventType(body: StripeEventBody): UnifiedWebhookEventType {
  const type = body.type ?? "";
  if (REFUND_OBJECT_EVENTS.has(type)) {
    switch (body.data?.object?.status) {
      case "succeeded":
        return "payment.refunded";
      case "failed":
      case "canceled":
        return "payment.refund_failed";
      default:
        return "unknown"; // pending / requires_action — not a terminal refund fact yet
    }
  }
  if (type === "charge.dispute.closed") {
    switch (body.data?.object?.status) {
      case "won":
      case "warning_closed": // inquiry closed without ever becoming a chargeback
        return "payment.chargeback_won";
      case "lost":
        return "payment.chargeback_lost";
      default:
        return "unknown"; // still-open states arrive via charge.dispute.updated
    }
  }
  // Genuinely unknown-but-valid event types map to "unknown" rather than throwing.
  return EVENT_TYPE_MAP[type] ?? "unknown";
}

export function parseStripeWebhookEvent(rawBody: string): UnifiedWebhookEvent {
  let body: StripeEventBody;
  try {
    body = JSON.parse(rawBody) as StripeEventBody;
  } catch (err) {
    throw new PayFanoutError({
      code: "invalid_request",
      message: "Unparseable Stripe webhook payload",
      retryable: false,
      raw: err,
      pspName: "stripe",
    });
  }
  return stripeEventBodyToUnified(body);
}
