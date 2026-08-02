import {
  bytesToBase64,
  constantTimeEqual,
  hmacSha256,
  PayFanoutError,
  type AdapterCapabilities,
  type CreatePaymentSessionInput,
  type MinorUnitAmount,
  type PaymentInfo,
  type PaymentSession,
  type RefundRequest,
  type RefundResult,
  type ServerPaymentAdapter,
  type UnifiedPaymentStatus,
  type UnifiedWebhookEvent,
} from "@payfanout/core";
import { runServerAdapterConformanceTests } from "../src/index.js";

const HMAC_KEY = "field-value-conformance-key";
const ENDPOINT_TOKEN_HEADER = "x-endpoint-token";
const ENDPOINT_TOKEN = "field-value-endpoint-token";

interface SignedEventLike {
  eventType?: string;
  eventReference?: string;
  merchantReference?: string;
  merchantAccount?: string;
  amount?: { currency?: string; value?: number };
  outcome?: string;
  eventDate?: string;
  /** The signature rides INSIDE the payload — there is no signature header to strip. */
  additionalData?: { hmacSignature?: string };
}

/** The seven values the provider signs, colon-joined. The bytes around them are not covered. */
async function fieldValueSignature(event: SignedEventLike): Promise<string> {
  const joined = [
    event.eventType,
    event.eventReference,
    event.merchantReference,
    event.merchantAccount,
    event.amount?.value,
    event.amount?.currency,
    event.outcome,
  ]
    .map((value) => String(value ?? ""))
    .join(":");
  return bytesToBase64(await hmacSha256(HMAC_KEY, joined));
}

async function deliver(event: SignedEventLike): Promise<string> {
  return JSON.stringify({ ...event, additionalData: { hmacSignature: await fieldValueSignature(event) } });
}

interface StoredPayment {
  id: string;
  amount: MinorUnitAmount;
  currency: string;
}

/**
 * A provider whose webhook signature covers EXTRACTED FIELD VALUES rather than
 * the delivered bytes: re-encoding the body leaves it verifying, and every
 * field outside the signed set arrives unauthenticated. Every shipped adapter
 * signs raw bytes, so without this fake the field-value half of the contract
 * would ship unproven — including the obligation such an adapter carries, to
 * authenticate the delivery channel by another means.
 */
class FieldValueSignatureAdapter implements ServerPaymentAdapter {
  readonly pspName = "field-value-signature";
  private readonly payments = new Map<string, StoredPayment>();
  private sequence = 0;

  getCapabilities(): AdapterCapabilities {
    return {
      pspName: this.pspName,
      supportsPaymentRetrieval: false,
      supportsRefunds: true,
      supportsPartialRefunds: false,
      supportsRefundRetrieval: false,
      supportsManualCapture: false,
      supportsMultiCapture: false,
      modificationOutcome: "synchronous",
      supportsPaymentMethodVerification: false,
      supportsSavedPaymentMethods: false,
      supportsSessionUpdate: false,
      supportsEventPolling: false,
      supportsListing: false,
      nativeSubscriptions: { list: false, retrieve: false, create: false, cancel: false },
      webhookSignatureScope: "field-values",
      requiresServerCompletion: false,
      paymentMethods: [{ type: "card", flow: "embedded", supported: true }],
    };
  }

  async createPaymentSession(input: CreatePaymentSessionInput): Promise<PaymentSession> {
    const pspSessionId = this.nextId("pay");
    const currency = input.currency.toUpperCase();
    const id = input.id ?? pspSessionId;
    this.payments.set(pspSessionId, { id, amount: input.amount, currency });
    return {
      id,
      pspName: this.pspName,
      pspSessionId,
      amount: input.amount,
      currency,
      status: "requires_payment_method",
    };
  }

  async cancelPayment(pspPaymentId: string, _idempotencyKey: string): Promise<PaymentInfo> {
    return this.snapshot(pspPaymentId, "canceled");
  }

  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    const payment = this.require(req.pspPaymentId);
    return {
      refundId: this.nextId("rfnd"),
      status: "succeeded",
      amount: req.amount ?? payment.amount,
      raw: { status: "refunded" },
    };
  }

  /**
   * Two independent checks. The endpoint credential authenticates the CHANNEL —
   * nothing else vouches for the fields the signature leaves out — and the HMAC
   * then authenticates the signed values.
   */
  async verifyWebhookSignature(rawBody: string, headers: Record<string, string>): Promise<boolean> {
    const token = headers[ENDPOINT_TOKEN_HEADER];
    if (!token || !constantTimeEqual(token, ENDPOINT_TOKEN)) return false;
    let event: SignedEventLike;
    try {
      event = JSON.parse(rawBody) as SignedEventLike;
    } catch {
      return false;
    }
    const provided = event?.additionalData?.hmacSignature;
    if (!provided) return false;
    return constantTimeEqual(provided, await fieldValueSignature(event));
  }

  async parseWebhookEvent(rawBody: string): Promise<UnifiedWebhookEvent> {
    let body: SignedEventLike;
    try {
      body = JSON.parse(rawBody) as SignedEventLike;
    } catch (err) {
      throw PayFanoutError.invalidRequest("field-value webhook payload is not JSON", err);
    }
    if (!body?.eventReference || !body.eventType) {
      throw PayFanoutError.invalidRequest("field-value webhook payload has no reference/type", body);
    }
    const succeeded = body.eventType === "payment_authorized" && body.outcome === "true";
    return {
      id: body.eventReference,
      pspName: this.pspName,
      type: succeeded ? "payment.succeeded" : "unknown",
      ...(body.merchantReference ? { pspPaymentId: body.merchantReference } : {}),
      ...(body.amount?.value !== undefined ? { amount: body.amount.value } : {}),
      ...(body.amount?.currency ? { currency: body.amount.currency } : {}),
      occurredAt: body.eventDate ?? "2026-08-01T00:00:00.000Z",
      raw: body,
    };
  }

  private snapshot(pspPaymentId: string, status: UnifiedPaymentStatus): PaymentInfo {
    const payment = this.require(pspPaymentId);
    return {
      id: payment.id,
      pspName: this.pspName,
      pspPaymentId,
      status,
      amount: payment.amount,
      amountRefunded: 0,
      currency: payment.currency,
      paymentMethodType: "card",
      createdAt: "2026-08-01T00:00:00.000Z",
      raw: { status },
    };
  }

  private require(pspPaymentId: string): StoredPayment {
    const payment = this.payments.get(pspPaymentId);
    if (!payment) {
      throw PayFanoutError.invalidRequest(`unknown payment "${pspPaymentId}"`, { status: "not_found" });
    }
    return payment;
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }
}

// The first digit of the delivered body sits in a SIGNED value, so the suite's
// blanket tamper case moves something the signature actually covers.
const validRawBody = await deliver({
  eventType: "payment_authorized",
  eventReference: "evt_fv_1",
  merchantReference: "pay_1",
  merchantAccount: "conformance",
  amount: { currency: "EUR", value: 1099 },
  outcome: "true",
  eventDate: "2026-08-01T09:00:00.000Z",
});
// The same delivery with the signed amount moved and the delivered signature
// left exactly as sent — what an attacker who can rewrite the body but not the
// HMAC produces, and what the signed value set exists to reject.
const tamperedSignedValueBody = JSON.stringify({
  ...(JSON.parse(validRawBody) as SignedEventLike),
  amount: { currency: "EUR", value: 9900 },
});
const unknownRawBody = await deliver({
  eventType: "payment_reconciled",
  eventReference: "evt_fv_2",
  merchantReference: "pay_2",
  merchantAccount: "conformance",
  amount: { currency: "EUR", value: 1099 },
  outcome: "true",
  eventDate: "2026-08-01T09:05:00.000Z",
});
const validHeaders = { [ENDPOINT_TOKEN_HEADER]: ENDPOINT_TOKEN };

async function reference(
  adapter: ServerPaymentAdapter,
  amount: MinorUnitAmount,
  id?: string,
): Promise<string> {
  const session = await adapter.createPaymentSession({
    amount,
    currency: "EUR",
    ...(id ? { id } : {}),
    idempotencyKey: `k-${Math.random()}`,
  });
  return session.pspSessionId;
}

runServerAdapterConformanceTests("field-value-signature", () => new FieldValueSignatureAdapter(), {
  createSessionInput: () => ({ amount: 1099, currency: "EUR", idempotencyKey: `k-${Math.random()}` }),
  zeroDecimalSessionInput: () => ({ amount: 500, currency: "JPY", idempotencyKey: `k-${Math.random()}` }),
  threeDecimalSessionInput: () => ({ amount: 1230, currency: "BHD", idempotencyKey: `k-${Math.random()}` }),
  webhook: {
    validRawBody,
    validHeaders,
    expectedType: "payment.succeeded",
    expectedEventId: "evt_fv_1",
    expectedAmount: 1099,
    unknownEvent: { rawBody: unknownRawBody, headers: validHeaders },
    tamperedSignedValueBody,
  },
  money: {
    completedPayment: (adapter, input) => reference(adapter, input.amount, input.id),
    cancelablePayment: (adapter) => reference(adapter, 1099),
  },
  failingCalls: [
    {
      name: "cancelPayment on an unknown payment",
      invoke: (adapter) => adapter.cancelPayment("pay_missing", "conformance-field-value-cancel-missing"),
      expectedCode: "invalid_request",
    },
    {
      name: "refundPayment on an unknown payment",
      invoke: (adapter) =>
        adapter.refundPayment({
          pspPaymentId: "pay_missing",
          idempotencyKey: "conformance-field-value-refund-missing",
        }),
      expectedCode: "invalid_request",
    },
  ],
});
