import {
  assertMinorUnitAmount,
  PayFanoutError,
  type AdapterCapabilities,
  type CancelNativeSubscriptionInput,
  type ChargeSavedPaymentMethodInput,
  type CompletePaymentInput,
  type CreateCustomerInput,
  type CreateNativeSubscriptionInput,
  type CreatePaymentSessionInput,
  type CustomerRef,
  type FetchEventsInput,
  type FetchEventsResult,
  type ListNativeSubscriptionsInput,
  type ListNativeSubscriptionsResult,
  type ListPaymentsInput,
  type ListPaymentsResult,
  type ListRefundsInput,
  type ListRefundsResult,
  type MinorUnitAmount,
  type NativeSubscriptionCapabilities,
  type NativeSubscriptionRecord,
  type PaymentInfo,
  type PaymentSession,
  type RefundInfo,
  type RefundRequest,
  type RefundResult,
  type RetrieveNativeSubscriptionInput,
  screenSessionInput,
  type SavedPaymentMethod,
  type SavePaymentMethodInput,
  type ServerPaymentAdapter,
  type UnifiedErrorCode,
  type UpdatePaymentSessionInput,
  validateAdapterCapabilities,
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
    | "chargeSavedPaymentMethod"
    | "listNativeSubscriptions"
    | "retrieveNativeSubscription"
    | "createNativeSubscription"
    | "cancelNativeSubscription";
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
        "invalid_request",
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
      throw guardError(pspName, "chargeSavedPaymentMethod requires a positive amount", "invalid_request");
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

  /** Capture is a charge — the idempotency key is required, per-capture under multi-capture. */
  async capturePayment(
    pspName: string,
    pspPaymentId: string,
    amount: MinorUnitAmount | undefined,
    idempotencyKey: string,
  ): Promise<PaymentInfo> {
    const adapter = this.adapterFor(pspName);
    if (!adapter.getCapabilities().supportsManualCapture || !adapter.capturePayment) {
      throw guardError(pspName, `"${pspName}" does not support manual capture`);
    }
    if (amount !== undefined) assertMinorUnitAmount(amount, "capture amount");
    requireIdempotencyKey(idempotencyKey, "capturePayment");
    return this.run(pspName, "capturePayment", () =>
      adapter.capturePayment!(pspPaymentId, amount, idempotencyKey),
    );
  }

  async cancelPayment(pspName: string, pspPaymentId: string, idempotencyKey: string): Promise<PaymentInfo> {
    const adapter = this.adapterFor(pspName);
    requireIdempotencyKey(idempotencyKey, "cancelPayment");
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
    requireIdempotencyKey(input.idempotencyKey, "verifyPaymentMethod");
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

  // --- PSP-native subscriptions -----------------------------------------
  // The PSP schedules and collects these charges itself. Contrast the
  // host-side SubscriptionManager, where the HOST bills on vault tokens.
  // Capability is per operation — provider support is uneven.

  async listNativeSubscriptions(
    pspName: string,
    input?: ListNativeSubscriptionsInput,
  ): Promise<ListNativeSubscriptionsResult> {
    const adapter = this.nativeSubscriptionAdapter(pspName, "list", "listing");
    return this.run(pspName, "listNativeSubscriptions", () => adapter.listNativeSubscriptions!(input));
  }

  async retrieveNativeSubscription(
    pspName: string,
    input: RetrieveNativeSubscriptionInput,
  ): Promise<NativeSubscriptionRecord> {
    const adapter = this.nativeSubscriptionAdapter(pspName, "retrieve", "retrieving");
    return this.run(pspName, "retrieveNativeSubscription", () => adapter.retrieveNativeSubscription!(input));
  }

  /** Server-only creation against an already-vaulted instrument (token or mandate). */
  async createNativeSubscription(
    pspName: string,
    input: CreateNativeSubscriptionInput,
  ): Promise<NativeSubscriptionRecord> {
    const adapter = this.nativeSubscriptionAdapter(pspName, "create", "creating");
    assertMinorUnitAmount(input.amount, "amount");
    if (input.amount === 0) {
      throw guardError(pspName, "createNativeSubscription requires a positive amount", "invalid_request");
    }
    // The cadence must be unambiguous: exactly one authoritative expression.
    if (!input.interval && !input.schedule) {
      throw guardError(
        pspName,
        "createNativeSubscription requires a billing cadence — pass interval (with optional intervalCount) or schedule",
        "invalid_request",
      );
    }
    if (input.interval && input.schedule) {
      throw guardError(
        pspName,
        "createNativeSubscription accepts interval or schedule, not both — one cadence must be authoritative",
        "invalid_request",
      );
    }
    if (input.intervalCount !== undefined) {
      if (!input.interval) {
        throw guardError(
          pspName,
          "createNativeSubscription intervalCount requires interval",
          "invalid_request",
        );
      }
      if (!Number.isInteger(input.intervalCount) || input.intervalCount < 1) {
        throw guardError(
          pspName,
          "createNativeSubscription intervalCount must be a positive integer",
          "invalid_request",
        );
      }
    }
    if (input.startAt !== undefined && Number.isNaN(Date.parse(input.startAt))) {
      throw guardError(
        pspName,
        "createNativeSubscription startAt must be an ISO 8601 instant",
        "invalid_request",
      );
    }
    requireIdempotencyKey(input.idempotencyKey, "createNativeSubscription");
    return this.run(pspName, "createNativeSubscription", () => adapter.createNativeSubscription!(input));
  }

  /**
   * Stops PSP-side billing. Adapters implement this verified-idempotent: an
   * already-terminal subscription resolves as success, so replaying a cancel
   * (adoption flows do) can never fail on its own earlier success.
   */
  async cancelNativeSubscription(
    pspName: string,
    input: CancelNativeSubscriptionInput,
  ): Promise<NativeSubscriptionRecord> {
    const adapter = this.nativeSubscriptionAdapter(pspName, "cancel", "canceling");
    requireIdempotencyKey(input.idempotencyKey, "cancelNativeSubscription");
    return this.run(pspName, "cancelNativeSubscription", () => adapter.cancelNativeSubscription!(input));
  }

  private nativeSubscriptionAdapter(
    pspName: string,
    operation: keyof NativeSubscriptionCapabilities,
    verb: string,
  ): ServerPaymentAdapter {
    const adapter = this.adapterFor(pspName);
    const methods = {
      list: adapter.listNativeSubscriptions,
      retrieve: adapter.retrieveNativeSubscription,
      create: adapter.createNativeSubscription,
      cancel: adapter.cancelNativeSubscription,
    } as const;
    if (!adapter.getCapabilities().nativeSubscriptions[operation] || !methods[operation]) {
      throw guardError(pspName, `"${pspName}" does not support ${verb} native subscriptions`);
    }
    return adapter;
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

/** Capability guards reject with unsupported_operation; input-shape problems pass invalid_request. */
function guardError(
  pspName: string,
  message: string,
  code: UnifiedErrorCode = "unsupported_operation",
): PayFanoutError {
  return new PayFanoutError({ code, message, retryable: false, pspName });
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

/**
 * Fails fast at registration if capability flags contradict the implemented
 * surface. The rule table lives in core (`validateAdapterCapabilities`) — the
 * same one the conformance suite asserts — so the two can never drift; the
 * service rejects on the first violation.
 */
function assertCapabilityCoherence(adapter: ServerPaymentAdapter): void {
  const issues = validateAdapterCapabilities(adapter);
  if (issues.length > 0) throw PayFanoutError.invalidRequest(issues[0]!);
}
