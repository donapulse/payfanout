import {
  assertMinorUnitAmount,
  classifyHttpFallback,
  getUserMessage,
  isPayFanoutError,
  isTransportRetryable,
  normalizeCurrency,
  PayFanoutError,
  requestWithTimeout,
  safeJson,
  withTransportRetries,
  type AdapterCapabilities,
  type CompletePaymentInput,
  type CreatePaymentSessionInput,
  type MinorUnitAmount,
  type PaymentInfo,
  type PaymentMethodCapability,
  type PaymentMethodDetails,
  type PaymentSession,
  type RefundInfo,
  type RefundRequest,
  type RefundResult,
  type RefundStatus,
  type ServerPaymentAdapter,
  type ShippingDetails,
  type UnifiedErrorCode,
  type UnifiedPaymentStatus,
  type UnifiedWebhookEvent,
  type VerifyCredentialsResult,
} from "@payfanout/core";
import { buildV1HmacAuthorization, deriveIdempotenceKey } from "./signing.js";
import {
  decodeSessionContext,
  encodeSessionContext,
  type WorldlineSessionContextV1,
} from "./session-context.js";
import {
  parseWorldlineWebhookEvent,
  verifyWorldlineWebhookSignature,
  type WorldlineWebhookKey,
} from "./webhook.js";

export const WORLDLINE_PSP_NAME = "worldline";

export interface WorldlineServerAdapterConfig {
  /** v1HMAC API key id (the identifier half — not a secret). */
  apiKeyId: string;
  /** v1HMAC secret API key (server-side only). */
  secretApiKey: string;
  /** Merchant id (PSPID) — the `{merchantId}` path segment on every endpoint. */
  merchantId: string;
  /**
   * Explicit, never inferred. sandbox -> payment.preprod.direct.worldline-solutions.com,
   * live -> payment.direct.worldline-solutions.com.
   */
  environment: "sandbox" | "live";
  /** HMAC key for the stateless signed session context (see session-context.ts). */
  sessionSigningKey: string;
  /**
   * Worldline webhook signing keys. Each webhook carries an `X-GCS-KeyId`
   * naming which key signed it; pass several to rotate with no cutover (any
   * active key verifying wins).
   */
  webhookKeys: WorldlineWebhookKey | WorldlineWebhookKey[];
  /**
   * How long a signed session context stays completable, in seconds.
   * Default 3600 (1h). A signed token must not be valid forever — expiry is
   * enforced at completePayment.
   */
  sessionTtlSeconds?: number;
  /**
   * Abort a hung Worldline connection after this many milliseconds (default
   * 30000). The timer covers the whole exchange including the response body
   * read. Money-moving calls carry a signed idempotence key, so a timed-out
   * request is safe to retry (a replayed tokenization create merely re-issues
   * an amountless session). Timeouts surface as retryable psp_unavailable.
   */
  requestTimeoutMs?: number;
  /**
   * Automatic retries for transport-level trouble only (network failure,
   * timeout, HTTP 5xx, 429) with exponential backoff. Default 2. Safe because
   * the idempotence key makes money-moving calls idempotent and a tokenization
   * create is amountless. Business errors (declines, validation) are NEVER
   * retried here.
   */
  maxNetworkRetries?: number;
  /** Account capabilities vary by contract — override instead of trusting defaults. */
  paymentMethods?: PaymentMethodCapability[];
  baseUrl?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /**
   * Injected clock (ms since epoch). Also drives the request `Date` header —
   * Worldline rejects timestamps older than five minutes, so keep it accurate.
   */
  now?: () => number;
  /** Injected backoff sleep for retry tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** Worldline card output (masked instrument facts on the payment object). */
export interface WorldlineCardOutput {
  card?: { cardNumber?: string; expiryDate?: string };
  paymentProductId?: number;
}

/** Structural subset of a Worldline payment object (GET /payments/{id} and create responses). */
export interface WorldlinePaymentLike {
  id: string;
  status?: string;
  statusOutput?: { statusCode?: number; statusCategory?: string; isCancellable?: boolean };
  paymentOutput?: {
    amountOfMoney?: { amount?: number; currencyCode?: string };
    references?: { merchantReference?: string };
    cardPaymentMethodSpecificOutput?: WorldlineCardOutput;
  };
}

/** Worldline merchantAction — the "what to do next" instruction (3-D Secure redirect). */
export interface WorldlineMerchantAction {
  actionType?: string;
  redirectData?: { redirectURL?: string };
}

/** Create-payment response envelope. */
export interface WorldlineCreatePaymentResponse {
  creationOutput?: unknown;
  merchantAction?: WorldlineMerchantAction;
  payment?: WorldlinePaymentLike;
}

/** A capture object (POST /capture, GET /captures). */
export interface WorldlineCaptureLike {
  id?: string;
  status?: string;
  statusOutput?: { statusCode?: number; statusCategory?: string };
  captureOutput?: { amountOfMoney?: { amount?: number; currencyCode?: string } };
}

/** A refund object (POST /refund and the GET /payments/{id}/refunds list). */
export interface WorldlineRefundLike {
  id: string;
  status?: string;
  statusOutput?: { statusCode?: number; statusCategory?: string };
  refundOutput?: { amountOfMoney?: { amount?: number; currencyCode?: string } };
}

/** POST /hostedtokenizations response. */
export interface WorldlineHostedTokenizationLike {
  hostedTokenizationId: string;
  hostedTokenizationUrl: string;
  partialRedirectUrl?: string;
  invalidTokens?: unknown;
}

/** A single entry in a Worldline error body's `errors` array. */
export interface WorldlineApiError {
  errorCode?: string;
  code?: string;
  category?: string;
  id?: string;
  message?: string;
  httpStatusCode?: number;
  propertyName?: string;
  retriable?: boolean;
}

const DEFAULT_METHODS: PaymentMethodCapability[] = [{ type: "card", flow: "embedded", supported: true }];

export class WorldlineServerAdapter implements ServerPaymentAdapter {
  readonly pspName = WORLDLINE_PSP_NAME;
  private readonly config: WorldlineServerAdapterConfig;
  private readonly baseUrl: string;
  private readonly webhookKeys: WorldlineWebhookKey[];

  constructor(config: WorldlineServerAdapterConfig) {
    for (const key of ["apiKeyId", "secretApiKey", "merchantId", "sessionSigningKey"] as const) {
      if (!config[key]) throw PayFanoutError.invalidRequest(`WorldlineServerAdapter config.${key} is required`);
    }
    this.webhookKeys = (Array.isArray(config.webhookKeys) ? config.webhookKeys : [config.webhookKeys]).filter(
      (k): k is WorldlineWebhookKey => Boolean(k?.keyId && k?.secretKey),
    );
    if (this.webhookKeys.length === 0) {
      throw PayFanoutError.invalidRequest(
        "WorldlineServerAdapter config.webhookKeys is required ({ keyId, secretKey }, one or several during rotation)",
      );
    }
    if (config.environment !== "sandbox" && config.environment !== "live") {
      throw PayFanoutError.invalidRequest('WorldlineServerAdapter config.environment must be "sandbox" or "live"');
    }
    if (config.sessionTtlSeconds !== undefined && !(config.sessionTtlSeconds > 0)) {
      throw PayFanoutError.invalidRequest("WorldlineServerAdapter config.sessionTtlSeconds must be > 0");
    }
    if (config.requestTimeoutMs !== undefined && !(config.requestTimeoutMs > 0)) {
      throw PayFanoutError.invalidRequest("WorldlineServerAdapter config.requestTimeoutMs must be > 0");
    }
    if (
      config.maxNetworkRetries !== undefined &&
      (!Number.isInteger(config.maxNetworkRetries) || config.maxNetworkRetries < 0)
    ) {
      throw PayFanoutError.invalidRequest("WorldlineServerAdapter config.maxNetworkRetries must be an integer >= 0");
    }
    this.config = config;
    this.baseUrl =
      config.baseUrl ??
      (config.environment === "live"
        ? "https://payment.direct.worldline-solutions.com"
        : "https://payment.preprod.direct.worldline-solutions.com");
  }

  getCapabilities(): AdapterCapabilities {
    return {
      pspName: this.pspName,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      supportsManualCapture: true, // PRE_AUTHORIZATION + POST /capture
      // A Worldline capture always finalizes (a partial capture releases the
      // remainder), and the core capturePayment(id, amount, key) contract has no
      // isFinal signal to hold an authorization open across captures.
      supportsMultiCapture: false,
      supportsPaymentMethodVerification: false,
      supportsSavedPaymentMethods: false,
      supportsSessionUpdate: false,
      supportsEventPolling: false, // no public events-list API
      supportsListing: false,
      requiresServerCompletion: true, // tokenize-first: the client tokenizes, the server creates the payment
      paymentMethods: this.config.paymentMethods ?? DEFAULT_METHODS,
    };
  }

  /**
   * Creates the Hosted Tokenization session (POST /hostedtokenizations — no
   * amount at this step) and encodes amount/currency/capture-method and the
   * returned hostedTokenizationId into a signed, self-contained context that
   * completePayment later verifies and trusts. The client mounts the iframe
   * from the returned hostedTokenizationUrl (the session's clientSecret).
   */
  async createPaymentSession(input: CreatePaymentSessionInput): Promise<PaymentSession> {
    assertMinorUnitAmount(input.amount, "amount");
    const currency = normalizeCurrency(input.currency);
    if (input.paymentMethodTypes?.some((t) => !this.isKnownMethodType(t))) {
      throw PayFanoutError.invalidRequest(
        `Worldline adapter does not support one of the requested payment method types: ${input.paymentMethodTypes.join(", ")}`,
      );
    }
    // CreateHostedTokenization is not on Worldline's documented idempotent
    // operations: the key is sent (harmless) but never relied on for dedupe.
    // Tokenization is amountless — money-side safety comes from CreatePayment
    // idempotency at completePayment.
    const tokenization = await this.request<WorldlineHostedTokenizationLike>(
      "POST",
      `/v2/${this.merchantPath()}/hostedtokenizations`,
      {},
      input.idempotencyKey,
    );
    const context: WorldlineSessionContextV1 = {
      v: 1,
      amount: input.amount,
      currency,
      captureMethod: input.captureMethod ?? "automatic",
      hostedTokenizationId: tokenization.hostedTokenizationId,
      expiresAt: this.now() + this.sessionTtlMs(),
      returnUrl: input.returnUrl,
      id: input.id,
      billingDetails: input.billingDetails,
      statementDescriptor: input.statementDescriptor,
      receiptEmail: input.receiptEmail,
      shippingDetails: input.shippingDetails,
    };
    const token = await encodeSessionContext(context, this.config.sessionSigningKey);
    return {
      id: input.id ?? tokenization.hostedTokenizationId,
      pspName: this.pspName,
      pspSessionId: token,
      clientSecret: tokenization.hostedTokenizationUrl,
      amount: input.amount,
      currency,
      status: "requires_payment_method",
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
  }

  /**
   * Tokenize-first completion: create the payment from the browser's
   * hostedTokenizationId. The signed context is the only trusted source of
   * amount/currency/capture-method. A REDIRECT merchantAction (3-D Secure
   * challenge) surfaces as requires_action with the redirect URL on `raw`; the
   * customer completes it and the host reconciles with retrievePayment.
   */
  async completePayment(input: CompletePaymentInput): Promise<PaymentInfo> {
    if (!input.clientToken) {
      throw PayFanoutError.invalidRequest(
        "completePayment requires the clientToken (hostedTokenizationId) produced by confirm()",
        { clientToken: input.clientToken },
      );
    }
    const context = await this.decodeContext(input.pspSessionId);
    const billing = mergeBillingDetails(context.billingDetails, input.billingDetails);
    const email = context.receiptEmail ?? billing?.email;
    const references: Record<string, string> = {
      ...(context.id ? { merchantReference: context.id } : {}),
      ...(context.statementDescriptor ? { descriptor: context.statementDescriptor } : {}),
    };
    const created = await this.request<WorldlineCreatePaymentResponse>(
      "POST",
      `/v2/${this.merchantPath()}/payments`,
      {
        order: {
          amountOfMoney: { amount: context.amount, currencyCode: context.currency },
          ...(Object.keys(references).length > 0 ? { references } : {}),
          ...(toWorldlineCustomer(billing, email) ?? {}),
          ...(toWorldlineShipping(context.shippingDetails) ?? {}),
        },
        // hostedTokenizationId rides at the ROOT of CreatePayment — it replaces
        // the card-data source; cardPaymentMethodSpecificInput has no such field.
        hostedTokenizationId: input.clientToken,
        cardPaymentMethodSpecificInput: {
          authorizationMode: context.captureMethod === "manual" ? "PRE_AUTHORIZATION" : "SALE",
          // The hosted-tokenization guide names the flattened returnUrl; the
          // domain model also carries the threeDSecure form — send both.
          ...(context.returnUrl
            ? {
                returnUrl: context.returnUrl,
                threeDSecure: { redirectionData: { returnUrl: context.returnUrl } },
              }
            : {}),
        },
      },
      input.idempotencyKey,
    );
    const payment = created.payment;
    if (!payment?.id) {
      throw new PayFanoutError({
        code: "processing_error",
        message: getUserMessage("processing_error"),
        retryable: false,
        raw: created,
        pspName: this.pspName,
      });
    }
    if (created.merchantAction?.actionType?.toUpperCase() === "REDIRECT") {
      return this.buildPaymentInfo(payment, {
        raw: created,
        payfanoutId: context.id,
        statusOverride: "requires_action",
        amountFallback: context.amount,
        currencyFallback: context.currency,
      });
    }
    // Some Worldline flows answer 2xx with a REJECTED payment rather than an HTTP
    // error; surface it as a decline instead of a "failed" PaymentInfo so callers
    // see the same rejection as the HTTP 402 decline path.
    if (mapWorldlineStatus(payment.status, payment.statusOutput?.statusCode, payment.statusOutput?.statusCategory) === "failed") {
      throw mapWorldlineRejectedPayment(created);
    }
    return this.retrievePayment(payment.id, context.id);
  }

  async retrievePayment(pspPaymentId: string, payfanoutId?: string): Promise<PaymentInfo> {
    const payment = await this.fetchPayment(pspPaymentId);
    // Captures and refunds are separate sub-resources — query them so the
    // reported captured/refunded totals reflect the settlement state.
    const [capturedAmount, refundedAmount] = await Promise.all([
      this.capturedAmount(pspPaymentId),
      this.refundedAmount(pspPaymentId),
    ]);
    const authorized = payment.paymentOutput?.amountOfMoney?.amount ?? 0;
    const status = mapWorldlineStatus(
      payment.status,
      payment.statusOutput?.statusCode,
      payment.statusOutput?.statusCategory,
    );
    let amountCaptured: number | undefined;
    let amountCapturable: number | undefined;
    if (status === "succeeded") {
      // A completed sale/capture is finalized: the captured amount settled and
      // any uncaptured remainder was released, so nothing is left to capture.
      amountCaptured = capturedAmount > 0 ? capturedAmount : authorized;
      amountCapturable = 0;
    } else if (status === "requires_capture") {
      amountCaptured = 0;
      amountCapturable = authorized;
    } else if (capturedAmount > 0) {
      amountCaptured = capturedAmount;
      amountCapturable = Math.max(0, authorized - capturedAmount);
    }
    return this.buildPaymentInfo(payment, {
      ...(payfanoutId ? { payfanoutId } : {}),
      ...(amountCaptured !== undefined ? { amountCaptured } : {}),
      ...(amountCapturable !== undefined ? { amountCapturable } : {}),
      amountRefunded: refundedAmount,
    });
  }

  async capturePayment(
    pspPaymentId: string,
    amount: MinorUnitAmount | undefined,
    idempotencyKey: string,
  ): Promise<PaymentInfo> {
    if (amount !== undefined) assertMinorUnitAmount(amount, "capture amount");
    await this.request(
      "POST",
      `/v2/${this.merchantPath()}/payments/${encodeURIComponent(pspPaymentId)}/capture`,
      {
        ...(amount !== undefined ? { amount } : {}),
        // Always finalize: a partial capture settles that amount and releases the
        // uncaptured remainder (a bare capture takes the full remaining amount).
        // Worldline only accepts referenced refunds once the capture is finalized,
        // and the core contract carries no isFinal signal for multi-capture.
        isFinal: true,
      },
      idempotencyKey,
    );
    return this.retrievePayment(pspPaymentId);
  }

  async cancelPayment(pspPaymentId: string, idempotencyKey: string): Promise<PaymentInfo> {
    await this.request(
      "POST",
      `/v2/${this.merchantPath()}/payments/${encodeURIComponent(pspPaymentId)}/cancel`,
      {},
      idempotencyKey,
    );
    return this.retrievePayment(pspPaymentId);
  }

  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    if (req.amount !== undefined) assertMinorUnitAmount(req.amount, "refund amount");
    // The refund needs a currencyCode the RefundRequest does not carry, and a
    // full refund must target the REMAINING refundable (captured minus already
    // refunded) — both come from the normalized payment view.
    const info = await this.retrievePayment(req.pspPaymentId);
    const currencyCode = info.currency;
    const refundable = (info.amountCaptured ?? info.amount) - info.amountRefunded;
    const amount = req.amount ?? Math.max(0, refundable);
    const refund = await this.request<WorldlineRefundLike>(
      "POST",
      `/v2/${this.merchantPath()}/payments/${encodeURIComponent(req.pspPaymentId)}/refund`,
      { amountOfMoney: { amount, currencyCode } },
      req.idempotencyKey,
    );
    return {
      // Worldline Direct has no refund-by-id read — retrieveRefund resolves this
      // composite through the per-payment list. The part after the last ":" is
      // Worldline's own refund id, the one webhooks report.
      refundId: `${req.pspPaymentId}:${refund.id}`,
      status: mapRefundStatus(refund.status, refund.statusOutput?.statusCategory),
      amount: refund.refundOutput?.amountOfMoney?.amount ?? amount,
      raw: refund,
    };
  }

  /**
   * Polls a refund. Worldline Direct exposes no refund-by-id endpoint (that is
   * a Connect-era surface) — the only read is `GET /payments/{id}/refunds` — so
   * `refundId` is the composite `"{paymentId}:{refundId}"` that refundPayment
   * returned, resolved here through the payment's refund list.
   */
  async retrieveRefund(refundId: string): Promise<RefundInfo> {
    const separator = refundId.lastIndexOf(":");
    if (separator <= 0 || separator === refundId.length - 1) {
      throw PayFanoutError.invalidRequest(
        'Worldline refund ids are the composite "{paymentId}:{refundId}" returned by refundPayment',
        { refundId },
      );
    }
    const pspPaymentId = refundId.slice(0, separator);
    const worldlineRefundId = refundId.slice(separator + 1);
    const result = await this.request<{ refunds?: WorldlineRefundLike[] }>(
      "GET",
      `/v2/${this.merchantPath()}/payments/${encodeURIComponent(pspPaymentId)}/refunds`,
    );
    const refund = (result.refunds ?? []).find((r) => r.id === worldlineRefundId);
    if (!refund) {
      throw PayFanoutError.invalidRequest(`No refund ${worldlineRefundId} on payment ${pspPaymentId}`, { refundId });
    }
    return {
      refundId,
      status: mapRefundStatus(refund.status, refund.statusOutput?.statusCategory),
      amount: refund.refundOutput?.amountOfMoney?.amount ?? 0,
      pspPaymentId,
      raw: refund,
    };
  }

  /**
   * "Test connection" probe: one side-effect-free read against the account's
   * test-connection service. Authentication is settled before the resource is
   * resolved, so only 401/403 means bad credentials; any other status proves the
   * credentials authenticated. A single call, never retried.
   */
  async verifyCredentials(): Promise<VerifyCredentialsResult> {
    let status: number;
    try {
      status = await this.probeStatus(`/v2/${this.merchantPath()}/services/testconnection`);
    } catch {
      return { ok: false, category: "network", message: "Could not reach Worldline — try again." };
    }
    if (status === 401 || status === 403) {
      return {
        ok: false,
        category: "auth",
        message: "Authentication failed — check the Worldline API key id and secret.",
      };
    }
    if (status === 429 || status >= 500) {
      return { ok: false, category: "network", message: "Could not reach Worldline — try again." };
    }
    return { ok: true };
  }

  async verifyWebhookSignature(rawBody: string, headers: Record<string, string>): Promise<boolean> {
    return verifyWorldlineWebhookSignature(rawBody, headers, this.webhookKeys);
  }

  async parseWebhookEvent(rawBody: string): Promise<UnifiedWebhookEvent> {
    return parseWorldlineWebhookEvent(rawBody);
  }

  // --- internals ------------------------------------------------------------

  private fetchPayment(pspPaymentId: string): Promise<WorldlinePaymentLike> {
    return this.request<WorldlinePaymentLike>(
      "GET",
      `/v2/${this.merchantPath()}/payments/${encodeURIComponent(pspPaymentId)}`,
    );
  }

  private async capturedAmount(pspPaymentId: string): Promise<number> {
    const result = await this.request<{ captures?: WorldlineCaptureLike[] }>(
      "GET",
      `/v2/${this.merchantPath()}/payments/${encodeURIComponent(pspPaymentId)}/captures`,
    );
    return (result.captures ?? [])
      .filter((c) => !isFailedStatus(c.status, c.statusOutput?.statusCategory))
      .reduce((sum, c) => sum + (c.captureOutput?.amountOfMoney?.amount ?? 0), 0);
  }

  private async refundedAmount(pspPaymentId: string): Promise<number> {
    const result = await this.request<{ refunds?: WorldlineRefundLike[] }>(
      "GET",
      `/v2/${this.merchantPath()}/payments/${encodeURIComponent(pspPaymentId)}/refunds`,
    );
    return (result.refunds ?? [])
      .filter((r) => !isFailedStatus(r.status, r.statusOutput?.statusCategory))
      .reduce((sum, r) => sum + (r.refundOutput?.amountOfMoney?.amount ?? 0), 0);
  }

  private buildPaymentInfo(
    payment: WorldlinePaymentLike,
    opts: {
      raw?: unknown;
      payfanoutId?: string;
      statusOverride?: UnifiedPaymentStatus;
      amountCaptured?: number;
      amountCapturable?: number;
      amountRefunded?: number;
      amountFallback?: number;
      currencyFallback?: string;
    } = {},
  ): PaymentInfo {
    const output = payment.paymentOutput ?? {};
    const money = output.amountOfMoney ?? {};
    const merchantReference = output.references?.merchantReference;
    const status =
      opts.statusOverride ??
      mapWorldlineStatus(payment.status, payment.statusOutput?.statusCode, payment.statusOutput?.statusCategory);
    const methodDetails = toPaymentMethodDetails(output.cardPaymentMethodSpecificOutput);
    return {
      id: opts.payfanoutId ?? merchantReference ?? payment.id,
      pspName: this.pspName,
      pspPaymentId: payment.id,
      status,
      amount: money.amount ?? opts.amountFallback ?? 0,
      amountRefunded: opts.amountRefunded ?? 0,
      ...(opts.amountCaptured !== undefined ? { amountCaptured: opts.amountCaptured } : {}),
      ...(opts.amountCapturable !== undefined ? { amountCapturable: opts.amountCapturable } : {}),
      currency: (money.currencyCode ?? opts.currencyFallback ?? "").toUpperCase() || "XXX",
      paymentMethodType: "card",
      ...(methodDetails ? { paymentMethodDetails: methodDetails } : {}),
      // Worldline's payment object carries no stable creation timestamp; hosts
      // that need one read it from the webhook `created` or their own record.
      createdAt: "1970-01-01T00:00:00.000Z",
      raw: opts.raw ?? payment,
    };
  }

  private decodeContext(pspSessionId: string): Promise<WorldlineSessionContextV1> {
    return decodeSessionContext(pspSessionId, this.config.sessionSigningKey, { now: this.now() });
  }

  private now(): number {
    return (this.config.now ?? Date.now)();
  }

  private sessionTtlMs(): number {
    return (this.config.sessionTtlSeconds ?? 3600) * 1000;
  }

  private merchantPath(): string {
    return encodeURIComponent(this.config.merchantId);
  }

  private isKnownMethodType(type: string): boolean {
    return (this.config.paymentMethods ?? DEFAULT_METHODS).some((m) => m.type === type);
  }

  /**
   * Transport with timeout + transient-only retries. Safe to retry mutating
   * calls: every one carries a deterministic X-GCS-Idempotence-Key, so a replay
   * can never double-charge. Business errors (4xx other than 429) never retry.
   */
  private request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    return withTransportRetries(() => this.requestOnce<T>(method, path, body, idempotencyKey), {
      attempts: 1 + (this.config.maxNetworkRetries ?? 2),
      sleep: this.config.sleep,
      // Beyond transport trouble, a 409 (an idempotent replay racing the still
      // in-flight original) resolves itself moments later — replay it too.
      isRetryable: (err) => isTransportRetryable(err) || isIdempotenceReplayInFlight(err),
    });
  }

  private async requestOnce<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    const date = new Date(this.now()).toUTCString();
    const hasBody = body !== undefined;
    const gcsHeaders: Record<string, string> = {};
    if (idempotencyKey !== undefined) {
      gcsHeaders["X-GCS-Idempotence-Key"] = await deriveIdempotenceKey(idempotencyKey);
    }
    const authorization = await buildV1HmacAuthorization({
      apiKeyId: this.config.apiKeyId,
      secretApiKey: this.config.secretApiKey,
      method,
      path,
      date,
      ...(hasBody ? { contentType: "application/json" } : {}),
      gcsHeaders,
    });
    // The Date header is sent AND signed. A target edge runtime that forbids
    // setting `Date` can switch to Worldline's X-GCS-Date signed header instead
    // (see signing.ts); the documented Date-header form is used here.
    const headers: Record<string, string> = { authorization, date };
    if (hasBody) headers["content-type"] = "application/json";
    for (const [key, value] of Object.entries(gcsHeaders)) headers[key] = value;
    const { response, text } = await requestWithTimeout(
      {
        fetch: this.config.fetch ?? fetch,
        timeoutMs,
        onFailure: (timedOut, cause) =>
          new PayFanoutError({
            code: "psp_unavailable",
            message: timedOut ? `Worldline did not respond within ${timeoutMs}ms.` : "Could not reach Worldline.",
            retryable: true,
            raw: cause,
            pspName: this.pspName,
          }),
      },
      `${this.baseUrl}${path}`,
      {
        method,
        headers,
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
      },
    );
    const json = text ? safeJson(text) : undefined;
    if (!response.ok) throw mapWorldlineError(response.status, json ?? text);
    return json as T;
  }

  /**
   * One read-only exchange returning the RAW HTTP status instead of mapping a
   * non-2xx into a PayFanoutError — verifyCredentials needs the status itself to
   * tell an auth rejection (401/403) from an outage (5xx/429). No retry loop.
   */
  private async probeStatus(path: string): Promise<number> {
    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    const date = new Date(this.now()).toUTCString();
    const authorization = await buildV1HmacAuthorization({
      apiKeyId: this.config.apiKeyId,
      secretApiKey: this.config.secretApiKey,
      method: "GET",
      path,
      date,
      gcsHeaders: {},
    });
    const { response } = await requestWithTimeout(
      {
        fetch: this.config.fetch ?? fetch,
        timeoutMs,
        onFailure: (_timedOut, cause) =>
          cause instanceof Error ? cause : new Error("Worldline connectivity probe failed"),
      },
      `${this.baseUrl}${path}`,
      { method: "GET", headers: { authorization, date } },
    );
    return response.status;
  }
}

/**
 * Worldline paymentProductId → lowercase brand names hosts can render. Only
 * ids confirmed on the current payment-method pages; an unknown id degrades to
 * brandless details.
 */
const WORLDLINE_PRODUCT_TO_BRAND: Record<number, string> = {
  1: "visa",
  2: "amex",
  3: "mastercard",
  117: "maestro",
  125: "jcb",
  132: "diners",
};

function toPaymentMethodDetails(output: WorldlineCardOutput | undefined): PaymentMethodDetails | undefined {
  if (!output) return undefined;
  const brand = output.paymentProductId !== undefined ? WORLDLINE_PRODUCT_TO_BRAND[output.paymentProductId] : undefined;
  const digits = output.card?.cardNumber?.replace(/\D/g, "");
  const last4 = digits && digits.length >= 4 ? digits.slice(-4) : undefined;
  const expiry = parseExpiry(output.card?.expiryDate);
  const details: PaymentMethodDetails = {
    ...(brand ? { brand } : {}),
    ...(last4 ? { last4 } : {}),
    ...(expiry?.month !== undefined ? { expMonth: expiry.month } : {}),
    ...(expiry?.year !== undefined ? { expYear: expiry.year } : {}),
  };
  return Object.keys(details).length > 0 ? details : undefined;
}

/** Worldline card.expiryDate is "MMYY". */
function parseExpiry(expiryDate: string | undefined): { month?: number; year?: number } | undefined {
  if (!expiryDate || !/^\d{4}$/.test(expiryDate)) return undefined;
  const month = Number(expiryDate.slice(0, 2));
  const year = 2000 + Number(expiryDate.slice(2, 4));
  return { ...(month >= 1 && month <= 12 ? { month } : {}), year };
}

function isFailedStatus(status: string | undefined, category: string | undefined): boolean {
  const s = (status ?? "").toUpperCase();
  const cat = (category ?? "").toUpperCase();
  return cat === "UNSUCCESSFUL" || s === "REJECTED" || s === "REJECTED_CAPTURE" || s === "CANCELLED";
}

/**
 * Maps a Worldline payment onto the unified status. Primary signal is
 * statusOutput.statusCategory (Worldline's forward-compatible band — new
 * statuses join an existing category), with statusCode and the status string as
 * fallbacks. CANCELLED is checked first so a voided authorization is never read
 * as a failure.
 */
export function mapWorldlineStatus(
  status: string | undefined,
  statusCode: number | undefined,
  statusCategory: string | undefined,
): UnifiedPaymentStatus {
  const s = (status ?? "").toUpperCase();
  if (s === "CANCELLED") return "canceled";

  switch ((statusCategory ?? "").toUpperCase()) {
    case "COMPLETED":
    case "REFUNDED": // the payment succeeded; refund state derives from amountRefunded
      return "succeeded";
    case "PENDING_MERCHANT":
      return "requires_capture"; // authorised, awaiting a merchant capture
    case "PENDING_CONNECT_OR_3RD_PARTY":
      // This band holds a genuine customer action (REDIRECTED -> a 3-D Secure
      // challenge) AND async downstream states (AUTHORIZATION_REQUESTED /
      // CAPTURE_REQUESTED / REFUND_REQUESTED) that need no customer action.
      return s === "REDIRECTED" ? "requires_action" : "processing";
    case "PENDING_PAYMENT":
    case "CREATED":
      return "processing";
    case "UNSUCCESSFUL":
      return "failed";
    default:
      break;
  }

  switch (statusCode) {
    case 9:
      return "succeeded"; // CAPTURED / settled
    case 5:
      return "requires_capture"; // authorised
    case 46:
      return "requires_action"; // waiting authentication
    case 2:
      return "failed"; // authorisation declined
    default:
      break;
  }

  switch (s) {
    case "CAPTURED":
    case "REFUNDED":
      return "succeeded";
    case "PENDING_CAPTURE":
      return "requires_capture";
    case "REDIRECTED":
      return "requires_action";
    case "REJECTED":
    case "REJECTED_CAPTURE":
      return "failed";
    default:
      // CAPTURE_REQUESTED / AUTHORIZATION_REQUESTED and any unknown status.
      return "processing";
  }
}

function mapRefundStatus(status: string | undefined, category: string | undefined): RefundStatus {
  const s = (status ?? "").toUpperCase();
  const cat = (category ?? "").toUpperCase();
  if (s === "REFUNDED" || cat === "REFUNDED" || cat === "COMPLETED") return "succeeded";
  if (s === "REJECTED" || s === "CANCELLED" || cat === "UNSUCCESSFUL") return "failed";
  return "pending"; // REFUND_REQUESTED / CREATED / PENDING_* — async, poll with retrieveRefund
}

/**
 * Worldline decline/reject codes → the unified taxonomy. Declines arrive as a
 * non-2xx body ({ errorId, errors, paymentResult }); the finer codes below come
 * from the API troubleshooting reference, and anything else on a 402 is still a
 * generic decline.
 */
const WORLDLINE_CODE_MAP: Record<string, UnifiedErrorCode> = {
  "30511001": "insufficient_funds",
  "30591001": "fraud_suspected",
  "40001134": "authentication_required", // failed 3-D Secure authentication
  "30171001": "card_declined", // customer cancelled at the acquirer
  "30041001": "card_declined", // rejected by issuer
};

export function mapWorldlineError(httpStatus: number, body: unknown): PayFanoutError {
  const errors = (body as { errors?: WorldlineApiError[] } | undefined)?.errors;
  const first = Array.isArray(errors) ? errors[0] : undefined;
  const pspCode = first?.errorCode ?? first?.code;
  let code: UnifiedErrorCode;
  let retryable = false;
  if (pspCode && WORLDLINE_CODE_MAP[pspCode]) {
    code = WORLDLINE_CODE_MAP[pspCode];
  } else if (httpStatus === 402) {
    // A rejection with no finer code we recognize is still a decline.
    code = "card_declined";
  } else if (httpStatus === 409) {
    // The request with this idempotence key is still being processed — the
    // outcome exists moments later, so a raced replay is retryable.
    code = "processing_error";
    retryable = true;
  } else {
    ({ code, retryable } = classifyHttpFallback(httpStatus));
  }
  // Only genuinely transient failures (429/5xx) stay retryable; declines and
  // authentication_required are business rejections resolved off the retry path.
  return new PayFanoutError({
    code,
    message: getUserMessage(code),
    retryable,
    raw: body,
    pspName: WORLDLINE_PSP_NAME,
  });
}

/** The retryable processing_error only mapWorldlineError's 409 branch produces. */
function isIdempotenceReplayInFlight(error: unknown): boolean {
  return isPayFanoutError(error) && error.code === "processing_error" && error.retryable;
}

function mapWorldlineRejectedPayment(raw: unknown): PayFanoutError {
  return new PayFanoutError({
    code: "card_declined",
    message: getUserMessage("card_declined"),
    retryable: false,
    raw,
    pspName: WORLDLINE_PSP_NAME,
  });
}

/**
 * Merge completion-time billingDetails over the session context's, field by
 * field: a completion field with a DEFINED value wins, but an explicit
 * `undefined` leaves the session's value intact.
 */
function mergeBillingDetails(
  base: CreatePaymentSessionInput["billingDetails"],
  override: CreatePaymentSessionInput["billingDetails"],
): CreatePaymentSessionInput["billingDetails"] {
  if (!base) return override;
  if (!override) return base;
  return {
    ...base,
    ...pruneUndefined(override),
    address: { ...base.address, ...pruneUndefined(override.address) },
  };
}

function pruneUndefined<T extends object>(obj: T | undefined): Partial<T> {
  if (!obj) return {};
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function toWorldlineCustomer(
  billing: CreatePaymentSessionInput["billingDetails"],
  email: string | undefined,
): { customer: Record<string, unknown> } | undefined {
  const customer: Record<string, unknown> = {};
  const address = billing?.address;
  if (address) {
    const billingAddress: Record<string, string> = {
      ...(address.line1 ? { street: address.line1 } : {}),
      ...(address.city ? { city: address.city } : {}),
      ...(address.postalCode ? { zip: address.postalCode } : {}),
      ...(address.country ? { countryCode: address.country } : {}),
    };
    if (Object.keys(billingAddress).length > 0) customer["billingAddress"] = billingAddress;
  }
  if (billing?.name) {
    const [firstName, ...rest] = billing.name.trim().split(/\s+/).filter(Boolean);
    const name: Record<string, string> = {
      ...(firstName ? { firstName } : {}),
      ...(rest.length > 0 ? { surname: rest.join(" ") } : {}),
    };
    if (Object.keys(name).length > 0) customer["personalInformation"] = { name };
  }
  if (email) customer["contactDetails"] = { emailAddress: email };
  return Object.keys(customer).length > 0 ? { customer } : undefined;
}

function toWorldlineShipping(
  shipping: ShippingDetails | undefined,
): { shipping: { address: Record<string, string> } } | undefined {
  const address = shipping?.address;
  if (!address) return undefined;
  const shippingAddress: Record<string, string> = {
    ...(address.line1 ? { street: address.line1 } : {}),
    ...(address.line2 ? { additionalInfo: address.line2 } : {}),
    ...(address.city ? { city: address.city } : {}),
    ...(address.state ? { state: address.state } : {}),
    ...(address.postalCode ? { zip: address.postalCode } : {}),
    ...(address.country ? { countryCode: address.country } : {}),
  };
  return Object.keys(shippingAddress).length > 0 ? { shipping: { address: shippingAddress } } : undefined;
}
