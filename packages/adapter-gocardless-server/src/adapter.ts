import {
  assertMinorUnitAmount,
  classifyHttpFallback,
  getUserMessage,
  normalizeCurrency,
  normalizeSecrets,
  PayFanoutError,
  requestWithTimeout,
  safeJson,
  withTransportRetries,
  type AdapterCapabilities,
  type CreatePaymentSessionInput,
  type FetchEventsInput,
  type FetchEventsResult,
  type ListPaymentsInput,
  type ListPaymentsResult,
  type ListRefundsInput,
  type ListRefundsResult,
  type PaymentInfo,
  type PaymentMethodCapability,
  type PaymentSession,
  type RefundInfo,
  type RefundRequest,
  type RefundResult,
  type ServerPaymentAdapter,
  type UnifiedErrorCode,
  type UnifiedPaymentMethodType,
  type UnifiedPaymentStatus,
  type UnifiedWebhookEvent,
} from "@payfanout/core";
import {
  normalizeGoCardlessEvent,
  parseGoCardlessWebhookEvents,
  verifyGoCardlessWebhookSignature,
  type GoCardlessEventLike,
} from "./webhook.js";

export const GOCARDLESS_PSP_NAME = "gocardless";

/** Still the current released API version as of 2026-07 — pinned, never the account default. */
const DEFAULT_GOCARDLESS_VERSION = "2015-07-06";

const EPOCH = "1970-01-01T00:00:00.000Z";

export interface GoCardlessServerAdapterConfig {
  /** Read-write access token from the GoCardless dashboard (server-side only). */
  accessToken: string;
  /** Explicit, never inferred. sandbox -> api-sandbox.gocardless.com, live -> api.gocardless.com. */
  environment: "sandbox" | "live";
  /**
   * Webhook endpoint secret(s) from the dashboard. Accepts several at once so
   * a rotation needs no cutover — any active secret verifying wins.
   */
  webhookSecret: string | string[];
  /** Pinned `GoCardless-Version` request header, overridable when GoCardless dates a new one. */
  goCardlessVersion?: string;
  /**
   * Lets a billing request fall back from instant bank payment to collecting
   * a Direct Debit mandate when the instant rails are unavailable. Off by
   * default: fallback payments confirm on debit timing (days), not seconds.
   */
  fallbackEnabled?: boolean;
  /** Where the hosted flow sends payers who cannot proceed (e.g. unsupported bank). */
  exitUri?: string;
  /** Scheme enablement varies per account — override the conservative defaults. */
  paymentMethods?: PaymentMethodCapability[];
  baseUrl?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /**
   * Abort a hung GoCardless connection after this many milliseconds (default
   * 30000; GoCardless's own server-side limit is 29s). The timer covers the
   * whole exchange including the response body read. Timed-out requests are
   * safe to retry (see maxNetworkRetries) and surface as retryable
   * psp_unavailable errors.
   */
  requestTimeoutMs?: number;
  /**
   * Automatic retries for transport-level trouble only (network failure,
   * timeout, HTTP 5xx, 429) with exponential backoff. Default 2. Safe for
   * mutating calls: billing-request/refund creates and cancel actions carry
   * an Idempotency-Key, and a replayed flow create only re-issues an
   * authorisation URL for the same billing request. Business errors
   * (validation, invalid_state, permissions) are NEVER retried here.
   */
  maxNetworkRetries?: number;
  /** Injected backoff sleep for retry tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** Structural shapes of GoCardless REST resources (wire names, snake_case). */
export interface GoCardlessBillingRequestLike {
  id: string;
  created_at?: string;
  status?: string;
  metadata?: Record<string, string>;
  payment_request?: {
    amount?: number;
    currency?: string;
    description?: string;
    scheme?: string;
    metadata?: Record<string, string>;
  };
  mandate_request?: { currency?: string; scheme?: string };
  links?: {
    payment_request_payment?: string;
    mandate_request_mandate?: string;
    customer?: string;
    creditor?: string;
  };
}

export interface GoCardlessPaymentLike {
  id: string;
  created_at?: string;
  charge_date?: string;
  amount?: number;
  /** Source of truth for amountRefunded — increments as refunds land. */
  amount_refunded?: number;
  currency?: string;
  description?: string;
  reference?: string;
  scheme?: string;
  status?: string;
  metadata?: Record<string, string>;
  links?: { mandate?: string; creditor?: string; payout?: string };
}

export interface GoCardlessRefundLike {
  id: string;
  created_at?: string;
  amount?: number;
  currency?: string;
  reference?: string;
  status?: string;
  metadata?: Record<string, string>;
  links?: { payment?: string; mandate?: string };
}

interface GoCardlessBillingRequestFlowLike {
  id: string;
  authorisation_url?: string;
  expires_at?: string;
  links?: { billing_request?: string };
}

interface GoCardlessMandateLike {
  id: string;
  reference?: string;
  scheme?: string;
  status?: string;
}

interface GoCardlessListMeta {
  cursors?: { before?: string | null; after?: string | null };
  limit?: number;
}

interface RequestOptions {
  body?: unknown;
  /** GoCardless dedupes creates on this header — the idempotency mechanism. */
  idempotencyKey?: string;
  /** Response envelope key to unwrap ({"payments": {...}} -> {...}); lists stay wrapped. */
  envelope?: string;
}

/**
 * One-off billing request payments (Instant Bank Pay / "Pay by Bank") are
 * GBP/EUR only; the classic debit schemes list what the fulfilled payment can
 * report. Everything is flow "redirect": bank authorisation is only permitted
 * from GoCardless-hosted UIs, so an embedded flow cannot honestly be claimed.
 */
const DEFAULT_METHODS: PaymentMethodCapability[] = [
  { type: "bank_redirect_generic", flow: "redirect", supported: true },
  { type: "sepa_debit", flow: "redirect", supported: true },
  { type: "bacs_debit", flow: "redirect", supported: true },
  { type: "ach", flow: "redirect", supported: false },
];

const SUPPORTED_ONE_OFF_CURRENCIES = new Set(["GBP", "EUR"]);

export class GoCardlessServerAdapter implements ServerPaymentAdapter {
  readonly pspName = GOCARDLESS_PSP_NAME;
  private readonly config: GoCardlessServerAdapterConfig;
  private readonly baseUrl: string;

  constructor(config: GoCardlessServerAdapterConfig) {
    if (!config.accessToken) {
      throw PayFanoutError.invalidRequest("GoCardlessServerAdapter config.accessToken is required");
    }
    if (config.environment !== "sandbox" && config.environment !== "live") {
      throw PayFanoutError.invalidRequest(
        'GoCardlessServerAdapter config.environment must be "sandbox" or "live"',
      );
    }
    if (normalizeSecrets(config.webhookSecret).length === 0) {
      throw PayFanoutError.invalidRequest(
        "GoCardlessServerAdapter config.webhookSecret is required (one secret, or several during rotation)",
      );
    }
    if (config.requestTimeoutMs !== undefined && !(config.requestTimeoutMs > 0)) {
      throw PayFanoutError.invalidRequest("GoCardlessServerAdapter config.requestTimeoutMs must be > 0");
    }
    this.config = config;
    this.baseUrl =
      config.baseUrl ??
      (config.environment === "live" ? "https://api.gocardless.com" : "https://api-sandbox.gocardless.com");
  }

  getCapabilities(): AdapterCapabilities {
    return {
      pspName: this.pspName,
      // One-off billing request payments are GBP/EUR only (other GoCardless
      // currencies need a mandate first) — declared so the router pre-screens.
      supportedCurrencies: [...SUPPORTED_ONE_OFF_CURRENCIES],
      supportsRefunds: true,
      supportsPartialRefunds: true,
      supportsManualCapture: false, // bank debits/credits have no authorize-then-capture split
      supportsMultiCapture: false,
      supportsPaymentMethodVerification: false, // no zero-amount verification without creating a mandate
      // GoCardless mandates ARE reusable charging handles, but bank debits
      // confirm asynchronously (days) — the vault contract's instantly
      // succeeded off-session charge cannot be met honestly. Mandates-as-vault
      // is documented as future work in the guide.
      supportsSavedPaymentMethods: false,
      supportsSessionUpdate: false, // a billing request's payment_request cannot be amended — cancel + recreate
      supportsEventPolling: true, // GET /events — the missed-webhook recovery path
      supportsListing: true,
      requiresServerCompletion: false, // the hosted flow fulfils the billing request itself
      paymentMethods: this.config.paymentMethods ?? DEFAULT_METHODS,
    };
  }

  /**
   * Creates the billing request (the payment) plus the billing request flow
   * (the GoCardless-hosted authorisation UI). The session's clientSecret is
   * the flow's authorisation_url — the client adapter redirects the payer to
   * it, GoCardless fulfils the billing request on completion (auto_fulfil is
   * always on), and the outcome is confirmed via webhooks or retrievePayment.
   */
  async createPaymentSession(input: CreatePaymentSessionInput): Promise<PaymentSession> {
    assertMinorUnitAmount(input.amount, "amount");
    const currency = normalizeCurrency(input.currency);
    if (!SUPPORTED_ONE_OFF_CURRENCIES.has(currency)) {
      // One-off billing request payments support GBP and EUR only; the other
      // GoCardless currencies need a Direct Debit mandate first.
      throw PayFanoutError.invalidRequest(
        `GoCardless one-off bank payments support GBP and EUR only, got ${currency}`,
        { currency },
      );
    }
    if (!input.returnUrl) {
      throw PayFanoutError.invalidRequest(
        "GoCardless sessions require returnUrl — the hosted bank authorisation flow redirects the payer back to it",
        { missing: "returnUrl" },
      );
    }
    if (input.paymentMethodTypes?.some((type) => !this.isSupportedMethodType(type))) {
      throw PayFanoutError.invalidRequest(
        `GoCardless adapter does not support one of the requested payment method types: ${input.paymentMethodTypes.join(", ")}`,
        { paymentMethodTypes: input.paymentMethodTypes },
      );
    }

    const metadata = toStampedMetadata(input);
    const billingRequest = await this.createWithIdempotencyReplay<GoCardlessBillingRequestLike>(
      "billing_requests",
      {
        billing_requests: {
          payment_request: {
            amount: input.amount,
            currency,
            // `description` is mandatory on payment requests (422 "can't be
            // blank", sandbox-verified) and is shown to the payer during
            // authorisation. `reference` is restricted to PayTo/direct-
            // settlement accounts, so the statement text rides the
            // description instead of failing the payment.
            description:
              input.statementDescriptor ??
              input.metadata?.description ??
              (input.id ? `Payment ${input.id}` : "Payment"),
            // payment_request.metadata is stored on the payment the billing
            // request creates — how payfanout_id and host metadata reach
            // retrievePayment once the payment exists.
            ...(metadata ? { metadata } : {}),
          },
          ...(this.config.fallbackEnabled !== undefined
            ? { fallback_enabled: this.config.fallbackEnabled }
            : {}),
          ...(metadata ? { metadata } : {}),
        },
      },
      input.idempotencyKey,
    );

    // GoCardless does not dedupe flow creates — two POSTs with the same
    // Idempotency-Key return two different flows (sandbox-verified
    // 2026-07-07) — so the flow goes out plain. A replayed session therefore
    // returns the same billing request with a fresh authorisation_url; every
    // flow authorises that one billing request, so there is no
    // duplicate-payment risk.
    const flow = await this.request<GoCardlessBillingRequestFlowLike>("POST", "/billing_request_flows", {
      body: {
        billing_request_flows: {
          redirect_uri: input.returnUrl,
          ...(this.config.exitUri ? { exit_uri: this.config.exitUri } : {}),
          ...(toPrefilledCustomer(input) ?? {}),
          links: { billing_request: billingRequest.id },
        },
      },
      envelope: "billing_request_flows",
    });
    if (!flow.authorisation_url) {
      throw new PayFanoutError({
        code: "unknown",
        message: "GoCardless returned a billing request flow without an authorisation URL.",
        retryable: false,
        raw: flow,
        pspName: this.pspName,
      });
    }

    return {
      id: input.id ?? billingRequest.id,
      pspName: this.pspName,
      pspSessionId: billingRequest.id,
      clientSecret: flow.authorisation_url,
      amount: input.amount,
      currency,
      status: "requires_action",
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
  }

  /**
   * Accepts BOTH ids the host may hold — GoCardless ids are typed by prefix
   * (BRQ = billing request/session, PM = payment) — so the redirect return
   * trip can resolve outcomes from the session id alone.
   */
  async retrievePayment(pspPaymentId: string): Promise<PaymentInfo> {
    if (pspPaymentId.startsWith("BRQ")) return this.retrieveViaBillingRequest(pspPaymentId);
    const payment = await this.request<GoCardlessPaymentLike>(
      "GET",
      `/payments/${encodeURIComponent(pspPaymentId)}`,
      { envelope: "payments" },
    );
    return this.toPaymentInfo(payment, { mandateReference: await this.mandateReference(payment) });
  }

  private async retrieveViaBillingRequest(billingRequestId: string): Promise<PaymentInfo> {
    const billingRequest = await this.request<GoCardlessBillingRequestLike>(
      "GET",
      `/billing_requests/${encodeURIComponent(billingRequestId)}`,
      { envelope: "billing_requests" },
    );
    const paymentId = billingRequest.links?.payment_request_payment;
    if (!paymentId) return this.billingRequestToPaymentInfo(billingRequest);
    const payment = await this.request<GoCardlessPaymentLike>(
      "GET",
      `/payments/${encodeURIComponent(paymentId)}`,
      { envelope: "payments" },
    );
    return this.toPaymentInfo(payment, {
      mandateReference: await this.mandateReference(payment),
      billingRequest,
    });
  }

  /** Session-side view while no payment exists yet — derived from the billing request state. */
  private billingRequestToPaymentInfo(billingRequest: GoCardlessBillingRequestLike): PaymentInfo {
    return {
      id: billingRequest.metadata?.["payfanout_id"] ?? billingRequest.id,
      pspName: this.pspName,
      pspPaymentId: billingRequest.id,
      status: mapBillingRequestStatus(billingRequest.status),
      amount: billingRequest.payment_request?.amount ?? 0,
      amountRefunded: 0,
      currency: (billingRequest.payment_request?.currency ?? "").toUpperCase() || "GBP",
      paymentMethodType: mapSchemeToMethodType(billingRequest.payment_request?.scheme),
      ...(billingRequest.metadata ? { metadata: billingRequest.metadata } : {}),
      createdAt: billingRequest.created_at ?? EPOCH,
      raw: billingRequest,
    };
  }

  /**
   * Cancels whichever stage the id names: a billing request pre-fulfilment
   * (expires its flows), or a payment — GoCardless only cancels
   * pending_submission payments, anything later rejects with invalid_state
   * (cancellation_failed) -> invalid_request, never retried. The caller's key
   * rides the Idempotency-Key header (GoCardless accepts it on POST actions).
   */
  async cancelPayment(pspPaymentId: string, idempotencyKey: string): Promise<PaymentInfo> {
    if (pspPaymentId.startsWith("BRQ")) {
      const billingRequest = await this.request<GoCardlessBillingRequestLike>(
        "POST",
        `/billing_requests/${encodeURIComponent(pspPaymentId)}/actions/cancel`,
        { body: {}, idempotencyKey, envelope: "billing_requests" },
      );
      return this.billingRequestToPaymentInfo(billingRequest);
    }
    const payment = await this.request<GoCardlessPaymentLike>(
      "POST",
      `/payments/${encodeURIComponent(pspPaymentId)}/actions/cancel`,
      { body: {}, idempotencyKey, envelope: "payments" },
    );
    return this.toPaymentInfo(payment, { mandateReference: await this.mandateReference(payment) });
  }

  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    if (req.amount !== undefined) assertMinorUnitAmount(req.amount, "refund amount");
    // A fresh read anchors total_amount_confirmation — GoCardless's guard
    // against concurrent double refunds. `amount` is mandatory on POST
    // /refunds, so "full refund" is resolved here as the unrefunded remainder.
    const payment = await this.request<GoCardlessPaymentLike>(
      "GET",
      `/payments/${encodeURIComponent(req.pspPaymentId)}`,
      { envelope: "payments" },
    );
    const alreadyRefunded = payment.amount_refunded ?? 0;
    const amount = req.amount ?? Math.max(0, (payment.amount ?? 0) - alreadyRefunded);
    if (amount <= 0) {
      throw PayFanoutError.invalidRequest(`Payment ${req.pspPaymentId} has nothing left to refund`, payment);
    }
    if (alreadyRefunded + amount > (payment.amount ?? 0)) {
      throw PayFanoutError.invalidRequest(
        `Refund of ${amount} exceeds the remaining refundable amount on payment ${req.pspPaymentId}`,
        payment,
      );
    }
    const refund = await this.createWithIdempotencyReplay<GoCardlessRefundLike>(
      "refunds",
      {
        refunds: {
          amount,
          total_amount_confirmation: alreadyRefunded + amount,
          links: { payment: req.pspPaymentId },
          ...(req.reason ? { metadata: { reason: req.reason } } : {}),
        },
      },
      req.idempotencyKey,
    );
    return {
      refundId: refund.id,
      status: mapGoCardlessRefundStatus(refund.status),
      amount: refund.amount ?? amount,
      raw: refund,
    };
  }

  /** Polls an async refund to a terminal state — bank refunds submit on debit-scheme timing. */
  async retrieveRefund(refundId: string): Promise<RefundInfo> {
    const refund = await this.request<GoCardlessRefundLike>(
      "GET",
      `/refunds/${encodeURIComponent(refundId)}`,
      { envelope: "refunds" },
    );
    return {
      refundId: refund.id,
      status: mapGoCardlessRefundStatus(refund.status),
      amount: refund.amount ?? 0,
      ...(refund.links?.payment ? { pspPaymentId: refund.links.payment } : {}),
      ...(refund.created_at ? { createdAt: refund.created_at } : {}),
      raw: refund,
    };
  }

  /** Missed-webhook recovery: GET /events, normalized by the same mapper webhooks use. */
  async fetchEvents(input: FetchEventsInput = {}): Promise<FetchEventsResult> {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.cursor) query.set("after", input.cursor);
    if (input.since) query.set("created_at[gte]", toIso(input.since));
    const page = await this.request<{ events?: GoCardlessEventLike[]; meta?: GoCardlessListMeta }>(
      "GET",
      withQuery("/events", query),
    );
    const events: UnifiedWebhookEvent[] = (page.events ?? []).map((event) => normalizeGoCardlessEvent(event));
    const nextCursor = page.meta?.cursors?.after;
    return { events, ...(nextCursor ? { nextCursor } : {}) };
  }

  async listPayments(input: ListPaymentsInput = {}): Promise<ListPaymentsResult> {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.cursor) query.set("after", input.cursor);
    if (input.createdAfter) query.set("created_at[gte]", toIso(input.createdAfter));
    if (input.createdBefore) query.set("created_at[lte]", toIso(input.createdBefore));
    const page = await this.request<{ payments?: GoCardlessPaymentLike[]; meta?: GoCardlessListMeta }>(
      "GET",
      withQuery("/payments", query),
    );
    // No per-payment mandate lookup here — a reconciliation page would fan out
    // into N extra API calls; mandateReference stays a retrievePayment fact.
    const payments = (page.payments ?? []).map((payment) => this.toPaymentInfo(payment));
    const nextCursor = page.meta?.cursors?.after;
    return { payments, ...(nextCursor ? { nextCursor } : {}) };
  }

  async listRefunds(input: ListRefundsInput = {}): Promise<ListRefundsResult> {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.cursor) query.set("after", input.cursor);
    if (input.createdAfter) query.set("created_at[gte]", toIso(input.createdAfter));
    if (input.createdBefore) query.set("created_at[lte]", toIso(input.createdBefore));
    // GET /refunds honors a ?payment= filter (sandbox-verified: 200 + the
    // scoped list) — scope server-side instead of paging everything down.
    if (input.pspPaymentId) query.set("payment", input.pspPaymentId);
    const page = await this.request<{ refunds?: GoCardlessRefundLike[]; meta?: GoCardlessListMeta }>(
      "GET",
      withQuery("/refunds", query),
    );
    const refunds = (page.refunds ?? []).map((refund) => this.toRefundInfo(refund));
    const nextCursor = page.meta?.cursors?.after;
    return { refunds, ...(nextCursor ? { nextCursor } : {}) };
  }

  async verifyWebhookSignature(rawBody: string, headers: Record<string, string>): Promise<boolean> {
    return verifyGoCardlessWebhookSignature(rawBody, headers, this.config.webhookSecret);
  }

  /**
   * Single-event contract method. GoCardless BATCHES up to 250 events per
   * delivery, so this only accepts single-event bodies — a multi-event
   * delivery throws (invalid_request) instead of silently dropping events.
   * Webhook ingress for GoCardless should verify once, then fan out with
   * parseGoCardlessWebhookEvents (see the package README for the recipe).
   */
  async parseWebhookEvent(rawBody: string): Promise<UnifiedWebhookEvent> {
    const events = parseGoCardlessWebhookEvents(rawBody);
    if (events.length === 1) return events[0]!;
    if (events.length === 0) {
      throw new PayFanoutError({
        code: "invalid_request",
        message: "GoCardless webhook delivery contains no events",
        retryable: false,
        raw: rawBody,
        pspName: this.pspName,
      });
    }
    throw new PayFanoutError({
      code: "invalid_request",
      message:
        `GoCardless webhook delivery contains ${events.length} events (GoCardless batches up to 250 per ` +
        "delivery) — verify the signature once, then fan out with parseGoCardlessWebhookEvents(rawBody) " +
        "instead of parseWebhookEvent",
      retryable: false,
      // The core contract keeps raw as the untouched PSP payload.
      raw: rawBody,
      pspName: this.pspName,
    });
  }

  private toPaymentInfo(
    payment: GoCardlessPaymentLike,
    extras: { mandateReference?: string; billingRequest?: GoCardlessBillingRequestLike } = {},
  ): PaymentInfo {
    return {
      id:
        payment.metadata?.["payfanout_id"] ??
        extras.billingRequest?.metadata?.["payfanout_id"] ??
        payment.id,
      pspName: this.pspName,
      pspPaymentId: payment.id,
      status: mapGoCardlessPaymentStatus(payment.status),
      amount: payment.amount ?? 0,
      amountRefunded: payment.amount_refunded ?? 0,
      currency: (payment.currency ?? "").toUpperCase() || "GBP",
      paymentMethodType: mapSchemeToMethodType(
        payment.scheme ?? extras.billingRequest?.payment_request?.scheme,
      ),
      // Echoed verbatim as stored at the PSP (payfanout_id slot included). No
      // amountCaptured/amountCapturable: bank debits have no capture split.
      ...(payment.metadata ? { metadata: payment.metadata } : {}),
      ...(extras.mandateReference ? { mandateReference: extras.mandateReference } : {}),
      createdAt: payment.created_at ?? EPOCH,
      raw: extras.billingRequest ? { billing_request: extras.billingRequest, payment } : payment,
    };
  }

  private toRefundInfo(refund: GoCardlessRefundLike): RefundInfo {
    return {
      refundId: refund.id,
      status: mapGoCardlessRefundStatus(refund.status),
      amount: refund.amount ?? 0,
      ...(refund.links?.payment ? { pspPaymentId: refund.links.payment } : {}),
      ...(refund.created_at ? { createdAt: refund.created_at } : {}),
      raw: refund,
    };
  }

  /**
   * The human-quotable reference lives on the mandate, not the payment — a
   * lazy lookup that must never fail the payment retrieval itself.
   */
  private async mandateReference(payment: GoCardlessPaymentLike): Promise<string | undefined> {
    const mandateId = payment.links?.mandate;
    if (!mandateId) return undefined;
    try {
      const mandate = await this.request<GoCardlessMandateLike>(
        "GET",
        `/mandates/${encodeURIComponent(mandateId)}`,
        { envelope: "mandates" },
      );
      return mandate.reference;
    } catch {
      // A payment stays retrievable even when the mandate lookup fails.
      return undefined;
    }
  }

  /**
   * POST-create with GoCardless's native Idempotency-Key semantics: a consumed
   * key answers 409 idempotent_creation_conflict naming the existing resource
   * in links.conflicting_resource_id. The official client libraries fetch that
   * resource and return it as the create result, and so does this helper.
   * Billing requests and refunds only — GoCardless does not dedupe flow
   * creates (sandbox-verified), those go through request() plain.
   */
  private async createWithIdempotencyReplay<T>(
    collection: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<T> {
    try {
      return await this.request<T>("POST", `/${collection}`, { body, idempotencyKey, envelope: collection });
    } catch (err) {
      const conflictId = idempotentConflictResourceId(err);
      if (!conflictId) throw err;
      return this.request<T>("GET", `/${collection}/${encodeURIComponent(conflictId)}`, {
        envelope: collection,
      });
    }
  }

  /** A type declared with supported: false (e.g. ach in the defaults) must reject too. */
  private isSupportedMethodType(type: UnifiedPaymentMethodType): boolean {
    return (this.config.paymentMethods ?? DEFAULT_METHODS).some(
      (method) => method.type === type && method.supported,
    );
  }

  /**
   * Transport with timeout + transient-only retries. Safe to retry mutating
   * calls: billing-request/refund creates and cancel actions carry an
   * Idempotency-Key (a consumed create key 409s and the create helper
   * resolves it), and a replayed flow create only re-issues an authorisation
   * URL for the same billing request.
   */
  private request<T>(method: "GET" | "POST", path: string, options: RequestOptions = {}): Promise<T> {
    return withTransportRetries(() => this.requestOnce<T>(method, path, options), {
      attempts: 1 + (this.config.maxNetworkRetries ?? 2),
      sleep: this.config.sleep,
    });
  }

  private async requestOnce<T>(method: "GET" | "POST", path: string, options: RequestOptions): Promise<T> {
    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    const { response, text } = await requestWithTimeout(
      {
        fetch: this.config.fetch ?? fetch,
        timeoutMs,
        onFailure: (timedOut, cause) =>
          new PayFanoutError({
            code: "psp_unavailable",
            message: timedOut
              ? `GoCardless did not respond within ${timeoutMs}ms.`
              : "Could not reach GoCardless.",
            retryable: true,
            raw: cause,
            pspName: this.pspName,
          }),
      },
      `${this.baseUrl}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.config.accessToken}`,
          "gocardless-version": this.config.goCardlessVersion ?? DEFAULT_GOCARDLESS_VERSION,
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      },
    );
    const json = text ? safeJson(text) : undefined;
    if (!response.ok) throw mapGoCardlessError(response.status, json ?? text, path);
    const payload = json as Record<string, unknown> | undefined;
    return (options.envelope && payload ? payload[options.envelope] : payload) as T;
  }
}

function mapBillingRequestStatus(status: string | undefined): UnifiedPaymentStatus {
  switch (status) {
    case "cancelled":
      return "canceled";
    // Fulfilled but the payment link has not landed yet — money is underway.
    case "fulfilled":
      return "processing";
    // pending / ready_to_fulfil / fulfilling: the payer has not finished authorising.
    default:
      return "requires_action";
  }
}

function mapGoCardlessPaymentStatus(status: string | undefined): UnifiedPaymentStatus {
  switch (status) {
    case "pending_customer_approval":
      return "requires_action";
    case "pending_submission":
    case "submitted":
      return "processing";
    // confirmed = collected from the payer; paid_out only adds the merchant payout.
    case "confirmed":
    case "paid_out":
      return "succeeded";
    case "cancelled":
      return "canceled";
    case "failed":
    case "customer_approval_denied":
      return "failed";
    // Funds were reclaimed by the payer; the chargeback itself surfaces via events.
    case "charged_back":
      return "failed";
    default:
      return "processing";
  }
}

function mapGoCardlessRefundStatus(status: string | undefined): RefundResult["status"] {
  switch (status) {
    case "paid":
      return "succeeded";
    case "cancelled":
    case "bounced": // failed at the payer's bank
    case "funds_returned": // never reached the payer; money came back
      return "failed";
    default: // created / pending_submission / submitted
      return "pending";
  }
}

/**
 * Scheme -> unified method type. Payment requests without an explicit scheme
 * (the payer picks at the bank) still authorise via redirect, hence the
 * bank_redirect_generic default; unmapped debit schemes (pad, becs, becs_nz,
 * autogiro, betalingsservice, pay_to) stay "other" rather than mislabeled.
 */
function mapSchemeToMethodType(scheme: string | undefined): UnifiedPaymentMethodType {
  switch ((scheme ?? "").toLowerCase()) {
    case "bacs":
      return "bacs_debit";
    case "sepa_core":
      return "sepa_debit";
    case "ach":
      return "ach";
    case "faster_payments":
    case "sepa_credit_transfer":
    case "sepa_instant_credit_transfer":
    case "":
      return "bank_redirect_generic";
    default:
      return "other";
  }
}

/**
 * GoCardless error envelope: { error: { message, type, code, errors: [{reason,
 * field, message, links}] } } with type ∈ validation_failed | invalid_api_usage
 * | invalid_state | gocardless. Declines never arrive here — they surface as
 * payment `failed` statuses/events, not API errors.
 */
export function mapGoCardlessError(httpStatus: number, body: unknown, path?: string): PayFanoutError {
  const errorBody = (body as { error?: { type?: string; message?: string } } | undefined)?.error;
  const fallback = classifyHttpFallback(httpStatus);
  let code: UnifiedErrorCode;
  let retryable = false;
  let message: string;
  if (fallback.code === "rate_limited") {
    ({ code, retryable } = fallback);
    message = getUserMessage(code);
  } else if (fallback.code === "psp_unavailable" || errorBody?.type === "gocardless") {
    // type "gocardless" = internal error; the docs say these may be retried.
    code = "psp_unavailable";
    retryable = true;
    message = getUserMessage(code);
  } else if (httpStatus === 401) {
    code = "invalid_request";
    message = "GoCardless rejected the access token — check the credential and its environment.";
  } else if (httpStatus === 403) {
    code = "invalid_request";
    message = path?.startsWith("/refunds")
      ? "Refunds are not enabled on this GoCardless account — ask GoCardless support to switch them on."
      : "The GoCardless access token does not have permission for this operation.";
  } else {
    // 400/404/409/422 (validation_failed, invalid_api_usage, invalid_state):
    // caller-side facts — never retryable, the router must not cascade on them.
    ({ code, retryable } = fallback);
    message = getUserMessage(code);
  }
  return new PayFanoutError({ code, message, retryable, raw: body, pspName: GOCARDLESS_PSP_NAME });
}

/** Extracts links.conflicting_resource_id from a 409 idempotent_creation_conflict, else undefined. */
function idempotentConflictResourceId(err: unknown): string | undefined {
  if (!(err instanceof PayFanoutError)) return undefined;
  const details = (
    err.raw as
      | { error?: { errors?: Array<{ reason?: string; links?: { conflicting_resource_id?: string } }> } }
      | undefined
  )?.error?.errors;
  for (const detail of details ?? []) {
    if (detail.reason === "idempotent_creation_conflict" && detail.links?.conflicting_resource_id) {
      return detail.links.conflicting_resource_id;
    }
  }
  return undefined;
}

/**
 * GoCardless metadata allows at most 3 keys (50-char names, 500-char values).
 * payfanout_id claims a slot first so the host id round-trips; host keys fill
 * the remaining slots and overflow is withheld rather than failing the payment.
 * Stamped on the billing request AND its payment_request, so the facts survive
 * onto the payment GoCardless creates at fulfilment.
 */
function toStampedMetadata(input: CreatePaymentSessionInput): Record<string, string> | undefined {
  const metadata: Record<string, string> = {};
  if (input.id) metadata["payfanout_id"] = input.id;
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (Object.keys(metadata).length >= 3) break;
    if (!(key in metadata)) metadata[key] = value;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Prefills the hosted flow's customer step from billingDetails/receiptEmail —
 * GoCardless stores it unvalidated and the payer can review and amend it.
 * GoCardless sends payer notifications itself, so receiptEmail maps to the
 * payer email rather than a receipt setting.
 */
function toPrefilledCustomer(
  input: CreatePaymentSessionInput,
): { prefilled_customer: Record<string, string> } | undefined {
  const billing = input.billingDetails;
  const email = billing?.email ?? input.receiptEmail;
  const [givenName, ...familyRest] = (billing?.name ?? "").trim().split(/\s+/).filter(Boolean);
  const address = billing?.address;
  const prefilled: Record<string, string> = {
    ...(givenName ? { given_name: givenName } : {}),
    ...(familyRest.length > 0 ? { family_name: familyRest.join(" ") } : {}),
    ...(email ? { email } : {}),
    ...(address?.line1 ? { address_line1: address.line1 } : {}),
    ...(address?.city ? { city: address.city } : {}),
    ...(address?.postalCode ? { postal_code: address.postalCode } : {}),
    ...(address?.country ? { country_code: address.country } : {}),
  };
  return Object.keys(prefilled).length > 0 ? { prefilled_customer: prefilled } : undefined;
}

function withQuery(path: string, query: URLSearchParams): string {
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

function toIso(value: string | Date): string {
  return typeof value === "string" ? value : value.toISOString();
}
