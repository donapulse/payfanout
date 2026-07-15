import {
  assertMinorUnitAmount,
  base64UrlToUtf8,
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
  type UnifiedPaymentMethodType,
  type UnifiedPaymentStatus,
  type UnifiedWebhookEvent,
  type UpdatePaymentSessionInput,
  type VerifyCredentialsResult,
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

/** Masked bank-account facts as Paysafe's sepa/bacs payload objects echo them. */
export interface PaysafeBankAccountLike {
  lastDigits?: string;
  accountHolderName?: string;
  bic?: string;
  sortCode?: string;
  mandateReference?: string;
  bankReference?: string;
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
  sepa?: PaysafeBankAccountLike;
  bacs?: PaysafeBankAccountLike;
  /** NOT populated by the real GET /payments — settlements are queried separately. */
  settlements?: PaysafeSettlementLike[];
  error?: { code?: string; message?: string };
}

/** Payment handle as POST /paymenthandles returns it for redirect and bank-debit rails. */
export interface PaysafePaymentHandleLike {
  id: string;
  paymentHandleToken: string;
  merchantRefNum?: string;
  status?: string;
  /** "REDIRECT" when the customer must authenticate at the provider. */
  action?: string;
  paymentType?: string;
  sepa?: PaysafeBankAccountLike;
  bacs?: PaysafeBankAccountLike;
  links?: Array<{ rel?: string; href?: string }>;
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
    paymentMethodType: toUnifiedMethodType(handle.paymentType),
    ...(details ? { details } : {}),
    raw: handle,
  };
}

/**
 * Interac e-Transfer settles in Canadian dollars only (Paysafe: "Supported
 * currency: CAD"). One constant, two readers: the capability below, so the
 * router skips a non-CAD session instead of failing at Paysafe, and
 * createInteracSession, which still rejects — screening is bypassed entirely
 * when a host drives the adapter without PaymentService, and a host overriding
 * config.paymentMethods can drop the declared gate.
 */
const INTERAC_CURRENCIES: string[] = ["CAD"];

/**
 * SEPA collects in euro and Bacs in pounds sterling, full stop (Paysafe: SEPA
 * "Currency: EUR", BACS "Currency: GBP"). Same one-constant-two-readers rule
 * as INTERAC_CURRENCIES: the capability gates routing, the session guard still
 * rejects. ACH and EFT are deliberately absent — Paysafe documents no currency
 * for either (see docs/decisions.md), and a guard the provider never stated
 * would reject payments the account might accept.
 */
const SEPA_CURRENCIES: string[] = ["EUR"];
const BACS_CURRENCIES: string[] = ["GBP"];

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
  // Bank-debit rails, Payments-API only like Interac (Paysafe.js cannot
  // tokenize them): the host collects the bank details in-page, so the flow is
  // embedded — no PSP-hosted redirect. Implemented, but off by default:
  // enablement is per merchant account, and claiming rails most accounts do
  // not carry would misreport them. An opt-in via config.paymentMethods
  // replaces this list wholesale and must carry its own gates. ACH and EFT
  // declare no currencies (Paysafe documents none for either — see
  // docs/decisions.md) and SEPA no countries (a zone, not a country; a
  // membership list would screen out valid payments the day it drifts).
  { type: "sepa_debit", flow: "embedded", supported: false, currencies: [...SEPA_CURRENCIES] },
  { type: "ach", flow: "embedded", supported: false },
  {
    type: "bacs_debit",
    flow: "embedded",
    supported: false,
    currencies: [...BACS_CURRENCIES],
    // "Region: United Kingdom" — the scheme debits UK bank accounts.
    countries: ["GB"],
  },
  // "Supported region: Canada" — Pre-Authorized Debit, which Paysafe calls EFT.
  { type: "pad", flow: "embedded", supported: false, countries: ["CA"] },
  // Payments-API only (Paysafe.js cannot tokenize it): the handle is minted
  // server-side at session creation and the customer authenticates at Interac.
  // Implemented, but off by default like every other non-card rail — it is
  // per-account enablement AND Canada/CAD only, so claiming it for every account
  // would misreport the majority of them. Canadian merchants opt in via
  // config.paymentMethods.
  {
    type: "interac_etransfer",
    flow: "redirect",
    supported: false,
    currencies: [...INTERAC_CURRENCIES],
    // "Supported region: Canada" — the customer authenticates at a Canadian
    // bank. An opt-in override carries its own gates (see the note above).
    countries: ["CA"],
  },
];

/** Paysafe paymentType -> the unified vocabulary. Everything else stays "other". */
const PAYSAFE_TYPE_TO_UNIFIED: Record<string, UnifiedPaymentMethodType> = {
  CARD: "card",
  INTERAC_ETRANSFER: "interac_etransfer",
  SEPA: "sepa_debit",
  ACH: "ach",
  BACS: "bacs_debit",
  EFT: "pad",
};

const INTERAC_PAYMENT_TYPE = "INTERAC_ETRANSFER";

/**
 * The bank-debit rails: unified type -> the paymentType a handle is minted
 * with. Unlike Interac these are not redirect rails — the host collects the
 * customer's bank details in-page and completePayment mints the handle and
 * charges it in one server round trip.
 */
const BANK_DEBIT_PAYMENT_TYPES = {
  sepa_debit: "SEPA",
  ach: "ACH",
  bacs_debit: "BACS",
  pad: "EFT",
} as const;

type BankDebitRail = keyof typeof BANK_DEBIT_PAYMENT_TYPES;
type BankDebitPaymentType = (typeof BANK_DEBIT_PAYMENT_TYPES)[BankDebitRail];

const BANK_DEBIT_TYPE_SET = new Set<string>(Object.values(BANK_DEBIT_PAYMENT_TYPES));

function isBankDebitPaymentType(paymentType: string | undefined): paymentType is BankDebitPaymentType {
  return paymentType !== undefined && BANK_DEBIT_TYPE_SET.has(paymentType);
}

/** The single-currency rails' session guard reads the same constants the capabilities declare. */
const BANK_DEBIT_CURRENCIES: Partial<Record<BankDebitPaymentType, string[]>> = {
  SEPA: SEPA_CURRENCIES,
  BACS: BACS_CURRENCIES,
};

/**
 * Every outcome returns to the host's single returnUrl. "on_completed" is also a
 * valid rel, but "default" already covers it and splitting them would imply the
 * landing URL is proof of the outcome.
 */
const INTERAC_RETURN_RELS = ["default", "on_failed", "on_cancelled"] as const;

/**
 * Paysafe appends nothing to the return URL, so the client adapter would have no
 * way to recognize its own return trip. Planting a marker on the links we
 * register is that evidence. Kept in step with PAYSAFE_RETURN_MARKER in
 * adapter-paysafe — the packages share no code, since a client-safe package
 * cannot depend on a server one.
 */
const PAYSAFE_RETURN_MARKER = "payfanout_psp";

function withReturnMarker(returnUrl: string): string {
  let url: URL;
  try {
    url = new URL(returnUrl);
  } catch (err) {
    throw PayFanoutError.invalidRequest(`returnUrl is not a valid absolute URL: ${returnUrl}`, err);
  }
  url.searchParams.set(PAYSAFE_RETURN_MARKER, "paysafe");
  return url.href;
}

/**
 * A handle is minted for exactly ONE paymentType, so a redirect rail cannot share
 * a session with the card path — asking for both is a request we cannot honor.
 */
function isInteracRequest(types: UnifiedPaymentMethodType[] | undefined): boolean {
  if (!types?.includes("interac_etransfer")) return false;
  if (types.length > 1) {
    throw PayFanoutError.invalidRequest(
      `Interac e-Transfer needs a session of its own — it cannot be combined with: ${types
        .filter((t) => t !== "interac_etransfer")
        .join(", ")}`,
    );
  }
  return true;
}

/**
 * Bank-debit sessions are single-rail for the same reason Interac ones are: a
 * handle is minted for exactly ONE paymentType, and the client mounts one
 * bank-details form per session.
 */
function bankDebitRailOf(types: UnifiedPaymentMethodType[] | undefined): BankDebitRail | undefined {
  if (!types) return undefined;
  const rail = types.find((t): t is BankDebitRail => t in BANK_DEBIT_PAYMENT_TYPES);
  if (rail === undefined) return undefined;
  if (types.length > 1) {
    throw PayFanoutError.invalidRequest(
      `${rail} needs a session of its own — it cannot be combined with: ${types
        .filter((t) => t !== rail)
        .join(", ")}`,
    );
  }
  return rail;
}

/**
 * Wire prefix of the bank-details envelope confirm() produces on bank-debit
 * sessions: "paysafe-bank." + base64url(JSON). Kept in step with the client
 * adapter — the packages share no code, since a client-safe package cannot
 * depend on a server one.
 */
const BANK_ENVELOPE_PREFIX = "paysafe-bank.";

/**
 * Completion-time bank details as the envelope carries them. Bank details are
 * not card data (SAQ-A is unaffected), but they are still never logged and
 * never echoed into error messages.
 */
interface PaysafeBankEnvelopeV1 {
  v: 1;
  paymentType: BankDebitPaymentType;
  accountHolderName: string;
  iban?: string;
  bic?: string;
  routingNumber?: string;
  accountNumber?: string;
  sortCode?: string;
  transitNumber?: string;
  institutionId?: string;
  /** SEPA/BACS: the customer agreed to the direct-debit mandate. */
  mandateConsent?: boolean;
}

/**
 * Each rail's bank object fields: accountHolderName is universal, the rest are
 * the coordinates the scheme routes by. SEPA's bic is the one documented
 * optional field, forwarded separately when present.
 */
const BANK_REQUIRED_FIELDS: Record<BankDebitPaymentType, ReadonlyArray<keyof PaysafeBankEnvelopeV1 & string>> = {
  SEPA: ["accountHolderName", "iban"],
  ACH: ["accountHolderName", "routingNumber", "accountNumber"],
  BACS: ["accountHolderName", "sortCode", "accountNumber"],
  EFT: ["accountHolderName", "institutionId", "transitNumber", "accountNumber"],
};

/** Mandate schemes: a completion the customer never agreed to is not a payment we may take. */
const BANK_MANDATE_PAYMENT_TYPES = new Set<BankDebitPaymentType>(["SEPA", "BACS"]);

interface ParsedBankDetails {
  accountHolderName: string;
  /** The rail's bank object, keyed and shaped as POST /paymenthandles takes it. */
  bank: Record<string, string>;
}

function parseBankEnvelope(
  clientToken: string | undefined,
  paymentType: BankDebitPaymentType,
): ParsedBankDetails {
  if (!clientToken || !clientToken.startsWith(BANK_ENVELOPE_PREFIX)) {
    throw PayFanoutError.invalidRequest(
      `This session collects ${paymentType} bank details — completePayment requires the ` +
        `"${BANK_ENVELOPE_PREFIX}" envelope produced by confirm(), not a Paysafe.js token`,
    );
  }
  let envelope: PaysafeBankEnvelopeV1;
  try {
    envelope = JSON.parse(base64UrlToUtf8(clientToken.slice(BANK_ENVELOPE_PREFIX.length))) as PaysafeBankEnvelopeV1;
  } catch (err) {
    // V8's JSON.parse message embeds a source snippet — a corrupted envelope
    // would ride typed bank digits into `raw`, so only the error name survives.
    throw PayFanoutError.invalidRequest("Bank-details envelope is not base64url-encoded JSON", {
      name: err instanceof Error ? err.name : "Error",
    });
  }
  if (envelope === null || typeof envelope !== "object" || envelope.v !== 1) {
    throw PayFanoutError.invalidRequest("Bank-details envelope has an unsupported shape — expected version 1");
  }
  if (envelope.paymentType !== paymentType) {
    throw PayFanoutError.invalidRequest(
      `Bank-details envelope carries "${String(envelope.paymentType)}" details but this session was created for ${paymentType}`,
    );
  }
  // Rejections name fields, never values — account numbers do not belong in
  // error messages or logs, so `raw` stays a field list too.
  const bank: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of BANK_REQUIRED_FIELDS[paymentType]) {
    const value = envelope[field];
    if (typeof value === "string" && value.trim() !== "") bank[field] = value;
    else missing.push(field);
  }
  if (missing.length > 0) {
    throw PayFanoutError.invalidRequest(
      `Bank-details envelope is missing required ${paymentType} field(s): ${missing.join(", ")}`,
      { paymentType, missing },
    );
  }
  if (BANK_MANDATE_PAYMENT_TYPES.has(paymentType) && envelope.mandateConsent !== true) {
    throw PayFanoutError.invalidRequest(
      `${paymentType} is a mandate scheme — the envelope must carry mandateConsent: true once the customer agrees to the direct-debit mandate`,
    );
  }
  if (paymentType === "SEPA" && typeof envelope.bic === "string" && envelope.bic.trim() !== "") {
    bank["bic"] = envelope.bic;
  }
  return { accountHolderName: envelope.accountHolderName, bank };
}

/**
 * SEPA/BACS document a "create a customer profile" step; the profile data is
 * embedded in the handle request instead of a separate /customers call —
 * PayFanout is stateless, and Paysafe's public pages stop at the flow
 * description (the field-level reference is not public). Wrong embedding fails
 * closed: /paymenthandles strict-rejects unrecognized fields (error 5023).
 * Same name split as createCustomer.
 */
function toBankProfile(accountHolderName: string, email: string | undefined): Record<string, string> {
  const [firstName, ...rest] = accountHolderName.trim().split(/\s+/).filter(Boolean);
  return {
    ...(firstName ? { firstName } : {}),
    ...(rest.length > 0 ? { lastName: rest.join(" ") } : {}),
    ...(email ? { email } : {}),
  };
}

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
    if (isInteracRequest(input.paymentMethodTypes)) return this.createInteracSession(context, input);
    const bankRail = bankDebitRailOf(input.paymentMethodTypes);
    if (bankRail) return this.createBankDebitSession(bankRail, context);
    return this.toSession(context);
  }

  /**
   * Interac e-Transfer is Payments-API only — Paysafe.js cannot tokenize it, so
   * unlike the card path this session DOES call Paysafe: the redirect URL has to
   * exist before the client can send the customer to their bank. The resulting
   * handle token rides the signed context, which is what keeps completion
   * stateless.
   */
  private async createInteracSession(
    context: PaysafeSessionContextV1,
    input: CreatePaymentSessionInput,
  ): Promise<PaymentSession> {
    if (!INTERAC_CURRENCIES.includes(context.currency)) {
      throw PayFanoutError.invalidRequest(
        `Interac e-Transfer settles in ${INTERAC_CURRENCIES.join("/")} only — this session is ${context.currency}`,
      );
    }
    if (context.captureMethod === "manual") {
      throw PayFanoutError.invalidRequest(
        "Interac e-Transfer cannot be authorized without settling — use captureMethod \"automatic\"",
      );
    }
    if (!input.returnUrl) {
      throw PayFanoutError.invalidRequest(
        "Interac e-Transfer requires returnUrl — Paysafe returns the customer to it after they authenticate at their bank",
      );
    }
    // Paysafe collects from an alias, so the customer's email is the instrument
    // itself, not a receipt nicety.
    const consumerId = input.receiptEmail ?? input.billingDetails?.email;
    if (!consumerId) {
      throw PayFanoutError.invalidRequest(
        "Interac e-Transfer requires the customer's email — pass receiptEmail or billingDetails.email",
      );
    }
    const returnHref = withReturnMarker(input.returnUrl);
    const handle = await this.request<PaysafePaymentHandleLike>("POST", "/paymenthub/v1/paymenthandles", {
      merchantRefNum: input.idempotencyKey,
      transactionType: "PAYMENT",
      paymentType: INTERAC_PAYMENT_TYPE,
      amount: context.amount,
      currencyCode: context.currency,
      // "interacEtransfer" (lowercase t) is contested: Paysafe's OpenAPI schema
      // interacObject spells it "interacETransfer", but that schema is flagged
      // x-internal, while every request example and the integration guide use
      // this spelling. Getting it wrong fails closed (error 5023, unrecognized
      // field). See docs/decisions.md.
      interacEtransfer: { consumerId, type: "EMAIL" },
      ...(context.merchantAccountId ? { accountId: context.merchantAccountId } : {}),
      // The same URL for every outcome: the browser's landing spot is a hint, not
      // evidence — the real result comes from completePayment/the webhook.
      returnLinks: INTERAC_RETURN_RELS.map((rel) => ({ rel, href: returnHref })),
      ...(toPaysafeBillingDetails(context.billingDetails) ?? {}),
    });
    const redirectUrl = handle.links?.find((link) => link.rel === "redirect_payment")?.href;
    if (!redirectUrl) {
      throw new PayFanoutError({
        code: "processing_error",
        message: "Paysafe returned an Interac payment handle with no redirect link",
        retryable: false,
        raw: handle,
        pspName: this.pspName,
      });
    }
    return this.toSession(
      {
        ...context,
        paymentType: INTERAC_PAYMENT_TYPE,
        paymentHandleToken: handle.paymentHandleToken,
        redirectUrl,
      },
      // The handle exists; what remains is the customer authenticating at Interac.
      "requires_action",
    );
  }

  /**
   * Bank-debit rails (SEPA/ACH/BACS/EFT) are Payments-API only, like Interac —
   * but nothing is minted here: the bank details do not exist until the
   * customer types them into the host's form. The session only stamps the
   * rail's paymentType into the signed context; completePayment mints the
   * handle from the client's envelope and charges it in one round trip.
   */
  private createBankDebitSession(
    rail: BankDebitRail,
    context: PaysafeSessionContextV1,
  ): Promise<PaymentSession> {
    const paymentType = BANK_DEBIT_PAYMENT_TYPES[rail];
    const currencies = BANK_DEBIT_CURRENCIES[paymentType];
    if (currencies && !currencies.includes(context.currency)) {
      throw PayFanoutError.invalidRequest(
        `${rail} settles in ${currencies.join("/")} only — this session is ${context.currency}`,
      );
    }
    if (context.captureMethod === "manual") {
      throw PayFanoutError.invalidRequest(
        `${rail} cannot be authorized without settling — use captureMethod "automatic"`,
      );
    }
    return this.toSession({ ...context, paymentType });
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
    // A minted handle is fixed at its amount/currency: the customer authorizes THAT
    // handle at their bank. Re-signing a context around it would charge an amount
    // they never approved, and would slip past the rail's own creation guards.
    if (context.paymentHandleToken) {
      throw PayFanoutError.invalidRequest(
        "This session's payment handle is already minted and cannot be amended — create a new payment session instead",
      );
    }
    if (input.amount !== undefined) assertMinorUnitAmount(input.amount, "amount");
    const currency = input.currency !== undefined ? normalizeCurrency(input.currency) : context.currency;
    // A bank-debit session keeps its rail across updates, so the rail's
    // currency guard must hold for the NEW currency too — otherwise an update
    // slips past the creation guard and dies at Paysafe instead of here.
    if (input.currency !== undefined && isBankDebitPaymentType(context.paymentType)) {
      const railCurrencies = BANK_DEBIT_CURRENCIES[context.paymentType];
      if (railCurrencies && !railCurrencies.includes(currency)) {
        throw PayFanoutError.invalidRequest(
          `${PAYSAFE_TYPE_TO_UNIFIED[context.paymentType]} settles in ${railCurrencies.join("/")} only — ` +
            `this session cannot be updated to ${currency}`,
        );
      }
    }
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

  private async toSession(
    context: PaysafeSessionContextV1,
    status: UnifiedPaymentStatus = "requires_payment_method",
  ): Promise<PaymentSession> {
    const token = await encodeSessionContext(context, this.config.sessionSigningKey);
    return {
      id: context.id ?? token,
      pspName: this.pspName,
      pspSessionId: token,
      clientSecret: token, // the client adapter decodes the payload half for tokenize/redirect params
      amount: context.amount,
      currency: context.currency,
      status,
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
    const context = await this.decodeContext(input.pspSessionId);
    // Bank-debit sessions have no handle yet at all: it is minted here, from
    // the bank details the client's envelope carries.
    const bankPaymentType = context.paymentType;
    if (isBankDebitPaymentType(bankPaymentType)) {
      return this.completeBankDebitPayment(context, bankPaymentType, input);
    }
    // Redirect rails (Interac) minted their handle at session creation and carry
    // it in the signed context; the card path only has a token once the browser
    // has tokenized, so it still comes from the caller.
    const paymentHandleToken = context.paymentHandleToken ?? input.clientToken;
    if (!paymentHandleToken) {
      throw PayFanoutError.invalidRequest("completePayment requires the clientToken produced by confirm()");
    }
    const payment = await this.request<PaysafePaymentLike>("POST", "/paymenthub/v1/payments", {
      merchantRefNum: input.idempotencyKey, // Paysafe dedupes on merchantRefNum — the idempotency mechanism
      amount: context.amount,
      currencyCode: context.currency,
      paymentHandleToken,
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

  /**
   * Bank-debit completion is two calls in one round trip: mint the handle from
   * the envelope's bank details, then charge it. Both share the caller's
   * idempotencyKey as merchantRefNum — Paysafe dedupes per endpoint, so a
   * replayed completion re-reads the same handle and the same payment instead
   * of minting or charging twice.
   */
  private async completeBankDebitPayment(
    context: PaysafeSessionContextV1,
    paymentType: BankDebitPaymentType,
    input: CompletePaymentInput,
  ): Promise<PaymentInfo> {
    const details = parseBankEnvelope(input.clientToken, paymentType);
    const billingDetails = mergeBillingDetails(context.billingDetails, input.billingDetails);
    const handle = await this.request<PaysafePaymentHandleLike>("POST", "/paymenthub/v1/paymenthandles", {
      merchantRefNum: input.idempotencyKey,
      transactionType: "PAYMENT",
      paymentType,
      amount: context.amount,
      currencyCode: context.currency,
      ...(context.merchantAccountId ? { accountId: context.merchantAccountId } : {}),
      profile: toBankProfile(details.accountHolderName, context.receiptEmail ?? context.billingDetails?.email),
      ...(toPaysafeBillingDetails(billingDetails) ?? {}),
      // The bank object is named after the paymentType in lowercase, exactly as
      // the sepa/bacs objects appear in Paysafe's own payloads.
      [paymentType.toLowerCase()]: details.bank,
    });
    // ACH/EFT document the handle as immediately PAYABLE; anything else cannot
    // be charged, and surfacing it here beats a cryptic /payments rejection.
    if ((handle.status ?? "").toUpperCase() !== "PAYABLE") {
      throw new PayFanoutError({
        code: "processing_error",
        message: `Paysafe returned a ${paymentType} payment handle in status ${handle.status ?? "unknown"} instead of PAYABLE`,
        retryable: false,
        raw: handle,
        pspName: this.pspName,
      });
    }
    const payment = await this.request<PaysafePaymentLike>("POST", "/paymenthub/v1/payments", {
      merchantRefNum: input.idempotencyKey,
      amount: context.amount,
      currencyCode: context.currency,
      paymentHandleToken: handle.paymentHandleToken,
      // Doc-verified: ACH/EFT require settleWithAuth true, and every SEPA/BACS
      // payload example shows it true. Manual capture was already rejected at
      // session creation, so this is unconditional.
      settleWithAuth: true,
      ...(context.merchantAccountId ? { accountId: context.merchantAccountId } : {}),
      ...(toPaysafeBillingDetails(billingDetails) ?? {}),
      ...(context.statementDescriptor
        ? { merchantDescriptor: { dynamicDescriptor: context.statementDescriptor } }
        : {}),
      ...(context.receiptEmail ? { profile: { email: context.receiptEmail } } : {}),
    });
    // The scheme mandate (SEPA/BACS) rides the payment's bank object — or, when
    // the payment echo omits it, the freshly minted handle's.
    return this.toPaymentInfo(payment, context.id, undefined, bankMandateReference(handle));
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

  /**
   * "Test connection" probe: one side-effect-free read against the Customer
   * Vault — look up an all-but-certainly-absent profile. This endpoint is an
   * object-or-404 point lookup, so authentication is settled BEFORE the resource
   * is resolved: only 401/403 means bad credentials, while every other status —
   * a 2xx match, the expected 404 "no such profile", or any business 4xx —
   * proves the credentials authenticated. Classified so a host UI can tell a
   * wrong key (`auth`) from a transient outage (`network`). It is a single call,
   * never retried (an auth rejection must not be replayed), and the credentials
   * never leak into the result.
   */
  async verifyCredentials(): Promise<VerifyCredentialsResult> {
    const probeCustomerId = `payfanout-verify-${crypto.randomUUID()}`;
    let status: number;
    try {
      status = await this.probeStatus(
        `/paymenthub/v1/customers?merchantCustomerId=${encodeURIComponent(probeCustomerId)}`,
      );
    } catch {
      // requestWithTimeout rejects only on a network failure or timeout.
      return { ok: false, category: "network", message: "Could not reach Paysafe — try again." };
    }
    if (status === 401 || status === 403) {
      return {
        ok: false,
        category: "auth",
        message: "Authentication failed — check the Paysafe username and password.",
      };
    }
    if (status === 429 || status >= 500) {
      return { ok: false, category: "network", message: "Could not reach Paysafe — try again." };
    }
    // Anything else — a 2xx match or the expected 404 for the absent probe id —
    // got past authentication to hit the account, so the credentials are valid.
    return { ok: true };
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
    fallbackMandateReference?: string,
  ): PaymentInfo {
    const methodDetails = toPaymentMethodDetails(payment.card);
    const mandateReference = bankMandateReference(payment) ?? fallbackMandateReference;
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
    const refunded = settlements.reduce((sum, s) => sum + settlementRefunded(s), 0);
    // amountCaptured is only claimed with a witness: settlements/derivation for
    // manual capture, or the settle-with-auth completion itself (full amount).
    let amountCaptured: number | undefined;
    // A settlement sum is only evidence of capture once the payment itself has
    // completed (or a void told us what was settled first) — a bank rail is
    // PROCESSING with a settlement attached long before any money has moved.
    if (settled > 0 && (completed || knownSettled !== undefined)) amountCaptured = settled;
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
      paymentMethodType: toUnifiedMethodType(payment.paymentType),
      ...(methodDetails ? { paymentMethodDetails: methodDetails } : {}),
      ...(mandateReference ? { mandateReference } : {}),
      createdAt: payment.txnTime ?? "1970-01-01T00:00:00.000Z",
      ...(amountCaptured !== undefined && amountCaptured > 0 && settlements[0]?.txnTime
        ? { capturedAt: settlements[0].txnTime }
        : {}),
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

  /**
   * One read-only exchange that returns the RAW HTTP status instead of mapping a
   * non-2xx into a PayFanoutError — verifyCredentials needs the status itself to
   * tell an auth rejection (401/403) apart from an outage (5xx/429). No retry
   * loop: a single probe is the contract. A network failure/timeout rejects.
   */
  private async probeStatus(path: string): Promise<number> {
    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    const { response } = await requestWithTimeout(
      {
        fetch: this.config.fetch ?? fetch,
        timeoutMs,
        onFailure: (_timedOut, cause) =>
          cause instanceof Error ? cause : new Error("Paysafe connectivity probe failed"),
      },
      `${this.baseUrl}${path}`,
      {
        method: "GET",
        headers: {
          authorization: `Basic ${utf8ToBase64(`${this.config.username}:${this.config.password}`)}`,
          "content-type": "application/json",
        },
      },
    );
    return response.status;
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

/** An absent paymentType means card: the vault and the card payment path both predate the field. */
function toUnifiedMethodType(paymentType: string | undefined): UnifiedPaymentMethodType {
  if (!paymentType) return "card";
  return PAYSAFE_TYPE_TO_UNIFIED[paymentType.toUpperCase()] ?? "other";
}

/**
 * SEPA/BACS payloads carry the scheme mandate on their bank object (webhook
 * examples show it on payments; the freshly minted handle is the
 * completion-time witness). ACH/EFT document no equivalent.
 */
function bankMandateReference(source: {
  sepa?: PaysafeBankAccountLike;
  bacs?: PaysafeBankAccountLike;
}): string | undefined {
  return source.sepa?.mandateReference ?? source.bacs?.mandateReference;
}

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

/** A settlement Paysafe has not finished moving — nothing has been refunded out of it yet. */
const IN_FLIGHT_SETTLEMENT_STATUSES = new Set(["INITIATED", "PENDING", "PROCESSING", "RECEIVED"]);

/**
 * How much of a settlement came back. `refundedAmount` is authoritative where the
 * API reports it; otherwise refunds are inferred from the drop in
 * availableToRefund. That inference only holds once the settlement has left the
 * flight: bank rails answer `availableToRefund: 0` on a perfectly healthy
 * PROCESSING settlement (it means "not refundable yet"), and subtracting that
 * would report an in-flight debit as fully refunded.
 */
function settlementRefunded(settlement: PaysafeSettlementLike): number {
  if (typeof settlement.refundedAmount === "number") return settlement.refundedAmount;
  if (IN_FLIGHT_SETTLEMENT_STATUSES.has((settlement.status ?? "").toUpperCase())) return 0;
  return Math.max(0, (settlement.amount ?? 0) - (settlement.availableToRefund ?? settlement.amount ?? 0));
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
 * Merge completion-time billingDetails over the session context's, field by field:
 * a completion field with a DEFINED value wins, but an explicit `undefined` leaves
 * the session's value intact — a host binding a maybe-empty form field to postalCode
 * would otherwise clobber the session zip and re-trigger the very 3004 this prevents.
 */
function mergeBillingDetails(
  base: PaysafeSessionContextV1["billingDetails"],
  override: PaysafeSessionContextV1["billingDetails"],
): PaysafeSessionContextV1["billingDetails"] {
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
