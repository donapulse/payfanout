import type {
  AdapterCapabilities,
  ChargeSavedPaymentMethodInput,
  CompletePaymentInput,
  CreateCustomerInput,
  CreatePaymentSessionInput,
  CustomerRef,
  FetchEventsInput,
  FetchEventsResult,
  ListPaymentsInput,
  ListPaymentsResult,
  ListRefundsInput,
  ListRefundsResult,
  MinorUnitAmount,
  PaymentInfo,
  PaymentSession,
  RefundInfo,
  RefundRequest,
  RefundResult,
  SavedPaymentMethod,
  SavePaymentMethodInput,
  ServerPaymentAdapter,
  UnifiedWebhookEvent,
  UpdatePaymentSessionInput,
} from "@payfanout/core";

export interface FakeAdapterOptions {
  pspName?: string;
  capabilities?: Partial<AdapterCapabilities>;
  /** Header value that makes verifyWebhookSignature return true. */
  webhookSecret?: string;
  /** When true, methods are omitted to simulate a minimal adapter. */
  omitOptionalMethods?: boolean;
}

export function makePaymentInfo(overrides: Partial<PaymentInfo> = {}): PaymentInfo {
  return {
    id: "pay_1",
    pspName: "fake",
    pspPaymentId: "psp_pay_1",
    status: "succeeded",
    amount: 1000,
    amountRefunded: 0,
    currency: "USD",
    paymentMethodType: "card",
    createdAt: "2026-07-04T00:00:00.000Z",
    raw: {},
    ...overrides,
  };
}

export class FakeAdapter implements ServerPaymentAdapter {
  readonly pspName: string;
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  private readonly caps: AdapterCapabilities;
  private readonly webhookSecret: string;

  completePayment?: (input: CompletePaymentInput) => Promise<PaymentInfo>;
  capturePayment?: (id: string, amount?: MinorUnitAmount, key?: string) => Promise<PaymentInfo>;
  verifyPaymentMethod?: (input: { pspSessionId: string; clientToken?: string }) => Promise<PaymentInfo>;
  retrieveRefund?: (refundId: string) => Promise<RefundInfo>;
  updatePaymentSession?: (input: UpdatePaymentSessionInput) => Promise<PaymentSession>;
  fetchEvents?: (input?: FetchEventsInput) => Promise<FetchEventsResult>;
  listPayments?: (input?: ListPaymentsInput) => Promise<ListPaymentsResult>;
  listRefunds?: (input?: ListRefundsInput) => Promise<ListRefundsResult>;
  createCustomer?: (input: CreateCustomerInput) => Promise<CustomerRef>;
  savePaymentMethod?: (input: SavePaymentMethodInput) => Promise<SavedPaymentMethod>;
  listSavedPaymentMethods?: (pspCustomerId: string) => Promise<SavedPaymentMethod[]>;
  deleteSavedPaymentMethod?: (pspCustomerId: string, token: string) => Promise<void>;
  chargeSavedPaymentMethod?: (input: ChargeSavedPaymentMethodInput) => Promise<PaymentInfo>;

  constructor(options: FakeAdapterOptions = {}) {
    this.pspName = options.pspName ?? "fake";
    this.webhookSecret = options.webhookSecret ?? "shh";
    this.caps = {
      pspName: this.pspName,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      supportsManualCapture: true,
      supportsMultiCapture: false,
      supportsPaymentMethodVerification: true,
      supportsSavedPaymentMethods: false,
      supportsSessionUpdate: true,
      supportsEventPolling: true,
      supportsListing: true,
      requiresServerCompletion: false,
      paymentMethods: [{ type: "card", flow: "embedded", supported: true }],
      ...options.capabilities,
    };
    if (!options.omitOptionalMethods) {
      if (this.caps.requiresServerCompletion) {
        this.completePayment = async (input) => {
          this.calls.push({ method: "completePayment", args: [input] });
          return makePaymentInfo({ pspName: this.pspName, pspPaymentId: input.pspSessionId });
        };
      }
      if (this.caps.supportsManualCapture) {
        this.capturePayment = async (id, amount, key) => {
          this.calls.push({ method: "capturePayment", args: [id, amount, key] });
          return makePaymentInfo({ pspName: this.pspName, pspPaymentId: id, status: "succeeded" });
        };
      }
      if (this.caps.supportsPaymentMethodVerification) {
        this.verifyPaymentMethod = async (input) => {
          this.calls.push({ method: "verifyPaymentMethod", args: [input] });
          return makePaymentInfo({ pspName: this.pspName, amount: 0 });
        };
      }
      if (this.caps.supportsRefunds) {
        this.retrieveRefund = async (refundId) => {
          this.calls.push({ method: "retrieveRefund", args: [refundId] });
          return { refundId, status: "succeeded", amount: 1000, raw: {} };
        };
      }
      if (this.caps.supportsSessionUpdate) {
        this.updatePaymentSession = async (input) => {
          this.calls.push({ method: "updatePaymentSession", args: [input] });
          return {
            id: "psp_sess_1",
            pspName: this.pspName,
            pspSessionId: input.pspSessionId,
            clientSecret: "secret_1",
            amount: input.amount ?? 1000,
            currency: input.currency ?? "USD",
            status: "requires_payment_method",
          };
        };
      }
      if (this.caps.supportsEventPolling) {
        this.fetchEvents = async (input) => {
          this.calls.push({ method: "fetchEvents", args: [input] });
          return { events: [] };
        };
      }
      if (this.caps.supportsListing) {
        this.listPayments = async (input) => {
          this.calls.push({ method: "listPayments", args: [input] });
          return { payments: [makePaymentInfo({ pspName: this.pspName })] };
        };
        this.listRefunds = async (input) => {
          this.calls.push({ method: "listRefunds", args: [input] });
          return { refunds: [] };
        };
      }
      if (this.caps.supportsSavedPaymentMethods) {
        const vaulted = new Map<string, SavedPaymentMethod[]>();
        this.createCustomer = async (input) => {
          this.calls.push({ method: "createCustomer", args: [input] });
          const pspCustomerId = `cust_${vaulted.size + 1}`;
          vaulted.set(pspCustomerId, []);
          return { pspName: this.pspName, pspCustomerId, ...(input.id ? { id: input.id } : {}), raw: {} };
        };
        this.savePaymentMethod = async (input) => {
          this.calls.push({ method: "savePaymentMethod", args: [input] });
          const method: SavedPaymentMethod = {
            token: `saved_${input.clientToken}`,
            pspName: this.pspName,
            pspCustomerId: input.pspCustomerId,
            paymentMethodType: "card",
            details: { brand: "visa", last4: "4242" },
            raw: {},
          };
          vaulted.get(input.pspCustomerId)?.push(method);
          return method;
        };
        this.listSavedPaymentMethods = async (pspCustomerId) => {
          this.calls.push({ method: "listSavedPaymentMethods", args: [pspCustomerId] });
          return vaulted.get(pspCustomerId) ?? [];
        };
        this.deleteSavedPaymentMethod = async (pspCustomerId, token) => {
          this.calls.push({ method: "deleteSavedPaymentMethod", args: [pspCustomerId, token] });
          const methods = vaulted.get(pspCustomerId) ?? [];
          vaulted.set(pspCustomerId, methods.filter((m) => m.token !== token));
        };
        this.chargeSavedPaymentMethod = async (input) => {
          this.calls.push({ method: "chargeSavedPaymentMethod", args: [input] });
          if (input.savedPaymentMethodToken === "tok_auth_required") {
            const { PayFanoutError } = await import("@payfanout/core");
            throw new PayFanoutError({
              code: "authentication_required",
              message: "This payment requires authentication.",
              retryable: true,
            });
          }
          if (input.savedPaymentMethodToken === "tok_declined") {
            const { PayFanoutError } = await import("@payfanout/core");
            throw new PayFanoutError({ code: "card_declined", message: "Declined.", retryable: false });
          }
          return makePaymentInfo({
            pspName: this.pspName,
            pspPaymentId: `pay_saved_${this.calls.length}`,
            amount: input.amount,
            currency: input.currency,
          });
        };
      }
    }
  }

  async createPaymentSession(input: CreatePaymentSessionInput): Promise<PaymentSession> {
    this.calls.push({ method: "createPaymentSession", args: [input] });
    return {
      id: input.id ?? "psp_sess_1",
      pspName: this.pspName,
      pspSessionId: "psp_sess_1",
      clientSecret: "secret_1",
      amount: input.amount,
      currency: input.currency,
      status: "requires_payment_method",
    };
  }

  async retrievePayment(pspPaymentId: string): Promise<PaymentInfo> {
    this.calls.push({ method: "retrievePayment", args: [pspPaymentId] });
    return makePaymentInfo({ pspName: this.pspName, pspPaymentId });
  }

  async cancelPayment(pspPaymentId: string, idempotencyKey?: string): Promise<PaymentInfo> {
    this.calls.push({ method: "cancelPayment", args: [pspPaymentId, idempotencyKey] });
    return makePaymentInfo({ pspName: this.pspName, pspPaymentId, status: "canceled" });
  }

  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    this.calls.push({ method: "refundPayment", args: [req] });
    return { refundId: "re_1", status: "succeeded", amount: req.amount ?? 1000, raw: {} };
  }

  getCapabilities(): AdapterCapabilities {
    return this.caps;
  }

  async verifyWebhookSignature(rawBody: string, headers: Record<string, string>): Promise<boolean> {
    this.calls.push({ method: "verifyWebhookSignature", args: [rawBody, headers] });
    return headers["x-fake-signature"] === this.webhookSecret;
  }

  async parseWebhookEvent(rawBody: string): Promise<UnifiedWebhookEvent> {
    this.calls.push({ method: "parseWebhookEvent", args: [rawBody] });
    const body = JSON.parse(rawBody) as { id: string; type?: string; paymentId?: string };
    return {
      id: body.id,
      pspName: this.pspName,
      type: "payment.succeeded",
      pspPaymentId: body.paymentId,
      occurredAt: "2026-07-04T00:00:00.000Z",
      raw: body,
    };
  }
}
