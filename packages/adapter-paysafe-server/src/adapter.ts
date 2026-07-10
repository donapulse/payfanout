import {
  assertMinorUnitAmount,
  classifyHttpFallback,
  getUserMessage,
  lowercaseKeys,
  normalizeCurrency,
  normalizeSecrets,
  PayFanoutError,
  requestWithTimeout,
  safeJson,
  utf8ToBase64,
  withTransportRetries,
  type AdapterCapabilities,
  type ChargeSavedPaymentMethodInput,
  type CompletePaymentInput,
  type CreateCustomerInput,
  type CreatePaymentSessionInput,
  type CustomerRef,
  type MinorUnitAmount,
  type PaymentInfo,
  type PaymentMethodCapability,
  type PaymentMethodDetails,
  type PaymentSession,
  type RefundInfo,
  type RefundRequest,
  type RefundResult,
  type SavedPaymentMethod,
  type SavePaymentMethodInput,
  type ServerPaymentAdapter,
  type UnifiedErrorCode,
  type UnifiedPaymentStatus,
  type UnifiedWebhookEvent,
  type UpdatePaymentSessionInput,
  type VerifyPaymentMethodInput,
} from "@payfanout/core";
import {
  decodeSessionContext,
  encodeSessionContext,
  type PaysafeSessionContextV1,
} from "./session-context.js";
import { parsePaysafeWebhookEvent, verifyPaysafeWebhookSignature } from "./webhook.js";

export const PAYSAFE_PSP_NAME = "paysafe";

export interface PaysafeServerAdapterConfig {
  /** Basic-auth API credentials (server-side only). */
  username: string;
  password: string;
  /** Explicit, never inferred. sandbox -> api.test.paysafe.com, live -> api.paysafe.com. */
  environment: "sandbox" | "live";
  /**
   * Paysafe selects a merchant account per currency/country — a single
   * hardcoded id is wrong. This is also why CreatePaymentSessionInput
   * carries `country`. Return undefined for single-account API keys: Paysafe
   * then routes by key + currency without an explicit accountId.
   */
  merchantAccountResolver: (currency: string, country?: string) => string | undefined;
  /** HMAC key for the stateless signed session context (see session-context.ts). */
  sessionSigningKey: string;
  /**
   * HMAC key Paysafe uses to sign webhook payloads. Accepts several keys at
   * once so a rotation needs no cutover — any active key verifying wins.
   */
  webhookHmacKey: string | string[];
  /**
   * How long a signed session context stays completable, in seconds.
   * Default 3600 (1h). A signed token must not be valid forever — expiry is
   * enforced at completePayment/verifyPaymentMethod/updatePaymentSession.
   */
  sessionTtlSeconds?: number;
  /**
   * Abort a hung Paysafe connection after this many milliseconds (default
   * 30000). The timer covers the whole exchange including the response body
   * read. Every mutating call carries an idempotent merchantRefNum, so a
   * timed-out request is safe to retry. Timeouts surface as retryable
   * psp_unavailable errors.
   */
  requestTimeoutMs?: number;
  /**
   * Automatic retries for transport-level trouble only (network failure,
   * timeout, HTTP 5xx, 429) with exponential backoff. Default 2. Safe because
   * merchantRefNum makes every mutating call idempotent. Business errors
   * (declines, 3406 unbatched-settlement, validation) are NEVER retried here.
   */
  maxNetworkRetries?: number;
  /**
   * Account capabilities vary by merchant account/currency/country — override
   * instead of trusting defaults. Defaults are conservative.
   */
  paymentMethods?: PaymentMethodCapability[];
  baseUrl?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Injected clock (ms since epoch) for session-TTL tests. */
  now?: () => number;
  /** Injected backoff sleep for retry tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** Masked instrument facts as the real API echoes them back (cardType/lastDigits/cardExpiry). */
export interface PaysafeCardLike {
  cardType?: string;
  cardBrand?: string;
  lastDigits?: string;
  cardExpiry?: { month?: number; year?: number };
}

/** Structural shape of Paysafe Payments API responses. */
export interface PaysafeSettlementLike {
  id: string;
  merchantRefNum?: string;
  status?: string;
  amount?: number;
  /** Decreases as refunds land — the source of truth for amountRefunded. */
  availableToRefund?: number;
  refundedAmount?: number;
  txnTime?: string;
}

export interface PaysafePaymentLike {
  id: string;
  merchantRefNum?: string;
  status?: string;
  amount?: number;
  /** Remaining authorized funds not yet settled (manual-capture flow). */
  availableToSettle?: number;
  currencyCode?: string;
  settleWithAuth?: boolean;
  txnTime?: string;
  paymentType?: string;
  card?: PaysafeCardLike;
  /** NOT populated by the real GET /payments — settlements are queried separately. */
  settlements?: PaysafeSettlementLike[];
  error?: { code?: string; message?: string };
}

/** Stored (MULTI_USE) handle as the vault reports it. */
export interface PaysafeStoredHandleLike {
  id: string;
  paymentHandleToken: string;
  merchantRefNum?: string;
  status?: string;
  usage?: string;
  paymentType?: string;
  card?: PaysafeCardLike;
}

function toStoredMethod(
  pspName: string,
  pspCustomerId: string,
  handle: PaysafeStoredHandleLike,
): SavedPaymentMethod {
  const details = toPaymentMethodDetails(handle.card);
  return {
    token: handle.paymentHandleToken,
    pspName,
    pspCustomerId,
    paymentMethodType: handle.paymentType === "CARD" || !handle.paymentType ? "card" : "other",
    ...(details ? { details } : {}),
    raw: handle,
  };
}

const DEFAULT_METHODS: PaymentMethodCapability[] = [
  { type: "card", flow: "embedded", supported: true },
  // Real redirect/voucher methods stay honestly modeled — never forced into an
  // "embedded" illusion. Off by default because enablement is per-account.
  { type: "apple_pay", flow: "popup", supported: false },
  { type: "google_pay", flow: "popup", supported: false },
  { type: "skrill", flow: "redirect", supported: false },
  { type: "neteller", flow: "redirect", supported: false },
  { type: "paysafecard", flow: "voucher_code", supported: false },
  { type: "paysafecash", flow: "voucher_code", supported: false },
  { type: "ach", flow: "embedded", supported: false },
  { type: "interac_etransfer", flow: "redirect", supported: false },
];

export class PaysafeServerAdapter implements ServerPaymentAdapter {
  readonly pspName = PAYSAFE_PSP_NAME;
  private readonly config: PaysafeServerAdapterConfig;
  private readonly baseUrl: string;

  constructor(config: PaysafeServerAdapterConfig) {
    for (const key of ["username", "password", "sessionSigningKey"] as const) {
      if (!config[key]) throw PayFanoutError.invalidRequest(`PaysafeServerAdapter config.${key} is required`);
    }
    if (normalizeSecrets(config.webhookHmacKey).length === 0) {
      throw PayFanoutError.invalidRequest(
        "PaysafeServerAdapter config.webhookHmacKey is required (one key, or several during rotation)",
      );
    }
    if (config.environment !== "sandbox" && config.environment !== "live") {
      throw PayFanoutError.invalidRequest('PaysafeServerAdapter config.environment must be "sandbox" or "live"');
    }
    if (typeof config.merchantAccountResolver !== "function") {
      throw PayFanoutError.invalidRequest(
        "PaysafeServerAdapter config.merchantAccountResolver is required — Paysafe merchant accounts are per currency/country",
      );
    }
    if (config.sessionTtlSeconds !== undefined && !(config.sessionTtlSeconds > 0)) {
      throw PayFanoutError.invalidRequest("PaysafeServerAdapter config.sessionTtlSeconds must be > 0");
    }
    if (config.requestTimeoutMs !== undefined && !(config.requestTimeoutMs > 0)) {
      throw PayFanoutError.invalidRequest("PaysafeServerAdapter config.requestTimeoutMs must be > 0");
    }
    if (
      config.maxNetworkRetries !== undefined &&
      (!Number.isInteger(config.maxNetworkRetries) || config.maxNetworkRetries < 0)
    ) {
      throw PayFanoutError.invalidRequest("PaysafeServerAdapter config.maxNetworkRetries must be an integer >= 0");
    }
    this.config = config;
    this.baseUrl =
      config.baseUrl ??
      (config.environment === "live" ? "https://api.paysafe.com" : "https://api.test.paysafe.com");
  }

  getCapabilities(): AdapterCapabilities {
    return {
      pspName: this.pspName,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      supportsManualCapture: true,
      // Settlements are partial-able: several captures (distinct idempotency
      // keys) can settle one authorization up to availableToSettle.
      supportsMultiCapture: true,
      supportsPaymentMethodVerification: true,
      // Customer Vault: single-use handles convert
      // to MULTI_USE tokens under a customer; charged with storedCredential.
      supportsSavedPaymentMethods: true,
      supportsSessionUpdate: true, // stateless re-issue: verify -> merge -> re-sign
      supportsEventPolling: false, // Paysafe exposes no public events-list API
      supportsListing: false, // /payments and /settlements query by merchantRefNum only
      requiresServerCompletion: true, // tokenize-first (§4a): the client alone cannot finalize
      paymentMethods: this.config.paymentMethods ?? DEFAULT_METHODS,
    };
  }

  /**
   * No PSP call happens here: Paysafe.js tokenizes client-side first. The
   * "session" is a signed, self-contained context (amount, currency, merchant
   * account, webhookUrl, ...) that completePayment later verifies and trusts.
   * Paysafe's per-session webhook registration requirement is honored by
   * carrying webhookUrl in this context into the /payments request.
   */
  async createPaymentSession(input: CreatePaymentSessionInput): Promise<PaymentSession> {
    assertMinorUnitAmount(input.amount, "amount");
    const currency = normalizeCurrency(input.currency);
    if (input.paymentMethodTypes?.some((t) => !this.isKnownMethodType(t))) {
      throw PayFanoutError.invalidRequest(
        `Paysafe adapter does not support one of the requested payment method types: ${input.paymentMethodTypes.join(", ")}`,
      );
    }
    const merchantAccountId = this.config.merchantAccountResolver(currency, input.country) || undefined;
    const context: PaysafeSessionContextV1 = {
      v: 1,
      amount: input.amount,
      currency,
      country: input.country,
      merchantAccountId,
      captureMethod: input.captureMethod ?? "automatic",
      expiresAt: this.now() + this.sessionTtlMs(),
      webhookUrl: input.webhookUrl,
      returnUrl: input.returnUrl,
      id: input.id,
      metadata: input.metadata,
      billingDetails: input.billingDetails,
      statementDescriptor: input.statementDescriptor,
      receiptEmail: input.receiptEmail,
      shippingDetails: input.shippingDetails,
    };
    return this.toSession(context);
  }

  /**
   * Stateless session update: verify + merge + re-sign. Paysafe has no PSP
   * object yet (tokenize-first), so the "update" re-issues the signed context
   * with the changes and a fresh TTL. The returned session carries a NEW
   * pspSessionId/clientSecret — the old token keeps its own (original) expiry,
   * so hosts should hand the new one to the client promptly.
   */
  async updatePaymentSession(input: UpdatePaymentSessionInput): Promise<PaymentSession> {
    const context = await this.decodeContext(input.pspSessionId);
    if (input.amount !== undefined) assertMinorUnitAmount(input.amount, "amount");
    const currency = input.currency !== undefined ? normalizeCurrency(input.currency) : context.currency;
    const merchantAccountId =
      input.currency !== undefined
        ? this.config.merchantAccountResolver(currency, context.country) || undefined
        : context.merchantAccountId;
    const updated: PaysafeSessionContextV1 = {
      ...context,
      amount: input.amount ?? context.amount,
      currency,
      merchantAccountId,
      expiresAt: this.now() + this.sessionTtlMs(),
      metadata: input.metadata ?? context.metadata,
      statementDescriptor: input.statementDescriptor ?? context.statementDescriptor,
      receiptEmail: input.receiptEmail ?? context.receiptEmail,
      shippingDetails: input.shippingDetails ?? context.shippingDetails,
    };
    return this.toSession(updated);
  }

  private async toSession(context: PaysafeSessionContextV1): Promise<PaymentSession> {
    const token = await encodeSessionContext(context, this.config.sessionSigningKey);
    return {
      id: context.id ?? token,
      pspName: this.pspName,
      pspSessionId: token,
      clientSecret: token, // the client adapter decodes the payload half for tokenize params
      amount: context.amount,
      currency: context.currency,
      status: "requires_payment_method",
      metadata: context.metadata,
    };
  }

  /**
   * Tokenize-first completion (§4a): create the actual Payment from the
   * client's Payment Handle token.
   *
   * Reality check: POST /payments strictly rejects
   * `webhook`/`returnLinks` fields (error 5023 "field not recognized") — those
   * belong on the payment HANDLE. Webhook endpoints are configured in the
   * Paysafe portal; `webhookUrl`/`returnUrl` stay in the session context for
   * handle-level flows (redirect methods) and future API support.
   */
  async completePayment(input: CompletePaymentInput): Promise<PaymentInfo> {
    if (!input.clientToken) {
      throw PayFanoutError.invalidRequest("completePayment requires the clientToken produced by confirm()");
    }
    const context = await this.decodeContext(input.pspSessionId);
    const payment = await this.request<PaysafePaymentLike>("POST", "/paymenthub/v1/payments", {
      merchantRefNum: input.idempotencyKey, // Paysafe dedupes on merchantRefNum — the idempotency mechanism
      amount: context.amount,
      currencyCode: context.currency,
      paymentHandleToken: input.clientToken,
      settleWithAuth: context.captureMethod !== "manual",
      ...(context.merchantAccountId ? { accountId: context.merchantAccountId } : {}),
      // Browser-tokenized handles carry no AVS data — Paysafe rejects card
      // payments without a zip (error 3004). Billing rides the signed context;
      // completion-time billingDetails (e.g. a zip collected on the payment step)
      // merges over it here, so AVS-enforcing accounts complete without a new session.
      ...(toPaysafeBillingDetails(mergeBillingDetails(context.billingDetails, input.billingDetails)) ?? {}),
      // Checkout fields against POST /payments (which
      // strict-rejects unknown fields, error 5023): merchantDescriptor and
      // profile are accepted; shippingDetails is NOT — it is a payment-HANDLE
      // field (like webhook/returnLinks) and stays in the signed context for
      // handle-level flows only.
      ...(context.statementDescriptor
        ? { merchantDescriptor: { dynamicDescriptor: context.statementDescriptor } }
        : {}),
      ...(context.receiptEmail ? { profile: { email: context.receiptEmail } } : {}),
    });
    return this.toPaymentInfo(payment, context.id);
  }

  /** Signature + TTL verification with the adapter's clock. */
  private decodeContext(pspSessionId: string): Promise<PaysafeSessionContextV1> {
    return decodeSessionContext(pspSessionId, this.config.sessionSigningKey, { now: this.now() });
  }

  private now(): number {
    return (this.config.now ?? Date.now)();
  }

  private sessionTtlMs(): number {
    return (this.config.sessionTtlSeconds ?? 3600) * 1000;
  }

  async retrievePayment(pspPaymentId: string): Promise<PaymentInfo> {
    const payment = await this.fetchPayment(pspPaymentId);
    // The real API never embeds settlements in the payment — query them so
    // amountRefunded/capturedAt reflect reality.
    const settlements = payment.settlements?.length
      ? payment.settlements
      : await this.findSettlements(payment);
    return this.toPaymentInfo({ ...payment, settlements });
  }

  async capturePayment(
    pspPaymentId: string,
    amount: MinorUnitAmount | undefined,
    idempotencyKey: string,
  ): Promise<PaymentInfo> {
    if (amount !== undefined) assertMinorUnitAmount(amount, "capture amount");
    // Paysafe requires an explicit amount on settlements (error 5068 without one)
    // — resolve "capture everything" ourselves.
    const captureAmount = amount ?? remainingToSettle(await this.fetchPayment(pspPaymentId));
    await this.request("POST", `/paymenthub/v1/payments/${encodeURIComponent(pspPaymentId)}/settlements`, {
      merchantRefNum: idempotencyKey, // Paysafe dedupes settlements on merchantRefNum — one charge per key
      amount: captureAmount,
    });
    return this.retrievePayment(pspPaymentId);
  }

  /**
   * Voids the remaining authorization. This also works AFTER partial
   * settlements (multi-capture flows) — settled funds stay settled and the
   * returned PaymentInfo reports them (status "succeeded"), derived from the
   * pre-void remainder; only a payment with no settlements at all comes back
   * "canceled". Caller-keyed settlements are not rediscoverable statelessly,
   * so LATER retrievePayment calls lose that split once the void has consumed
   * availableToSettle (documented limitation).
   */
  async cancelPayment(pspPaymentId: string, idempotencyKey: string): Promise<PaymentInfo> {
    const payment = await this.fetchPayment(pspPaymentId);
    // Voidauths also require an explicit amount (full remaining authorization).
    const remaining = remainingToSettle(payment);
    await this.request("POST", `/paymenthub/v1/payments/${encodeURIComponent(pspPaymentId)}/voidauths`, {
      merchantRefNum: idempotencyKey,
      amount: remaining,
    });
    const fresh = await this.fetchPayment(pspPaymentId);
    const settlements = fresh.settlements?.length ? fresh.settlements : await this.findSettlements(fresh);
    // Post-void the amount/availableToSettle derivation would count the voided
    // funds as settled — the pre-void remainder is the last stateless witness.
    const settledBeforeVoid = Math.max(0, (payment.amount ?? 0) - remaining);
    return this.toPaymentInfo({ ...fresh, settlements }, undefined, settledBeforeVoid);
  }

  private fetchPayment(pspPaymentId: string): Promise<PaysafePaymentLike> {
    return this.request<PaysafePaymentLike>(
      "GET",
      `/paymenthub/v1/payments/${encodeURIComponent(pspPaymentId)}`,
    );
  }

  /**
   * Settlements are query-only in the real API and keyed by merchantRefNum.
   * Auto-capture settlements share the payment's refNum; caller-keyed capture
   * settlements cannot be rediscovered statelessly. The second candidate keeps
   * payments captured by earlier releases' derived default keys readable.
   */
  private async findSettlements(payment: PaysafePaymentLike): Promise<PaysafeSettlementLike[]> {
    const candidates = [payment.merchantRefNum, `payfanout-capture-${payment.id}`];
    for (const refNum of candidates) {
      if (!refNum) continue;
      try {
        const result = await this.request<{ settlements?: PaysafeSettlementLike[] }>(
          "GET",
          `/paymenthub/v1/settlements?merchantRefNum=${encodeURIComponent(refNum)}`,
        );
        if (result.settlements?.length) return result.settlements;
      } catch {
        // A refNum with no settlements can 404 — try the next candidate.
      }
    }
    return [];
  }

  /** Paysafe refunds settle against a settlement, not the payment — resolved here so callers keep one API. */
  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    if (req.amount !== undefined) assertMinorUnitAmount(req.amount, "refund amount");
    const payment = await this.fetchPayment(req.pspPaymentId);
    const settlements = payment.settlements?.length ? payment.settlements : await this.findSettlements(payment);
    const settlement = settlements.find(
      (s) => s.status !== "CANCELLED" && s.status !== "FAILED" && (s.availableToRefund ?? s.amount ?? 0) > 0,
    );
    if (!settlement) {
      throw PayFanoutError.invalidRequest(
        `Payment ${req.pspPaymentId} has no refundable settlement — either it is only authorized (cancel it ` +
          "instead), the sandbox settlement batch has not run yet, or it was captured with a custom " +
          "idempotency key PayFanout cannot rediscover statelessly",
        payment,
      );
    }
    const refund = await this.request<{ id: string; status?: string; amount?: number }>(
      "POST",
      `/paymenthub/v1/settlements/${encodeURIComponent(settlement.id)}/refunds`,
      {
        merchantRefNum: req.idempotencyKey,
        ...(req.amount !== undefined ? { amount: req.amount } : {}),
        // Paysafe has no refund-reason enum — the normalized reason rides the free-text description.
        ...(req.reason ? { description: req.reason } : {}),
      },
    );
    return {
      refundId: refund.id,
      status: mapRefundStatus(refund.status),
      amount: refund.amount ?? req.amount ?? settlement.amount ?? 0,
      raw: refund,
    };
  }

  /**
   * Polls an async refund to a terminal state — sandbox refunds in particular
   * sit PENDING until the overnight settlement batch runs.
   */
  async retrieveRefund(refundId: string): Promise<RefundInfo> {
    const refund = await this.request<{
      id: string;
      status?: string;
      amount?: number;
      txnTime?: string;
      paymentId?: string;
    }>("GET", `/paymenthub/v1/refunds/${encodeURIComponent(refundId)}`);
    return {
      refundId: refund.id,
      status: mapRefundStatus(refund.status),
      amount: refund.amount ?? 0,
      ...(refund.paymentId ? { pspPaymentId: refund.paymentId } : {}),
      ...(refund.txnTime ? { createdAt: refund.txnTime } : {}),
      raw: refund,
    };
  }

  /** Zero-amount verification via Paysafe's Verifications API — no charge, nothing stored. */
  async verifyPaymentMethod(input: VerifyPaymentMethodInput): Promise<PaymentInfo> {
    if (!input.clientToken) {
      throw PayFanoutError.invalidRequest(
        "Paysafe verification is tokenize-first: pass the clientToken produced by the client adapter's confirm()",
      );
    }
    const context = await this.decodeContext(input.pspSessionId);
    // Verification refNums must be unique per ATTEMPT (Paysafe 409s on reuse) —
    // the caller's required idempotencyKey carries exactly that duty.
    const verification = await this.request<PaysafePaymentLike>("POST", "/paymenthub/v1/verifications", {
      merchantRefNum: input.idempotencyKey,
      paymentHandleToken: input.clientToken,
      ...(context.merchantAccountId ? { accountId: context.merchantAccountId } : {}),
      currencyCode: context.currency,
    });
    return {
      id: context.id ?? verification.id,
      pspName: this.pspName,
      pspPaymentId: verification.id,
      status: verification.status === "COMPLETED" ? "succeeded" : verification.status === "FAILED" ? "failed" : "processing",
      amount: 0,
      amountRefunded: 0,
      currency: context.currency,
      paymentMethodType: "card",
      createdAt: verification.txnTime ?? "1970-01-01T00:00:00.000Z",
      raw: verification,
    };
  }

  // --- Customer Vault ------

  async createCustomer(input: CreateCustomerInput): Promise<CustomerRef> {
    const [firstName, ...rest] = (input.name ?? "").trim().split(/\s+/).filter(Boolean);
    const merchantCustomerId = input.id ?? input.idempotencyKey;
    let customer: { id: string; merchantCustomerId?: string; status?: string };
    try {
      customer = await this.request("POST", "/paymenthub/v1/customers", {
        // merchantCustomerId is unique per profile — the host id is the
        // natural key; the idempotencyKey covers hosts that don't pass one.
        merchantCustomerId,
        ...(firstName ? { firstName } : {}),
        ...(rest.length > 0 ? { lastName: rest.join(" ") } : {}),
        ...(input.email ? { email: input.email } : {}),
      });
    } catch (err) {
      // Idempotent create: 7505 = this merchantCustomerId already has a
      // profile (host restarted, lost its cache). Recover it instead of
      // failing.
      if (!isDuplicateCustomerError(err)) throw err;
      customer = await this.request(
        "GET",
        `/paymenthub/v1/customers?merchantCustomerId=${encodeURIComponent(merchantCustomerId)}`,
      );
    }
    return {
      pspName: this.pspName,
      pspCustomerId: customer.id,
      ...(input.id ? { id: input.id } : {}),
      raw: customer,
    };
  }

  /**
   * Converts the client's SINGLE_USE handle (from Paysafe.js tokenize) into a
   * permanent MULTI_USE token under the customer. This is the tokenize-first
   * counterpart of Stripe's save-during-checkout.
   */
  async savePaymentMethod(input: SavePaymentMethodInput): Promise<SavedPaymentMethod> {
    try {
      const handle = await this.request<PaysafeStoredHandleLike>(
        "POST",
        `/paymenthub/v1/customers/${encodeURIComponent(input.pspCustomerId)}/paymenthandles`,
        {
          merchantRefNum: input.idempotencyKey,
          paymentHandleTokenFrom: input.clientToken,
        },
      );
      return toStoredMethod(this.pspName, input.pspCustomerId, handle);
    } catch (err) {
      // 7503 "Card number already in use": re-saving a card the customer
      // already vaulted is a normal UX event (they re-checked "save my card").
      // The error names the existing handle — if it belongs to THIS customer,
      // return it (idempotent save). A card vaulted under a DIFFERENT profile
      // stays an error, with the PSP detail preserved on raw.
      const existingHandleId = duplicateCardHandleId(err);
      if (existingHandleId) {
        const handles = await this.storedHandles(input.pspCustomerId);
        const existing = handles.find((h) => h.id === existingHandleId && (h.status ?? "PAYABLE") === "PAYABLE");
        if (existing) return toStoredMethod(this.pspName, input.pspCustomerId, existing);
      }
      throw err;
    }
  }

  async listSavedPaymentMethods(pspCustomerId: string): Promise<SavedPaymentMethod[]> {
    const handles = await this.storedHandles(pspCustomerId);
    return handles
      .filter((h) => (h.status ?? "PAYABLE") === "PAYABLE")
      .map((h) => toStoredMethod(this.pspName, pspCustomerId, h));
  }

  /** Deletion needs the handle's internal id; hosts only hold the token — resolved here. */
  async deleteSavedPaymentMethod(pspCustomerId: string, token: string): Promise<void> {
    const handles = await this.storedHandles(pspCustomerId);
    const match = handles.find((h) => h.paymentHandleToken === token);
    if (!match) {
      throw PayFanoutError.invalidRequest(
        `No stored payment method with this token on customer "${pspCustomerId}"`,
        { token },
      );
    }
    await this.request(
      "DELETE",
      `/paymenthub/v1/customers/${encodeURIComponent(pspCustomerId)}/paymenthandles/${encodeURIComponent(match.id)}`,
    );
  }

  /**
   * Merchant-initiated charge of a MULTI_USE token. storedCredential carries
   * the networks' credential-on-file semantics (INITIAL while the customer is
   * present, SUBSEQUENT for recurring; ADHOC covers unscheduled top-ups).
   */
  async chargeSavedPaymentMethod(input: ChargeSavedPaymentMethodInput): Promise<PaymentInfo> {
    assertMinorUnitAmount(input.amount, "amount");
    const currency = normalizeCurrency(input.currency);
    const merchantAccountId = this.config.merchantAccountResolver(currency, undefined) || undefined;
    const occurrence = input.occurrence ?? "recurring";
    const payment = await this.request<PaysafePaymentLike>("POST", "/paymenthub/v1/payments", {
      merchantRefNum: input.idempotencyKey,
      amount: input.amount,
      currencyCode: currency,
      paymentHandleToken: input.savedPaymentMethodToken,
      settleWithAuth: true,
      ...(merchantAccountId ? { accountId: merchantAccountId } : {}),
      storedCredential:
        occurrence === "unscheduled"
          ? { type: "ADHOC", occurrence: "SUBSEQUENT" }
          : { type: "RECURRING", occurrence: occurrence === "initial" ? "INITIAL" : "SUBSEQUENT" },
      // INITIAL (customer-present) charges of browser-originated tokens need
      // AVS data on the payment itself (3004 without a zip).
      ...(toPaysafeBillingDetails(input.billingDetails) ?? {}),
      ...(input.statementDescriptor
        ? { merchantDescriptor: { dynamicDescriptor: input.statementDescriptor } }
        : {}),
    });
    return this.toPaymentInfo(payment, input.id);
  }

  /** GET /customers/{id}?fields=paymenthandles — the collection route itself 405s. */
  private async storedHandles(pspCustomerId: string): Promise<PaysafeStoredHandleLike[]> {
    const customer = await this.request<{ id: string; paymentHandles?: PaysafeStoredHandleLike[] }>(
      "GET",
      `/paymenthub/v1/customers/${encodeURIComponent(pspCustomerId)}?fields=paymenthandles`,
    );
    return customer.paymentHandles ?? [];
  }

  async verifyWebhookSignature(rawBody: string, headers: Record<string, string>): Promise<boolean> {
    return verifyPaysafeWebhookSignature(
      rawBody,
      lowercaseKeys(headers),
      normalizeSecrets(this.config.webhookHmacKey),
    );
  }

  async parseWebhookEvent(rawBody: string): Promise<UnifiedWebhookEvent> {
    return parsePaysafeWebhookEvent(rawBody);
  }

  private toPaymentInfo(
    payment: PaysafePaymentLike,
    payfanoutId?: string,
    knownSettled?: number,
  ): PaymentInfo {
    const methodDetails = toPaymentMethodDetails(payment.card);
    const settlements = (payment.settlements ?? []).filter(
      (s) => s.status !== "CANCELLED" && s.status !== "FAILED",
    );
    const completed = (payment.status ?? "").toUpperCase() === "COMPLETED";
    let settled = settlements.reduce((sum, s) => sum + (s.amount ?? 0), 0);
    if (settled === 0 && knownSettled !== undefined) {
      settled = knownSettled;
    } else if (
      settled === 0 &&
      payment.settleWithAuth === false &&
      typeof payment.availableToSettle === "number" &&
      completed
    ) {
      // The payment itself is the only witness when settlements weren't queried:
      // whatever left availableToSettle has been captured.
      settled = Math.max(0, (payment.amount ?? 0) - payment.availableToSettle);
    }
    // availableToRefund decreases as refunds land; refundedAmount is a legacy fallback.
    const refunded = settlements.reduce(
      (sum, s) => sum + (s.refundedAmount ?? Math.max(0, (s.amount ?? 0) - (s.availableToRefund ?? s.amount ?? 0))),
      0,
    );
    // amountCaptured is only claimed with a witness: settlements/derivation for
    // manual capture, or the settle-with-auth completion itself (full amount).
    let amountCaptured: number | undefined;
    if (settled > 0) amountCaptured = settled;
    else if (completed && payment.settleWithAuth) amountCaptured = payment.amount ?? 0;
    else if (completed && (typeof payment.availableToSettle === "number" || knownSettled !== undefined)) {
      amountCaptured = 0;
    }
    return {
      id: payfanoutId ?? payment.merchantRefNum ?? payment.id,
      pspName: this.pspName,
      pspPaymentId: payment.id,
      status: mapPaysafeStatus(payment, settled),
      // Same rule as Stripe: once money moved, report the settled (captured)
      // amount — the authorized amount is only meaningful pre-settlement.
      amount: settled > 0 ? settled : (payment.amount ?? 0),
      amountRefunded: refunded,
      ...(amountCaptured !== undefined ? { amountCaptured } : {}),
      ...(typeof payment.availableToSettle === "number"
        ? { amountCapturable: payment.availableToSettle }
        : {}),
      currency: (payment.currencyCode ?? "").toUpperCase() || "USD",
      paymentMethodType: payment.paymentType === "CARD" || !payment.paymentType ? "card" : "other",
      ...(methodDetails ? { paymentMethodDetails: methodDetails } : {}),
      createdAt: payment.txnTime ?? "1970-01-01T00:00:00.000Z",
      ...(settled > 0 && settlements[0]?.txnTime ? { capturedAt: settlements[0].txnTime } : {}),
      raw: payment,
    };
  }

  private isKnownMethodType(type: string): boolean {
    return (this.config.paymentMethods ?? DEFAULT_METHODS).some((m) => m.type === type);
  }

  /**
   * Transport with timeout + transient-only retries. Safe to retry mutating
   * calls: every one carries an idempotent merchantRefNum, so a replay can
   * never double-charge. Business errors (4xx other than 429) never retry —
   * core's isTransportRetryable deliberately ignores `error.retryable` (3406,
   * unbatched settlement, is retryable *hours* later, not milliseconds).
   */
  private request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    return withTransportRetries(() => this.requestOnce<T>(method, path, body), {
      attempts: 1 + (this.config.maxNetworkRetries ?? 2),
      sleep: this.config.sleep,
    });
  }

  private async requestOnce<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    const { response, text } = await requestWithTimeout(
      {
        fetch: this.config.fetch ?? fetch,
        timeoutMs,
        onFailure: (timedOut, cause) =>
          new PayFanoutError({
            code: "psp_unavailable",
            message: timedOut
              ? `Paysafe did not respond within ${timeoutMs}ms.`
              : "Could not reach Paysafe.",
            retryable: true,
            raw: cause,
            pspName: this.pspName,
          }),
      },
      `${this.baseUrl}${path}`,
      {
        method,
        headers: {
          authorization: `Basic ${utf8ToBase64(`${this.config.username}:${this.config.password}`)}`,
          "content-type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
    );
    const json = text ? safeJson(text) : undefined;
    if (!response.ok) throw mapPaysafeError(response.status, json ?? text);
    return json as T;
  }
}

/** Paysafe card.type codes → lowercase brand names hosts can render. */
const PAYSAFE_CARD_TYPE_TO_BRAND: Record<string, string> = {
  VI: "visa",
  VD: "visa", // Visa Debit
  VE: "visa", // Visa Electron
  MC: "mastercard",
  MD: "mastercard", // Debit MasterCard
  AM: "amex",
  DI: "discover",
  JC: "jcb",
  DC: "diners",
  UP: "unionpay",
};

function toPaymentMethodDetails(card: PaysafeCardLike | undefined): PaymentMethodDetails | undefined {
  if (!card) return undefined;
  const brand =
    card.cardBrand?.toLowerCase() ??
    (card.cardType ? PAYSAFE_CARD_TYPE_TO_BRAND[card.cardType.toUpperCase()] : undefined);
  const details: PaymentMethodDetails = {
    ...(brand ? { brand } : {}),
    ...(card.lastDigits ? { last4: card.lastDigits } : {}),
    ...(typeof card.cardExpiry?.month === "number" ? { expMonth: card.cardExpiry.month } : {}),
    ...(typeof card.cardExpiry?.year === "number" ? { expYear: card.cardExpiry.year } : {}),
  };
  return Object.keys(details).length > 0 ? details : undefined;
}

/** Authorized-but-unsettled remainder — the explicit amount full captures and voids need. */
function remainingToSettle(payment: PaysafePaymentLike): number {
  return payment.availableToSettle ?? payment.amount ?? 0;
}

/**
 * Paysafe 7503: "Card number already in use — <owner>" with the existing
 * handle id in details. Returns that handle id, or undefined for other errors.
 */
function duplicateCardHandleId(err: unknown): string | undefined {
  if (!(err instanceof PayFanoutError)) return undefined;
  const raw = err.raw as { error?: { code?: string; details?: string[] } } | undefined;
  if (raw?.error?.code !== "7503") return undefined;
  for (const detail of raw.error.details ?? []) {
    const match = /Payment Handle Id:\s*([\w-]+)/.exec(detail);
    if (match) return match[1];
  }
  return undefined;
}

/** Paysafe 7505: "merchantCustomerId ... already been used for another profile". */
function isDuplicateCustomerError(err: unknown): boolean {
  if (!(err instanceof PayFanoutError)) return false;
  const code = (err.raw as { error?: { code?: string } } | undefined)?.error?.code;
  return code === "7505";
}

function mapRefundStatus(status: string | undefined): RefundResult["status"] {
  switch ((status ?? "").toUpperCase()) {
    case "COMPLETED":
      return "succeeded";
    case "FAILED":
    case "CANCELLED":
    case "DECLINED":
    case "ERROR":
      return "failed";
    default: // RECEIVED / PENDING / PROCESSING / INITIATED
      return "pending";
  }
}

function mapPaysafeStatus(payment: PaysafePaymentLike, settledAmount: number): UnifiedPaymentStatus {
  switch ((payment.status ?? "").toUpperCase()) {
    case "COMPLETED":
      // COMPLETED means authorized; whether funds move depends on settlement.
      if (payment.settleWithAuth || settledAmount > 0) return "succeeded";
      return "requires_capture";
    case "RECEIVED":
    case "PENDING":
    case "PROCESSING":
    case "HELD": // risk review — funds not moving yet
      return "processing";
    case "INITIATED":
      return "requires_action";
    case "FAILED":
    case "ERROR":
      return "failed";
    case "CANCELLED":
    case "EXPIRED":
      return "canceled";
    default:
      return "processing";
  }
}

/** Paysafe error body: { error: { code, message } } with meaningful HTTP statuses (402 = declined). */
const PAYSAFE_CODE_MAP: Record<string, UnifiedErrorCode> = {
  "3022": "insufficient_funds",
  "3006": "expired_card",
  "3017": "invalid_card_data",
  // 3004: the zip/billing data Paysafe requires is missing from the request —
  // a data-quality error (fixed by supplying billingDetails), not a decline.
  "3004": "invalid_request",
  "3009": "card_declined",
  // 3406: settlement not batched yet — a timing state, retry later.
  "3406": "processing_error",
  "8000": "fraud_suspected",
  "8001": "fraud_suspected",
};

export function mapPaysafeError(httpStatus: number, body: unknown): PayFanoutError {
  const errorBody = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
  const pspCode = errorBody?.code;
  let code: UnifiedErrorCode;
  let retryable = false;
  if (pspCode && PAYSAFE_CODE_MAP[pspCode]) {
    code = PAYSAFE_CODE_MAP[pspCode];
    retryable = code === "processing_error";
  } else if (httpStatus === 402) {
    code = "card_declined";
  } else {
    ({ code, retryable } = classifyHttpFallback(httpStatus));
  }
  return new PayFanoutError({
    code,
    message: getUserMessage(code),
    retryable,
    raw: body,
    pspName: PAYSAFE_PSP_NAME,
  });
}

/**
 * Merge completion-time billingDetails over the session context's, field by field
 * (completion wins), so a postal code collected on the payment step augments —
 * rather than replaces — whatever the session already carried.
 */
function mergeBillingDetails(
  base: PaysafeSessionContextV1["billingDetails"],
  override: PaysafeSessionContextV1["billingDetails"],
): PaysafeSessionContextV1["billingDetails"] {
  if (!base) return override;
  if (!override) return base;
  return { ...base, ...override, address: { ...base.address, ...override.address } };
}

function toPaysafeBillingDetails(
  billing: PaysafeSessionContextV1["billingDetails"],
): { billingDetails: Record<string, string> } | undefined {
  const address = billing?.address;
  if (!address) return undefined;
  const mapped: Record<string, string> = {
    ...(address.line1 ? { street: address.line1 } : {}),
    ...(address.city ? { city: address.city } : {}),
    ...(address.postalCode ? { zip: address.postalCode } : {}),
    ...(address.country ? { country: address.country } : {}),
  };
  return Object.keys(mapped).length > 0 ? { billingDetails: mapped } : undefined;
}
