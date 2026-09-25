import {
  assertMinorUnitAmount,
  classifyHttpFallback,
  getUserMessage,
  normalizeCurrency,
  normalizeSecrets,
  PayFanoutError,
  requestWithTimeout,
  safeJson,
  sha256Hex,
  withTransportRetries,
  type AdapterCapabilities,
  type CancelNativeSubscriptionInput,
  type CreateNativeSubscriptionInput,
  type CreatePaymentSessionInput,
  type FetchEventsInput,
  type FetchEventsResult,
  type ListNativeSubscriptionsInput,
  type ListNativeSubscriptionsResult,
  type ListPaymentsInput,
  type ListPaymentsResult,
  type ListRefundsInput,
  type ListRefundsResult,
  type NativeSubscriptionInterval,
  type NativeSubscriptionRecord,
  type NativeSubscriptionStatus,
  type PaymentInfo,
  type PaymentMethodCapability,
  type PaymentSession,
  type RefundInfo,
  type RefundRequest,
  type RefundResult,
  type RetrieveNativeSubscriptionInput,
  type ServerPaymentAdapter,
  type UnifiedErrorCode,
  type UnifiedPaymentMethodType,
  type UnifiedPaymentStatus,
  type UnifiedWebhookEvent,
  type VerifyCredentialsResult,
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

/**
 * Refund metadata key holding the SHA-256 (hex) of the idempotencyKey the
 * refund was created with: how a replay is recognised from GoCardless's own
 * data. The hash keeps the host's key out of the dashboard at a fixed 64
 * characters (metadata values allow 500).
 */
const REFUND_KEY_STAMP = "payfanout_key_sha256";

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
   * mutating calls: a retried create carries the same Idempotency-Key and
   * resolves to the resource GoCardless already created, a retried cancel
   * that finds the resource cancelled is resolved by re-reading it, and a
   * retried flow create only issues another authorisation URL for the same
   * billing request. Business errors (validation, invalid_state,
   * permissions) are NEVER retried here.
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

/**
 * Wire shape of a GoCardless subscription (snake_case). `interval` is the
 * NUMBER of interval_units between charges (unified `intervalCount`);
 * `upcoming_payments` carries up to 10 scheduled charges with their dates.
 */
export interface GoCardlessSubscriptionLike {
  id: string;
  created_at?: string;
  amount?: number;
  currency?: string;
  status?: string;
  /** Merchant-facing name; also set as the description on each payment created. */
  name?: string;
  start_date?: string;
  end_date?: string;
  /** Number of interval_units between charge dates (defaults to 1). */
  interval?: number;
  /** weekly | monthly | yearly. */
  interval_unit?: string;
  day_of_month?: number;
  month?: string;
  count?: number;
  payment_reference?: string;
  retry_if_possible?: boolean;
  earliest_charge_date_after_resume?: string;
  parent_plan_paused?: boolean;
  upcoming_payments?: Array<{ charge_date?: string; amount?: number }>;
  metadata?: Record<string, string>;
  links?: { mandate?: string };
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

/** The refund a refundPayment call settles on; `rejection` is GoCardless's answer to a create the stamp settled. */
interface RefundOutcome {
  refund: GoCardlessRefundLike;
  replayed: boolean;
  rejection?: unknown;
}

/**
 * One-off billing request payments (Instant Bank Pay / "Pay by Bank") are
 * GBP/EUR only; the classic debit schemes list what the fulfilled payment can
 * report. Everything is flow "redirect": bank authorisation is only permitted
 * from GoCardless-hosted UIs, so an embedded flow cannot honestly be claimed.
 */
const DEFAULT_METHODS: PaymentMethodCapability[] = [
  { type: "bank_redirect_generic", flow: "redirect", supported: true },
  // Bacs is GB-only ("GBP from UK bank accounts" per GoCardless). SEPA is a
  // zone, not a country — GoCardless states "the Eurozone" — so it carries no
  // country gate; a stale membership list would screen out valid payments.
  { type: "sepa_debit", flow: "redirect", supported: true, currencies: ["EUR"] },
  { type: "bacs_debit", flow: "redirect", supported: true, currencies: ["GBP"], countries: ["GB"] },
  { type: "ach", flow: "redirect", supported: false },
];

const SUPPORTED_ONE_OFF_CURRENCIES = new Set(["GBP", "EUR"]);

/**
 * Subscriptions charge a mandate, so they bill in every GoCardless debit
 * currency — unlike one-off billing request payments (GBP/EUR only).
 */
const SUBSCRIPTION_CURRENCIES = new Set(["AUD", "CAD", "DKK", "EUR", "GBP", "NZD", "SEK", "USD"]);

/**
 * GoCardless subscriptions bill weekly, monthly, or yearly only — "day" has
 * no faithful projection and must reject rather than approximate.
 */
const INTERVAL_UNIT_BY_INTERVAL: Partial<Record<NativeSubscriptionInterval, string>> = {
  week: "weekly",
  month: "monthly",
  year: "yearly",
};

const INTERVAL_BY_INTERVAL_UNIT: Record<string, NativeSubscriptionInterval> = {
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

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
    if (
      config.maxNetworkRetries !== undefined &&
      (!Number.isInteger(config.maxNetworkRetries) || config.maxNetworkRetries < 0)
    ) {
      throw PayFanoutError.invalidRequest(
        "GoCardlessServerAdapter config.maxNetworkRetries must be an integer >= 0",
      );
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
      supportsPaymentRetrieval: true, // GET /payments/:id
      supportsRefunds: true,
      supportsPartialRefunds: true,
      supportsRefundRetrieval: true, // GET /refunds/:id
      supportsManualCapture: false, // bank debits/credits have no authorize-then-capture split
      supportsMultiCapture: false,
      // The MONEY moves on debit-scheme timing (days), but the modification
      // calls themselves are not push-only: cancel and refund answer with the
      // resulting resource and its real status, not a bare acknowledgement.
      modificationOutcome: "synchronous",
      supportsPaymentMethodVerification: false, // no zero-amount verification without creating a mandate
      // GoCardless mandates ARE reusable charging handles, but bank debits
      // confirm asynchronously (days) — the vault contract's instantly
      // succeeded off-session charge cannot be met honestly. Mandates-as-vault
      // is documented as future work in the guide.
      supportsSavedPaymentMethods: false,
      supportsSessionUpdate: false, // a billing request's payment_request cannot be amended — cancel + recreate
      supportsEventPolling: true, // GET /events — the missed-webhook recovery path
      supportsListing: true,
      // The Subscriptions API is a full native billing engine: GoCardless
      // creates each payment against the mandate on its own schedule. All four
      // operations exist server-side, so all four are declared.
      nativeSubscriptions: { list: true, retrieve: true, create: true, cancel: true },
      // Webhook-Signature = hex HMAC-SHA256 of the whole raw delivery, batch
      // and all — verified once over the bytes, then fanned out per event.
      webhookSignatureScope: "raw-bytes",
      requiresServerCompletion: false, // the hosted flow fulfils the billing request itself
      paymentMethods: this.config.paymentMethods ?? DEFAULT_METHODS,
    };
  }

  /**
   * Side-effect-free credential probe — the engine behind a host "Test
   * connection" button. Makes ONE read-only GET /payments (limit 1) and reads
   * the RAW HTTP status so an auth rejection (401/403) is told apart from an
   * outage (429/5xx) directly from the status line, never from a body that a
   * proxy or edge error page may not carry. A single shot with no transport
   * retry loop: a "Test connection" click cannot hang on backoff, and a bad key
   * is not replayed. Never mutates PSP state, never puts the token in the result.
   */
  async verifyCredentials(): Promise<VerifyCredentialsResult> {
    let status: number;
    try {
      status = await this.probeStatus("/payments?limit=1");
    } catch {
      // requestWithTimeout rejects only on a network failure or timeout.
      return { ok: false, category: "network", message: "Could not reach GoCardless — try again." };
    }
    if (status === 401 || status === 403) {
      return {
        ok: false,
        category: "auth",
        message: "Authentication failed — check the GoCardless access token.",
      };
    }
    if (status === 429 || status >= 500) {
      return { ok: false, category: "network", message: "Could not reach GoCardless — try again." };
    }
    // The read-only GET authenticated — a healthy probe answers 200 with the list.
    return { ok: true };
  }

  /**
   * Creates the billing request (the payment) plus the billing request flow
   * (the GoCardless-hosted authorisation UI). The session's clientSecret is
   * the flow's authorisation_url — the client adapter redirects the payer to
   * it, GoCardless fulfils the billing request on completion (auto_fulfil is
   * always on), and the outcome is confirmed via webhooks or retrievePayment.
   *
   * A reused idempotencyKey resolves to the billing request GoCardless already
   * holds under it. GoCardless documents no parameter comparison, so the
   * adapter compares: its amount, currency and host `id` must match this
   * input, or the call rejects with `invalid_request`. The replayed session
   * reports the status of the payment the billing request created, as
   * `retrievePayment` does, except that a payment awaiting the customer's
   * approval reads `processing` where `retrievePayment` reports
   * `requires_action`: a replay of a billing request that has a payment
   * carries no `clientSecret`. While the billing request has no payment, the
   * session reports the billing request's own status. Only a `pending`
   * billing request gets a fresh authorisation URL; once the payer has
   * authorised, or the request is fulfilled or cancelled, the session carries
   * no `clientSecret`.
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
    const { resource: billingRequest, replayed } = await this.createWithIdempotencyReplay<GoCardlessBillingRequestLike>(
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

    let status: UnifiedPaymentStatus = "requires_action";
    let authorisable = true;
    if (replayed) {
      const mismatched = sessionReplayMismatches(billingRequest, {
        amount: input.amount,
        currency,
        id: metadata?.["payfanout_id"],
      });
      if (mismatched.length > 0) {
        throw idempotencyKeyReused("payment", "billing request", mismatched, {
          billing_request: billingRequest,
          mismatched,
        });
      }
      ({ status, authorisable } = await this.replayedSessionState(billingRequest));
    }
    // Past `pending` the payer has authorised, or nothing can be paid any
    // more: a new authorisation URL would only invite a second authorisation.
    const clientSecret = authorisable ? await this.createFlow(input, billingRequest.id) : undefined;

    return {
      id: input.id ?? billingRequest.id,
      pspName: this.pspName,
      pspSessionId: billingRequest.id,
      ...(clientSecret ? { clientSecret } : {}),
      amount: input.amount,
      currency,
      status,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
  }

  /**
   * Once the billing request names its payment, the payment's status stands,
   * so a replay never reports a failed payment as `processing`. That read
   * happens on replays only, and if it fails the billing request's own status
   * stands instead: failing the replay would let a router fail over to
   * another PSP for a payment that already exists.
   */
  private async replayedSessionState(
    billingRequest: GoCardlessBillingRequestLike,
  ): Promise<{ status: UnifiedPaymentStatus; authorisable: boolean }> {
    const status = mapBillingRequestStatus(billingRequest.status);
    const paymentId = billingRequest.links?.payment_request_payment;
    if (!paymentId) return { status, authorisable: status === "requires_action" };
    try {
      const payment = await this.request<GoCardlessPaymentLike>(
        "GET",
        `/payments/${encodeURIComponent(paymentId)}`,
        { envelope: "payments" },
      );
      const status = mapGoCardlessPaymentStatus(payment.status);
      // A replay carries no flow, so a payment awaiting the customer's approval
      // is something to wait for, not to act on.
      return { status: status === "requires_action" ? "processing" : status, authorisable: false };
    } catch {
      // Best effort, like the mandate lookup: the payment exists either way.
      return { status, authorisable: false };
    }
  }

  /**
   * GoCardless does not dedupe flow creates — two POSTs with the same
   * Idempotency-Key return two different flows (sandbox-verified 2026-07-07)
   * — so the flow goes out plain, and a replay of a pending session mints a
   * new one. Every flow authorises the one billing request, so a second flow
   * cannot duplicate the payment.
   */
  private async createFlow(input: CreatePaymentSessionInput, billingRequestId: string): Promise<string> {
    const flow = await this.request<GoCardlessBillingRequestFlowLike>("POST", "/billing_request_flows", {
      body: {
        billing_request_flows: {
          redirect_uri: input.returnUrl,
          ...(this.config.exitUri ? { exit_uri: this.config.exitUri } : {}),
          ...(toPrefilledCustomer(input) ?? {}),
          links: { billing_request: billingRequestId },
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
    return flow.authorisation_url;
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
   * (cancellation_failed) -> invalid_request, never retried.
   *
   * Verified-idempotent. GoCardless documents Idempotency-Key for creates
   * only, and documents cancellation_failed for cancelling a payment that is
   * already cancelled (what it answers for an already-cancelled billing
   * request is undocumented), so a repeated cancel can be refused although
   * the cancel it repeats went through. On any rejection the payment or
   * billing request is re-read, and one that is already cancelled resolves as
   * `canceled`; any other state rethrows the original error. The caller's key
   * still rides the Idempotency-Key header.
   */
  async cancelPayment(pspPaymentId: string, idempotencyKey: string): Promise<PaymentInfo> {
    const id = encodeURIComponent(pspPaymentId);
    if (pspPaymentId.startsWith("BRQ")) {
      const toInfo = (billingRequest: GoCardlessBillingRequestLike): PaymentInfo =>
        this.billingRequestToPaymentInfo(billingRequest);
      return this.verifiedCancel(
        async () =>
          toInfo(
            await this.request<GoCardlessBillingRequestLike>("POST", `/billing_requests/${id}/actions/cancel`, {
              body: {},
              idempotencyKey,
              envelope: "billing_requests",
            }),
          ),
        async () =>
          toInfo(
            await this.request<GoCardlessBillingRequestLike>("GET", `/billing_requests/${id}`, {
              envelope: "billing_requests",
            }),
          ),
      );
    }
    return this.verifiedCancel(
      async () => {
        const payment = await this.request<GoCardlessPaymentLike>("POST", `/payments/${id}/actions/cancel`, {
          body: {},
          idempotencyKey,
          envelope: "payments",
        });
        return this.toPaymentInfo(payment, { mandateReference: await this.mandateReference(payment) });
      },
      () => this.retrievePayment(pspPaymentId),
    );
  }

  /** The resource state decides, never the error shape: an already-cancelled re-read is the success. */
  private async verifiedCancel(
    cancel: () => Promise<PaymentInfo>,
    reread: () => Promise<PaymentInfo>,
  ): Promise<PaymentInfo> {
    try {
      return await cancel();
    } catch (err) {
      let info: PaymentInfo;
      try {
        info = await reread();
      } catch {
        // The re-read failing must not mask the original rejection.
        throw err;
      }
      if (info.status === "canceled") return info;
      throw err;
    }
  }

  /**
   * Refunds against a fresh read of the payment; omit `amount` to refund the
   * remainder. More than the remainder, or an explicit `amount` of 0, rejects
   * locally with `invalid_request`, and a payment or refund amount GoCardless
   * sends that is not a whole number rejects with `unknown`.
   *
   * Each refund is created with the SHA-256 of its idempotencyKey in its
   * GoCardless metadata (`payfanout_key_sha256`, next to `reason`), so a
   * replay is recognised from the refund itself. A reused key resolves to the
   * refund created with it, which must belong to this payment and, when an
   * amount is given, be for that amount, or the call rejects with
   * `invalid_request`. A request the remainder check refuses, such as the
   * replay of a refund that used up the payment, is never sent: the payment's
   * refunds are read and the one stamped with this key is returned, or the
   * refusal stands. A create GoCardless rejects is settled by the same read.
   * GoCardless lets accounts opt out of the total_amount_confirmation check,
   * so none of this relies on it, nor on whether GoCardless checks the key
   * before the request body. Refunds created by adapter versions without the
   * stamp are not recognised: a replay of one that the remainder check
   * refuses rejects, as it did before. While GoCardless reports an amount
   * already refunded on the payment, the stamp is also checked before any
   * create, so a key GoCardless no longer honours (it promises at least 30
   * days) is still read back instead of refunding again.
   *
   * A read of the payment's refunds that fails sends nothing further. A
   * transient failure rejects retryable (`psp_unavailable`, or
   * `rate_limited`), with GoCardless's answer to a rejected create on
   * `raw.rejection`; retry with the same key, as a new one can refund twice.
   * Any other failure of the read before a create is a final
   * `invalid_request`, and the refund is not sent.
   */
  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    // A blank key gives GoCardless nothing to dedupe on, while every such refund would share one stamp.
    if (typeof req.idempotencyKey !== "string" || req.idempotencyKey.trim() === "") {
      throw PayFanoutError.invalidRequest("refundPayment requires a non-empty idempotencyKey");
    }
    if (req.amount !== undefined) {
      assertMinorUnitAmount(req.amount, "refund amount");
      if (req.amount === 0) {
        throw PayFanoutError.invalidRequest(
          "A refund amount must be greater than 0 — omit amount to refund what is left",
          { amount: req.amount },
        );
      }
    }
    // A fresh read anchors total_amount_confirmation — GoCardless's guard
    // against concurrent double refunds. `amount` is mandatory on POST
    // /refunds, so "full refund" is resolved here as the unrefunded remainder.
    const payment = await this.request<GoCardlessPaymentLike>(
      "GET",
      `/payments/${encodeURIComponent(req.pspPaymentId)}`,
      { envelope: "payments" },
    );
    const paymentAmount = wireAmount(payment.amount);
    const alreadyRefunded = wireAmount(payment.amount_refunded);
    if (paymentAmount === undefined || alreadyRefunded === undefined) throw unreadableAmount("payment", payment);
    const amount = req.amount ?? Math.max(0, paymentAmount - alreadyRefunded);
    const refusal =
      amount === 0
        ? `Payment ${req.pspPaymentId} has nothing left to refund`
        : alreadyRefunded + amount > paymentAmount
          ? `Refund of ${amount} exceeds the remaining refundable amount on payment ${req.pspPaymentId}`
          : undefined;
    const stamp = await sha256Hex(req.idempotencyKey);
    let outcome: RefundOutcome | undefined;
    if (refusal !== undefined) {
      outcome = { refund: await this.resolveRefusedRefund(req, stamp, refusal, payment), replayed: true };
    } else {
      // Keys are honoured for 30 days at the least, so a refund GoCardless already counts may be this key's.
      if (alreadyRefunded > 0) outcome = await this.stampedRefundBeforeCreate(req, stamp, payment);
      outcome ??= await this.createRefund(req, amount, alreadyRefunded + amount, stamp);
    }
    const { refund, replayed, rejection } = outcome;
    const refundedAmount = wireAmount(refund.amount);
    if (refundedAmount === undefined) throw unreadableAmount("refund", refund);
    if (replayed) {
      const mismatched = refundReplayMismatches(refund, req);
      if (mismatched.length > 0) {
        throw idempotencyKeyReused("refund", "refund", mismatched, {
          refund,
          mismatched,
          ...(rejection !== undefined ? { rejection } : {}),
        });
      }
    }
    return {
      refundId: refund.id,
      status: mapGoCardlessRefundStatus(refund.status),
      amount: refundedAmount,
      raw: refund,
    };
  }

  /**
   * POST /refunds under the caller's key; a consumed key resolves to the
   * refund created with it. Any other rejection is checked against the
   * payment's refunds: one stamped with this key means the POST was a replay
   * GoCardless refused on its body, and that refund is the answer.
   */
  private async createRefund(
    req: RefundRequest,
    amount: number,
    totalAmountConfirmation: number,
    stamp: string,
  ): Promise<RefundOutcome> {
    try {
      const { resource, replayed } = await this.createWithIdempotencyReplay<GoCardlessRefundLike>(
        "refunds",
        toRefundBody(req, amount, totalAmountConfirmation, stamp),
        req.idempotencyKey,
      );
      return { refund: resource, replayed };
    } catch (err) {
      const rejection = PayFanoutError.wrap(err, { pspName: this.pspName });
      let original: GoCardlessRefundLike | undefined;
      try {
        original = await this.stampedRefund(req.pspPaymentId, stamp);
      } catch (lookupErr) {
        const lookup = PayFanoutError.wrap(lookupErr, { pspName: this.pspName });
        // An outage of the read leaves open whether this key already made a
        // refund GoCardless refused to repeat: a retry settles it, where the
        // rejection alone would read as final.
        if (lookup.retryable && !rejection.retryable) {
          throw new PayFanoutError({
            code: lookup.code,
            message: lookup.message,
            retryable: true,
            raw: { rejection: rejection.raw, lookup: lookup.raw },
            pspName: this.pspName,
          });
        }
        throw err;
      }
      if (!original) throw err;
      return { refund: original, replayed: true, rejection: rejection.raw };
    }
  }

  /**
   * The refund this key already made, read before a create while GoCardless
   * reports an amount refunded on the payment: a key GoCardless has stopped
   * honouring would otherwise be refunded afresh. The read exists only to
   * prevent that second refund, so a failed read sends nothing: a transient
   * failure stays retryable, and any other is a final refusal.
   */
  private async stampedRefundBeforeCreate(
    req: RefundRequest,
    stamp: string,
    payment: GoCardlessPaymentLike,
  ): Promise<RefundOutcome | undefined> {
    let original: GoCardlessRefundLike | undefined;
    try {
      original = await this.stampedRefund(req.pspPaymentId, stamp);
    } catch (err) {
      const lookup = PayFanoutError.wrap(err, { pspName: this.pspName });
      if (lookup.retryable) throw lookup;
      throw PayFanoutError.invalidRequest(
        "Could not read GoCardless's refund list to check for a refund already made with this idempotency key, " +
          `so the refund was not sent. Check the refunds of payment ${req.pspPaymentId} in the GoCardless dashboard.`,
        { payment, lookup: lookup.raw },
      );
    }
    return original ? { refund: original, replayed: true } : undefined;
  }

  /**
   * A request the remainder check refuses is sent nowhere. It can still be
   * the replay of a refund that used up the payment, and only the stamp tells:
   * the refund of this payment stamped with this key is returned, anything
   * else keeps the refusal, whose `raw` holds the payment and, when the read
   * was refused, its answer as `lookup`.
   */
  private async resolveRefusedRefund(
    req: RefundRequest,
    stamp: string,
    refusal: string,
    payment: GoCardlessPaymentLike,
  ): Promise<GoCardlessRefundLike> {
    let original: GoCardlessRefundLike | undefined;
    try {
      original = await this.stampedRefund(req.pspPaymentId, stamp);
    } catch (err) {
      const lookup = PayFanoutError.wrap(err, { pspName: this.pspName });
      // A transient failure leaves open whether this is a replay: a retry with the same key settles it.
      if (lookup.retryable) throw lookup;
      throw PayFanoutError.invalidRequest(refusal, { payment, lookup: lookup.raw });
    }
    if (!original) throw PayFanoutError.invalidRequest(refusal, { payment });
    return original;
  }

  /**
   * The refund of this payment created with the key behind `stamp`, if any.
   * One page holds every refund of a payment: GoCardless allows at most five.
   * Should two carry the stamp (a key reused after GoCardless stopped
   * honouring it), the newest was created by the latest request.
   */
  private async stampedRefund(pspPaymentId: string, stamp: string): Promise<GoCardlessRefundLike | undefined> {
    const page = await this.request<{ refunds?: GoCardlessRefundLike[] }>(
      "GET",
      withQuery("/refunds", new URLSearchParams({ payment: pspPaymentId, limit: "500" })),
    );
    let match: GoCardlessRefundLike | undefined;
    for (const refund of page.refunds ?? []) {
      if (refund.metadata?.[REFUND_KEY_STAMP] !== stamp) continue;
      if (!match || (refund.created_at ?? "") > (match.created_at ?? "")) match = refund;
    }
    return match;
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
    if (input.limit !== undefined) query.set("limit", String(clampPageSize(input.limit)));
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
    if (input.limit !== undefined) query.set("limit", String(clampPageSize(input.limit)));
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
    if (input.limit !== undefined) query.set("limit", String(clampPageSize(input.limit)));
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

  /**
   * Creates a subscription GoCardless itself bills (POST /subscriptions)
   * against an existing MANDATE — `savedPaymentMethodToken` is the mandate id
   * (`MD...`), and GoCardless derives the customer from it, so
   * `pspCustomerId` is ignored. Cadence is weekly/monthly/yearly only:
   * interval "day" and RRULE `schedule`s reject (`invalid_request`) instead
   * of approximating. `merchantRefNum` rides the dedicated `name` field
   * (max 255 chars; GoCardless also sets it as the description on each
   * payment created) — never `payment_reference`, which is restricted to
   * accounts with their own Service User Number. `startAt` maps to the
   * date-only `start_date` (the instant's stated calendar date); omitted, the
   * first charge lands on the mandate's next_possible_charge_date. `planId`
   * rejects: GoCardless subscriptions have no plan object.
   */
  async createNativeSubscription(input: CreateNativeSubscriptionInput): Promise<NativeSubscriptionRecord> {
    assertMinorUnitAmount(input.amount, "amount");
    if (input.amount === 0) {
      throw PayFanoutError.invalidRequest("createNativeSubscription requires a positive amount", { input });
    }
    const currency = normalizeCurrency(input.currency);
    if (!SUBSCRIPTION_CURRENCIES.has(currency)) {
      throw PayFanoutError.invalidRequest(
        `GoCardless subscriptions support AUD, CAD, DKK, EUR, GBP, NZD, SEK and USD, got ${currency}`,
        { currency },
      );
    }
    if (!input.savedPaymentMethodToken) {
      throw PayFanoutError.invalidRequest(
        "createNativeSubscription requires savedPaymentMethodToken — the GoCardless mandate id the subscription charges",
        { missing: "savedPaymentMethodToken" },
      );
    }
    if (input.schedule !== undefined) {
      throw PayFanoutError.invalidRequest(
        "GoCardless subscriptions have no RRULE surface — express the cadence as interval week/month/year",
        { schedule: input.schedule },
      );
    }
    if (!input.interval) {
      throw PayFanoutError.invalidRequest(
        "createNativeSubscription requires a billing cadence — pass interval week/month/year",
        { missing: "interval" },
      );
    }
    const intervalUnit = INTERVAL_UNIT_BY_INTERVAL[input.interval];
    if (!intervalUnit) {
      throw PayFanoutError.invalidRequest(
        `GoCardless subscriptions bill weekly, monthly, or yearly — interval "${input.interval}" has no faithful projection`,
        { interval: input.interval },
      );
    }
    if (
      input.intervalCount !== undefined &&
      (!Number.isInteger(input.intervalCount) || input.intervalCount < 1)
    ) {
      throw PayFanoutError.invalidRequest(
        "createNativeSubscription intervalCount must be a positive integer",
        { intervalCount: input.intervalCount },
      );
    }
    if (input.planId !== undefined) {
      throw PayFanoutError.invalidRequest(
        "GoCardless subscriptions have no plan object — omit planId",
        { planId: input.planId },
      );
    }
    if (input.merchantRefNum !== undefined && input.merchantRefNum.length > 255) {
      throw PayFanoutError.invalidRequest(
        "merchantRefNum rides the GoCardless subscription name, which must not exceed 255 characters",
        { length: input.merchantRefNum.length },
      );
    }
    const startDate = input.startAt === undefined ? undefined : toStartDate(input.startAt);
    const metadata = toStampedMetadata(input);
    const { resource: subscription } = await this.createWithIdempotencyReplay<GoCardlessSubscriptionLike>(
      "subscriptions",
      {
        subscriptions: {
          amount: input.amount,
          currency,
          interval_unit: intervalUnit,
          ...(input.intervalCount !== undefined ? { interval: input.intervalCount } : {}),
          ...(startDate ? { start_date: startDate } : {}),
          ...(input.merchantRefNum ? { name: input.merchantRefNum } : {}),
          ...(metadata ? { metadata } : {}),
          links: { mandate: input.savedPaymentMethodToken },
        },
      },
      input.idempotencyKey,
    );
    return this.toNativeSubscriptionRecord(subscription);
  }

  /** Pages GET /subscriptions with GoCardless cursor semantics (`after`; limit 1-500, default 50). */
  async listNativeSubscriptions(
    input: ListNativeSubscriptionsInput = {},
  ): Promise<ListNativeSubscriptionsResult> {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set("limit", String(clampPageSize(input.limit)));
    if (input.cursor) query.set("after", input.cursor);
    const page = await this.request<{
      subscriptions?: GoCardlessSubscriptionLike[];
      meta?: GoCardlessListMeta;
    }>("GET", withQuery("/subscriptions", query));
    const subscriptions = (page.subscriptions ?? []).map((s) => this.toNativeSubscriptionRecord(s));
    const nextCursor = page.meta?.cursors?.after;
    return { subscriptions, ...(nextCursor ? { nextCursor } : {}) };
  }

  /** GET /subscriptions/:id — the subscription id alone keys retrieval (savedPaymentMethodToken is not needed). */
  async retrieveNativeSubscription(
    input: RetrieveNativeSubscriptionInput,
  ): Promise<NativeSubscriptionRecord> {
    const subscription = await this.request<GoCardlessSubscriptionLike>(
      "GET",
      `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      { envelope: "subscriptions" },
    );
    return this.toNativeSubscriptionRecord(subscription);
  }

  /**
   * POST /subscriptions/:id/actions/cancel — stops FUTURE payment creation
   * only: payments the subscription has already created still collect unless
   * they are cancelled separately (GoCardless documents this explicitly).
   * GoCardless rejects the action with a cancellation_failed invalid_state
   * error once a subscription is already cancelled or finished, so this is
   * verified-idempotent: on any rejection the subscription is re-fetched and
   * a terminal state resolves as success — the billing stop the caller asked
   * for already holds. The caller's key rides the Idempotency-Key header,
   * matching the adapter's other cancel actions.
   */
  async cancelNativeSubscription(input: CancelNativeSubscriptionInput): Promise<NativeSubscriptionRecord> {
    const path = `/subscriptions/${encodeURIComponent(input.subscriptionId)}`;
    try {
      const subscription = await this.request<GoCardlessSubscriptionLike>(
        "POST",
        `${path}/actions/cancel`,
        { body: {}, idempotencyKey: input.idempotencyKey, envelope: "subscriptions" },
      );
      return this.toNativeSubscriptionRecord(subscription);
    } catch (err) {
      // The resource state decides, never the error shape: a terminal
      // re-fetch means billing is already stopped, whatever the action said.
      let record: NativeSubscriptionRecord;
      try {
        record = this.toNativeSubscriptionRecord(
          await this.request<GoCardlessSubscriptionLike>("GET", path, { envelope: "subscriptions" }),
        );
      } catch {
        // The re-fetch failing must not mask the original rejection.
        throw err;
      }
      if (record.status === "canceled" || record.status === "completed") return record;
      throw err;
    }
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

  /**
   * Wire subscription -> unified record. GoCardless's `interval` is the count
   * of `interval_unit`s, so it lands on `intervalCount` (default 1); an
   * unrecognized interval_unit omits the cadence pair rather than guessing.
   * `currentPeriodEnd` is the earliest upcoming charge_date — when the next
   * charge is due. There is no currentPeriodStart fact to report (start_date
   * is the FIRST charge, not the running period), and the mandate is the
   * reusable charging handle, so it doubles as savedPaymentMethodToken.
   */
  private toNativeSubscriptionRecord(subscription: GoCardlessSubscriptionLike): NativeSubscriptionRecord {
    const interval = INTERVAL_BY_INTERVAL_UNIT[subscription.interval_unit ?? ""];
    const currentPeriodEnd = earliestUpcomingChargeDate(subscription);
    return {
      id: subscription.id,
      pspName: this.pspName,
      status: mapGoCardlessSubscriptionStatus(subscription.status),
      amount: subscription.amount ?? 0,
      currency: (subscription.currency ?? "").toUpperCase() || "GBP",
      ...(interval ? { interval, intervalCount: subscription.interval ?? 1 } : {}),
      ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
      ...(subscription.links?.mandate ? { savedPaymentMethodToken: subscription.links.mandate } : {}),
      ...(subscription.name ? { merchantRefNum: subscription.name } : {}),
      raw: subscription,
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
   * resource and return it as the create result, and so does this helper,
   * flagged `replayed` — GoCardless documents no parameter comparison, so
   * callers check the resource against their input. Billing requests, refunds
   * and subscriptions only — GoCardless does not dedupe flow creates
   * (sandbox-verified), those go out plain.
   */
  private async createWithIdempotencyReplay<T>(
    collection: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<{ resource: T; replayed: boolean }> {
    try {
      const resource = await this.request<T>("POST", `/${collection}`, {
        body,
        idempotencyKey,
        envelope: collection,
      });
      return { resource, replayed: false };
    } catch (err) {
      const conflictId = idempotentConflictResourceId(err);
      if (!conflictId) throw err;
      const resource = await this.request<T>("GET", `/${collection}/${encodeURIComponent(conflictId)}`, {
        envelope: collection,
      });
      return { resource, replayed: true };
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
   * calls: creates carry an Idempotency-Key (a consumed key 409s and the
   * create helper resolves it), cancels are verified by re-reading the
   * resource, and a replayed flow create only issues another authorisation
   * URL for the same billing request.
   */
  private request<T>(method: "GET" | "POST", path: string, options: RequestOptions = {}): Promise<T> {
    return withTransportRetries(() => this.requestOnce<T>(method, path, options), {
      attempts: 1 + (this.config.maxNetworkRetries ?? 2),
      sleep: this.config.sleep,
    });
  }

  /**
   * One read-only exchange returning the RAW HTTP status instead of mapping a
   * non-2xx into a PayFanoutError — verifyCredentials needs the status itself to
   * tell an auth rejection (401/403) apart from an outage (429/5xx), without
   * depending on the error body carrying a numeric code. No retry loop: a single
   * probe is the contract. A network failure/timeout rejects.
   */
  private async probeStatus(path: string): Promise<number> {
    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    const { response } = await requestWithTimeout(
      {
        fetch: this.config.fetch ?? fetch,
        timeoutMs,
        onFailure: (_timedOut, cause) =>
          cause instanceof Error ? cause : new Error("GoCardless connectivity probe failed"),
      },
      `${this.baseUrl}${path}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.config.accessToken}`,
          "gocardless-version": this.config.goCardlessVersion ?? DEFAULT_GOCARDLESS_VERSION,
        },
      },
    );
    return response.status;
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

/**
 * Only `pending` still waits on the payer: a billing request is ready to
 * fulfil once every action required to fulfil it is complete (bank
 * authorisation, on Pay by Bank), so ready_to_fulfil, fulfilling and a
 * fulfilled request whose payment link has not landed are all money underway.
 * Undocumented states read as processing too, since requires_action would
 * invite a second authorisation of the same payment.
 */
function mapBillingRequestStatus(status: string | undefined): UnifiedPaymentStatus {
  switch (status) {
    case "pending":
      return "requires_action";
    case "cancelled":
      return "canceled";
    default:
      return "processing";
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

/**
 * Documented subscription statuses: pending_customer_approval |
 * customer_approval_denied | active | finished | cancelled | paused.
 * customer_approval_denied is terminal — the customer refused the approval,
 * nothing was ever billed and no payments will be created — and GoCardless
 * groups it with the non-cancellable states (cancellation_failed), so it
 * projects to "canceled": billing is permanently stopped. Anything
 * undocumented stays "unknown", never guessed.
 */
function mapGoCardlessSubscriptionStatus(status: string | undefined): NativeSubscriptionStatus {
  switch (status) {
    case "pending_customer_approval":
      return "pending";
    case "active":
      return "active";
    case "paused":
      return "paused";
    // All scheduled payments have been created — the finite schedule ran out.
    case "finished":
      return "completed";
    case "cancelled":
    case "customer_approval_denied":
      return "canceled";
    default:
      return "unknown";
  }
}

/** Earliest of the up-to-10 upcoming charges (date-only strings sort lexically). */
function earliestUpcomingChargeDate(subscription: GoCardlessSubscriptionLike): string | undefined {
  let earliest: string | undefined;
  for (const payment of subscription.upcoming_payments ?? []) {
    if (payment.charge_date && (!earliest || payment.charge_date < earliest)) {
      earliest = payment.charge_date;
    }
  }
  return earliest;
}

/**
 * GoCardless date fields want YYYY-MM-DD. An ISO instant keeps its STATED
 * calendar date (no timezone math — the caller's date is the authority).
 */
function toStartDate(startAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(startAt.trim());
  if (!match || Number.isNaN(Date.parse(startAt.trim()))) {
    throw PayFanoutError.invalidRequest(
      `startAt must be an ISO 8601 date or instant, got: ${startAt}`,
      { startAt },
    );
  }
  return match[1]!;
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
 * bank_redirect_generic default; debit schemes with no unified type (becs,
 * becs_nz, autogiro, betalingsservice, pay_to) stay "other" rather than
 * mislabeled.
 */
function mapSchemeToMethodType(scheme: string | undefined): UnifiedPaymentMethodType {
  switch ((scheme ?? "").toLowerCase()) {
    case "bacs":
      return "bacs_debit";
    case "sepa_core":
      return "sepa_debit";
    case "ach":
      return "ach";
    case "pad":
      return "pad";
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
 * What makes a replayed billing request this session's payment: the amount
 * and currency of its payment_request, and the stamped host id. Sessions send
 * no mandate_request and choose no scheme, so a mandate_request that is
 * present only has to share the payment's currency.
 */
function sessionReplayMismatches(
  billingRequest: GoCardlessBillingRequestLike,
  expected: { amount: number; currency: string; id: string | undefined },
): string[] {
  const paymentRequest = billingRequest.payment_request;
  const mandateCurrency = billingRequest.mandate_request?.currency;
  return [
    ...(wireAmount(paymentRequest?.amount) !== expected.amount ? ["amount"] : []),
    ...((paymentRequest?.currency ?? "").toUpperCase() !== expected.currency ? ["currency"] : []),
    ...(mandateCurrency !== undefined && mandateCurrency.toUpperCase() !== expected.currency
      ? ["mandate currency"]
      : []),
    ...(billingRequest.metadata?.["payfanout_id"] !== expected.id ? ["id"] : []),
  ];
}

/** A full refund's amount was the remainder at the time, so only a given amount is compared. */
function refundReplayMismatches(refund: GoCardlessRefundLike, req: RefundRequest): string[] {
  return [
    ...(refund.links?.payment !== req.pspPaymentId ? ["payment"] : []),
    ...(req.amount !== undefined && wireAmount(refund.amount) !== req.amount ? ["amount"] : []),
  ];
}

/**
 * Hosts show `message` to payers, so it names no GoCardless id: the resource
 * belongs to another request. The resource itself rides `raw`.
 */
function idempotencyKeyReused(
  kind: "payment" | "refund",
  resource: "billing request" | "refund",
  mismatched: string[],
  raw: unknown,
): PayFanoutError {
  return new PayFanoutError({
    code: "invalid_request",
    message:
      `Idempotency key reused for a different ${kind}: the ${resource} created with it does not match this ` +
      `request's ${mismatched.join(", ")}. Use a fresh key for a new ${kind}.`,
    retryable: false,
    raw,
    pspName: GOCARDLESS_PSP_NAME,
  });
}

/** GoCardless types amounts as integer or string; only a non-negative whole number reads. */
function wireAmount(value: unknown): number | undefined {
  const amount = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
}

/** Fails closed: no refund arithmetic, and no RefundResult, rests on an amount that does not read. */
function unreadableAmount(resource: "payment" | "refund", raw: unknown): PayFanoutError {
  return new PayFanoutError({
    code: "unknown",
    message: `GoCardless returned a ${resource} whose amount is not a whole number of minor units.`,
    retryable: false,
    raw,
    pspName: GOCARDLESS_PSP_NAME,
  });
}

/** `reason` and the key stamp take two of GoCardless's three metadata keys. */
function toRefundBody(
  req: RefundRequest,
  amount: number,
  totalAmountConfirmation: number,
  stamp: string,
): unknown {
  return {
    refunds: {
      amount,
      total_amount_confirmation: totalAmountConfirmation,
      links: { payment: req.pspPaymentId },
      metadata: { ...(req.reason ? { reason: req.reason } : {}), [REFUND_KEY_STAMP]: stamp },
    },
  };
}

/**
 * GoCardless metadata allows at most 3 keys (50-char names, 500-char values)
 * on every resource that carries it — billing requests and subscriptions
 * alike. payfanout_id claims a slot first where the input has a host id so it
 * round-trips; remaining keys fill the slots and overflow is withheld rather
 * than failing the call. On sessions it is stamped on the billing request AND
 * its payment_request, so the facts survive onto the payment GoCardless
 * creates at fulfilment.
 */
function toStampedMetadata(input: {
  id?: string;
  metadata?: Record<string, string>;
}): Record<string, string> | undefined {
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

/**
 * GoCardless cursor pagination documents `limit` as 1-500 (default 50) —
 * clamped locally so fractional/zero/oversized values never reach the API.
 */
function clampPageSize(limit: number): number {
  return Math.min(500, Math.max(1, Math.trunc(limit)));
}

function withQuery(path: string, query: URLSearchParams): string {
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

function toIso(value: string | Date): string {
  return typeof value === "string" ? value : value.toISOString();
}
