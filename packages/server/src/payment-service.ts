import {
  assertMinorUnitAmount,
  PayFanoutError,
  type AdapterCapabilities,
  type ChargeSavedPaymentMethodInput,
  type CompletePaymentInput,
  type CreateCustomerInput,
  type CreatePaymentSessionInput,
  type CustomerRef,
  type FetchEventsInput,
  type FetchEventsResult,
  type ListPaymentsInput,
  type ListPaymentsResult,
  type ListRefundsInput,
  type ListRefundsResult,
  type MinorUnitAmount,
  type PaymentInfo,
  type PaymentSession,
  type RefundInfo,
  type RefundRequest,
  type RefundResult,
  screenSessionInput,
  type SavedPaymentMethod,
  type SavePaymentMethodInput,
  type ServerPaymentAdapter,
  type UnifiedErrorCode,
  type UpdatePaymentSessionInput,
  type VerifyPaymentMethodInput,
} from "@payfanout/core";

/**
 * One record per adapter call, emitted to PaymentServiceOptions.telemetry.
 * Metadata-only (no amounts, no ids, no raw payloads) so the
 * hook can feed metrics/tracing without any PII handling burden.
 */
export interface PaymentOperationTelemetry {
  pspName: string;
  operation:
    | "createPaymentSession"
    | "updatePaymentSession"
    | "completePayment"
    | "retrievePayment"
    | "capturePayment"
    | "cancelPayment"
    | "refundPayment"
    | "retrieveRefund"
    | "verifyPaymentMethod"
    | "fetchEvents"
    | "listPayments"
    | "listRefunds"
    | "createCustomer"
    | "savePaymentMethod"
    | "listSavedPaymentMethods"
    | "deleteSavedPaymentMethod"
    | "chargeSavedPaymentMethod";
  durationMs: number;
  ok: boolean;
  /** Unified code when the call rejected. */
  errorCode?: UnifiedErrorCode;
}

export type PaymentTelemetryHook = (record: PaymentOperationTelemetry) => void;

export interface PaymentServiceOptions {
  adapters: ServerPaymentAdapter[];
  /**
   * Observability seam: called after every adapter operation, success or
   * failure. MUST be cheap and MUST NOT throw — a throwing hook is swallowed
   * (the payment path always wins over telemetry).
   */
  telemetry?: PaymentTelemetryHook;
  /** Injected clock for telemetry duration tests. */
  now?: () => number;
}

/**
 * Unified server-side orchestration over a registry of ServerPaymentAdapters.
 *
 * Stateless: holds no database and persists nothing. The consuming
 * application owns the internal-id -> pspPaymentId mapping, the webhook dedupe
 * store, and any audit log. Every call names the target PSP explicitly.
 */
export class PaymentService {
  private readonly registry = new Map<string, ServerPaymentAdapter>();
  private readonly telemetry?: PaymentTelemetryHook;
  private readonly now: () => number;

  constructor(options: PaymentServiceOptions) {
    this.telemetry = options.telemetry;
    this.now = options.now ?? Date.now;
    for (const adapter of options.adapters) {
      if (!adapter.pspName) {
        throw PayFanoutError.invalidRequest("Adapter is missing a pspName");
      }
      if (this.registry.has(adapter.pspName)) {
        throw PayFanoutError.invalidRequest(`Duplicate adapter registered for psp "${adapter.pspName}"`);
      }
      assertCapabilityCoherence(adapter);
      this.registry.set(adapter.pspName, adapter);
    }
  }

  listPsps(): string[] {
    return [...this.registry.keys()];
  }

  getCapabilities(pspName: string): AdapterCapabilities {
    return this.adapterFor(pspName).getCapabilities();
  }

  getAdapter(pspName: string): ServerPaymentAdapter {
    return this.adapterFor(pspName);
  }

  async createPaymentSession(pspName: string, input: CreatePaymentSessionInput): Promise<PaymentSession> {
    const adapter = this.adapterFor(pspName);
    assertMinorUnitAmount(input.amount, "amount");
    requireIdempotencyKey(input.idempotencyKey, "createPaymentSession");
    // Capability rules live in core's screenSessionInput — the router consumes
    // the same predicate for candidate skipping, so the two can never drift.
    const issue = screenSessionInput(adapter.getCapabilities(), input);
    if (issue) throw guardError(pspName, issue);
    if (input.savePaymentMethod && !input.customer) {
      throw guardError(
        pspName,
        "savePaymentMethod requires `customer` — create one with createCustomer first",
      );
    }
    return this.run(pspName, "createPaymentSession", () => adapter.createPaymentSession(input));
  }

  // --- Vaulting / recurring surface -------------------------------------

  /** Creates the PSP-side customer saved instruments attach to. The HOST stores the returned id. */
  async createCustomer(pspName: string, input: CreateCustomerInput): Promise<CustomerRef> {
    const adapter = this.vaultAdapter(pspName, "createCustomer");
    requireIdempotencyKey(input.idempotencyKey, "createCustomer");
    return this.run(pspName, "createCustomer", () => adapter.createCustomer!(input));
  }

  /**
   * Tokenize-first PSPs: converts a client-produced single-use token into a
   * permanent stored instrument. Confirm-on-client PSPs vault during checkout
   * (`savePaymentMethod` on the session) and reject this call.
   */
  async savePaymentMethod(pspName: string, input: SavePaymentMethodInput): Promise<SavedPaymentMethod> {
    const adapter = this.vaultAdapter(pspName, "savePaymentMethod");
    if (!adapter.savePaymentMethod) {
      throw guardError(
        pspName,
        `"${pspName}" vaults during checkout — pass savePaymentMethod on the session instead`,
      );
    }
    requireIdempotencyKey(input.idempotencyKey, "savePaymentMethod");
    return this.run(pspName, "savePaymentMethod", () => adapter.savePaymentMethod!(input));
  }

  async listSavedPaymentMethods(pspName: string, pspCustomerId: string): Promise<SavedPaymentMethod[]> {
    const adapter = this.vaultAdapter(pspName, "listSavedPaymentMethods");
    return this.run(pspName, "listSavedPaymentMethods", () =>
      adapter.listSavedPaymentMethods!(pspCustomerId),
    );
  }

  async deleteSavedPaymentMethod(pspName: string, pspCustomerId: string, token: string): Promise<void> {
    const adapter = this.vaultAdapter(pspName, "deleteSavedPaymentMethod");
    return this.run(pspName, "deleteSavedPaymentMethod", () =>
      adapter.deleteSavedPaymentMethod!(pspCustomerId, token),
    );
  }

  /** Off-session charge of a stored token — the recurring-payments primitive. */
  async chargeSavedPaymentMethod(
    pspName: string,
    input: ChargeSavedPaymentMethodInput,
  ): Promise<PaymentInfo> {
    const adapter = this.vaultAdapter(pspName, "chargeSavedPaymentMethod");
    assertMinorUnitAmount(input.amount, "amount");
    if (input.amount === 0) {
      throw guardError(pspName, "chargeSavedPaymentMethod requires a positive amount");
    }
    requireIdempotencyKey(input.idempotencyKey, "chargeSavedPaymentMethod");
    return this.run(pspName, "chargeSavedPaymentMethod", () => adapter.chargeSavedPaymentMethod!(input));
  }

  private vaultAdapter(pspName: string, operation: string): ServerPaymentAdapter {
    const adapter = this.adapterFor(pspName);
    if (!adapter.getCapabilities().supportsSavedPaymentMethods) {
      throw guardError(pspName, `"${pspName}" does not support saved payment methods (${operation})`);
    }
    return adapter;
  }

  /**
   * Amends a not-yet-completed session (e.g. cart total changed). Some PSPs
   * re-issue the session — always continue with the RETURNED PaymentSession.
   */
  async updatePaymentSession(pspName: string, input: UpdatePaymentSessionInput): Promise<PaymentSession> {
    const adapter = this.adapterFor(pspName);
    if (!adapter.getCapabilities().supportsSessionUpdate || !adapter.updatePaymentSession) {
      throw guardError(pspName, `"${pspName}" does not support updating payment sessions`);
    }
    if (input.amount !== undefined) assertMinorUnitAmount(input.amount, "amount");
    requireIdempotencyKey(input.idempotencyKey, "updatePaymentSession");
    return this.run(pspName, "updatePaymentSession", () => adapter.updatePaymentSession!(input));
  }

  /**
   * Finalizes a tokenize-first payment (e.g. Paysafe) with the clientToken the
   * client adapter's confirm() produced. Rejects for confirm-on-client PSPs.
   */
  async completePayment(pspName: string, input: CompletePaymentInput): Promise<PaymentInfo> {
    const adapter = this.adapterFor(pspName);
    const caps = adapter.getCapabilities();
    if (!caps.requiresServerCompletion || !adapter.completePayment) {
      throw guardError(
        pspName,
        `"${pspName}" completes payments on the client — completePayment is not part of its flow`,
      );
    }
    requireIdempotencyKey(input.idempotencyKey, "completePayment");
    return this.run(pspName, "completePayment", () => adapter.completePayment!(input));
  }

  async retrievePayment(pspName: string, pspPaymentId: string): Promise<PaymentInfo> {
    const adapter = this.adapterFor(pspName);
    return this.run(pspName, "retrievePayment", () => adapter.retrievePayment(pspPaymentId));
  }

  async capturePayment(
    pspName: string,
    pspPaymentId: string,
    amount?: MinorUnitAmount,
    idempotencyKey?: string,
  ): Promise<PaymentInfo> {
    const adapter = this.adapterFor(pspName);
    if (!adapter.getCapabilities().supportsManualCapture || !adapter.capturePayment) {
      throw guardError(pspName, `"${pspName}" does not support manual capture`);
    }
    if (amount !== undefined) assertMinorUnitAmount(amount, "capture amount");
    return this.run(pspName, "capturePayment", () =>
      adapter.capturePayment!(pspPaymentId, amount, idempotencyKey),
    );
  }

  async cancelPayment(pspName: string, pspPaymentId: string, idempotencyKey?: string): Promise<PaymentInfo> {
    const adapter = this.adapterFor(pspName);
    return this.run(pspName, "cancelPayment", () => adapter.cancelPayment(pspPaymentId, idempotencyKey));
  }

  async refundPayment(pspName: string, req: RefundRequest): Promise<RefundResult> {
    const adapter = this.adapterFor(pspName);
    const caps = adapter.getCapabilities();
    if (!caps.supportsRefunds) {
      throw guardError(pspName, `"${pspName}" does not support refunds`);
    }
    if (req.amount !== undefined) {
      assertMinorUnitAmount(req.amount, "refund amount");
      if (!caps.supportsPartialRefunds) {
        throw guardError(
          pspName,
          `"${pspName}" does not support partial refunds — omit amount for a full refund`,
        );
      }
    }
    requireIdempotencyKey(req.idempotencyKey, "refundPayment");
    return this.run(pspName, "refundPayment", () => adapter.refundPayment(req));
  }

  /** Polls a refund to a terminal state (refundPayment can return "pending"). */
  async retrieveRefund(pspName: string, refundId: string): Promise<RefundInfo> {
    const adapter = this.adapterFor(pspName);
    if (!adapter.getCapabilities().supportsRefunds || !adapter.retrieveRefund) {
      throw guardError(pspName, `"${pspName}" does not support refund retrieval`);
    }
    return this.run(pspName, "retrieveRefund", () => adapter.retrieveRefund!(refundId));
  }

  async verifyPaymentMethod(pspName: string, input: VerifyPaymentMethodInput): Promise<PaymentInfo> {
    const adapter = this.adapterFor(pspName);
    if (!adapter.getCapabilities().supportsPaymentMethodVerification || !adapter.verifyPaymentMethod) {
      throw guardError(pspName, `"${pspName}" does not support payment method verification`);
    }
    return this.run(pspName, "verifyPaymentMethod", () => adapter.verifyPaymentMethod!(input));
  }

  /**
   * Missed-webhook recovery: normalized events straight from the PSP's event
   * store. Dedupe by event.id exactly as with delivered webhooks — replaying
   * an already-processed event must be a no-op in the host's handler.
   */
  async fetchEvents(pspName: string, input?: FetchEventsInput): Promise<FetchEventsResult> {
    const adapter = this.adapterFor(pspName);
    if (!adapter.getCapabilities().supportsEventPolling || !adapter.fetchEvents) {
      throw guardError(pspName, `"${pspName}" does not support event polling`);
    }
    return this.run(pspName, "fetchEvents", () => adapter.fetchEvents!(input));
  }

  async listPayments(pspName: string, input?: ListPaymentsInput): Promise<ListPaymentsResult> {
    const adapter = this.adapterFor(pspName);
    if (!adapter.getCapabilities().supportsListing || !adapter.listPayments) {
      throw guardError(pspName, `"${pspName}" does not support listing payments`);
    }
    return this.run(pspName, "listPayments", () => adapter.listPayments!(input));
  }

  async listRefunds(pspName: string, input?: ListRefundsInput): Promise<ListRefundsResult> {
    const adapter = this.adapterFor(pspName);
    if (!adapter.getCapabilities().supportsListing || !adapter.listRefunds) {
      throw guardError(pspName, `"${pspName}" does not support listing refunds`);
    }
    return this.run(pspName, "listRefunds", () => adapter.listRefunds!(input));
  }

  private adapterFor(pspName: string): ServerPaymentAdapter {
    const adapter = this.registry.get(pspName);
    if (!adapter) {
      throw PayFanoutError.invalidRequest(
        `No adapter registered for psp "${pspName}" (registered: ${this.listPsps().join(", ") || "none"})`,
      );
    }
    return adapter;
  }

  /** Every rejection leaving the service is a PayFanoutError with pspName attached. */
  private async run<T>(
    pspName: string,
    operation: PaymentOperationTelemetry["operation"],
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = this.now();
    try {
      const result = await fn();
      this.emit({ pspName, operation, durationMs: this.now() - startedAt, ok: true });
      return result;
    } catch (err) {
      const wrapped = ensurePspName(PayFanoutError.wrap(err, { pspName }), pspName);
      this.emit({
        pspName,
        operation,
        durationMs: this.now() - startedAt,
        ok: false,
        errorCode: wrapped.code,
      });
      throw wrapped;
    }
  }

  private emit(record: PaymentOperationTelemetry): void {
    if (!this.telemetry) return;
    try {
      this.telemetry(record);
    } catch {
      // Telemetry must never break the payment path.
    }
  }
}

function requireIdempotencyKey(key: string, operation: string): void {
  if (typeof key !== "string" || key.trim() === "") {
    throw PayFanoutError.invalidRequest(`${operation} requires a non-empty idempotencyKey`);
  }
}

function guardError(pspName: string, message: string): PayFanoutError {
  return new PayFanoutError({ code: "invalid_request", message, retryable: false, pspName });
}

/**
 * PayFanoutError.wrap passes existing PayFanoutErrors through without
 * backfilling pspName, so an adapter error thrown without one would leave the
 * service unattributed. Fields are readonly — rebuild the error, keeping the
 * original stack so the adapter's throw site stays in logs.
 */
function ensurePspName(error: PayFanoutError, pspName: string): PayFanoutError {
  if (error.pspName !== undefined) return error;
  const attributed = new PayFanoutError({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    raw: error.raw,
    pspName,
  });
  attributed.stack = error.stack;
  return attributed;
}

/** Fails fast at registration if capability flags contradict the implemented surface. */
function assertCapabilityCoherence(adapter: ServerPaymentAdapter): void {
  const caps = adapter.getCapabilities();
  if (caps.pspName !== adapter.pspName) {
    throw PayFanoutError.invalidRequest(
      `Adapter "${adapter.pspName}" reports capabilities for "${caps.pspName}"`,
    );
  }
  if (caps.requiresServerCompletion && typeof adapter.completePayment !== "function") {
    throw PayFanoutError.invalidRequest(
      `Adapter "${adapter.pspName}" requires server completion but does not implement completePayment`,
    );
  }
  if (caps.supportsManualCapture && typeof adapter.capturePayment !== "function") {
    throw PayFanoutError.invalidRequest(
      `Adapter "${adapter.pspName}" claims manual capture but does not implement capturePayment`,
    );
  }
  if (caps.supportsPaymentMethodVerification && typeof adapter.verifyPaymentMethod !== "function") {
    throw PayFanoutError.invalidRequest(
      `Adapter "${adapter.pspName}" claims verification but does not implement verifyPaymentMethod`,
    );
  }
  if (caps.supportsPartialRefunds && !caps.supportsRefunds) {
    throw PayFanoutError.invalidRequest(
      `Adapter "${adapter.pspName}" claims partial refunds without refund support`,
    );
  }
  if (caps.supportsRefunds && typeof adapter.retrieveRefund !== "function") {
    throw PayFanoutError.invalidRequest(
      `Adapter "${adapter.pspName}" supports refunds but does not implement retrieveRefund — ` +
        "pending refunds would be unpollable",
    );
  }
  if (caps.supportsMultiCapture && !caps.supportsManualCapture) {
    throw PayFanoutError.invalidRequest(
      `Adapter "${adapter.pspName}" claims multi-capture without manual capture support`,
    );
  }
  if (caps.supportsSessionUpdate && typeof adapter.updatePaymentSession !== "function") {
    throw PayFanoutError.invalidRequest(
      `Adapter "${adapter.pspName}" claims session update but does not implement updatePaymentSession`,
    );
  }
  if (caps.supportsEventPolling && typeof adapter.fetchEvents !== "function") {
    throw PayFanoutError.invalidRequest(
      `Adapter "${adapter.pspName}" claims event polling but does not implement fetchEvents`,
    );
  }
  if (
    caps.supportsListing &&
    (typeof adapter.listPayments !== "function" || typeof adapter.listRefunds !== "function")
  ) {
    throw PayFanoutError.invalidRequest(
      `Adapter "${adapter.pspName}" claims listing but does not implement listPayments/listRefunds`,
    );
  }
  // The saved-payment-methods flag demands the full method surface. Cards
  // still live at the PSP only — the coherence rule is about implemented
  // methods, not about storing card data (never).
  if (caps.supportsSavedPaymentMethods) {
    for (const method of [
      "createCustomer",
      "listSavedPaymentMethods",
      "deleteSavedPaymentMethod",
      "chargeSavedPaymentMethod",
    ] as const) {
      if (typeof adapter[method] !== "function") {
        throw PayFanoutError.invalidRequest(
          `Adapter "${adapter.pspName}" claims saved payment methods but does not implement ${method}`,
        );
      }
    }
    if (caps.requiresServerCompletion && typeof adapter.savePaymentMethod !== "function") {
      throw PayFanoutError.invalidRequest(
        `Adapter "${adapter.pspName}" is tokenize-first with saved payment methods but does not implement savePaymentMethod`,
      );
    }
  }
}
