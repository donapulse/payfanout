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
import { deriveAdyenIdempotencyKey, derivePaymentIdempotencyKey, hexToBytes } from "./signing.js";
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
   * Where Adyen sends the shopper back from a redirect, including the 3-D
   * Secure redirect flow Adyen can choose instead of the native one.
   * `returnUrl` is one of the required top-level fields on POST /payments, so
   * a session that carries none falls back to this value; with neither,
   * session creation is refused instead of sending Adyen a request it rejects.
   * Absolute with a scheme (`https://` on the web, an app scheme such as
   * `my-app://`), without whitespace, at most 1024 characters once serialized,
   * and without `//` in the path of a web URL — a value that breaks those rules
   * is refused at construction. It is sent WHATWG-serialized, so non-ASCII
   * characters travel percent-encoded.
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
   * The timer covers the whole exchange including the response body read.
   * Timeouts surface as retryable psp_unavailable and are retried under the same
   * `idempotency-key`, so a request that did reach Adyen is answered from its
   * store rather than performed twice.
   */
  requestTimeoutMs?: number;
  /**
   * Automatic retries with exponential backoff, each under the same
   * `idempotency-key` (default 2): network failures, timeouts, HTTP 408 and 429,
   * `errorCode` 705 (rate limited), a duplicate racing its in-flight original
   * (`errorCode` 704), 5xx errors other than 501 unless Adyen types them
   * `validation`, `configuration` or `security`, a 2xx whose body is not a JSON
   * object, and any error Adyen sends with `transient-error: true`. The 5xx retry
   * needs no `transient-error` header, deliberately: Adyen does not store a
   * request an internal error stopped, and the retry carries the same key. Every
   * other rejection surfaces on the first attempt, and a refusal is an answer,
   * never retried.
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
  /** The modification's own reference, never the payment's. */
  pspReference?: string;
  paymentPspReference?: string;
  merchantAccount?: string;
  /** Always "received": the outcome arrives by webhook. */
  status?: string;
  reference?: string;
  /** Captures and refunds echo the amount they were requested for. */
  amount?: { value?: number; currency?: string };
  /** Refunds echo the reason they were sent with. */
  merchantRefundReason?: string;
}

/** Adyen's error envelope. */
export interface AdyenApiError {
  status?: number;
  errorCode?: string;
  message?: string;
  /** `internal`, `validation`, `security` or `configuration`. */
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
 * eight values the webhook HMAC joins with `:` and no escaping. The verifier
 * can split a `:` in that one field, but a payment this adapter creates never
 * relies on it: for a push-only provider the webhook is the only source of
 * truth, so the delimiter (and a backslash) is refused at session creation,
 * while the host still owns the id.
 */
const REFERENCE_FORBIDDEN_CHARACTERS = /[:\\]/;

/** The metadata key the host's own payment id round-trips on. */
const HOST_ID_METADATA_KEY = "payfanout_id";

/** Adyen answers an in-flight duplicate of an idempotent request with this error code. */
const IN_FLIGHT_DUPLICATE_ERROR_CODE = "704";

/** Adyen's error code for a request its rate limiter refused. */
const RATE_LIMITED_ERROR_CODE = "705";

/**
 * Error types that fault the request itself. Adyen documents them on 5xx
 * answers too (its generic 500 example is a `configuration` error, and Checkout
 * v72 moved only some validation errors from 500 to 422), and replaying the
 * same request cannot change the answer.
 */
const REQUEST_ERROR_TYPES = new Set(["validation", "configuration", "security"]);

/** Creates the payment; its idempotency key covers the merchant account but not the body. */
const PAYMENTS_PATH = "/payments";

/** Finishes an action; the one endpoint whose idempotency key also covers the submitted data. */
const PAYMENT_DETAILS_PATH = "/payments/details";

/** A capture, cancel or refund of one payment: the paths that keep the 0.1.0 idempotency key. */
const MODIFICATION_PATH = /^\/payments\/[^/]+\/(?:captures|cancels|refunds)$/;

/** RefundRequest.reason -> Adyen's `merchantRefundReason`. */
const MERCHANT_REFUND_REASONS = new Map<string, string>([
  ["duplicate", "DUPLICATE"],
  ["fraudulent", "FRAUD"],
  ["requested_by_customer", "CUSTOMER REQUEST"],
]);

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
  /** `config.defaultReturnUrl`, serialized. */
  private readonly defaultReturnUrl: string | undefined;

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
    this.defaultReturnUrl = config.defaultReturnUrl
      ? assertReturnUrl(config.defaultReturnUrl, "defaultReturnUrl")
      : undefined;
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
   *
   * The shopper email Adyen asks for on Visa and JCB 3-D Secure 2 payments is
   * `receiptEmail`, or `billingDetails.email` when there is none; both ride
   * the signed context, whose payload half the browser can read. Refused with
   * invalid_request, before the shopper enters a card, when the return URL is
   * missing or malformed (see assertReturnUrl) or `receiptEmail` is not an
   * address of at most 256 characters. A `billingDetails.email` like that is
   * left out instead: billing details are optional data, withheld rather than
   * failing the session.
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
    // The configured default was checked and serialized at construction.
    const returnUrl =
      input.returnUrl === undefined
        ? this.defaultReturnUrl
        : input.returnUrl && assertReturnUrl(input.returnUrl, "returnUrl");
    if (!returnUrl) throw this.missingReturnUrl();
    const receiptEmail = input.receiptEmail ? assertShopperEmail(input.receiptEmail, "receiptEmail") : undefined;
    const billingEmail =
      !receiptEmail && input.billingDetails?.email && isShopperEmail(input.billingDetails.email)
        ? input.billingDetails.email
        : undefined;
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
          "eight values the webhook HMAC joins with that delimiter, and the adapter keeps the references it creates " +
          "free of it",
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
      ...(receiptEmail ? { receiptEmail } : {}),
      ...(billingEmail ? { billingEmail } : {}),
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
   * Tokenize-first completion. `clientToken` is the JSON the client adapter
   * produced (see parseClientToken):
   *
   *  - confirm()'s envelope — the encrypted card `paymentMethod` plus the
   *    browser data 3-D Secure uses — or the bare `paymentMethod` earlier
   *    client adapters send, which creates the payment (POST /payments), or
   *  - `{ details }` from a finished action (handleAction(), or the
   *    redirectResult of a 3-D Secure redirect return), which finishes it
   *    (POST /payments/details).
   *
   * The signed context is the only trusted source of amount, currency,
   * reference and capture method. A refusal is raised as a mapped
   * PayFanoutError rather than folded into a "failed" PaymentInfo. An `action`
   * surfaces as requires_action with Adyen's answer on `raw`. Adyen can answer
   * an action without a pspReference (its native 3-D Secure 2 example does);
   * `pspPaymentId` is then the empty string, which capturePayment,
   * cancelPayment and refundPayment refuse.
   *
   * Every answer is compared with the session it completes. A /payments
   * answer naming another merchant reference or amount is refused: the
   * request named the session's own, so the answer belongs to another request
   * (an idempotencyKey reused across sessions replays the first answer), and
   * unless it is Refused, Error or Cancelled the refusal carries
   * outcomeUnknown (see anotherRequestsAnswer). A
   * /payments/details answer stands for the session only when it names the
   * session's merchant reference and amount (see detailsBelongToSession); one
   * that does not carries no pspPaymentId and reads "processing". The
   * AUTHORISATION webhook, whose merchantReference is one of the signed
   * values, then supplies the reference
   * (`encodeAdyenPaymentRef(event.pspPaymentId, event.amount, event.currency)`).
   */
  async completePayment(input: CompletePaymentInput): Promise<PaymentInfo> {
    const submission = parseClientToken(input.clientToken);
    const context = await this.decodeContext(input.pspSessionId);
    let response: AdyenPaymentResponse;
    // Whether the answer is shown to be this session's, so its pspReference and result stand.
    let ownAnswer: boolean;
    if (submission.kind === "details") {
      response = await this.post<AdyenPaymentResponse>(
        "/payments/details",
        {
          details: submission.details,
          ...(submission.paymentData ? { paymentData: submission.paymentData } : {}),
        },
        input.idempotencyKey,
      );
      // The details decide which payment they finish, so a refusal is the
      // outcome of the details submitted and is raised as such.
      throwIfRefused(response);
      ownAnswer = this.detailsBelongToSession(response, context);
    } else {
      response = await this.post<AdyenPaymentResponse>(
        "/payments",
        this.buildPaymentRequest(context, submission),
        input.idempotencyKey,
      );
      // Checked before the refusal: an answer to another request says nothing
      // about this card, a refusal included.
      if (compareWithSession(response, context).differs) throw this.anotherRequestsAnswer(response, context);
      throwIfRefused(response);
      // The request carried the session's own reference and amount.
      ownAnswer = true;
    }
    if (response.action) return this.toPaymentInfo(context, response, "requires_action", ownAnswer);
    if (!response.pspReference) {
      throw new PayFanoutError({
        code: "processing_error",
        message: getUserMessage("processing_error"),
        retryable: false,
        raw: response,
        pspName: this.pspName,
      });
    }
    return this.toPaymentInfo(
      context,
      response,
      ownAnswer ? mapAdyenResultCode(response.resultCode ?? "", context.captureMethod) : "processing",
      ownAnswer,
    );
  }

  /**
   * Requests a capture. Adyen answers `{ status: "received" }`, so the reported
   * status is "processing" and no amountCaptured is invented — the settled amount
   * is knowable only from the CAPTURE webhook. An acknowledgement echoing a
   * different amount or currency is rejected, and one echoing none is accepted
   * (see readAcknowledgement).
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
    const response = await this.post<AdyenModificationResponse>(
      `/payments/${encodeURIComponent(ref.pspReference)}/captures`,
      {
        merchantAccount: this.config.merchantAccount,
        // The capture currency must match the authorisation's.
        amount: { currency, value },
      },
      idempotencyKey,
    );
    const acknowledgement = this.readAcknowledgement("capture", response, { currency, value });
    return this.acknowledge(ref, acknowledgement, ref.amount ?? value);
  }

  /**
   * Requests a cancel. Accepts the bare pspReference: no money facts are needed.
   * Adyen documents only that a captured payment can no longer be cancelled; a
   * cancel after the capture is assumed to be acknowledged and to fail in the
   * CANCELLATION webhook, and a rejection in the answer surfaces as an error.
   */
  async cancelPayment(pspPaymentId: string, idempotencyKey: string): Promise<PaymentInfo> {
    const ref = decodeAdyenPaymentRef(pspPaymentId);
    const response = await this.post<AdyenModificationResponse>(
      `/payments/${encodeURIComponent(ref.pspReference)}/cancels`,
      { merchantAccount: this.config.merchantAccount },
      idempotencyKey,
    );
    return this.acknowledge(ref, this.readAcknowledgement("cancel", response), ref.amount ?? 0);
  }

  /**
   * Requests a refund. Always "pending": Adyen acknowledges the request and the
   * REFUND / REFUND_FAILED webhook carries the outcome. With no payment read, an
   * amountless refund takes its value from the composite pspPaymentId, which is
   * the authorised amount: after a partial capture or refund Adyen refuses it.
   */
  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    if (req.amount !== undefined) assertMinorUnitAmount(req.amount, "refund amount");
    const ref = decodeAdyenPaymentRef(req.pspPaymentId);
    const value = req.amount ?? ref.amount;
    if (value === undefined || ref.currency === undefined) throw this.missingMoneyFacts("refund", req.pspPaymentId);
    const currency = this.assertSupportedCurrency(ref.currency);
    const merchantRefundReason = req.reason === undefined ? undefined : MERCHANT_REFUND_REASONS.get(req.reason);
    const response = await this.post<AdyenModificationResponse>(
      `/payments/${encodeURIComponent(ref.pspReference)}/refunds`,
      {
        merchantAccount: this.config.merchantAccount,
        amount: { currency, value },
        ...(merchantRefundReason ? { merchantRefundReason } : {}),
      },
      req.idempotencyKey,
    );
    const acknowledgement = this.readAcknowledgement("refund", response, { currency, value });
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
   * A /payments answer naming another reference or amount: Adyen answered
   * the key with its first request's stored response. Unless that payment was
   * refused, failed or cancelled, it may be the payment this call was meant
   * to make, so the refusal carries outcomeUnknown and no new key follows
   * until that payment is known to be another one.
   */
  private anotherRequestsAnswer(response: AdyenPaymentResponse, context: AdyenSessionContextV1): PayFanoutError {
    const outcome = mapAdyenResultCode(response.resultCode ?? "", context.captureMethod);
    const live = outcome !== "failed" && outcome !== "canceled";
    const reused =
      "This Adyen answer belongs to another request: an idempotencyKey reused across sessions replays the first answer";
    return new PayFanoutError({
      code: "invalid_request",
      message: live
        ? `${reused}, a payment that has not failed. It may be the payment this request was meant to make, so use a ` +
          "new idempotencyKey only once that payment is known to be another one."
        : `${reused}.`,
      retryable: false,
      outcomeUnknown: live,
      raw: response,
      pspName: this.pspName,
    });
  }

  /**
   * Completion correctness: /payments/details finishes whichever payment the
   * details were issued for, so its answer can only stand for this session
   * once it is shown to describe the session's own payment. A
   * `merchantReference` or `amount` that differs from the signed context means
   * the details finished a different payment: refused, not retryable, since a
   * retry gets the same answer. When Adyen omits either — its own example
   * answer carries neither — nothing ties the answer to the session. True only
   * when both are present and match.
   */
  private detailsBelongToSession(response: AdyenPaymentResponse, context: AdyenSessionContextV1): boolean {
    const { differs, names } = compareWithSession(response, context);
    if (differs) {
      throw new PayFanoutError({
        code: "invalid_request",
        message: "These payment details belong to a different payment than this session.",
        retryable: false,
        raw: response,
        pspName: this.pspName,
      });
    }
    return names;
  }

  /**
   * `ownAnswer` is false for an answer not shown to be the session's: its
   * pspReference is then left out, since nothing ties it to this payment, and
   * `raw` keeps only `resultCode` and `action`, the parts the browser needs.
   */
  private toPaymentInfo(
    context: AdyenSessionContextV1,
    response: AdyenPaymentResponse,
    status: UnifiedPaymentStatus,
    ownAnswer: boolean,
  ): PaymentInfo {
    return {
      id: context.id ?? context.reference,
      pspName: this.pspName,
      // Empty rather than a placeholder while the adapter holds no reference
      // for the payment: a placeholder could be stored and later mistaken for
      // Adyen's own.
      pspPaymentId:
        ownAnswer && response.pspReference
          ? encodeAdyenPaymentRef(response.pspReference, context.amount, context.currency)
          : "",
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
      raw: ownAnswer
        ? response
        : {
            ...(response.resultCode !== undefined ? { resultCode: response.resultCode } : {}),
            ...(response.action ? { action: response.action } : {}),
          },
    };
  }

  /**
   * The POST /payments body. `returnUrl` is one of Adyen's required top-level
   * fields, so the session's own value is used when it has one and the adapter's
   * `defaultReturnUrl` otherwise; a context carrying neither (one signed before
   * the fallback was configured) is refused here rather than sent to be rejected.
   *
   * The browser contributes only the fields Adyen's 3-D Secure guides ask the
   * page for; amount, currency, reference, merchant account and capture method
   * come from the signed context alone. With both `browserInfo` and `origin`
   * the payment asks for native 3-D Secure 2 with the fields Adyen's native
   * guide lists as required on the web. With `browserInfo` alone it carries the
   * browser data and omits `nativeThreeDS`, `channel` and `origin`; that Adyen
   * then uses its redirect flow is an unverified inference. A bare card token
   * from an earlier client adapter keeps the body it always had.
   *
   * `shopperIP` is not sent: core's inputs carry no shopper IP address. Adyen's
   * v72 reference requires it for Visa and JCB 3-D Secure 2 web payments only
   * when no `shopperEmail` is sent, while its 3-D Secure guides list it as
   * required for Visa and JCB on the web; which applies is unverified.
   */
  private buildPaymentRequest(context: AdyenSessionContextV1, card: AdyenCardSubmission): Record<string, unknown> {
    const returnUrl = context.returnUrl ?? this.defaultReturnUrl;
    if (!returnUrl) throw this.missingReturnUrl();
    // encodeSessionContext is exported, so a context can be minted by hand or
    // signed before this map changed — re-check on the way out rather than
    // trusting that createPaymentSession was the only door in.
    const currency = this.assertSupportedCurrency(context.currency);
    assertMinorUnitAmount(context.amount, "amount");
    const shopperEmail = context.receiptEmail ?? context.billingEmail;
    return {
      merchantAccount: this.config.merchantAccount,
      amount: { currency, value: context.amount },
      reference: context.reference,
      paymentMethod: card.paymentMethod,
      returnUrl,
      ...(context.metadata ? { metadata: context.metadata } : {}),
      ...(shopperEmail ? { shopperEmail } : {}),
      // Manual capture is a per-payment flag; the alternative is enabling it
      // account-wide, which would hold EVERY payment for capture.
      ...(context.captureMethod === "manual" ? { additionalData: { manualCapture: "true" } } : {}),
      ...(card.browserInfo ? { browserInfo: card.browserInfo } : {}),
      ...(card.browserInfo && card.origin
        ? {
            channel: "Web",
            origin: card.origin,
            authenticationData: { threeDSRequestData: { nativeThreeDS: "preferred" } },
          }
        : {}),
      ...(card.billingAddress ? { billingAddress: card.billingAddress } : {}),
      ...(card.riskData ? { riskData: card.riskData } : {}),
    };
  }

  private missingReturnUrl(): PayFanoutError {
    return PayFanoutError.invalidRequest(
      "Adyen lists returnUrl among the required fields on POST /payments — pass returnUrl on createPaymentSession, " +
        "or set the adapter's defaultReturnUrl",
    );
  }

  /**
   * A modification resolves only on an acknowledgement carrying its own
   * pspReference. One missing it confirms nothing, and since a replay under the
   * same key cannot repeat the modification, that rejection is retryable.
   * Adyen answers a reused idempotency key with the first request's stored
   * response, so a capture or refund acknowledgement echoing a different amount
   * or currency is the answer to an earlier request under the same key: it is
   * rejected, since reporting the requested amount as accepted would be false.
   * That request is only received, its outcome known from the webhook alone,
   * and it may be the one this call was meant to make, so the refusal always
   * carries outcomeUnknown. One echoing no amount is accepted, and a malformed
   * echo confirms nothing (retryable, like a missing pspReference).
   */
  private readAcknowledgement(
    operation: "capture" | "cancel" | "refund",
    response: AdyenModificationResponse,
    requested?: { currency: string; value: MinorUnitAmount },
  ): AdyenModificationResponse & { pspReference: string } {
    const unconfirmed = () =>
      new PayFanoutError({
        code: "processing_error",
        message: getUserMessage("processing_error"),
        retryable: true,
        raw: response,
        pspName: this.pspName,
      });
    if (typeof response.pspReference !== "string" || response.pspReference === "") throw unconfirmed();
    // The contract requires the echo, but the refund guide's own example omits
    // it: an absent or null echo is accepted, since refusing it would report a
    // refund Adyen took as failed. Only an echo naming another amount or
    // currency proves the key was used before.
    if (requested && response.amount != null) {
      const echoed = echoedAmount(response);
      if (!echoed) throw unconfirmed();
      if (echoed.value !== requested.value || echoed.currency !== requested.currency) {
        throw new PayFanoutError({
          code: "invalid_request",
          message:
            `Adyen already received a ${operation} of ${echoed.value} ${echoed.currency} under this idempotencyKey ` +
            `(pspReference ${response.pspReference}), whose outcome only its webhook reports. It may be the ` +
            `${operation} this request was meant to make, so send a further ${operation} under a new ` +
            `idempotencyKey only once that ${operation} is known to be another one.`,
          retryable: false,
          outcomeUnknown: true,
          raw: response,
          pspName: this.pspName,
        });
      }
    }
    return response as AdyenModificationResponse & { pspReference: string };
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
   * whose `idempotency-key` is derived once and sent unchanged on every attempt,
   * so a replay is answered from Adyen's store and can never double-charge;
   * rejections surface on the first attempt unless mapAdyenError reads them as
   * retryable. Resolves only with a JSON object.
   */
  private async post<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    const idempotencyHeader = await this.idempotencyHeader(path, body, idempotencyKey);
    return withTransportRetries(() => this.postOnce<T>(path, body, idempotencyHeader), {
      attempts: 1 + (this.config.maxNetworkRetries ?? 2),
      ...(this.config.sleep ? { sleep: this.config.sleep } : {}),
      // Beyond transport trouble, Adyen's transient errors — a duplicate racing
      // the still in-flight original among them — may be replayed too.
      isRetryable: (err) => isTransportRetryable(err) || isTransientRejection(err),
    });
  }

  /**
   * `/payments` and `/payments/details` carry no pspReference in their path, so
   * their header also covers the merchant account (and, on `/payments/details`,
   * the submitted data). Captures, cancels and refunds keep the header 0.1.0
   * sent; signing.ts gives the reasons for both derivations.
   */
  private idempotencyHeader(path: string, body: unknown, idempotencyKey: string): Promise<string> {
    const { merchantAccount } = this.config;
    if (path === PAYMENTS_PATH) return derivePaymentIdempotencyKey({ merchantAccount, path, idempotencyKey });
    if (path === PAYMENT_DETAILS_PATH) {
      return derivePaymentIdempotencyKey({ merchantAccount, path, idempotencyKey, ...detailsSubmission(body) });
    }
    if (MODIFICATION_PATH.test(path)) return deriveAdyenIdempotencyKey(path, idempotencyKey);
    // A new endpoint must choose its derivation: the 0.1.0 one is only safe on
    // paths that carry a payment's globally unique pspReference.
    throw new Error(`No idempotency-key derivation is defined for ${path}`);
  }

  private async postOnce<T>(path: string, body: unknown, idempotencyHeader: string): Promise<T> {
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
          "idempotency-key": idempotencyHeader,
        },
        body: JSON.stringify(body),
      },
    );
    const json = text ? safeJson(text) : undefined;
    if (!response.ok) {
      throw mapAdyenError(response.status, json ?? text, {
        transient: response.headers.get("transient-error")?.trim().toLowerCase() === "true",
      });
    }
    // Every endpoint the adapter calls answers a JSON object, so anything else
    // is no answer to act on; replaying it under the same key is safe.
    if (!isJsonObject(json)) {
      throw new PayFanoutError({
        code: "psp_unavailable",
        message: "Adyen returned an unreadable response.",
        retryable: true,
        raw: { status: response.status, body: text },
        pspName: this.pspName,
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

/**
 * Accepts the composite or a bare pspReference (all a cancel needs). An empty
 * or whitespace-only reference is refused with invalid_request, so capture,
 * cancel and refund send nothing for it: the empty `pspPaymentId`
 * completePayment reports while it holds no reference is not one.
 */
export function decodeAdyenPaymentRef(pspPaymentId: string): AdyenPaymentRef {
  const ref = splitPaymentRef(typeof pspPaymentId === "string" ? pspPaymentId : "");
  if (ref.pspReference.trim() === "") {
    throw PayFanoutError.invalidRequest(
      "An empty pspPaymentId is not an Adyen reference: completePayment reports one while it holds no reference for " +
        "the payment. Correlate by PaymentInfo.id, the merchant reference, until the AUTHORISATION webhook reports it",
      { pspPaymentId },
    );
  }
  return ref;
}

function splitPaymentRef(pspPaymentId: string): AdyenPaymentRef {
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
  "4": "processing_error", // Acquirer Error: the acquirer failed, not the card
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
  "21": "processing_error", // Not Submitted: the payment never reached processing
  "24": "invalid_card_data", // CVC Declined
  "31": "fraud_suspected", // Issuer Suspected Fraud
  "32": "invalid_card_data", // AVS Declined: the address the shopper entered is wrong
  "38": "authentication_required", // the issuer refused the exemption and asks for 3-D Secure
  // 3-D Secure the network, the issuer or the scheme could not complete, and a
  // payment network out of reach: authenticating again now does not help.
  "39": "processing_error", // RReq not received from DS
  "40": "processing_error", // Current AID is in Penalty Box
  "42": "processing_error", // 3DS Authentication Error
  "46": "card_declined", // Transaction blocked by Adyen
};

/** Looks a refusal code up among the map's own keys only. */
function refusalCodeFor(reason: string | undefined): UnifiedErrorCode | undefined {
  return reason !== undefined && Object.hasOwn(REFUSAL_CODE_MAP, reason) ? REFUSAL_CODE_MAP[reason] : undefined;
}

export function mapAdyenRefusal(response: AdyenPaymentResponse): PayFanoutError {
  // Adyen separates "Refused" (the issuer said no) from "Error" (the payment
  // failed while being processed). Defaulting both to card_declined would tell a
  // shopper their card was declined when nothing reached the issuer.
  const fallback: UnifiedErrorCode = response.resultCode === "Error" ? "processing_error" : "card_declined";
  const code = refusalCodeFor(response.refusalReasonCode) ?? fallback;
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
  /**
   * True when the response carried Adyen's `transient-error` header set to
   * `true`; the adapter reads the value case-insensitively, ignoring
   * surrounding whitespace.
   */
  transient?: boolean;
}

/**
 * Adyen HTTP errors -> the unified taxonomy, in this order:
 *
 *  - 429, or `errorCode` 705 whatever the status, is rate_limited (retryable);
 *  - `transient-error: true` is Adyen saying the same request may be retried
 *    with the same key: processing_error below 500, psp_unavailable from 500,
 *    both retryable;
 *  - `errorCode` 704 (a duplicate racing the in-flight original) is a retryable
 *    processing_error, any other 409 a non-retryable one;
 *  - 408 (Adyen: "You can retry the request") is a retryable psp_unavailable,
 *    501 (functionality not supported) a non-retryable invalid_request;
 *  - a 5xx typed `validation`, `configuration` or `security` faults the request
 *    itself: non-retryable invalid_request. Other 5xx are psp_unavailable and
 *    other 4xx (401/403 bad key, 422 validation) invalid_request.
 *
 * The processing_errors of the transient, 704 and 409 branches carry
 * outcomeUnknown: Adyen answers a request sent while another under the same
 * key is in flight with 704 or a transient error, and a 409 means "the request
 * was already processed or is in progress", so the key's request may still go
 * through.
 *
 * Those other 5xx stay retryable without the transient header, and under
 * `transient-error: false`, deliberately, although Adyen's idempotency guide
 * advises against retrying then: its HTTP status codes page says Adyen neither
 * accepts nor stores a request an internal error stopped, and a retry carries
 * the same key, so Adyen answers it from its store if the first attempt did
 * get through.
 */
export function mapAdyenError(httpStatus: number, body: unknown, options: MapAdyenErrorOptions = {}): PayFanoutError {
  const error = isJsonObject(body) ? (body as AdyenApiError) : undefined;
  const errorCode = typeof error?.errorCode === "string" ? error.errorCode : undefined;
  const errorType = typeof error?.errorType === "string" ? error.errorType.toLowerCase() : undefined;
  const raw = body ?? { status: httpStatus };
  const reject = (code: UnifiedErrorCode, retryable: boolean, outcomeUnknown = false) =>
    new PayFanoutError({ code, message: getUserMessage(code), retryable, raw, pspName: ADYEN_PSP_NAME, outcomeUnknown });
  if (httpStatus === 429 || errorCode === RATE_LIMITED_ERROR_CODE) return reject("rate_limited", true);
  if (options.transient === true) {
    return httpStatus >= 500 ? reject("psp_unavailable", true) : reject("processing_error", true, true);
  }
  if (errorCode === IN_FLIGHT_DUPLICATE_ERROR_CODE) return reject("processing_error", true, true);
  if (httpStatus === 409) return reject("processing_error", false, true);
  // Core's shared tail reads 408 as a client error and 501 as an outage.
  if (httpStatus === 408) return reject("psp_unavailable", true);
  if (httpStatus === 501) return reject("invalid_request", false);
  if (httpStatus >= 500 && errorType !== undefined && REQUEST_ERROR_TYPES.has(errorType)) {
    return reject("invalid_request", false);
  }
  const { code, retryable } = classifyHttpFallback(httpStatus);
  return reject(code, retryable);
}

/** The retryable processing_error mapAdyenError gives a transient 4xx or an in-flight duplicate (704). */
function isTransientRejection(error: unknown): boolean {
  return isPayFanoutError(error) && error.code === "processing_error" && error.retryable;
}

/** Raises Adyen's two failure resultCodes as the mapped refusal. */
function throwIfRefused(response: AdyenPaymentResponse): void {
  if (response.resultCode === "Refused" || response.resultCode === "Error") throw mapAdyenRefusal(response);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The amount a capture or refund acknowledgement echoes, when it is a well-formed one. */
function echoedAmount(response: AdyenModificationResponse): { value: number; currency: string } | undefined {
  const amount: unknown = response.amount;
  if (!isJsonObject(amount)) return undefined;
  const { value, currency } = amount;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || typeof currency !== "string") return undefined;
  return { value, currency: currency.toUpperCase() };
}

/** The part of a /payments/details body that tells one step of an action flow from the next. */
function detailsSubmission(body: unknown): { details?: unknown; paymentData?: string } {
  const { details, paymentData } = body as { details?: unknown; paymentData?: unknown };
  return { details, ...(typeof paymentData === "string" ? { paymentData } : {}) };
}

/**
 * The payment facts an answer carries, against the signed context: `differs`
 * when a `merchantReference`, `amount.value` or `amount.currency` is present
 * and not the session's; `names` when all three are present and match. A null
 * value reads as absent, as webhook values do.
 */
function compareWithSession(
  response: AdyenPaymentResponse,
  context: AdyenSessionContextV1,
): { differs: boolean; names: boolean } {
  const reference = response.merchantReference ?? undefined;
  const value = response.amount?.value ?? undefined;
  const currency = response.amount?.currency ?? undefined;
  const differs =
    (reference !== undefined && reference !== context.reference) ||
    (value !== undefined && value !== context.amount) ||
    (currency !== undefined && String(currency).toUpperCase() !== context.currency);
  return { differs, names: !differs && reference !== undefined && value !== undefined && currency !== undefined };
}

/** A card payment, from confirm()'s envelope or the bare paymentMethod earlier client adapters send. */
interface AdyenCardSubmission {
  kind: "card";
  paymentMethod: Record<string, string>;
  browserInfo?: AdyenBrowserInfo;
  origin?: string;
  billingAddress?: Record<string, string>;
  riskData?: { clientData: string };
}

/** The details that finish an action, for POST /payments/details. */
interface AdyenDetailsSubmission {
  kind: "details";
  details: Record<string, unknown>;
  paymentData?: string;
}

type AdyenSubmission = AdyenCardSubmission | AdyenDetailsSubmission;

/** Adyen's BrowserInfo: on the web, every field but javaScriptEnabled is required. */
interface AdyenBrowserInfo {
  acceptHeader: string;
  colorDepth: number;
  javaEnabled: boolean;
  javaScriptEnabled?: boolean;
  language: string;
  screenHeight: number;
  screenWidth: number;
  timeZoneOffset: number;
  userAgent: string;
}

/** CardDetails fields that are raw card data rather than the blob Adyen's hosted fields encrypt. */
const UNENCRYPTED_CARD_FIELDS = ["number", "expiryMonth", "expiryYear", "cvc"] as const;
/**
 * The CardDetails fields Adyen Web 6.41.0's Card puts in its paymentMethod for
 * a card entered in its hosted fields: the type, the encrypted field values
 * (`encryptedPassword` is the Korean-card one), the holder name, the detected
 * brand, a configured funding source, Fastlane data, and the
 * `checkoutAttemptId` and `sdkData` every Adyen Web element adds. Adyen's
 * native 3-D Secure 2 guide lists that complete paymentMethod, `sdkData`
 * included, as required. The Card's stored-card and Click to Pay values are
 * not among them, since the adapter supports neither flow, nor is the
 * Korean-card `taxNumber`, which v72's CardDetails does not define.
 */
const CARD_PAYMENT_METHOD_FIELDS = [
  "type",
  "encryptedCardNumber",
  "encryptedExpiryMonth",
  "encryptedExpiryYear",
  "encryptedSecurityCode",
  "encryptedPassword",
  "holderName",
  "brand",
  "fundingSource",
  "fastlaneData",
  "checkoutAttemptId",
  "sdkData",
] as const;
/** Adyen's BillingAddress: every field but stateOrProvince is required, each within its maximum length. */
const BILLING_ADDRESS_REQUIRED_FIELDS = ["city", "country", "houseNumberOrName", "postalCode", "street"] as const;
const BILLING_ADDRESS_MAX_LENGTHS: Readonly<Record<string, number>> = {
  city: 3000,
  houseNumberOrName: 3000,
  postalCode: 10,
  stateOrProvince: 3,
  street: 3000,
};
/** Adyen's limits on the fields completion fills from the browser and the session. */
const ORIGIN_MAX_LENGTH = 80;
const RISK_CLIENT_DATA_MAX_LENGTH = 5000;
const RETURN_URL_MAX_LENGTH = 1024;
const SHOPPER_EMAIL_MAX_LENGTH = 256;
/** An RFC 3986 scheme and "://": https:// on the web, an app's own scheme (my-app://) on mobile. */
const RETURN_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/\S*$/i;
/**
 * Plausibility, not full RFC 5322: one "@", no whitespace, dot-separated
 * domain labels. A domain without a dot (`jane@localhost`) is valid RFC 5322.
 */
const SHOPPER_EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*$/;

/**
 * Decodes the clientToken completePayment receives, which the browser
 * controls. Three shapes are accepted: confirm()'s envelope
 * `{ paymentMethod, browserInfo?, origin?, billingAddress?, riskData? }`, the
 * bare card `paymentMethod` earlier client adapters send, and
 * `{ details, paymentData? }` from a finished action. Only those keys are
 * read, so nothing the browser sends reaches the amount, currency, reference,
 * merchant account or capture method.
 *
 * The card must be the blob Adyen's hosted fields encrypt: a `paymentMethod`
 * that is not "scheme", or that carries unencrypted card fields, is refused,
 * and the adapter forwards only the card fields Adyen Web's Card produces.
 * The browser data is authentication and risk data, not part of the payment,
 * so a field that fails its check is dropped rather than failing the payment.
 * No error repeats the token, which can carry card data.
 */
function parseClientToken(clientToken: string): AdyenSubmission {
  if (!clientToken) {
    throw PayFanoutError.invalidRequest("completePayment requires the clientToken produced by confirm()", {
      reason: "missing clientToken",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(clientToken);
  } catch {
    // JSON.parse quotes the input in its message, so its error stays out of this one.
    throw PayFanoutError.invalidRequest(
      "Adyen clientTokens are the JSON payloads confirm() and handleAction() produce",
      { reason: "clientToken is not JSON" },
    );
  }
  if (!isJsonObject(parsed)) {
    throw PayFanoutError.invalidRequest("Adyen clientToken payload is not a JSON object", {
      reason: "clientToken is not a JSON object",
    });
  }
  if (parsed["details"] !== undefined) {
    const details = parsed["details"];
    if (!isJsonObject(details) || parsed["paymentMethod"] !== undefined) {
      throw PayFanoutError.invalidRequest(
        "An Adyen clientToken carries either a paymentMethod or the `details` object of an action",
        { reason: "malformed details" },
      );
    }
    const paymentData = parsed["paymentData"];
    return { kind: "details", details, ...(typeof paymentData === "string" ? { paymentData } : {}) };
  }
  if (parsed["paymentMethod"] === undefined) {
    // The bare paymentMethod earlier client adapters send.
    if (typeof parsed["type"] === "string") return { kind: "card", paymentMethod: assertCardPaymentMethod(parsed) };
    throw PayFanoutError.invalidRequest(
      `Adyen clientTokens carry a paymentMethod (cards are "${CARD_PAYMENT_METHOD_TYPE}") or the details of an action`,
      { reason: "no paymentMethod or details" },
    );
  }
  const paymentMethod = assertCardPaymentMethod(parsed["paymentMethod"]);
  const browserInfo = sanitizeBrowserInfo(parsed["browserInfo"]);
  const origin = sanitizeOrigin(parsed["origin"]);
  const billingAddress = sanitizeBillingAddress(parsed["billingAddress"]);
  const riskData = sanitizeRiskData(parsed["riskData"]);
  return {
    kind: "card",
    paymentMethod,
    ...(browserInfo ? { browserInfo } : {}),
    ...(origin ? { origin } : {}),
    ...(billingAddress ? { billingAddress } : {}),
    ...(riskData ? { riskData } : {}),
  };
}

/** Rebuilt from CARD_PAYMENT_METHOD_FIELDS; a listed field that is not a string is left out. */
function assertCardPaymentMethod(value: unknown): Record<string, string> {
  if (!isJsonObject(value) || value["type"] !== CARD_PAYMENT_METHOD_TYPE) {
    throw PayFanoutError.invalidRequest(
      `The Adyen adapter completes card payments, whose paymentMethod type is "${CARD_PAYMENT_METHOD_TYPE}"`,
      { reason: "paymentMethod is not a card" },
    );
  }
  // Cards are captured in Adyen's hosted fields only, which never hand out raw
  // card data: a token carrying it was not built by them.
  const unencrypted = UNENCRYPTED_CARD_FIELDS.filter((field) => Object.hasOwn(value, field));
  if (unencrypted.length > 0) {
    throw PayFanoutError.invalidRequest(
      "Adyen card data must arrive encrypted by Adyen's hosted fields, never as raw card fields",
      { reason: "unencrypted card fields", fields: unencrypted },
    );
  }
  const card: Record<string, string> = {};
  for (const field of CARD_PAYMENT_METHOD_FIELDS) {
    const entry = value[field];
    if (typeof entry === "string") card[field] = entry;
  }
  return card;
}

/** Rebuilt from the documented fields; one missing or of the wrong type drops the object, as the web needs all of them. */
function sanitizeBrowserInfo(value: unknown): AdyenBrowserInfo | undefined {
  if (!isJsonObject(value)) return undefined;
  const { acceptHeader, colorDepth, javaEnabled, javaScriptEnabled, language, screenHeight, screenWidth } = value;
  const { timeZoneOffset, userAgent } = value;
  if (
    !isNonEmptyString(acceptHeader) ||
    !isNonEmptyString(language) ||
    !isNonEmptyString(userAgent) ||
    !isInteger(colorDepth) ||
    !isInteger(screenHeight) ||
    !isInteger(screenWidth) ||
    !isInteger(timeZoneOffset) ||
    typeof javaEnabled !== "boolean"
  ) {
    return undefined;
  }
  return {
    acceptHeader,
    colorDepth,
    javaEnabled,
    ...(typeof javaScriptEnabled === "boolean" ? { javaScriptEnabled } : {}),
    language,
    screenHeight,
    screenWidth,
    timeZoneOffset,
    userAgent,
  };
}

/**
 * The page's bare origin — scheme, host, optional port; no path, no trailing
 * slash — at most 80 characters. Anything else is dropped rather than failing
 * the payment, and with it `channel` and the request for native 3-D Secure:
 * Adyen documents that a missing or wrong origin keeps the 3-D Secure 2 action
 * from being handled. That the payment then takes Adyen's redirect flow is an
 * unverified inference — Adyen's redirect guide lists `channel` and `origin`
 * as required too. The value only tells Adyen where the shopper's own page
 * is; no money fact depends on it.
 */
function sanitizeOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > ORIGIN_MAX_LENGTH || !/^https?:\/\/[^/?#\s]+$/i.test(value)) {
    return undefined;
  }
  try {
    // A value URL rewrites (upper case, a default port, credentials) is not
    // the origin a browser reports.
    return new URL(value).origin === value ? value : undefined;
  } catch {
    // Not parseable as a URL, so not an origin.
    return undefined;
  }
}

/**
 * Forwarded only when complete and within Adyen's limits: the five required
 * fields, `stateOrProvince` when present and always for the US and Canada
 * (Adyen: "Required for the US and Canada"), each within its maximum length, an
 * ISO 3166-1 alpha-2 country, and at most five digits for a US postal code.
 * Anything else drops the whole address rather than failing the payment. Adyen
 * Web fills the fields a country does not use with "N/A"; its partial address
 * mode can still produce an address this drops.
 */
function sanitizeBillingAddress(value: unknown): Record<string, string> | undefined {
  if (!isJsonObject(value)) return undefined;
  const address: Record<string, string> = {};
  for (const field of BILLING_ADDRESS_REQUIRED_FIELDS) {
    const entry = value[field];
    if (!isNonEmptyString(entry)) return undefined;
    address[field] = entry;
  }
  const stateOrProvince = value["stateOrProvince"];
  if (stateOrProvince !== undefined) {
    if (!isNonEmptyString(stateOrProvince)) return undefined;
    address["stateOrProvince"] = stateOrProvince;
  }
  const withinLimits = Object.entries(address).every(
    ([field, entry]) => entry.length <= (BILLING_ADDRESS_MAX_LENGTHS[field] ?? Number.POSITIVE_INFINITY),
  );
  if (!withinLimits || !/^[A-Z]{2}$/.test(address["country"]!)) return undefined;
  if ((address["country"] === "US" || address["country"] === "CA") && address["stateOrProvince"] === undefined) {
    return undefined;
  }
  if (address["country"] === "US" && !/^\d{1,5}$/.test(address["postalCode"]!)) return undefined;
  return address;
}

/**
 * `clientData` only — the device fingerprint Adyen Web collects, and the one
 * riskData field in its state. riskData's other fields are merchant risk
 * settings, not browser data.
 */
function sanitizeRiskData(value: unknown): { clientData: string } | undefined {
  if (!isJsonObject(value)) return undefined;
  const clientData = value["clientData"];
  return isNonEmptyString(clientData) && clientData.length <= RISK_CLIENT_DATA_MAX_LENGTH ? { clientData } : undefined;
}

/**
 * Adyen's returnUrl rules: absolute with a scheme, at most 1024 characters,
 * and no "//" after the domain of a web URL; whitespace is refused. Checked
 * where the value enters — session creation, adapter construction — so a
 * malformed one is refused before the shopper enters a card rather than by
 * Adyen afterwards. Returns the WHATWG serialization, the value that is sent:
 * Adyen asks for non-ASCII characters to be URL-encoded, and the length limit
 * applies to the encoded form.
 */
function assertReturnUrl(returnUrl: string, field: "returnUrl" | "defaultReturnUrl"): string {
  if (returnUrl.length > RETURN_URL_MAX_LENGTH) {
    throw PayFanoutError.invalidRequest(
      `Adyen accepts a ${field} of at most ${RETURN_URL_MAX_LENGTH} characters, got ${returnUrl.length}`,
      { field },
    );
  }
  const url = RETURN_URL_PATTERN.test(returnUrl) ? parseUrl(returnUrl) : undefined;
  if (!url) {
    throw PayFanoutError.invalidRequest(
      `The ${field} must be absolute, with a scheme: https:// on the web, or an app scheme such as my-app://`,
      { field },
    );
  }
  if ((url.protocol === "https:" || url.protocol === "http:") && `${url.pathname}${url.search}${url.hash}`.includes("//")) {
    throw PayFanoutError.invalidRequest(`Adyen refuses a ${field} with "//" after the domain`, { field });
  }
  if (url.href.length > RETURN_URL_MAX_LENGTH) {
    throw PayFanoutError.invalidRequest(
      `Adyen accepts a ${field} of at most ${RETURN_URL_MAX_LENGTH} characters once URL-encoded, got ${url.href.length}`,
      { field },
    );
  }
  return url.href;
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    // Unparseable, so not an absolute URL.
    return undefined;
  }
}

/**
 * For `receiptEmail`, which the host sets for this purpose; the optional
 * `billingDetails.email` is left out instead when isShopperEmail rejects it.
 */
function assertShopperEmail(email: string, field: "receiptEmail"): string {
  if (!isShopperEmail(email)) {
    throw PayFanoutError.invalidRequest(
      `Adyen sends ${field} as shopperEmail, which takes an email address of at most ${SHOPPER_EMAIL_MAX_LENGTH} characters`,
      { field },
    );
  }
  return email;
}

function isShopperEmail(email: string): boolean {
  return email.length <= SHOPPER_EMAIL_MAX_LENGTH && SHOPPER_EMAIL_PATTERN.test(email);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
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
