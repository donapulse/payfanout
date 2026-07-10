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
  utf8ToBase64,
  withTransportRetries,
  type AdapterCapabilities,
  type CreatePaymentSessionInput,
  type MinorUnitAmount,
  type PaymentInfo,
  type PaymentMethodCapability,
  type PaymentMethodDetails,
  type PaymentSession,
  type RefundInfo,
  type RefundRequest,
  type RefundResult,
  type ServerPaymentAdapter,
  type UnifiedErrorCode,
  type UnifiedPaymentStatus,
  type UnifiedWebhookEvent,
  type VerifyCredentialsResult,
} from "@payfanout/core";
import { parsePayZenWebhookEvent, verifyPayZenWebhookSignature } from "./webhook.js";

export const PAYZEN_PSP_NAME = "payzen";

export interface PayZenServerAdapterConfig {
  /** Back Office "User" — the numeric shop id, Basic-auth username. */
  shopId: string;
  /**
   * REST API password for the SELECTED environment (testpassword_… /
   * prodpassword_…). Also the HMAC key that signs IPN kr-answers
   * (`kr-hash-key: "password"`). An array keeps old + new valid while the
   * Back Office key is being regenerated (any entry verifies IPNs); the FIRST
   * entry authenticates REST calls.
   */
  password: string | string[];
  /**
   * Explicit, never inferred. PayZen selects TEST vs LIVE by the KEY SET, not
   * the endpoint — the adapter validates that the password family matches
   * this declaration and refuses mismatches.
   */
  environment: "sandbox" | "live";
  /**
   * Back Office "HMAC-SHA-256 key" — signs BROWSER-return kr-answers
   * (`kr-hash-key: "sha256_hmac"`). Optional because IPN-only integrations
   * never see that path. Accepts an array for rotation.
   */
  hmacKey?: string | string[];
  /**
   * REST API base up to (excluding) /V4 — the Back Office "Server name" plus
   * "/api-payment". Sister Lyra platforms use different hosts, so this is
   * config, not a constant. Default: https://api.payzen.eu/api-payment
   */
  apiBaseUrl?: string;
  /**
   * Abort a hung PayZen connection after this many milliseconds (default
   * 30000). The timer covers the whole exchange including the response body
   * read. Timeouts surface as psp_unavailable — retryable except on
   * refund/cancel/validate, whose outcome is unknown.
   */
  requestTimeoutMs?: number;
  /**
   * Automatic retries for transport-level trouble only (network failure,
   * timeout, HTTP 5xx, 429) with exponential backoff. Default 2. PayZen
   * answers HTTP 200 even for errors, so business errors NEVER retry here —
   * and because PayZen has no idempotency mechanism at all, refunds and
   * state-transition calls are never auto-retried either (a lost response
   * may mean the operation was applied); their transport failures surface
   * retryable: false so callers cannot replay them blindly.
   */
  maxNetworkRetries?: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Injected backoff sleep for retry tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** PayZen response envelope — the outcome lives HERE, the HTTP status is always 200. */
export interface PayZenEnvelopeLike {
  webService?: string;
  status?: string;
  answer?: unknown;
  serverDate?: string;
  mode?: string;
}

export interface PayZenErrorAnswerLike {
  errorCode?: string | null;
  errorMessage?: string | null;
  detailedErrorCode?: string | null;
  detailedErrorMessage?: string | null;
}

/** Structural subset of the V4/Transaction object. */
export interface PayZenTransactionLike {
  uuid?: string;
  amount?: number;
  currency?: string;
  paymentMethodType?: string;
  status?: string;
  detailedStatus?: string;
  operationType?: string;
  creationDate?: string;
  errorCode?: string | null;
  detailedErrorCode?: string | null;
  metadata?: Record<string, string> | null;
  orderDetails?: { orderId?: string | null; metadata?: Record<string, string> | null };
  transactionDetails?: {
    parentTransactionUuid?: string | null;
    creationContext?: string;
    cardDetails?: {
      effectiveBrand?: string;
      pan?: string;
      expiryMonth?: number | null;
      expiryYear?: number | null;
      manualValidation?: string;
      expectedCaptureDate?: string;
      captureResponse?: { captureDate?: string | null; refundAmount?: number | null };
    };
  };
}

/** Structural subset of the Order/Get answer (V4/OrderTransactions). */
export interface PayZenOrderLike {
  orderStatus?: string;
  orderDetails?: { orderId?: string | null };
  transactions?: PayZenTransactionLike[];
}

/**
 * PayZen's official currency table, minus three deliberate gaps:
 *   - BHD is NOT supported by the platform (absent from the table) — rejected
 *     locally so callers get invalid_request instead of a PSP_610 surprise.
 *   - CNY and KHR are excluded because PayZen prices them with one and zero
 *     fractional digits while ISO 4217 minor units (core's contract) use two —
 *     passing core minor units through would silently shift the decimal point
 *     (4,000,000 core minor units = 40,000.00 KHR, but PayZen would read
 *     4,000,000 riel).
 */
const PAYZEN_CURRENCIES = new Set([
  "ARS", "AUD", "BRL", "CAD", "CHF", "COP", "CZK", "DKK", "EUR", "GBP",
  "HKD", "HUF", "IDR", "INR", "JPY", "KRW", "KWD", "MAD", "MXN",
  "MYR", "NOK", "NZD", "PEN", "PHP", "PLN", "RUB", "SEK", "SGD", "THB",
  "TND", "TRY", "TWD", "USD", "XOF", "XPF", "ZAR",
]);

/** PayZen-supported currencies the ADAPTER excludes: PayZen fractional digits vs ISO 4217's. */
const MISMATCHED_EXPONENT_CURRENCIES = new Map([
  ["CNY", 1],
  ["KHR", 0],
]);

const UUID_RE = /^[0-9a-f]{32}$/i;

const PAYMENT_METHODS: PaymentMethodCapability[] = [
  // SmartForm wallets/APMs exist on the platform but are per-contract and use
  // a different form mode — card via the embedded krypton form is v1.
  { type: "card", flow: "embedded", supported: true },
];

export class PayZenServerAdapter implements ServerPaymentAdapter {
  readonly pspName = PAYZEN_PSP_NAME;
  private readonly config: PayZenServerAdapterConfig;
  private readonly baseUrl: string;

  constructor(config: PayZenServerAdapterConfig) {
    if (!config.shopId) throw PayFanoutError.invalidRequest("PayZenServerAdapter config.shopId is required");
    const passwords = normalizeSecrets(config.password);
    if (passwords.length === 0) {
      throw PayFanoutError.invalidRequest(
        "PayZenServerAdapter config.password is required (one key, or several during rotation)",
      );
    }
    if (config.environment !== "sandbox" && config.environment !== "live") {
      throw PayFanoutError.invalidRequest('PayZenServerAdapter config.environment must be "sandbox" or "live"');
    }
    // PayZen selects TEST vs LIVE by the key, not the URL — a mismatched
    // password would silently run in the wrong mode. Validation, not inference.
    for (const password of passwords) {
      if (config.environment === "sandbox" && password.startsWith("prodpassword_")) {
        throw PayFanoutError.invalidRequest(
          'PayZenServerAdapter: environment is "sandbox" but config.password is a production key',
        );
      }
      if (config.environment === "live" && password.startsWith("testpassword_")) {
        throw PayFanoutError.invalidRequest(
          'PayZenServerAdapter: environment is "live" but config.password is a test key',
        );
      }
    }
    if (config.requestTimeoutMs !== undefined && !(config.requestTimeoutMs > 0)) {
      throw PayFanoutError.invalidRequest("PayZenServerAdapter config.requestTimeoutMs must be > 0");
    }
    if (
      config.maxNetworkRetries !== undefined &&
      (!Number.isInteger(config.maxNetworkRetries) || config.maxNetworkRetries < 0)
    ) {
      throw PayFanoutError.invalidRequest("PayZenServerAdapter config.maxNetworkRetries must be an integer >= 0");
    }
    this.config = config;
    this.baseUrl = (config.apiBaseUrl ?? "https://api.payzen.eu/api-payment").replace(/\/$/, "");
  }

  getCapabilities(): AdapterCapabilities {
    return {
      pspName: this.pspName,
      // Router pre-screen input: the platform currency table minus the
      // adapter's CNY/KHR exclusions — exactly what createPaymentSession
      // enforces locally.
      supportedCurrencies: [...PAYZEN_CURRENCIES],
      supportsRefunds: true,
      supportsPartialRefunds: true,
      supportsManualCapture: true, // manualValidation:"YES" + Transaction/Validate
      supportsMultiCapture: false, // Validate releases the whole authorization once
      supportsPaymentMethodVerification: false, // Charge/CreateToken creates a stored token — not verification-only
      supportsSavedPaymentMethods: false, // REGISTER_PAY / paymentMethodToken path is documented future work
      // formTokens are immutable and their inputs are not statelessly
      // recoverable — hosts create a fresh (cheap, 15-min) session instead.
      supportsSessionUpdate: false,
      supportsEventPolling: false, // IPN only — no events API exists
      supportsListing: false, // Order/Get is per-order; no cross-order query exists
      requiresServerCompletion: false, // confirm-on-client: the krypton form creates the transaction
      paymentMethods: PAYMENT_METHODS,
    };
  }

  /**
   * Charge/CreatePayment → formToken (the client secret the krypton form
   * mounts with). No transaction exists until the shopper pays, and the
   * formToken expires after ~15 minutes — sessions are cheap to re-create.
   *
   * PayZen has no idempotency mechanism, so the adapter synthesizes traceable
   * replays: orderId derives deterministically from the idempotencyKey and the
   * key is stamped into metadata. A replayed call mints another formToken for
   * the SAME orderId — harmless (no money moves until the shopper completes
   * the form) and reconcilable via Order/Get.
   */
  async createPaymentSession(input: CreatePaymentSessionInput): Promise<PaymentSession> {
    assertMinorUnitAmount(input.amount, "amount");
    const currency = this.assertSupportedCurrency(input.currency);
    if (input.paymentMethodTypes?.some((t) => t !== "card")) {
      throw PayFanoutError.invalidRequest(
        `PayZen adapter supports card only; requested: ${input.paymentMethodTypes.join(", ")}`,
      );
    }
    const orderId = await derivePayZenOrderId(input.idempotencyKey);
    const customer = toPayZenCustomer(input);
    const cardOptions = {
      ...(input.captureMethod === "manual" ? { manualValidation: "YES" } : {}),
      // MOTO is an SCA-exemption request, never a guarantee.
      ...(input.sca?.exemption === "moto" ? { paymentSource: "MOTO" } : {}),
    };
    const answer = await this.call<{ formToken?: string }>("Charge/CreatePayment", {
      amount: input.amount,
      currency,
      orderId,
      contrib: "payfanout",
      ...(customer ? { customer } : {}),
      ...(input.sca?.challenge === "force" ? { strongAuthentication: "CHALLENGE_REQUESTED" } : {}),
      ...(Object.keys(cardOptions).length > 0 ? { transactionOptions: { cardOptions } } : {}),
      // Per-session IPN override; the Back Office rule stays the fallback.
      ...(input.webhookUrl ? { ipnTargetUrl: input.webhookUrl } : {}),
      metadata: {
        ...input.metadata,
        payfanout_key: input.idempotencyKey,
        ...(input.id ? { payfanout_id: input.id } : {}),
      },
      // statementDescriptor is withheld: V4 has no per-transaction descriptor
      // field (descriptors are an acquirer-contract matter on this platform).
    });
    if (typeof answer?.formToken !== "string" || answer.formToken.length === 0) {
      throw new PayFanoutError({
        code: "processing_error",
        message: "PayZen did not return a formToken.",
        retryable: false,
        raw: answer,
        pspName: this.pspName,
      });
    }
    return {
      id: input.id ?? orderId,
      pspName: this.pspName,
      pspSessionId: orderId,
      clientSecret: answer.formToken,
      amount: input.amount,
      currency,
      status: "requires_payment_method",
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
  }

  /**
   * Accepts either a transaction uuid (32-hex, from webhooks/refunds) or a
   * PayFanout pspSessionId (= the derived orderId): the krypton form creates
   * the transaction in-browser, so right after checkout the host may only
   * hold the orderId. The orderId path reads the order and reports its most
   * recent payment (DEBIT) attempt.
   */
  async retrievePayment(pspPaymentId: string): Promise<PaymentInfo> {
    if (UUID_RE.test(pspPaymentId)) {
      const tx = await this.call<PayZenTransactionLike>("Transaction/Get", { uuid: pspPaymentId });
      return this.toPaymentInfo(tx, refundedFromCaptureResponse(tx), tx);
    }
    const order = await this.call<PayZenOrderLike>("Order/Get", { orderId: pspPaymentId });
    const tx = latestDebit(order);
    if (!tx) {
      throw PayFanoutError.invalidRequest(`Order "${pspPaymentId}" has no payment transaction`, order);
    }
    return this.toPaymentInfo(tx, sumSuccessfulCredits(order), order);
  }

  /**
   * Manual capture = Transaction/Validate: it confirms an
   * AUTHORISED_TO_VALIDATE transaction for capture on its expected date.
   * Transaction/Capture is NOT this operation — it is a Brazil-specific batch
   * WS and must never be used here. Validation releases the full authorized
   * amount; PayZen has no partial validate, so a differing `amount` is
   * rejected. The required `idempotencyKey` cannot be delegated — PayZen has
   * no idempotency channel — but replays are naturally safe: validating twice
   * yields a status error, never a duplicate capture.
   */
  async capturePayment(
    pspPaymentId: string,
    amount: MinorUnitAmount | undefined,
    _idempotencyKey: string,
  ): Promise<PaymentInfo> {
    if (amount !== undefined) assertMinorUnitAmount(amount, "capture amount");
    const { transaction } = await this.resolveTransaction(pspPaymentId);
    if (amount !== undefined && amount !== transaction.amount) {
      throw PayFanoutError.invalidRequest(
        `PayZen captures by validating the full authorized amount (${String(transaction.amount)}) — ` +
          "partial capture is not supported",
        transaction,
      );
    }
    const validated = await this.call<PayZenTransactionLike>(
      "Transaction/Validate",
      { uuid: transaction.uuid },
      { retryTransport: false },
    );
    return this.toPaymentInfo(validated, refundedFromCaptureResponse(validated), validated);
  }

  /**
   * Pre-capture void via Transaction/Cancel; captured transactions come back
   * PSP_075 → invalid_request. The required `idempotencyKey` has no PayZen
   * channel; a replayed cancel is a PSP_105 state error, never a second effect.
   */
  async cancelPayment(pspPaymentId: string, _idempotencyKey: string): Promise<PaymentInfo> {
    const { transaction } = await this.resolveTransaction(pspPaymentId);
    const canceled = await this.call<PayZenTransactionLike>(
      "Transaction/Cancel",
      { uuid: transaction.uuid },
      { retryTransport: false },
    );
    return this.toPaymentInfo(canceled, refundedFromCaptureResponse(canceled), canceled);
  }

  /**
   * PayZen has NO refund idempotency: a replayed Transaction/Refund creates a
   * SECOND credit while the total stays within the original, and the refund
   * request carries no metadata/reference field the adapter could pre-check
   * against (`idempotencyKey` cannot be delegated OR reliably synthesized).
   * Consequences, deliberately encoded here:
   *   - refund calls are never transport-retried, and their transport
   *     failures surface retryable: false (a lost response may mean the
   *     credit exists);
   *   - hosts must not blind-retry refunds — re-read the payment
   *     (amountRefunded) before trying again.
   *
   * Partial refunds go to Transaction/Refund (requires a captured source).
   * Full refunds go through Transaction/CancelOrRefund AUTO, which cancels
   * a not-yet-captured transaction instead — the result is mapped honestly
   * (a cancellation releases the authorization; the shopper was never
   * charged, so the refund "succeeded").
   */
  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    if (req.amount !== undefined) assertMinorUnitAmount(req.amount, "refund amount");
    const { transaction, order } = await this.resolveTransaction(req.pspPaymentId);
    const currency = (transaction.currency ?? "").toUpperCase();
    const comment = req.reason ? { comment: req.reason } : {};
    let answer: PayZenTransactionLike;
    if (req.amount !== undefined) {
      answer = await this.call<PayZenTransactionLike>(
        "Transaction/Refund",
        { uuid: transaction.uuid, amount: req.amount, currency, ...comment },
        { retryTransport: false },
      );
    } else {
      const alreadyRefunded = order ? sumSuccessfulCredits(order) : refundedFromCaptureResponse(transaction);
      const remaining = (transaction.amount ?? 0) - alreadyRefunded;
      if (remaining <= 0) {
        throw PayFanoutError.invalidRequest(
          `Payment ${transaction.uuid ?? req.pspPaymentId} is already fully refunded`,
          transaction,
        );
      }
      answer = await this.call<PayZenTransactionLike>(
        "Transaction/CancelOrRefund",
        { uuid: transaction.uuid, amount: remaining, currency, resolutionMode: "AUTO", ...comment },
        { retryTransport: false },
      );
    }
    return {
      refundId: answer.uuid ?? "",
      status: mapRefundTransactionStatus(answer),
      amount: answer.amount ?? req.amount ?? 0,
      raw: answer,
    };
  }

  /**
   * A PayZen refund IS a transaction (the CREDIT created by Transaction/
   * Refund) — polling it is Transaction/Get on the refund uuid. A
   * cancellation outcome (full refund of an uncaptured payment) polls the
   * original DEBIT, whose CANCELLED state still means "funds released".
   */
  async retrieveRefund(refundId: string): Promise<RefundInfo> {
    const tx = await this.call<PayZenTransactionLike>("Transaction/Get", { uuid: refundId });
    const parent = tx.transactionDetails?.parentTransactionUuid;
    return {
      refundId: tx.uuid ?? refundId,
      status: mapRefundTransactionStatus(tx),
      amount: tx.amount ?? 0,
      pspPaymentId: parent ?? tx.uuid ?? refundId,
      ...(tx.creationDate ? { createdAt: tx.creationDate } : {}),
      raw: tx,
    };
  }

  /**
   * "Test connection" probe: one side-effect-free Charge/SDKTest call — PayZen's
   * purpose-built connection test, which just echoes the submitted value back on
   * valid credentials. The outcome is classified so a host UI can tell a wrong
   * shopId/password (`auth`) from a transient outage (`network`); it resolves on
   * every path instead of throwing, and never surfaces the credential.
   */
  async verifyCredentials(): Promise<VerifyCredentialsResult> {
    try {
      await this.call<{ value?: string }>("Charge/SDKTest", {
        value: "connection-test",
        mode: this.config.environment === "live" ? "PRODUCTION" : "TEST",
      });
      return { ok: true };
    } catch (err) {
      const e = (err ?? {}) as { code?: string; retryable?: boolean; raw?: unknown };
      const envelopeCode = readEnvelopeErrorCode(e.raw);
      // INT_905 is PayZen's wrong shopId/password rejection (delivered inside an
      // HTTP 200 ERROR envelope); an auth proxy in front of the gateway would
      // answer HTTP 401/403, which classifyHttpFallback collapses to a bare,
      // non-retryable invalid_request with no PayZen envelope. Both are auth.
      if (envelopeCode === "INT_905" || (envelopeCode === undefined && e.code === "invalid_request")) {
        return { ok: false, category: "auth", message: "Authentication failed — check the PayZen shop id and password." };
      }
      // rate_limited / psp_unavailable — the only transient (retryable) failures.
      if (e.retryable === true) {
        return { ok: false, category: "network", message: "Could not reach PayZen — try again." };
      }
      return { ok: false, category: "internal", message: "Could not verify PayZen credentials." };
    }
  }

  async verifyWebhookSignature(rawBody: string, headers: Record<string, string>): Promise<boolean> {
    return verifyPayZenWebhookSignature(rawBody, headers, {
      passwords: normalizeSecrets(this.config.password),
      hmacKeys: normalizeSecrets(this.config.hmacKey),
    });
  }

  async parseWebhookEvent(rawBody: string, headers: Record<string, string>): Promise<UnifiedWebhookEvent> {
    return parsePayZenWebhookEvent(rawBody, headers);
  }

  private async resolveTransaction(
    pspPaymentId: string,
  ): Promise<{ transaction: PayZenTransactionLike; order?: PayZenOrderLike }> {
    if (UUID_RE.test(pspPaymentId)) {
      return { transaction: await this.call<PayZenTransactionLike>("Transaction/Get", { uuid: pspPaymentId }) };
    }
    const order = await this.call<PayZenOrderLike>("Order/Get", { orderId: pspPaymentId });
    const transaction = latestDebit(order);
    if (!transaction) {
      throw PayFanoutError.invalidRequest(`Order "${pspPaymentId}" has no payment transaction`, order);
    }
    return { transaction, order };
  }

  private assertSupportedCurrency(currency: string): string {
    const code = normalizeCurrency(currency);
    const payzenDigits = MISMATCHED_EXPONENT_CURRENCIES.get(code);
    if (payzenDigits !== undefined) {
      // PayZen supports these — the claim would be false. The exclusion is ours.
      throw PayFanoutError.invalidRequest(
        `The PayZen adapter excludes ${code}: PayZen prices it with ${String(payzenDigits)} fractional ` +
          "digit(s) while ISO 4217 minor units use 2, so amounts passed through would shift the decimal point",
        { currency: code, payzenFractionalDigits: payzenDigits },
      );
    }
    if (!PAYZEN_CURRENCIES.has(code)) {
      throw PayFanoutError.invalidRequest(`PayZen does not support the currency ${code}`, {
        currency: code,
        supported: [...PAYZEN_CURRENCIES],
      });
    }
    return code;
  }

  private toPaymentInfo(tx: PayZenTransactionLike, amountRefunded: number, raw: unknown): PaymentInfo {
    const methodDetails = toPaymentMethodDetails(tx.transactionDetails?.cardDetails);
    const capturedAt = tx.transactionDetails?.cardDetails?.captureResponse?.captureDate;
    const detailedStatus = (tx.detailedStatus ?? "").toUpperCase();
    // Validation commits the FULL authorized amount to the capture batch, so
    // AUTHORISED already reports as captured (the merchant has nothing left to
    // do); AUTHORISED_TO_VALIDATE is the remainder Transaction/Validate can
    // still release.
    const captured = detailedStatus === "CAPTURED" || detailedStatus === "AUTHORISED";
    return {
      id: tx.metadata?.["payfanout_id"] ?? tx.orderDetails?.orderId ?? tx.uuid ?? "",
      pspName: this.pspName,
      pspPaymentId: tx.uuid ?? "",
      status: mapPayZenDetailedStatus(tx.detailedStatus),
      amount: tx.amount ?? 0,
      amountRefunded,
      ...(captured ? { amountCaptured: tx.amount ?? 0 } : {}),
      ...(detailedStatus === "AUTHORISED_TO_VALIDATE" ? { amountCapturable: tx.amount ?? 0 } : {}),
      // Never fabricate a currency: empty is more honest when PayZen omits it.
      currency: (tx.currency ?? "").toUpperCase(),
      paymentMethodType: tx.paymentMethodType === "CARD" || !tx.paymentMethodType ? "card" : "other",
      // Echoed verbatim as stored at the PSP — the payfanout_* stamps included
      // (they are genuinely on the transaction and visible in the Back Office).
      ...(tx.metadata && Object.keys(tx.metadata).length > 0 ? { metadata: tx.metadata } : {}),
      ...(methodDetails ? { paymentMethodDetails: methodDetails } : {}),
      createdAt: tx.creationDate ?? "1970-01-01T00:00:00.000Z",
      ...(capturedAt ? { capturedAt } : {}),
      raw,
    };
  }

  /**
   * Transport with timeout + transient-only retries. `retryTransport: false`
   * covers the mutating operations PayZen gives no idempotency for
   * (refund/cancel/validate): a timed-out request may have been applied, so
   * an automatic replay could stack a second refund or surface a false
   * "wrong status" failure. Their transport failures are stripped of the
   * retryable flag too — core's withRetry replays purely on that flag, and a
   * host wrapping refundPayment in it must not double-refund after a timeout
   * PayZen actually applied. An ERROR envelope keeps its mapped flags: it
   * proves the gateway rejected the call, so nothing was applied. Reads and
   * CreatePayment (an extra formToken is inert) retry freely.
   */
  private async call<T>(
    operation: string,
    body: Record<string, unknown>,
    opts: { retryTransport?: boolean } = {},
  ): Promise<T> {
    const retryTransport = opts.retryTransport ?? true;
    let envelope: PayZenEnvelopeLike;
    try {
      envelope = await withTransportRetries(() => this.requestOnce(operation, body), {
        attempts: retryTransport ? 1 + (this.config.maxNetworkRetries ?? 2) : 1,
        sleep: this.config.sleep,
      });
    } catch (err) {
      // Only requestOnce's transport-level failures carry retryable: true.
      if (retryTransport || !(err instanceof PayFanoutError) || !err.retryable) throw err;
      throw new PayFanoutError({
        code: err.code,
        message:
          `${err.message} The outcome of ${operation} is unknown — it may have been applied. ` +
          "Do not retry blindly: re-read the payment (amountRefunded) first.",
        retryable: false,
        raw: err.raw,
        pspName: this.pspName,
      });
    }
    if (envelope.status !== "SUCCESS") {
      throw mapPayZenError(envelope.answer as PayZenErrorAnswerLike | undefined, envelope);
    }
    return envelope.answer as T;
  }

  private async requestOnce(operation: string, body: Record<string, unknown>): Promise<PayZenEnvelopeLike> {
    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    const { response, text } = await requestWithTimeout(
      {
        fetch: this.config.fetch ?? fetch,
        timeoutMs,
        onFailure: (timedOut, cause) =>
          new PayFanoutError({
            code: "psp_unavailable",
            message: timedOut ? `PayZen did not respond within ${timeoutMs}ms.` : "Could not reach PayZen.",
            retryable: true,
            raw: cause,
            pspName: this.pspName,
          }),
      },
      `${this.baseUrl}/V4/${operation}`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${utf8ToBase64(`${this.config.shopId}:${normalizeSecrets(this.config.password)[0]}`)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    // Non-200s only ever come from infrastructure in front of the gateway
    // (the API itself answers 200 + an ERROR envelope) — map by HTTP status.
    if (!response.ok) {
      const { code, retryable } = classifyHttpFallback(response.status);
      throw new PayFanoutError({
        code,
        message: getUserMessage(code),
        retryable,
        raw: safeJson(text) ?? text,
        pspName: this.pspName,
      });
    }
    const envelope = safeJson(text) as PayZenEnvelopeLike | undefined;
    if (!envelope || typeof envelope !== "object") {
      throw new PayFanoutError({
        code: "psp_unavailable",
        message: "PayZen returned an unreadable response.",
        retryable: true,
        raw: text,
        pspName: this.pspName,
      });
    }
    return envelope;
  }
}

/**
 * Deterministic orderId from the caller's idempotencyKey — PayZen has no
 * idempotency mechanism, so replays at least converge on the same order and
 * stay reconcilable via Order/Get. Keys already inside PayZen's charset
 * (ASCII, ≤64 chars with the pf- prefix) map 1:1; anything else keeps a
 * readable prefix plus a SHA-256 fragment so distinct keys can never collide
 * after sanitization.
 */
export async function derivePayZenOrderId(idempotencyKey: string): Promise<string> {
  const sanitized = idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "-");
  const direct = `pf-${sanitized}`;
  if (sanitized === idempotencyKey && direct.length <= 64) return direct;
  return `pf-${sanitized.slice(0, 52)}-${(await sha256Hex(idempotencyKey)).slice(0, 8)}`;
}

const SUCCEEDED_STATUSES = new Set(["AUTHORISED", "CAPTURED", "ACCEPTED", "PRE_AUTHORISED"]);

export function mapPayZenDetailedStatus(detailedStatus: string | undefined): UnifiedPaymentStatus {
  switch ((detailedStatus ?? "").toUpperCase()) {
    case "AUTHORISED": // auto-capture is scheduled — nothing is pending for anyone
    case "CAPTURED":
    case "ACCEPTED":
    case "PRE_AUTHORISED":
      return "succeeded";
    case "AUTHORISED_TO_VALIDATE":
    case "WAITING_AUTHORISATION_TO_VALIDATE":
      return "requires_capture";
    case "WAITING_AUTHORISATION":
    case "WAITING_FOR_PAYMENT":
    case "UNDER_VERIFICATION":
    case "REFUND_TO_RETRY":
      return "processing";
    case "REFUSED":
    case "ERROR":
    case "CAPTURE_FAILED":
      return "failed";
    case "CANCELLED":
    case "EXPIRED":
      return "canceled";
    default:
      // The platform adds statuses over time; a payment that exists but is
      // not terminal is safest reported as in-flight.
      return "processing";
  }
}

/** Refund state of a CREDIT transaction — or of a DEBIT whose full refund resolved as a cancellation. */
function mapRefundTransactionStatus(tx: PayZenTransactionLike): RefundResult["status"] {
  const status = (tx.detailedStatus ?? "").toUpperCase();
  if (tx.operationType !== "CREDIT" && status === "CANCELLED") {
    // CancelOrRefund resolved as a cancellation: the authorization was
    // released and the shopper was never charged — the refund succeeded.
    return "succeeded";
  }
  if (SUCCEEDED_STATUSES.has(status)) return "succeeded";
  if (["REFUSED", "ERROR", "CAPTURE_FAILED", "CANCELLED", "EXPIRED"].includes(status)) return "failed";
  return "pending"; // REFUND_TO_RETRY / WAITING_* / UNDER_VERIFICATION
}

/** Newest DEBIT in the order snapshot = the payment attempt the order is about. */
function latestDebit(order: PayZenOrderLike): PayZenTransactionLike | undefined {
  const debits = (order.transactions ?? []).filter((t) => (t.operationType ?? "DEBIT") === "DEBIT");
  return debits.sort(
    (a, b) => (Date.parse(a.creationDate ?? "") || 0) - (Date.parse(b.creationDate ?? "") || 0),
  )[debits.length - 1];
}

/** amountRefunded from an order snapshot: only credits that actually moved (or will move) funds count. */
function sumSuccessfulCredits(order: PayZenOrderLike): number {
  return (order.transactions ?? [])
    .filter((t) => t.operationType === "CREDIT" && SUCCEEDED_STATUSES.has((t.detailedStatus ?? "").toUpperCase()))
    .reduce((sum, t) => sum + (t.amount ?? 0), 0);
}

/** Single-transaction reads carry the running total on captureResponse.refundAmount. */
function refundedFromCaptureResponse(tx: PayZenTransactionLike): number {
  return tx.transactionDetails?.cardDetails?.captureResponse?.refundAmount ?? 0;
}

function toPaymentMethodDetails(
  card: NonNullable<PayZenTransactionLike["transactionDetails"]>["cardDetails"],
): PaymentMethodDetails | undefined {
  if (!card) return undefined;
  const last4 = /(\d{4})$/.exec(card.pan ?? "")?.[1];
  const details: PaymentMethodDetails = {
    ...(card.effectiveBrand ? { brand: card.effectiveBrand.toLowerCase() } : {}),
    ...(last4 ? { last4 } : {}),
    ...(typeof card.expiryMonth === "number" ? { expMonth: card.expiryMonth } : {}),
    ...(typeof card.expiryYear === "number" ? { expYear: card.expiryYear } : {}),
  };
  return Object.keys(details).length > 0 ? details : undefined;
}

/** Acquirer refusal codes (ACQ_001 / PSP_101 detailedErrorCode) → decline refinement. */
const ACQUIRER_DECLINE_MAP: Record<string, UnifiedErrorCode> = {
  "51": "insufficient_funds",
  "33": "expired_card",
  "54": "expired_card",
  "14": "invalid_card_data",
  "43": "fraud_suspected", // stolen card
  "59": "fraud_suspected", // suspected fraud
  "1A": "authentication_required", // SCA soft decline
};

const PAYZEN_PSP_CODE_MAP: Record<string, UnifiedErrorCode> = {
  PSP_042: "insufficient_funds",
  PSP_202: "expired_card",
  PSP_508: "expired_card",
  PSP_112: "expired_card",
  PSP_023: "invalid_card_data",
  PSP_024: "invalid_card_data",
  PSP_026: "invalid_card_data",
  PSP_509: "invalid_card_data",
  PSP_526: "invalid_card_data",
  PSP_527: "invalid_card_data",
  PSP_528: "invalid_card_data",
  PSP_529: "invalid_card_data",
  PSP_530: "invalid_card_data",
  PSP_531: "invalid_card_data",
  PSP_532: "invalid_card_data",
  PSP_533: "invalid_card_data",
  PSP_136: "authentication_required",
  PSP_539: "authentication_required",
  PSP_203: "fraud_suspected",
  PSP_204: "fraud_suspected",
  PSP_205: "fraud_suspected",
  PSP_536: "fraud_suspected",
  // HTTP-200 rate limiting — the envelope is the only signal.
  PSP_099: "rate_limited",
  PSP_106: "rate_limited",
  PSP_999: "psp_unavailable",
  PSP_513: "psp_unavailable",
  PSP_514: "psp_unavailable",
  PSP_515: "psp_unavailable",
  PSP_516: "psp_unavailable",
  PSP_525: "psp_unavailable",
  PSP_538: "psp_unavailable",
  PSP_540: "psp_unavailable",
  PSP_541: "psp_unavailable",
  PSP_010: "invalid_request", // transaction not found
  PSP_015: "invalid_request", // too many results (Order/Get > 30 transactions)
  PSP_100: "invalid_request", // REST API not enabled on the shop
  PSP_108: "session_expired", // formToken outlived its ~15 min — create a fresh session
  PSP_109: "invalid_request", // production mode not activated
  PSP_610: "invalid_request", // no acceptance agreement (currency/config)
  // State-machine rejections: retrying cannot succeed — never retryable.
  PSP_011: "invalid_request",
  PSP_503: "invalid_request",
  PSP_075: "invalid_request", // captured — cancel impossible, refund instead
  PSP_083: "invalid_request", // unpaid — nothing to refund
  PSP_104: "invalid_request", // already fully refunded
  PSP_105: "invalid_request", // already cancelled
  PSP_510: "invalid_request", // refund amount too high
  PSP_511: "invalid_request", // refund amount exceeds remainder
  // Capture pending — the refund becomes possible once capture lands.
  PSP_076: "processing_error",
};

/**
 * Envelope-level error → taxonomy. PayZen prefixes announce the origin:
 * INT_ (merchant integration), PSP_ (gateway), ACQ_ (acquirer decline),
 * AUTH_ (3DS), CLIENT_ (browser). New codes appear over time — unmapped
 * PSP-side codes degrade to a non-retryable processing_error.
 */
export function mapPayZenError(answer: PayZenErrorAnswerLike | undefined, raw: unknown): PayFanoutError {
  const errorCode = answer?.errorCode ?? "";
  let code: UnifiedErrorCode;
  if (errorCode === "ACQ_999" || errorCode === "AUTH_999") {
    code = "psp_unavailable";
  } else if (errorCode.startsWith("ACQ_")) {
    code = ACQUIRER_DECLINE_MAP[answer?.detailedErrorCode ?? ""] ?? "card_declined";
  } else if (errorCode === "PSP_101") {
    // Refund refused by the issuer; the acquirer refusal code rides detailedErrorCode.
    code = ACQUIRER_DECLINE_MAP[answer?.detailedErrorCode ?? ""] ?? "card_declined";
  } else if (errorCode.startsWith("AUTH_")) {
    code = "authentication_required";
  } else if (errorCode.startsWith("INT_") || errorCode.startsWith("CLIENT_")) {
    code = "invalid_request";
  } else if (errorCode.startsWith("PSP_")) {
    code = PAYZEN_PSP_CODE_MAP[errorCode] ?? "processing_error";
  } else {
    code = "processing_error";
  }
  // Genuinely transient only: HTTP-200 rate limits, gateway outage codes, and
  // PSP_076 (capture pending). Business/state rejections never retry.
  const retryable = code === "rate_limited" || code === "psp_unavailable" || errorCode === "PSP_076";
  return new PayFanoutError({
    code,
    message:
      errorCode === "INT_905"
        ? "PayZen rejected the API credentials — check shopId, password, and that they match the configured environment."
        : getUserMessage(code),
    retryable,
    raw,
    pspName: PAYZEN_PSP_NAME,
  });
}

/**
 * The PayZen `errorCode` carried on a mapped envelope error's `raw` (an ERROR
 * envelope), or undefined for a transport-level failure — a network/timeout
 * (raw is the cause) or an HTTP status from infrastructure in front of the
 * gateway (raw is the response body). Lets verifyCredentials tell an INT_905
 * credential rejection apart from a mere outage.
 */
function readEnvelopeErrorCode(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const answer = (raw as { answer?: unknown }).answer;
  if (typeof answer !== "object" || answer === null) return undefined;
  const errorCode = (answer as { errorCode?: unknown }).errorCode;
  return typeof errorCode === "string" ? errorCode : undefined;
}

function toPayZenCustomer(input: CreatePaymentSessionInput): Record<string, unknown> | undefined {
  const email = input.receiptEmail ?? input.billingDetails?.email;
  const billing = toPayZenBillingDetails(input.billingDetails);
  const shipping = toPayZenShippingDetails(input.shippingDetails);
  const customer = {
    ...(email ? { email } : {}),
    ...(billing ? { billingDetails: billing } : {}),
    ...(shipping ? { shippingDetails: shipping } : {}),
  };
  return Object.keys(customer).length > 0 ? customer : undefined;
}

function toPayZenBillingDetails(
  billing: CreatePaymentSessionInput["billingDetails"],
): Record<string, string> | undefined {
  if (!billing) return undefined;
  const [firstName, ...rest] = (billing.name ?? "").trim().split(/\s+/).filter(Boolean);
  const mapped: Record<string, string> = {
    ...(firstName ? { firstName } : {}),
    ...(rest.length > 0 ? { lastName: rest.join(" ") } : {}),
    ...(billing.address?.line1 ? { address: billing.address.line1 } : {}),
    ...(billing.address?.city ? { city: billing.address.city } : {}),
    ...(billing.address?.postalCode ? { zipCode: billing.address.postalCode } : {}),
    ...(billing.address?.country ? { country: billing.address.country } : {}),
  };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function toPayZenShippingDetails(
  shipping: CreatePaymentSessionInput["shippingDetails"],
): Record<string, string> | undefined {
  if (!shipping) return undefined;
  const [firstName, ...rest] = (shipping.name ?? "").trim().split(/\s+/).filter(Boolean);
  const mapped: Record<string, string> = {
    ...(firstName ? { firstName } : {}),
    ...(rest.length > 0 ? { lastName: rest.join(" ") } : {}),
    ...(shipping.phone ? { phoneNumber: shipping.phone } : {}),
    ...(shipping.address?.line1 ? { address: shipping.address.line1 } : {}),
    ...(shipping.address?.line2 ? { address2: shipping.address.line2 } : {}),
    ...(shipping.address?.city ? { city: shipping.address.city } : {}),
    ...(shipping.address?.state ? { state: shipping.address.state } : {}),
    ...(shipping.address?.postalCode ? { zipCode: shipping.address.postalCode } : {}),
    ...(shipping.address?.country ? { country: shipping.address.country } : {}),
  };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}
