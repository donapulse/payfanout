import {
  constantTimeEqual,
  hmacSha256Hex,
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

const HMAC_KEY = "push-only-conformance-key";
const SIGNATURE_HEADER = "x-push-only-signature";

interface StoredPayment {
  id: string;
  amount: MinorUnitAmount;
  currency: string;
}

/**
 * A provider that takes its payment reference as a WRITE TARGET ONLY: no read
 * for a payment, none for a refund, and every modification answered with a bare
 * acknowledgement whose real outcome arrives by webhook. Every shipped adapter
 * can read its PSP back, so without this fake the push-only half of the
 * contract would ship unproven.
 */
class PushOnlyAdapter implements ServerPaymentAdapter {
  readonly pspName = "push-only";
  private readonly payments = new Map<string, StoredPayment>();
  private sequence = 0;

  getCapabilities(): AdapterCapabilities {
    return {
      pspName: this.pspName,
      supportsPaymentRetrieval: false,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      supportsRefundRetrieval: false,
      supportsManualCapture: true,
      supportsMultiCapture: false,
      modificationOutcome: "asynchronous",
      supportsPaymentMethodVerification: false,
      supportsSavedPaymentMethods: false,
      supportsSessionUpdate: false,
      supportsEventPolling: false,
      supportsListing: false,
      nativeSubscriptions: { list: false, retrieve: false, create: false, cancel: false },
      webhookSignatureScope: "raw-bytes", // HMAC over the delivered body
      requiresServerCompletion: false,
      paymentMethods: [{ type: "card", flow: "embedded", supported: true }],
    };
  }

  async createPaymentSession(input: CreatePaymentSessionInput): Promise<PaymentSession> {
    const pspSessionId = this.nextId("ref");
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

  async capturePayment(
    pspPaymentId: string,
    _amount: MinorUnitAmount | undefined,
    _idempotencyKey: string,
  ): Promise<PaymentInfo> {
    // The settled amount stays unknown until the webhook lands, so no
    // amountCaptured is reported rather than one being invented.
    return this.acknowledge(pspPaymentId, "processing");
  }

  async cancelPayment(pspPaymentId: string, _idempotencyKey: string): Promise<PaymentInfo> {
    return this.acknowledge(pspPaymentId, "processing");
  }

  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    const payment = this.require(req.pspPaymentId);
    return {
      refundId: this.nextId("rfnd"),
      status: "pending",
      amount: req.amount ?? payment.amount,
      raw: { status: "received" },
    };
  }

  async verifyWebhookSignature(rawBody: string, headers: Record<string, string>): Promise<boolean> {
    const provided = headers[SIGNATURE_HEADER];
    if (!provided) return false;
    return constantTimeEqual(provided, await hmacSha256Hex(HMAC_KEY, rawBody));
  }

  async parseWebhookEvent(rawBody: string): Promise<UnifiedWebhookEvent> {
    let body: { id?: string; type?: string; reference?: string; amount?: number; occurredAt?: string };
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch (err) {
      throw PayFanoutError.invalidRequest("push-only webhook payload is not JSON", err);
    }
    if (!body.id || !body.type) {
      throw PayFanoutError.invalidRequest("push-only webhook payload has no id/type", body);
    }
    return {
      id: body.id,
      pspName: this.pspName,
      type: body.type === "payment_settled" ? "payment.succeeded" : "unknown",
      ...(body.reference ? { pspPaymentId: body.reference } : {}),
      ...(body.amount !== undefined ? { amount: body.amount } : {}),
      occurredAt: body.occurredAt ?? "2026-08-01T00:00:00.000Z",
      raw: body,
    };
  }

  private acknowledge(pspPaymentId: string, status: UnifiedPaymentStatus): PaymentInfo {
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
      raw: { status: "received" },
    };
  }

  private require(pspPaymentId: string): StoredPayment {
    const payment = this.payments.get(pspPaymentId);
    if (!payment) {
      throw PayFanoutError.invalidRequest(`unknown push-only reference "${pspPaymentId}"`, {
        status: "reference_not_found",
      });
    }
    return payment;
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }
}

const validRawBody = JSON.stringify({
  id: "evt_push_1",
  type: "payment_settled",
  reference: "ref_1",
  amount: 1099,
  occurredAt: "2026-08-01T09:00:00.000Z",
});
const unknownRawBody = JSON.stringify({
  id: "evt_push_2",
  type: "payment_reconciled",
  occurredAt: "2026-08-01T09:05:00.000Z",
});

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

runServerAdapterConformanceTests("push-only", () => new PushOnlyAdapter(), {
  createSessionInput: () => ({ amount: 1099, currency: "EUR", idempotencyKey: `k-${Math.random()}` }),
  zeroDecimalSessionInput: () => ({ amount: 500, currency: "JPY", idempotencyKey: `k-${Math.random()}` }),
  threeDecimalSessionInput: () => ({ amount: 1230, currency: "BHD", idempotencyKey: `k-${Math.random()}` }),
  webhook: {
    validRawBody,
    validHeaders: { [SIGNATURE_HEADER]: await hmacSha256Hex(HMAC_KEY, validRawBody) },
    expectedType: "payment.succeeded",
    expectedEventId: "evt_push_1",
    expectedAmount: 1099,
    unknownEvent: {
      rawBody: unknownRawBody,
      headers: { [SIGNATURE_HEADER]: await hmacSha256Hex(HMAC_KEY, unknownRawBody) },
    },
  },
  money: {
    completedPayment: (adapter, input) => reference(adapter, input.amount, input.id),
    authorizedPayment: (adapter, input) => reference(adapter, input.amount),
    cancelablePayment: (adapter) => reference(adapter, 1099),
  },
  failingCalls: [
    {
      name: "cancelPayment on an unknown reference",
      invoke: (adapter) => adapter.cancelPayment("ref_missing", "conformance-push-only-cancel-missing"),
      expectedCode: "invalid_request",
    },
    {
      name: "refundPayment on an unknown reference",
      invoke: (adapter) =>
        adapter.refundPayment({
          pspPaymentId: "ref_missing",
          idempotencyKey: "conformance-push-only-refund-missing",
        }),
      expectedCode: "invalid_request",
    },
  ],
});
