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
  type CancelNativeSubscriptionInput,
  type CreateNativeSubscriptionInput,
  type CreatePaymentSessionInput,
  type MinorUnitAmount,
  type NativeSubscriptionInterval,
  type NativeSubscriptionRecord,
  type NativeSubscriptionStatus,
  type PaymentInfo,
  type PaymentMethodCapability,
  type PaymentMethodDetails,
  type PaymentSession,
  type UnifiedPaymentMethodType,
  type RefundInfo,
  type RefundRequest,
  type RefundResult,
  type RetrieveNativeSubscriptionInput,
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
  /**
   * Wallet/APM enablement varies per shop contract — override the
   * conservative card-only default once the Back Office lists the contract
   * (e.g. flip `{ type: "paypal", flow: "popup", supported: true }`).
   * Overrides wholesale, like every adapter with per-account rails.
   */
  paymentMethods?: PaymentMethodCapability[];
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Injected backoff sleep for retry tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Injected clock for tests (epoch milliseconds, default Date.now). Feeds
   * the default subscription effectDate and the pending-vs-active status
   * derivation of native subscriptions.
   */
  now?: () => number;
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

/** Structural subset of the Charge/CreateSubscription answer (V4/SubscriptionCreated). */
export interface PayZenSubscriptionCreatedLike {
  subscriptionId?: string;
  rrule?: string;
  amount?: number;
  currency?: string;
  effectDate?: string;
  initialAmount?: number | null;
  initialAmountNumber?: number | null;
}

/**
 * Structural subset of the Subscription/Get answer (V4/Subscription). The
 * object carries NO status field — the unified status is derived (see
 * derivePayZenSubscriptionStatus).
 */
export interface PayZenSubscriptionLike {
  subscriptionId?: string;
  shopId?: string;
  paymentMethodToken?: string | null;
  orderId?: string | null;
  metadata?: Record<string, string> | null;
  effectDate?: string;
  cancelDate?: string | null;
  initialAmount?: number | null;
  initialAmountNumber?: number | null;
  amount?: number;
  currency?: string;
  pastPaymentsNumber?: number;
  totalPaymentsNumber?: number;
  rrule?: string;
  description?: string | null;
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

/**
 * Methods the adapter can request. Card exists on every shop; everything else
 * needs a per-shop contract, so it defaults to supported: false — hosts flip
 * entries via `config.paymentMethods` once the Back Office lists the
 * contract. Two surfaces exist:
 *
 *   - flow "embedded"/"popup" — the krypton form/smartForm on the merchant
 *     page (formToken sessions).
 *   - flow "redirect" — PayZen's hosted payment page reached through a
 *     Charge/CreatePaymentOrder URL: the bank rails (SEPA Direct Debit, the
 *     DSP2 pay-by-bank family, iDEAL, Multibanco) only exist there.
 *
 * Redirect-rail constraints come from each method's technical-information
 * table. `bank_redirect_generic` groups the platform's bank-redirect products
 * (SEPA Credit Transfer / instant via payment initiation, MyBank,
 * Przelewy24): the buyer picks the concrete rail on the hosted page, so the
 * declared constraints are the family's union. SEPA Direct Debit declares no
 * countries: it is a zone rail, and encoding the zone's membership would
 * screen out valid payments the day it drifts.
 */
const DEFAULT_METHODS: PaymentMethodCapability[] = [
  { type: "card", flow: "embedded", supported: true },
  { type: "apple_pay", flow: "popup", supported: false },
  { type: "paypal", flow: "popup", supported: false },
  { type: "sepa_debit", flow: "redirect", supported: false, currencies: ["EUR"] },
  { type: "ideal", flow: "redirect", supported: false, currencies: ["EUR"], countries: ["NL"] },
  {
    type: "bank_redirect_generic",
    flow: "redirect",
    supported: false,
    currencies: ["EUR", "PLN"],
    countries: ["FR", "ES", "GR", "IT", "PL"],
  },
  { type: "voucher_generic", flow: "redirect", supported: false, currencies: ["EUR"], countries: ["PT"] },
];

/**
 * Unified type → Charge/CreatePayment `paymentMethods` value. The REST field
 * shares the kr-payment-method vocabulary (CARDS selects all card brands).
 * PAYPAL follows the official request samples, which send it against the
 * TEST demo shop; the client-side button table separately lists PAYPAL_SB
 * for the sandbox wallet, so verify PayPal end-to-end in TEST before live.
 */
const METHOD_TYPE_TO_PAYZEN: Partial<Record<UnifiedPaymentMethodType, string>> = {
  card: "CARDS",
  apple_pay: "APPLE_PAY",
  paypal: "PAYPAL",
};

/**
 * Transaction.paymentMethodType → unified type. The published vocabulary for
 * the RESPONSE field documents CARD and SDD; the remaining entries normalize
 * the request-side method codes best-effort when the platform echoes them,
 * and anything else stays an honest "other".
 */
const PAYZEN_METHOD_TYPE_TO_UNIFIED: Record<string, UnifiedPaymentMethodType> = {
  CARD: "card",
  APPLE_PAY: "apple_pay",
  PAYPAL: "paypal",
  SDD: "sepa_debit",
  IDEAL: "ideal",
  IP_WIRE: "bank_redirect_generic",
  IP_WIRE_INST: "bank_redirect_generic",
  MYBANK: "bank_redirect_generic",
  PRZELEWY24: "bank_redirect_generic",
  MULTIBANCO: "voucher_generic",
};

/**
 * Redirect-rail unified type → hosted-page method codes (the
 * vads_payment_cards vocabulary), with each code's documented settlement
 * currencies. A session request sends every code of the type that can settle
 * in the session currency — the hosted page then narrows to what the shop's
 * contracts actually enable.
 */
const REDIRECT_METHOD_CODES: Partial<Record<UnifiedPaymentMethodType, Array<{ code: string; currencies: string[] }>>> =
  {
    sepa_debit: [{ code: "SDD", currencies: ["EUR"] }],
    ideal: [{ code: "IDEAL", currencies: ["EUR"] }],
    bank_redirect_generic: [
      { code: "IP_WIRE", currencies: ["EUR"] },
      { code: "IP_WIRE_INST", currencies: ["EUR"] },
      { code: "MYBANK", currencies: ["EUR"] },
      { code: "PRZELEWY24", currencies: ["EUR", "PLN"] },
    ],
    voucher_generic: [{ code: "MULTIBANCO", currencies: ["EUR"] }],
  };

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
      // PayZen HAS a native subscription engine (Charge/CreateSubscription;
      // the gateway schedules, charges, and retries each installment itself)
      // but NO list/search API: Subscription/Get and Subscription/Cancel are
      // keyed by subscriptionId + paymentMethodToken. list stays false
      // honestly, and hosts MUST retain BOTH identifiers per subscription —
      // they form a composite key that cannot be rediscovered via the API.
      nativeSubscriptions: { list: false, retrieve: true, create: true, cancel: true },
      requiresServerCompletion: false, // confirm-on-client: the krypton form creates the transaction
      paymentMethods: this.config.paymentMethods ?? DEFAULT_METHODS,
    };
  }

  /**
   * Two session shapes, routed by the requested payment method types:
   *
   *   - Embedded (default, card/wallet types): Charge/CreatePayment →
   *     formToken (the client secret the krypton form mounts with). No
   *     transaction exists until the shopper pays, and the formToken expires
   *     after ~15 minutes — sessions are cheap to re-create.
   *   - Hosted redirect (any bank-rail type): Charge/CreatePaymentOrder →
   *     paymentURL (the client secret the client adapter redirects to). See
   *     createHostedPaymentSession.
   *
   * PayZen has no idempotency mechanism, so the adapter synthesizes traceable
   * replays: orderId derives deterministically from the idempotencyKey and the
   * key is stamped into metadata. A replayed call mints another formToken (or
   * payment order) for the SAME orderId — harmless (no money moves until the
   * shopper completes) and reconcilable via Order/Get.
   */
  async createPaymentSession(input: CreatePaymentSessionInput): Promise<PaymentSession> {
    assertMinorUnitAmount(input.amount, "amount");
    const currency = this.assertSupportedCurrency(input.currency);
    const requested = input.paymentMethodTypes ?? [];
    this.assertRequestedTypesEnabled(requested);
    if (requested.some((type) => REDIRECT_METHOD_CODES[type] !== undefined)) {
      return this.createHostedPaymentSession(input, currency, requested);
    }
    const paymentMethods = this.toPayZenPaymentMethods(requested);
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
      // Omitted when the session does not restrict methods — PayZen's
      // documented (and recommended) default then offers every method the
      // shop is eligible for.
      ...(paymentMethods ? { paymentMethods } : {}),
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
   * Creates a PSP-native subscription via Charge/CreateSubscription: the
   * gateway itself schedules, charges, and retries every installment against
   * the vaulted `savedPaymentMethodToken` (a PayZen paymentMethodToken; for
   * SEPA direct debits the mandate reference, which PayZen requires to start
   * >= 14 days out). Installment outcomes arrive as ordinary transaction
   * IPNs on the existing webhook path — enable the Back Office rule
   * "Notification URL when creating a recurring payment".
   *
   * Cadence: `interval`/`intervalCount` synthesize an RFC 5545 RRULE
   * (day/week/month/year are all accepted — PayZen rejects only sub-daily
   * periods); `schedule` passes a host RRULE through after validation and is
   * sent in PayZen's documented `RRULE:`-prefixed form. `startAt` becomes
   * `effectDate` (normalized to PayZen's 25-character ISO 8601 UTC shape);
   * when omitted the adapter's clock supplies "now" because effectDate is a
   * REQUIRED field. `merchantRefNum` rides the dedicated orderId field.
   * `pspCustomerId` is withheld (PayZen keys subscriptions by token, not by
   * a customer object) and `planId` is rejected — the platform has no
   * plan/price model to bill from.
   *
   * Replay safety: PayZen has no idempotency channel and creation applies
   * IMMEDIATELY (unlike a formToken, a subscription is a live billing
   * schedule), so this call is never transport-retried and a replayed create
   * CAN create a second active subscription. The deterministic orderId
   * (derived from `idempotencyKey` unless `merchantRefNum` is set) and the
   * `payfanout_key` metadata stamp make duplicates visible in the Back
   * Office and on installment IPNs, but there is no API to look a
   * subscription up by orderId — never blind-retry this call; reconcile
   * first. RETAIN the returned record's id together with the token: they
   * form the composite key every later retrieve/cancel needs.
   */
  async createNativeSubscription(input: CreateNativeSubscriptionInput): Promise<NativeSubscriptionRecord> {
    if (!input.savedPaymentMethodToken) {
      throw PayFanoutError.invalidRequest(
        "createNativeSubscription requires savedPaymentMethodToken — PayZen bills subscriptions from a vaulted paymentMethodToken",
      );
    }
    assertMinorUnitAmount(input.amount, "amount");
    if (input.amount === 0) {
      throw PayFanoutError.invalidRequest("createNativeSubscription requires a positive amount");
    }
    const currency = this.assertSupportedCurrency(input.currency);
    if (!input.interval && !input.schedule) {
      throw PayFanoutError.invalidRequest(
        "createNativeSubscription requires a billing cadence — pass interval (with optional intervalCount) or schedule",
      );
    }
    if (input.interval && input.schedule) {
      throw PayFanoutError.invalidRequest(
        "createNativeSubscription accepts interval or schedule, not both — one cadence must be authoritative",
      );
    }
    if (input.intervalCount !== undefined) {
      if (!input.interval) {
        throw PayFanoutError.invalidRequest("createNativeSubscription intervalCount requires interval");
      }
      if (!Number.isInteger(input.intervalCount) || input.intervalCount < 1) {
        throw PayFanoutError.invalidRequest("createNativeSubscription intervalCount must be a positive integer");
      }
    }
    if (input.planId !== undefined) {
      throw PayFanoutError.invalidRequest(
        "PayZen has no plan/price model — omit planId and express the cadence via interval or schedule",
      );
    }
    const rrule = input.interval
      ? buildPayZenRrule(input.interval, input.intervalCount ?? 1)
      : normalizePayZenSchedule(input.schedule!);
    let effectDate: string;
    if (input.startAt !== undefined) {
      const startMs = Date.parse(input.startAt);
      if (Number.isNaN(startMs)) {
        throw PayFanoutError.invalidRequest("createNativeSubscription startAt must be an ISO 8601 instant");
      }
      effectDate = toPayZenEffectDate(startMs);
    } else {
      // effectDate is REQUIRED by Charge/CreateSubscription — "now" starts
      // billing on the next rrule occurrence.
      effectDate = toPayZenEffectDate(this.nowMs());
    }
    const orderId = input.merchantRefNum ?? (await derivePayZenOrderId(input.idempotencyKey));
    const answer = await this.call<PayZenSubscriptionCreatedLike>(
      "Charge/CreateSubscription",
      {
        amount: input.amount,
        currency,
        effectDate,
        rrule,
        paymentMethodToken: input.savedPaymentMethodToken,
        orderId,
        metadata: {
          ...input.metadata,
          payfanout_key: input.idempotencyKey,
        },
      },
      {
        retryTransport: false,
        unknownOutcomeHint:
          "Do not retry blindly: a replay can create a second active subscription — " +
          "reconcile via the Back Office (orderId) first.",
      },
    );
    if (typeof answer?.subscriptionId !== "string" || answer.subscriptionId.length === 0) {
      throw new PayFanoutError({
        code: "processing_error",
        message: "PayZen did not return a subscriptionId.",
        retryable: false,
        raw: answer,
        pspName: this.pspName,
      });
    }
    // Built from the create answer plus the request facts — never a follow-up
    // read, so a transient read failure cannot orphan a subscription that was
    // just created (the caller MUST receive the id).
    return this.toSubscriptionRecord(
      {
        subscriptionId: answer.subscriptionId,
        rrule: answer.rrule ?? rrule,
        amount: answer.amount ?? input.amount,
        currency: answer.currency ?? currency,
        effectDate: answer.effectDate ?? effectDate,
        orderId,
      },
      input.savedPaymentMethodToken,
      answer,
    );
  }

  /**
   * Reads a subscription via Subscription/Get. PayZen keys subscriptions by
   * subscriptionId + paymentMethodToken (BOTH required — there is no list
   * API to rediscover either), so `savedPaymentMethodToken` is mandatory
   * here. The V4/Subscription answer has no status field; the unified status
   * is derived — see derivePayZenSubscriptionStatus for the exact rule.
   */
  async retrieveNativeSubscription(input: RetrieveNativeSubscriptionInput): Promise<NativeSubscriptionRecord> {
    this.assertSubscriptionKey(input.subscriptionId, input.savedPaymentMethodToken, "retrieveNativeSubscription");
    const answer = await this.call<PayZenSubscriptionLike>("Subscription/Get", {
      subscriptionId: input.subscriptionId,
      paymentMethodToken: input.savedPaymentMethodToken,
    });
    return this.toSubscriptionRecord(answer, answer.paymentMethodToken ?? input.savedPaymentMethodToken, answer);
  }

  /**
   * Stops PSP-side billing via Subscription/Cancel (immediate termination —
   * installments already in flight are NOT cancelled; use cancelPayment on
   * the individual transaction for those). The composite key rule of
   * retrieveNativeSubscription applies: `savedPaymentMethodToken` is
   * required.
   *
   * The Cancel answer is a bare Common/ResponseCodeAnswer (0 terminated,
   * 30 token not found, 32 subscription not found, 99 undefined error), so
   * the returned record always comes from a follow-up Subscription/Get.
   * Verified-idempotent: on ANY rejection — nonzero responseCode or an ERROR
   * envelope such as PSP_033/PSP_564 (already cancelled) — the adapter
   * re-reads the subscription and resolves successfully when it is already
   * terminated; only a subscription that is genuinely still billing
   * surfaces the rejection. Replaying this call is therefore always safe,
   * which is also why it is the one mutating PayZen call that keeps
   * automatic transport retries. `idempotencyKey` has no PayZen channel to
   * ride; replay safety comes from this verification, not from dedupe.
   */
  async cancelNativeSubscription(input: CancelNativeSubscriptionInput): Promise<NativeSubscriptionRecord> {
    this.assertSubscriptionKey(input.subscriptionId, input.savedPaymentMethodToken, "cancelNativeSubscription");
    const token = input.savedPaymentMethodToken!;
    let failure: PayFanoutError | undefined;
    try {
      const answer = await this.call<{ responseCode?: number }>("Subscription/Cancel", {
        subscriptionId: input.subscriptionId,
        paymentMethodToken: token,
      });
      if (answer?.responseCode !== 0) failure = mapPayZenCancelResponseCode(answer);
    } catch (err) {
      if (!(err instanceof PayFanoutError)) throw err;
      failure = err;
    }
    if (failure) {
      const settled = await this.readTerminatedSubscription(input.subscriptionId, token);
      if (settled) return settled;
      throw failure;
    }
    // responseCode 0 — the gateway confirmed termination. The record comes
    // from a fresh read; if that read fails, replaying the cancel is safe.
    const record = await this.retrieveNativeSubscription({
      subscriptionId: input.subscriptionId,
      savedPaymentMethodToken: token,
    });
    // A read that has not caught up with the just-confirmed termination must
    // not resurrect the subscription.
    return record.status === "canceled" || record.status === "completed"
      ? record
      : { ...record, status: "canceled" };
  }

  /** The verified-idempotency probe: the record iff it is already terminated, undefined otherwise. */
  private async readTerminatedSubscription(
    subscriptionId: string,
    token: string,
  ): Promise<NativeSubscriptionRecord | undefined> {
    try {
      const record = await this.retrieveNativeSubscription({
        subscriptionId,
        savedPaymentMethodToken: token,
      });
      return record.status === "canceled" || record.status === "completed" ? record : undefined;
    } catch {
      // The original cancel rejection stays authoritative — a failed probe
      // (e.g. subscription not found) adds nothing actionable.
      return undefined;
    }
  }

  /** Both halves of PayZen's composite subscription key, or a message telling hosts to retain them. */
  private assertSubscriptionKey(
    subscriptionId: string,
    savedPaymentMethodToken: string | undefined,
    operation: string,
  ): void {
    if (!subscriptionId) {
      throw PayFanoutError.invalidRequest(`${operation} requires subscriptionId`);
    }
    if (!savedPaymentMethodToken) {
      throw PayFanoutError.invalidRequest(
        `${operation} requires savedPaymentMethodToken — PayZen keys subscriptions by subscriptionId + ` +
          "paymentMethodToken, and no list API exists to rediscover them: hosts must retain both",
      );
    }
  }

  private toSubscriptionRecord(
    sub: PayZenSubscriptionLike,
    token: string | undefined,
    raw: unknown,
  ): NativeSubscriptionRecord {
    const cadence = sub.rrule ? projectPayZenRrule(sub.rrule) : undefined;
    return {
      id: sub.subscriptionId ?? "",
      pspName: this.pspName,
      status: derivePayZenSubscriptionStatus(sub, this.nowMs()),
      amount: sub.amount ?? 0,
      // Never fabricate a currency: empty is more honest when PayZen omits it.
      currency: (sub.currency ?? "").toUpperCase(),
      ...(cadence ? { interval: cadence.interval, intervalCount: cadence.intervalCount } : {}),
      // The source cadence, verbatim as PayZen reports it.
      ...(sub.rrule ? { schedule: sub.rrule } : {}),
      ...(token ? { savedPaymentMethodToken: token } : {}),
      ...(sub.orderId ? { merchantRefNum: sub.orderId } : {}),
      raw,
    };
  }

  private nowMs(): number {
    return (this.config.now ?? Date.now)();
  }

  /**
   * "Test connection" probe: one single-shot, side-effect-free Charge/SDKTest
   * call — PayZen's purpose-built connection test, which just echoes the
   * submitted value back on valid credentials. Transport retries are disabled so
   * a transient failure surfaces promptly instead of replaying (a "Test
   * connection" click must not hang for multiples of the timeout). PayZen
   * selects TEST vs LIVE by the key set, so the probe body carries no mode. The
   * outcome is classified so a host UI can tell a wrong shopId/password (`auth`)
   * from a transient outage (`network`); it resolves on every path instead of
   * throwing, and never surfaces the credential.
   */
  async verifyCredentials(): Promise<VerifyCredentialsResult> {
    try {
      await this.call<{ value?: string }>("Charge/SDKTest", { value: "connection-test" }, { retryTransport: false });
      return { ok: true };
    } catch (err) {
      // `call` with retryTransport:false strips the retryable flag off transport
      // failures, so classify the transient bucket by the preserved taxonomy
      // `code`, not `retryable`.
      const e = (err ?? {}) as { code?: string; raw?: unknown };
      // PayZen's wrong shopId/password rejection is the INT_905 ERROR envelope
      // (delivered over HTTP 200) — the only unambiguous credential signal. A
      // bare 4xx from infrastructure in front of the gateway is NOT proof of a
      // bad key, so it is never labeled auth.
      if (readEnvelopeErrorCode(e.raw) === "INT_905") {
        return { ok: false, category: "auth", message: "Authentication failed — check the PayZen shop id and password." };
      }
      // Transient transport trouble — network/timeout, HTTP 429/5xx.
      if (e.code === "psp_unavailable" || e.code === "rate_limited") {
        return { ok: false, category: "network", message: "Could not reach PayZen — try again." };
      }
      // Anything else — including a rare non-envelope infra 4xx — is unexpected.
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

  /**
   * EVERY requested type must be known to the adapter AND declared supported
   * in the capability list — stricter than router screening, which passes a
   * candidate when ANY requested type is eligible — because sending PayZen a
   * method the shop has no contract for would surface as a broken form, not
   * a clean rejection.
   */
  private assertRequestedTypesEnabled(types: UnifiedPaymentMethodType[]): void {
    const declared = this.config.paymentMethods ?? DEFAULT_METHODS;
    for (const type of types) {
      const known = METHOD_TYPE_TO_PAYZEN[type] !== undefined || REDIRECT_METHOD_CODES[type] !== undefined;
      const method = declared.find((m) => m.type === type);
      if (!known || !method) {
        throw PayFanoutError.invalidRequest(`PayZen adapter does not support payment method type "${type}"`, {
          requested: types,
        });
      }
      if (!method.supported) {
        throw PayFanoutError.invalidRequest(
          `Payment method type "${type}" is not enabled for this PayZen shop — its contract is per-shop; ` +
            "declare it supported via config.paymentMethods once the Back Office lists it",
          { requested: types },
        );
      }
    }
  }

  /**
   * Embedded-route `paymentMethodTypes` → the Charge/CreatePayment
   * `paymentMethods` array. Empty requests omit the field (PayZen then
   * offers all shop-eligible methods). Types are pre-validated by
   * assertRequestedTypesEnabled and pre-routed, so only embedded codes reach
   * this mapping.
   */
  private toPayZenPaymentMethods(types: UnifiedPaymentMethodType[]): string[] | undefined {
    if (types.length === 0) return undefined;
    return [...new Set(types.map((type) => METHOD_TYPE_TO_PAYZEN[type]!))];
  }

  /**
   * The hosted-payment route: bank rails have no embedded/smartForm surface,
   * so the session becomes a payment order (Charge/CreatePaymentOrder,
   * channel URL) whose paymentURL the client adapter redirects to — the
   * documented home of SDD, the DSP2 pay-by-bank family, iDEAL and
   * Multibanco. The buyer completes on PayZen's hosted page and lands back
   * on `returnUrl` (returnMode GET); outcomes reach the host via the same V4
   * IPN and Order/Get reads as every other PayZen payment. Embedded types
   * cannot share the session: the two surfaces are different products, and a
   * card brand list for the hosted page would be guessed, not mapped.
   */
  private async createHostedPaymentSession(
    input: CreatePaymentSessionInput,
    currency: string,
    requested: UnifiedPaymentMethodType[],
  ): Promise<PaymentSession> {
    const embedded = requested.filter((type) => REDIRECT_METHOD_CODES[type] === undefined);
    if (embedded.length > 0) {
      throw PayFanoutError.invalidRequest(
        `PayZen cannot mix embedded methods (${embedded.join(", ")}) with hosted bank rails in one session — ` +
          "create one session per surface",
        { requested },
      );
    }
    if (!input.returnUrl) {
      throw PayFanoutError.invalidRequest(
        "returnUrl is required for PayZen bank rails — the hosted payment page sends the buyer back to it",
        { requested },
      );
    }
    const codes = new Set<string>();
    for (const type of requested) {
      const eligible = REDIRECT_METHOD_CODES[type]!.filter((entry) => entry.currencies.includes(currency));
      if (eligible.length === 0) {
        throw PayFanoutError.invalidRequest(
          `Payment method type "${type}" cannot settle in ${currency} on PayZen`,
          { requested, currency },
        );
      }
      for (const entry of eligible) codes.add(entry.code);
    }
    const orderId = await derivePayZenOrderId(input.idempotencyKey);
    const customer = toPayZenCustomer(input);
    // CreatePaymentOrder documents manualValidation but NO paymentSource — the
    // MOTO exemption is a card-form concept, so it is withheld here rather
    // than sent as an undocumented field.
    const cardOptions = {
      ...(input.captureMethod === "manual" ? { manualValidation: "YES" } : {}),
    };
    const answer = await this.call<{ paymentOrderId?: string; paymentURL?: string; paymentOrderStatus?: string }>(
      "Charge/CreatePaymentOrder",
      {
        amount: input.amount,
        currency,
        orderId,
        channelOptions: { channelType: "URL" },
        paymentMethods: [...codes],
        // One returnUrl covers every outcome (success/refused/cancel/error
        // default to it); GET puts the return fields in the query string,
        // where the client adapter's handleRedirectReturn can read them.
        returnMode: "GET",
        returnUrl: input.returnUrl,
        ...(input.webhookUrl ? { ipnTargetUrl: input.webhookUrl } : {}),
        ...(input.sca?.challenge === "force" ? { strongAuthentication: "CHALLENGE_REQUESTED" } : {}),
        ...(Object.keys(cardOptions).length > 0 ? { transactionOptions: { cardOptions } } : {}),
        ...(customer ? { customer } : {}),
        metadata: {
          ...input.metadata,
          payfanout_key: input.idempotencyKey,
          ...(input.id ? { payfanout_id: input.id } : {}),
        },
      },
    );
    if (typeof answer?.paymentURL !== "string" || answer.paymentURL.length === 0) {
      throw new PayFanoutError({
        code: "processing_error",
        message: "PayZen did not return a payment URL.",
        retryable: false,
        raw: answer,
        pspName: this.pspName,
      });
    }
    return {
      id: input.id ?? orderId,
      pspName: this.pspName,
      pspSessionId: orderId,
      clientSecret: answer.paymentURL,
      amount: input.amount,
      currency,
      // The next step is the buyer authorising at their bank — the same
      // shape redirect-only PSPs report.
      status: "requires_action",
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
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
      // Absent on some snapshots — card is the only method that predates the
      // field on this platform, so it stays the honest fallback.
      paymentMethodType: !tx.paymentMethodType
        ? "card"
        : (PAYZEN_METHOD_TYPE_TO_UNIFIED[tx.paymentMethodType] ?? "other"),
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
    opts: { retryTransport?: boolean; unknownOutcomeHint?: string } = {},
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
          (opts.unknownOutcomeHint ?? "Do not retry blindly: re-read the payment (amountRefunded) first."),
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

/**
 * Unified interval → RFC 5545 frequency. PayZen accepts all four (its only
 * rrule restriction is periods below one day: SECONDLY/MINUTELY/HOURLY are
 * not taken into account).
 */
const RRULE_FREQ_BY_INTERVAL: Record<NativeSubscriptionInterval, string> = {
  day: "DAILY",
  week: "WEEKLY",
  month: "MONTHLY",
  year: "YEARLY",
};

const RRULE_INTERVAL_BY_FREQ: Record<string, NativeSubscriptionInterval> = {
  DAILY: "day",
  WEEKLY: "week",
  MONTHLY: "month",
  YEARLY: "year",
};

/** The frequencies PayZen documents as ignored (no period below one day). */
const SUB_DAILY_FREQS = new Set(["SECONDLY", "MINUTELY", "HOURLY"]);

/** interval/intervalCount → the wire rrule, in PayZen's documented `RRULE:`-prefixed form. */
function buildPayZenRrule(interval: NativeSubscriptionInterval, intervalCount: number): string {
  return `RRULE:FREQ=${RRULE_FREQ_BY_INTERVAL[interval]};INTERVAL=${String(intervalCount)}`;
}

/**
 * Light validation + normalization of a host-supplied schedule: the RRULE
 * value must start with FREQ= (an optional `RRULE:` prefix is tolerated) and
 * use a frequency PayZen can honor — sub-daily frequencies are rejected here
 * because the platform documents them as "not taken into account", which
 * would silently rebill on a different cadence than the host asked for. The
 * rest of the rule (BYDAY, BYMONTHDAY, COUNT, UNTIL, …) passes through
 * verbatim; PayZen validates it (INT_064/PSP_566). Sent with the `RRULE:`
 * prefix, the only form the platform documents.
 */
function normalizePayZenSchedule(schedule: string): string {
  const value = schedule.startsWith("RRULE:") ? schedule.slice("RRULE:".length) : schedule;
  if (!value.startsWith("FREQ=")) {
    throw PayFanoutError.invalidRequest(
      'schedule must be an RFC 5545 RRULE value starting with "FREQ=" (an "RRULE:" prefix is accepted)',
      { schedule },
    );
  }
  const freq = /^FREQ=([^;]*)/.exec(value)![1]!.toUpperCase();
  if (SUB_DAILY_FREQS.has(freq)) {
    throw PayFanoutError.invalidRequest(
      `PayZen does not accept recurring payment periods below one day — FREQ=${freq} is not taken into account`,
      { schedule },
    );
  }
  if (RRULE_INTERVAL_BY_FREQ[freq] === undefined) {
    throw PayFanoutError.invalidRequest(`schedule has no valid RFC 5545 frequency: FREQ=${freq}`, { schedule });
  }
  return `RRULE:${value}`;
}

/**
 * The faithful day/week/month/year projection of a PayZen rrule, or
 * undefined when none exists. Only FREQ + INTERVAL (+ COUNT, which bounds
 * the number of installments without changing the cadence) project; any
 * other part (BYDAY, BYMONTHDAY, BYSETPOS, UNTIL, …) shifts occurrences in
 * ways the simple interval vocabulary cannot express, so the record then
 * carries only `schedule`.
 */
export function projectPayZenRrule(
  rrule: string,
): { interval: NativeSubscriptionInterval; intervalCount: number } | undefined {
  const value = rrule.startsWith("RRULE:") ? rrule.slice("RRULE:".length) : rrule;
  // PayZen's own examples include trailing semicolons ("RRULE:FREQ=WEEKLY;INTERVAL=2;").
  const parts = value.split(";").filter((part) => part.length > 0);
  let interval: NativeSubscriptionInterval | undefined;
  let intervalCount = 1;
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) return undefined;
    const key = part.slice(0, eq).toUpperCase();
    const raw = part.slice(eq + 1);
    if (key === "FREQ") {
      interval = RRULE_INTERVAL_BY_FREQ[raw.toUpperCase()];
      if (!interval) return undefined;
    } else if (key === "INTERVAL") {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) return undefined;
      intervalCount = parsed;
    } else if (key !== "COUNT") {
      return undefined;
    }
  }
  return interval ? { interval, intervalCount } : undefined;
}

/** Epoch ms → PayZen's exact 25-character effectDate shape (2026-07-17T10:00:00+00:00). */
function toPayZenEffectDate(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/**
 * The V4/Subscription object has NO status field — the unified status is
 * derived from the facts it does carry, first match wins:
 *
 *   1. cancelDate set → "canceled" (Subscription/Cancel stamps it);
 *   2. totalPaymentsNumber > 0 and pastPaymentsNumber has reached it →
 *      "completed" (a finite rrule — COUNT/UNTIL — ran all installments;
 *      open-ended subscriptions report totalPaymentsNumber 0 and never
 *      complete);
 *   3. effectDate in the future → "pending" (created, not yet billing);
 *   4. otherwise → "active".
 */
export function derivePayZenSubscriptionStatus(
  sub: Pick<PayZenSubscriptionLike, "cancelDate" | "effectDate" | "pastPaymentsNumber" | "totalPaymentsNumber">,
  nowMs: number,
): NativeSubscriptionStatus {
  if (sub.cancelDate) return "canceled";
  if (
    typeof sub.totalPaymentsNumber === "number" &&
    sub.totalPaymentsNumber > 0 &&
    typeof sub.pastPaymentsNumber === "number" &&
    sub.pastPaymentsNumber >= sub.totalPaymentsNumber
  ) {
    return "completed";
  }
  const effectMs = Date.parse(sub.effectDate ?? "");
  if (!Number.isNaN(effectMs) && effectMs > nowMs) return "pending";
  return "active";
}

/**
 * Subscription/Cancel answers a Common/ResponseCodeAnswer INSIDE a SUCCESS
 * envelope — nonzero responseCodes are rejections riding HTTP 200 + SUCCESS:
 * 30 token not found, 32 subscription not found, 99 undefined error. Never
 * retryable: the same key material yields the same answer.
 */
function mapPayZenCancelResponseCode(answer: { responseCode?: number } | undefined): PayFanoutError {
  const responseCode = answer?.responseCode;
  if (responseCode === 30) {
    return new PayFanoutError({
      code: "invalid_request",
      message:
        "PayZen did not find the paymentMethodToken for this subscription — subscriptionId and " +
        "savedPaymentMethodToken form a composite key and must belong together.",
      retryable: false,
      raw: answer,
      pspName: PAYZEN_PSP_NAME,
    });
  }
  if (responseCode === 32) {
    return new PayFanoutError({
      code: "invalid_request",
      message: "PayZen did not find the subscription — check the subscriptionId.",
      retryable: false,
      raw: answer,
      pspName: PAYZEN_PSP_NAME,
    });
  }
  return new PayFanoutError({
    code: "processing_error",
    message: getUserMessage("processing_error"),
    retryable: false,
    raw: answer,
    pspName: PAYZEN_PSP_NAME,
  });
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
    case "INITIAL": // temporary — no acquirer response yet
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

/** Acquirer refusal codes (ACQ_001 / PSP_101 detailedErrorCode) → decline refinement (CB network table). */
const ACQUIRER_DECLINE_MAP: Record<string, UnifiedErrorCode> = {
  "51": "insufficient_funds",
  "33": "expired_card",
  "38": "expired_card",
  "54": "expired_card",
  "14": "invalid_card_data",
  "34": "fraud_suspected", // suspected fraud
  "41": "fraud_suspected", // lost card
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
  // Token / subscription lookups and state rejections.
  PSP_030: "invalid_request", // token not found
  PSP_031: "invalid_request", // invalid token (canceled, empty, …)
  PSP_032: "invalid_request", // subscriptionId not found
  PSP_033: "invalid_request", // rrule invalid or recurring payment already canceled
  PSP_563: "invalid_request", // recurring payment already exists
  PSP_564: "invalid_request", // recurring payment already terminated
  PSP_565: "invalid_request", // invalid recurring payment
  PSP_566: "invalid_request", // invalid recurrence rule
  PSP_567: "processing_error", // recurring payment creation failed (cause unstated — never retryable)
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
