import {
  assertMinorUnitAmount,
  classifyHttpFallback,
  getCurrencyExponent,
  getUserMessage,
  isPayFanoutError,
  isTransportRetryable,
  normalizeCurrency,
  normalizeSecrets,
  PayFanoutError,
  requestWithTimeout,
  safeJson,
  sha256Hex,
  withTransportRetries,
  type AdapterCapabilities,
  type CompletePaymentInput,
  type CreatePaymentSessionInput,
  type MinorUnitAmount,
  type PaymentInfo,
  type PaymentMethodCapability,
  type PaymentSession,
  type RefundRequest,
  type RefundResult,
  type ServerPaymentAdapter,
  type UnifiedErrorCode,
  type UnifiedPaymentStatus,
  type UnifiedWebhookEvent,
} from "@payfanout/core";
import { deriveAdyenIdempotencyKey, hexToBytes } from "./signing.js";
import { decodeSessionContext, encodeSessionContext, type AdyenSessionContextV1 } from "./session-context.js";
import {
  parseAdyenWebhookEvent,
  verifyAdyenWebhookSignature,
  type AdyenWebhookBasicAuth,
} from "./webhook.js";

export const ADYEN_PSP_NAME = "adyen";

/** Checkout API version this adapter targets. Moves only with a read of Adyen's release notes. */
export const ADYEN_DEFAULT_API_VERSION = "v72";

export interface AdyenServerAdapterConfig {
  /** Checkout API key, sent as the `X-API-Key` header. Server-side only. */
  apiKey: string;
  /** The merchant account every request is booked against. */
  merchantAccount: string;
  /**
   * Explicit, never inferred. sandbox -> checkout-test.adyen.com,
   * live -> {liveUrlPrefix}-checkout-live.adyenpayments.com.
   */
  environment: "sandbox" | "live";
  /** The account's live URL prefix — REQUIRED when environment is "live". */
  liveUrlPrefix?: string;
  /** Pinned Checkout API version, e.g. "v72". */
  apiVersion?: string;
  /**
   * Where Adyen sends the shopper back from a redirect or a 3-D Secure
   * challenge. `returnUrl` is one of the required top-level fields on
   * POST /payments, so a session that carries none falls back to this value;
   * with neither, session creation is refused instead of sending Adyen a
   * request it rejects.
   */
  defaultReturnUrl?: string;
  /** HMAC key for the stateless signed session context (see session-context.ts). */
  sessionSigningKey: string;
  /**
   * Webhook HMAC keys as generated in the Customer Area (HEX). Pass several to
   * rotate with no cutover — any active key verifying wins.
   */
  hmacKeys: string | string[];
  /**
   * Basic-auth credentials configured on the Adyen webhook endpoint. Adyen's HMAC
   * authenticates eight field values only, so the rest of a delivery is trusted
   * on the strength of the channel it arrived on — verification requires these.
   * Pass several to rotate with no cutover.
   */
  webhookBasicAuth: AdyenWebhookBasicAuth | AdyenWebhookBasicAuth[];
  /**
   * How long a signed session context stays completable, in seconds.
   * Default 3600 (1h). A signed token must not be valid forever — expiry is
   * enforced at completePayment.
   */
  sessionTtlSeconds?: number;
  /**
   * Abort a hung Adyen connection after this many milliseconds (default 30000).
   * The timer covers the whole exchange including the response body read. Every
   * call carries an `idempotency-key`, so a timed-out request is safe to retry.
   * Timeouts surface as retryable psp_unavailable.
   */
  requestTimeoutMs?: number;
  /**
   * Automatic retries for transport-level trouble only (network failure, timeout,
   * HTTP 5xx, 429) with exponential backoff. Default 2. Safe because every
   * mutating call carries an idempotency key. Business errors (refusals,
   * validation) are NEVER retried here.
   */
  maxNetworkRetries?: number;
  /** Account capabilities vary by contract — override instead of trusting defaults. */
  paymentMethods?: PaymentMethodCapability[];
  baseUrl?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Injected clock (ms since epoch) — drives the session context expiry. */
  now?: () => number;
  /** Injected backoff sleep for retry tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** The "what to do next" instruction Adyen returns instead of a result (3-D Secure, redirect). */
export interface AdyenAction {
  type?: string;
  url?: string;
  paymentData?: string;
  [key: string]: unknown;
}

/** Structural subset of a POST /payments (and /payments/details) response. */
export interface AdyenPaymentResponse {
  pspReference?: string;
  resultCode?: string;
  action?: AdyenAction;
  refusalReason?: string;
  refusalReasonCode?: string;
  merchantReference?: string;
  amount?: { value?: number; currency?: string };
  additionalData?: Record<string, string>;
}

/** Every modification (capture/cancel/refund) answers with a bare acknowledgement. */
export interface AdyenModificationResponse {
  pspReference?: string;
  paymentPspReference?: string;
  /** Always "received": the outcome arrives by webhook. */
  status?: string;
  reference?: string;
  amount?: { value?: number; currency?: string };
}

/** Adyen's error envelope. */
export interface AdyenApiError {
  status?: number;
  errorCode?: string;
  message?: string;
  errorType?: string;
  pspReference?: string;
}

const DEFAULT_METHODS: PaymentMethodCapability[] = [{ type: "card", flow: "embedded", supported: true }];

/** Adyen's payment method type string for cards. */
const CARD_PAYMENT_METHOD_TYPE = "scheme";

/**
 * Currencies Adyen prices with a different number of fractional digits than
 * ISO 4217, which is core's minor-unit contract. Adyen documents its own table
 * as leading, so passing core minor units through would silently shift the
 * decimal point (100 ISK in core minor units is 1.00 ISK, but Adyen would read
 * 100 ISK). Rejected locally rather than mis-charged; the same shape as the
 * PayZen CNY/KHR exclusion.
 */
const ADYEN_EXPONENT_DEVIATIONS = new Map<string, number>([
  ["CLP", 2],
  ["CVE", 0],
  ["IDR", 0],
  ["ISK", 2],
]);

/** Adyen's documented limits on the fields the adapter fills. */
const REFERENCE_MAX_LENGTH = 80;
const METADATA_MAX_ENTRIES = 20;
const METADATA_MAX_KEY_LENGTH = 20;
const METADATA_MAX_VALUE_LENGTH = 80;

/**
 * Adyen documents no charset restriction on `reference`, so this one is the
 * adapter's: Adyen echoes the value back as `merchantReference`, one of the
 * eight colon-joined values the webhook HMAC signs, and a reference containing
 * the delimiter (or a backslash) makes that signing payload ambiguous. Every
 * webhook for the payment would then fail verification, silently and
 * permanently, after the shopper has paid. For a push-only provider the webhook
 * is the only source of truth, so the constraint is enforced at session
 * creation, while the host still owns the id.
 */
const REFERENCE_FORBIDDEN_CHARACTERS = /[:\\]/;

/** The metadata key the host's own payment id round-trips on. */
const HOST_ID_METADATA_KEY = "payfanout_id";

/** Adyen answers an in-flight duplicate of an idempotent request with this error code. */
const IN_FLIGHT_DUPLICATE_ERROR_CODE = "704";

/**
 * Adyen's Checkout responses carry no creation timestamp, and a push-only
 * provider offers no read to fetch one from. Hosts take the payment's creation
 * time from their own record or from the webhook's `eventDate`.
 */
const UNKNOWN_CREATED_AT = "1970-01-01T00:00:00.000Z";

/**
 * Adyen is a PUSH-ONLY provider: its `pspReference` is a write target, there is
 * no read for a payment or a refund, and every modification answers with a bare
 * acknowledgement whose outcome arrives by webhook. Two consequences shape this
 * adapter:
 *
 *  - Capabilities declare `supportsPaymentRetrieval: false`,
 *    `supportsRefundRetrieval: false` and `modificationOutcome: "asynchronous"`;
 *    capture and cancel resolve "processing" and refunds "pending", never a
 *    terminal state Adyen has not confirmed.
 *  - `PaymentInfo.pspPaymentId` is the composite `"{pspReference}:{value}:{currency}"`.
 *    A capture or refund needs the payment's currency (and, when no amount is
 *    given, its value); with no read and no persistence, the money facts ride the
 *    reference. The part before the first ":" is Adyen's own pspReference — the
 *    one webhooks report — and cancels accept it bare.
 */
export class AdyenServerAdapter implements ServerPaymentAdapter {
  readonly pspName = ADYEN_PSP_NAME;
  private readonly config: AdyenServerAdapterConfig;
  private readonly baseUrl: string;
  private readonly hmacKeys: string[];
  private readonly webhookBasicAuth: AdyenWebhookBasicAuth[];

  constructor(config: AdyenServerAdapterConfig) {
    for (const key of ["apiKey", "merchantAccount", "sessionSigningKey"] as const) {
      if (!config[key]) throw PayFanoutError.invalidRequest(`AdyenServerAdapter config.${key} is required`);
    }
    if (config.environment !== "sandbox" && config.environment !== "live") {
      throw PayFanoutError.invalidRequest('AdyenServerAdapter config.environment must be "sandbox" or "live"');
    }
    if (config.environment === "live" && !config.baseUrl && !config.liveUrlPrefix) {
      throw PayFanoutError.invalidRequest(
        "AdyenServerAdapter config.liveUrlPrefix is required on live (the account's live URL prefix)",
      );
    }
    const apiVersion = config.apiVersion ?? ADYEN_DEFAULT_API_VERSION;
    if (!/^v\d+$/.test(apiVersion)) {
      throw PayFanoutError.invalidRequest('AdyenServerAdapter config.apiVersion must look like "v72"');
    }
    this.hmacKeys = normalizeSecrets(config.hmacKeys);
    if (this.hmacKeys.length === 0) {
      throw PayFanoutError.invalidRequest(
        "AdyenServerAdapter config.hmacKeys is required (the hex webhook HMAC key, or several during rotation)",
      );
    }
    // Decoded here so a mistyped key fails at construction rather than inside
    // the webhook handler, on a delivery that is already in production.
    for (const key of this.hmacKeys) hexToBytes(key);
    this.webhookBasicAuth = (
      Array.isArray(config.webhookBasicAuth) ? config.webhookBasicAuth : [config.webhookBasicAuth]
    ).filter((credential): credential is AdyenWebhookBasicAuth => Boolean(credential?.username && credential?.password));
    if (this.webhookBasicAuth.length === 0) {
      throw PayFanoutError.invalidRequest(
        "AdyenServerAdapter config.webhookBasicAuth is required ({ username, password } as configured on the Adyen webhook)",
      );
    }
    if (config.sessionTtlSeconds !== undefined && !(config.sessionTtlSeconds > 0)) {
      throw PayFanoutError.invalidRequest("AdyenServerAdapter config.sessionTtlSeconds must be > 0");
    }
    if (config.requestTimeoutMs !== undefined && !(config.requestTimeoutMs > 0)) {
      throw PayFanoutError.invalidRequest("AdyenServerAdapter config.requestTimeoutMs must be > 0");
    }
    if (
      config.maxNetworkRetries !== undefined &&
      (!Number.isInteger(config.maxNetworkRetries) || config.maxNetworkRetries < 0)
    ) {
      throw PayFanoutError.invalidRequest("AdyenServerAdapter config.maxNetworkRetries must be an integer >= 0");
    }
    this.config = config;
    this.baseUrl =
      config.baseUrl ??
      (config.environment === "live"
        ? `https://${config.liveUrlPrefix}-checkout-live.adyenpayments.com/checkout/${apiVersion}`
        : `https://checkout-test.adyen.com/${apiVersion}`);
  }

  getCapabilities(): AdapterCapabilities {
    return {
      pspName: this.pspName,
      // Adyen exposes no read for a payment: the pspReference is a write target,
      // and payment state reaches the host over webhooks alone.
      supportsPaymentRetrieval: false,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      // Nor a read for a refund — the REFUND / REFUND_FAILED webhooks are the
      // only place a refund outcome appears.
      supportsRefundRetrieval: false,
      supportsManualCapture: true, // additionalData.manualCapture + POST /payments/{id}/captures
      // Multiple partial captures are disabled by default at Adyen (per-account
      // enablement) and a single partial capture auto-cancels the remainder, so
      // the adapter does not claim the capability.
      supportsMultiCapture: false,
      // Every modification answers { status: "received" } — the acknowledgement,
      // not the outcome.
      modificationOutcome: "asynchronous",
      // The HMAC covers eight values extracted from the payload, not its bytes,
      // so a re-encoded body still verifies and everything outside those eight
      // fields arrives unauthenticated — the channel carries the credentials.
      webhookSignatureScope: "field-values",
      supportsPaymentMethodVerification: false,
      supportsSavedPaymentMethods: false,
      supportsSessionUpdate: false,
      supportsEventPolling: false,
      supportsListing: false,
      nativeSubscriptions: { list: false, retrieve: false, create: false, cancel: false },
      requiresServerCompletion: true, // tokenize-first: the browser encrypts, the server creates the payment
      paymentMethods: this.config.paymentMethods ?? DEFAULT_METHODS,
    };
  }

  /**
   * Creates NO Adyen object: the payment only exists once `completePayment`
   * posts `/payments`. Amount, currency, reference, capture method and the
   * checkout fields are signed into the returned `pspSessionId`, which is also
   * the session's `clientSecret` — the browser reads the payload half to drive
   * Adyen Web's own copy and cannot tamper with the amount.
   */
  async createPaymentSession(input: CreatePaymentSessionInput): Promise<PaymentSession> {
    assertMinorUnitAmount(input.amount, "amount");
    const currency = this.assertSupportedCurrency(input.currency);
    if (input.paymentMethodTypes?.some((type) => !this.isKnownMethodType(type))) {
      throw PayFanoutError.invalidRequest(
        `Adyen adapter does not support one of the requested payment method types: ${input.paymentMethodTypes.join(", ")}`,
        { paymentMethodTypes: input.paymentMethodTypes },
      );
    }
    const returnUrl = input.returnUrl ?? this.config.defaultReturnUrl;
    if (!returnUrl) throw this.missingReturnUrl();
    // Deterministic so a replayed session creation yields the same merchant
    // reference: paired with the caller's idempotency key on /payments, a replay
    // converges on one Adyen payment.
    const reference = input.id ?? `pf_${(await sha256Hex(input.idempotencyKey)).slice(0, 32)}`;
    if (reference.length > REFERENCE_MAX_LENGTH) {
      throw PayFanoutError.invalidRequest(
        `Adyen references are at most ${REFERENCE_MAX_LENGTH} characters, got ${reference.length}`,
        { reference },
      );
    }
    if (REFERENCE_FORBIDDEN_CHARACTERS.test(reference)) {
      throw PayFanoutError.invalidRequest(
        'Adyen references must not contain ":" or "\\": the reference travels back as merchantReference, one of the ' +
          "eight values the webhook HMAC signs, and a signed value carrying the delimiter would make every webhook " +
          "for this payment fail verification",
        { reference },
      );
    }
    const metadata = assertMetadata(input.id ? { ...input.metadata, [HOST_ID_METADATA_KEY]: input.id } : input.metadata);
    const context: AdyenSessionContextV1 = {
      v: 1,
      amount: input.amount,
      currency,
      captureMethod: input.captureMethod ?? "automatic",
      reference,
      expiresAt: this.now() + this.sessionTtlMs(),
      returnUrl,
      ...(input.id ? { id: input.id } : {}),
      ...(metadata ? { metadata } : {}),
      ...(input.receiptEmail ? { receiptEmail: input.receiptEmail } : {}),
    };
    const token = await encodeSessionContext(context, this.config.sessionSigningKey);
    return {
      id: input.id ?? reference,
      pspName: this.pspName,
      pspSessionId: token,
      // The browser needs the session's own facts (amount/currency), not a PSP
      // secret: Adyen Web is addressed by the public clientKey the client adapter
      // holds, so the signed context is what travels.
      clientSecret: token,
      amount: input.amount,
      currency,
      status: "requires_payment_method",
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
  }

  /**
   * Tokenize-first completion. `clientToken` is the JSON the client adapter's
   * confirm() produced:
   *
   *  - the encrypted `paymentMethod` blob from Adyen's hosted card fields, which
   *    creates the payment (POST /payments), or
   *  - `{ details, paymentData }` from a resolved action, which finishes it
   *    (POST /payments/details).
   *
   * The signed context is the only trusted source of amount/currency/capture
   * method. An `action` in the response surfaces as requires_action with the
   * action preserved on `raw`; a refusal is raised as a mapped PayFanoutError
   * rather than folded into a "failed" PaymentInfo.
   */
  async completePayment(input: CompletePaymentInput): Promise<PaymentInfo> {
    const submission = parseClientToken(input.clientToken);
    const context = await this.decodeContext(input.pspSessionId);
    const response =
      "details" in submission
        ? await this.post<AdyenPaymentResponse>(
            "/payments/details",
            {
              details: submission.details,
              ...(submission.paymentData ? { paymentData: submission.paymentData } : {}),
            },
            input.idempotencyKey,
          )
        : await this.post<AdyenPaymentResponse>(
            "/payments",
            this.buildPaymentRequest(context, submission.paymentMethod),
            input.idempotencyKey,
          );
    const pspReference = response.pspReference;
    if (!pspReference) {
      throw new PayFanoutError({
        code: "processing_error",
        message: getUserMessage("processing_error"),
        retryable: false,
        raw: response,
        pspName: this.pspName,
      });
    }
    const resultCode = response.resultCode ?? "";
    if (resultCode === "Refused" || resultCode === "Error") throw mapAdyenRefusal(response);
    const status = response.action ? "requires_action" : mapAdyenResultCode(resultCode, context.captureMethod);
    return {
      id: context.id ?? context.reference,
      pspName: this.pspName,
      pspPaymentId: encodeAdyenPaymentRef(pspReference, context.amount, context.currency),
      status,
      amount: context.amount,
      // Refunds and captures are acknowledged, never settled, in-band: the
      // running totals only exist once the webhooks land.
      amountRefunded: 0,
      ...(status === "requires_capture" ? { amountCapturable: context.amount } : {}),
      currency: context.currency,
      paymentMethodType: "card",
      ...(context.metadata ? { metadata: context.metadata } : {}),
      createdAt: UNKNOWN_CREATED_AT,
      raw: response,
    };
  }

  /**
   * Requests a capture. Adyen answers `{ status: "received" }`, so the reported
   * status is "processing" and no amountCaptured is invented — the settled amount
   * is knowable only from the CAPTURE webhook.
   */
  async capturePayment(
    pspPaymentId: string,
    amount: MinorUnitAmount | undefined,
    idempotencyKey: string,
  ): Promise<PaymentInfo> {
    if (amount !== undefined) assertMinorUnitAmount(amount, "capture amount");
    const ref = decodeAdyenPaymentRef(pspPaymentId);
    const value = amount ?? ref.amount;
    if (value === undefined || ref.currency === undefined) throw this.missingMoneyFacts("capture", pspPaymentId);
    // The exponent guard is not a session-time formality: the composite
    // reference is documented, so a host can drive a capture for a payment
    // created elsewhere, and an excluded currency would be priced 100x off.
    const currency = this.assertSupportedCurrency(ref.currency);
    const acknowledgement = await this.post<AdyenModificationResponse>(
      `/payments/${encodeURIComponent(ref.pspReference)}/captures`,
      {
        merchantAccount: this.config.merchantAccount,
        // The capture currency must match the authorisation's.
        amount: { currency, value },
      },
      idempotencyKey,
    );
    return this.acknowledge(ref, acknowledgement, ref.amount ?? value);
  }

  /** Requests a cancel. Accepts the bare pspReference: no money facts are needed. */
  async cancelPayment(pspPaymentId: string, idempotencyKey: string): Promise<PaymentInfo> {
    const ref = decodeAdyenPaymentRef(pspPaymentId);
    const acknowledgement = await this.post<AdyenModificationResponse>(
      `/payments/${encodeURIComponent(ref.pspReference)}/cancels`,
      { merchantAccount: this.config.merchantAccount },
      idempotencyKey,
    );
    return this.acknowledge(ref, acknowledgement, ref.amount ?? 0);
  }

  /**
   * Requests a refund. Always "pending": Adyen acknowledges the request and the
   * REFUND / REFUND_FAILED webhook carries the outcome. With no payment read, an
   * amountless (full) refund takes its value from the composite pspPaymentId.
   */
  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    if (req.amount !== undefined) assertMinorUnitAmount(req.amount, "refund amount");
    const ref = decodeAdyenPaymentRef(req.pspPaymentId);
    const value = req.amount ?? ref.amount;
    if (value === undefined || ref.currency === undefined) throw this.missingMoneyFacts("refund", req.pspPaymentId);
    const currency = this.assertSupportedCurrency(ref.currency);
    const acknowledgement = await this.post<AdyenModificationResponse>(
      `/payments/${encodeURIComponent(ref.pspReference)}/refunds`,
      {
        merchantAccount: this.config.merchantAccount,
        amount: { currency, value },
      },
      req.idempotencyKey,
    );
    if (!acknowledgement.pspReference) {
      throw new PayFanoutError({
        code: "processing_error",
        message: getUserMessage("processing_error"),
        retryable: false,
        raw: acknowledgement,
        pspName: this.pspName,
      });
    }
    return {
      // The refund's OWN pspReference — the one the REFUND webhook reports.
      refundId: acknowledgement.pspReference,
      status: "pending",
      amount: value,
      raw: acknowledgement,
    };
  }

  async verifyWebhookSignature(rawBody: string, headers: Record<string, string>): Promise<boolean> {
    return verifyAdyenWebhookSignature(rawBody, headers, {
      hmacKeys: this.hmacKeys,
      basicAuth: this.webhookBasicAuth,
    });
  }

  async parseWebhookEvent(rawBody: string): Promise<UnifiedWebhookEvent> {
    return parseAdyenWebhookEvent(rawBody);
  }

  // --- internals ------------------------------------------------------------

  /**
   * The POST /payments body. `returnUrl` is one of Adyen's required top-level
   * fields, so the session's own value is used when it has one and the adapter's
   * `defaultReturnUrl` otherwise; a context carrying neither (one signed before
   * the fallback was configured) is refused here rather than sent to be rejected.
   */
  private buildPaymentRequest(
    context: AdyenSessionContextV1,
    paymentMethod: Record<string, unknown>,
  ): Record<string, unknown> {
    const returnUrl = context.returnUrl ?? this.config.defaultReturnUrl;
    if (!returnUrl) throw this.missingReturnUrl();
    // encodeSessionContext is exported, so a context can be minted by hand or
    // signed before this map changed — re-check on the way out rather than
    // trusting that createPaymentSession was the only door in.
    const currency = this.assertSupportedCurrency(context.currency);
    assertMinorUnitAmount(context.amount, "amount");
    return {
      merchantAccount: this.config.merchantAccount,
      amount: { currency, value: context.amount },
      reference: context.reference,
      paymentMethod,
      returnUrl,
      ...(context.metadata ? { metadata: context.metadata } : {}),
      ...(context.receiptEmail ? { shopperEmail: context.receiptEmail } : {}),
      // Manual capture is a per-payment flag; the alternative is enabling it
      // account-wide, which would hold EVERY payment for capture.
      ...(context.captureMethod === "manual" ? { additionalData: { manualCapture: "true" } } : {}),
    };
  }

  private missingReturnUrl(): PayFanoutError {
    return PayFanoutError.invalidRequest(
      "Adyen lists returnUrl among the required fields on POST /payments — pass returnUrl on createPaymentSession, " +
        "or set the adapter's defaultReturnUrl",
    );
  }

  private acknowledge(
    ref: AdyenPaymentRef,
    acknowledgement: AdyenModificationResponse,
    amount: MinorUnitAmount,
  ): PaymentInfo {
    return {
      id: ref.pspReference,
      pspName: this.pspName,
      pspPaymentId:
        ref.amount !== undefined && ref.currency !== undefined
          ? encodeAdyenPaymentRef(ref.pspReference, ref.amount, ref.currency)
          : ref.pspReference,
      // Adyen has ACKNOWLEDGED the request, nothing more: reporting "canceled" or
      // a captured total would claim an outcome only the webhook can confirm.
      status: "processing",
      amount,
      amountRefunded: 0,
      // XXX is ISO 4217's "no currency": a bare pspReference carries none.
      currency: ref.currency ?? "XXX",
      paymentMethodType: "card",
      createdAt: UNKNOWN_CREATED_AT,
      raw: acknowledgement,
    };
  }

  private missingMoneyFacts(operation: string, pspPaymentId: string): PayFanoutError {
    return PayFanoutError.invalidRequest(
      `Adyen exposes no payment read, so a ${operation} takes its currency (and, without an explicit amount, its value) from the ` +
        'pspPaymentId completePayment returned — the composite "{pspReference}:{value}:{currency}", not a bare pspReference',
      { pspPaymentId },
    );
  }

  private assertSupportedCurrency(currency: string): string {
    const code = normalizeCurrency(currency);
    const adyenDigits = ADYEN_EXPONENT_DEVIATIONS.get(code);
    if (adyenDigits !== undefined) {
      // Adyen supports these — the exclusion is the adapter's, because the two
      // exponent tables disagree and Adyen's own is the one it charges by.
      throw PayFanoutError.invalidRequest(
        `The Adyen adapter excludes ${code}: Adyen prices it with ${String(adyenDigits)} fractional digit(s) while ` +
          `ISO 4217 minor units use ${String(getCurrencyExponent(code))}, so amounts passed through would shift the decimal point`,
        { currency: code, adyenFractionalDigits: adyenDigits },
      );
    }
    return code;
  }

  private decodeContext(pspSessionId: string): Promise<AdyenSessionContextV1> {
    return decodeSessionContext(pspSessionId, this.config.sessionSigningKey, { now: this.now() });
  }

  private now(): number {
    return (this.config.now ?? Date.now)();
  }

  private sessionTtlMs(): number {
    return (this.config.sessionTtlSeconds ?? 3600) * 1000;
  }

  private isKnownMethodType(type: string): boolean {
    return (this.config.paymentMethods ?? DEFAULT_METHODS).some((method) => method.type === type);
  }

  /**
   * Transport with timeout + transient-only retries. Every Adyen call is a POST
   * carrying an `idempotency-key`, so a replay can never double-charge; business
   * rejections (refusals, validation) surface on the first attempt.
   */
  private post<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    return withTransportRetries(() => this.postOnce<T>(path, body, idempotencyKey), {
      attempts: 1 + (this.config.maxNetworkRetries ?? 2),
      ...(this.config.sleep ? { sleep: this.config.sleep } : {}),
      // Beyond transport trouble, a duplicate racing the still in-flight original
      // resolves itself moments later — replay it too.
      isRetryable: (err) => isTransportRetryable(err) || isReplayInFlight(err),
    });
  }

  private async postOnce<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    const { response, text } = await requestWithTimeout(
      {
        fetch: this.config.fetch ?? fetch,
        timeoutMs,
        onFailure: (timedOut, cause) =>
          new PayFanoutError({
            code: "psp_unavailable",
            message: timedOut ? `Adyen did not respond within ${timeoutMs}ms.` : "Could not reach Adyen.",
            retryable: true,
            raw: cause,
            pspName: this.pspName,
          }),
      },
      `${this.baseUrl}${path}`,
      {
        method: "POST",
        headers: {
          "x-api-key": this.config.apiKey,
          "content-type": "application/json",
          // Scoped to the endpoint: Adyen's keys are account-wide, so one
          // caller key spanning two calls must not replay the first answer.
          "idempotency-key": await deriveAdyenIdempotencyKey(path, idempotencyKey),
        },
        body: JSON.stringify(body),
      },
    );
    const json = text ? safeJson(text) : undefined;
    if (!response.ok) {
      throw mapAdyenError(response.status, json ?? text, {
        transient: response.headers.get("transient-error") === "true",
      });
    }
    return json as T;
  }
}

/** The money facts a push-only reference carries alongside Adyen's own pspReference. */
export interface AdyenPaymentRef {
  pspReference: string;
  amount?: MinorUnitAmount;
  currency?: string;
}

/**
 * `"{pspReference}:{value}:{currency}"`. Adyen's pspReference is alphanumeric, so
 * the separator is unambiguous, and the part before the first ":" stays the bare
 * reference webhooks report.
 */
export function encodeAdyenPaymentRef(pspReference: string, amount: MinorUnitAmount, currency: string): string {
  return `${pspReference}:${amount}:${currency}`;
}

/** Accepts the composite or a bare pspReference (all a cancel needs). */
export function decodeAdyenPaymentRef(pspPaymentId: string): AdyenPaymentRef {
  const parts = pspPaymentId.split(":");
  if (parts.length === 3) {
    // Digits only: Number() would otherwise accept "1e3", "0x10" and padding.
    const amount = /^\d+$/.test(parts[1] ?? "") ? Number(parts[1]) : Number.NaN;
    if (parts[0] && Number.isSafeInteger(amount) && amount >= 0 && /^[A-Za-z]{3}$/.test(parts[2]!)) {
      return { pspReference: parts[0], amount, currency: parts[2]!.toUpperCase() };
    }
  }
  return { pspReference: pspPaymentId };
}

/**
 * Adyen resultCode -> the unified status. `Authorised` is terminal for an
 * automatic-capture payment (the capture is scheduled) and `requires_capture`
 * when the payment was authorised for manual capture. The 3-D Secure
 * intermediates (`AuthenticationFinished`, `AuthenticationNotRequired`) are not
 * results: the authorisation follows from /payments/details.
 */
export function mapAdyenResultCode(
  resultCode: string,
  captureMethod: "automatic" | "manual",
): UnifiedPaymentStatus {
  switch (resultCode) {
    case "Authorised":
      return captureMethod === "manual" ? "requires_capture" : "succeeded";
    case "Cancelled":
      return "canceled";
    case "Refused":
    case "Error":
      return "failed";
    case "RedirectShopper":
    case "IdentifyShopper":
    case "ChallengeShopper":
    case "PresentToShopper":
      return "requires_action";
    case "PartiallyAuthorised":
      // Only part of the amount was authorised; the shopper still owes the
      // remainder, so the payment is not done — it needs another instrument.
      return "requires_action";
    case "Received":
    case "Pending":
    case "AuthenticationFinished":
    case "AuthenticationNotRequired":
      return "processing";
    default:
      return "processing";
  }
}

/**
 * Adyen refusalReasonCode -> the unified taxonomy. Every refusal is a business
 * rejection, so none of them is retryable: replaying the same idempotency key
 * returns the same refusal, and a fresh attempt is the shopper's move.
 */
const REFUSAL_CODE_MAP: Record<string, UnifiedErrorCode> = {
  "2": "card_declined", // Refused
  "5": "card_declined", // Blocked Card
  "6": "expired_card",
  "8": "invalid_card_data", // Invalid Card Number
  // Issuer Unavailable: transient at the issuer, but a replay of the same key
  // returns the same answer, so it is the shopper who retries, not the caller.
  "9": "processing_error",
  "11": "authentication_required", // 3D Not Authenticated
  "12": "insufficient_funds", // Not enough balance
  "14": "fraud_suspected", // Acquirer Fraud
  "20": "fraud_suspected", // FRAUD
  "24": "invalid_card_data", // CVC Declined
  "38": "authentication_required",
  "42": "authentication_required", // 3DS Authentication Error
  "46": "card_declined", // Transaction blocked by Adyen
};

export function mapAdyenRefusal(response: AdyenPaymentResponse): PayFanoutError {
  // Adyen separates "Refused" (the issuer said no) from "Error" (the payment
  // failed while being processed). Defaulting both to card_declined would tell a
  // shopper their card was declined when nothing reached the issuer.
  const fallback: UnifiedErrorCode = response.resultCode === "Error" ? "processing_error" : "card_declined";
  const code = REFUSAL_CODE_MAP[response.refusalReasonCode ?? ""] ?? fallback;
  return new PayFanoutError({
    code,
    message: getUserMessage(code),
    // A refusal never replays into a different answer.
    retryable: false,
    raw: response,
    pspName: ADYEN_PSP_NAME,
  });
}

export interface MapAdyenErrorOptions {
  /** True when the response carried Adyen's `transient-error: true` header. */
  transient?: boolean;
}

/**
 * Adyen HTTP errors -> the unified taxonomy. 401/403 (bad key) and 422
 * (validation) are caller-side invalid_request, 429 is rate_limited and 5xx is
 * psp_unavailable — both retryable. A 409 is replayable only when Adyen marks it
 * transient, and errorCode 704 (a duplicate racing the in-flight original)
 * resolves itself moments later.
 */
export function mapAdyenError(httpStatus: number, body: unknown, options: MapAdyenErrorOptions = {}): PayFanoutError {
  const error = (body ?? undefined) as AdyenApiError | undefined;
  const errorCode = typeof error?.errorCode === "string" ? error.errorCode : undefined;
  const raw = body ?? { status: httpStatus };
  if (errorCode === IN_FLIGHT_DUPLICATE_ERROR_CODE) {
    return new PayFanoutError({
      code: "processing_error",
      message: getUserMessage("processing_error"),
      retryable: true,
      raw,
      pspName: ADYEN_PSP_NAME,
    });
  }
  if (httpStatus === 409) {
    return new PayFanoutError({
      code: "processing_error",
      message: getUserMessage("processing_error"),
      retryable: options.transient === true,
      raw,
      pspName: ADYEN_PSP_NAME,
    });
  }
  const { code, retryable } = classifyHttpFallback(httpStatus);
  return new PayFanoutError({ code, message: getUserMessage(code), retryable, raw, pspName: ADYEN_PSP_NAME });
}

/** The retryable processing_error only mapAdyenError's in-flight branches produce. */
function isReplayInFlight(error: unknown): boolean {
  return isPayFanoutError(error) && error.code === "processing_error" && error.retryable;
}

/** What the client adapter's confirm() produced, parsed back out of the clientToken. */
type AdyenSubmission =
  | { paymentMethod: Record<string, unknown> }
  | { details: Record<string, unknown>; paymentData?: string };

function parseClientToken(clientToken: string): AdyenSubmission {
  if (!clientToken) {
    throw PayFanoutError.invalidRequest("completePayment requires the clientToken produced by confirm()", {
      clientToken,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(clientToken);
  } catch (err) {
    throw PayFanoutError.invalidRequest(
      "Adyen clientTokens are the JSON payload confirm() produced (the encrypted paymentMethod, or { details })",
      err,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw PayFanoutError.invalidRequest("Adyen clientToken payload is not a JSON object", parsed);
  }
  const payload = parsed as Record<string, unknown>;
  const details = payload["details"];
  if (details !== undefined) {
    if (details === null || typeof details !== "object") {
      throw PayFanoutError.invalidRequest("Adyen clientToken `details` must be an object", payload);
    }
    const paymentData = payload["paymentData"];
    return {
      details: details as Record<string, unknown>,
      ...(typeof paymentData === "string" ? { paymentData } : {}),
    };
  }
  if (typeof payload["type"] !== "string") {
    throw PayFanoutError.invalidRequest(
      `Adyen paymentMethod payloads carry a type (cards are "${CARD_PAYMENT_METHOD_TYPE}")`,
      payload,
    );
  }
  return { paymentMethod: payload };
}

/** Adyen caps metadata at 20 entries, 20-character keys and 80-character values. */
function assertMetadata(metadata: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata);
  if (entries.length === 0) return undefined;
  if (entries.length > METADATA_MAX_ENTRIES) {
    throw PayFanoutError.invalidRequest(`Adyen accepts at most ${METADATA_MAX_ENTRIES} metadata entries`, {
      entries: entries.length,
    });
  }
  for (const [key, value] of entries) {
    if (key.length > METADATA_MAX_KEY_LENGTH) {
      throw PayFanoutError.invalidRequest(
        `Adyen metadata keys are at most ${METADATA_MAX_KEY_LENGTH} characters, got "${key}"`,
        { key },
      );
    }
    if (typeof value !== "string" || value.length > METADATA_MAX_VALUE_LENGTH) {
      throw PayFanoutError.invalidRequest(
        `Adyen metadata values are at most ${METADATA_MAX_VALUE_LENGTH} characters, got "${key}"`,
        { key },
      );
    }
  }
  return metadata;
}
