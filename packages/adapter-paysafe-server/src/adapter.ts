import {
  assertMinorUnitAmount,
  base64UrlToUtf8,
  classifyHttpFallback,
  getUserMessage,
  isPayFanoutError,
  lowercaseKeys,
  normalizeCurrency,
  normalizeSecrets,
  normalizeTime,
  PayFanoutError,
  requestWithTimeout,
  safeJson,
  utf8ToBase64,
  withTransportRetries,
  type AdapterCapabilities,
  type CancelNativeSubscriptionInput,
  type ChargeSavedPaymentMethodInput,
  type CompletePaymentInput,
  type CreateCustomerInput,
  type CreateNativeSubscriptionInput,
  type CreatePaymentSessionInput,
  type CustomerRef,
  type ListNativeSubscriptionsInput,
  type ListNativeSubscriptionsResult,
  type MinorUnitAmount,
  type NativeSubscriptionInterval,
  type NativeSubscriptionRecord,
  type NativeSubscriptionStatus,
  type PaymentInfo,
  type PaymentMethodCapability,
  type PaymentMethodDetails,
  type PaymentSession,
  type RefundInfo,
  type RefundRequest,
  type RefundResult,
  type RetrieveNativeSubscriptionInput,
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
   * Abort a hung Paysafe exchange after this many milliseconds (default
   * 60000, the response timeout of Paysafe's own SDKs, which warn that "some
   * requests may take longer to process"). The timer covers the whole
   * exchange including the response body read. A read that times out
   * surfaces as a retryable psp_unavailable; a write that times out may
   * still have been processed, so it is looked up by its merchantRefNum
   * instead (see maxNetworkRetries).
   *
   * The bound is per exchange, and one call can make several: a read takes
   * up to 1 + maxNetworkRetries attempts, a write up to 1 + maxNetworkRetries
   * attempts with up to three lookups after an unanswered or duplicate one,
   * and many calls read before they write (a card completion looks its key
   * up, a refund reads the payment and its settlements). If Paysafe hangs on
   * every exchange, a write can therefore take about
   * (1 + maxNetworkRetries) × 4 × requestTimeoutMs, plus
   * (1 + maxNetworkRetries) × requestTimeoutMs for each read before it:
   * minutes at the defaults. On a platform that ends requests after 25-30
   * seconds, lower this and maxNetworkRetries until a call fits, and replay
   * a call the platform ended with the same idempotencyKey: the replay reads
   * back what the ended call did.
   */
  requestTimeoutMs?: number;
  /**
   * How many times a call may be repeated after transport-level trouble,
   * with exponential backoff. Default 2. A GET is re-sent after a network
   * failure, timeout, HTTP 5xx or 429 (Paysafe's own SDKs retry GETs only).
   * A write is never re-sent blindly, because Paysafe rejects a reused
   * merchantRefNum (409/5031 under dupCheck) instead of answering with the
   * original. A 429 is re-sent after backoff: Paysafe refused it
   * unprocessed. After a timeout, network failure or 5xx the write is looked
   * up by its merchantRefNum and the original returned when Paysafe has it.
   * When it does not, a payment, capture or refund is not re-sent — the call
   * fails with a non-retryable processing_error, to retry later with the
   * same key — while a payment handle, verification or void, which move no
   * money, are. Business errors (declines, 3406 unbatched settlement,
   * validation) never repeat here.
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
  /** Numbers in the schema; Paysafe's response examples send strings ("10", "2025"). */
  cardExpiry?: { month?: number | string; year?: number | string };
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
  /**
   * A date-time string in the schema; Paysafe's payment examples send an
   * embedded settlement's as epoch milliseconds.
   */
  txnTime?: string | number;
}

/** Masked bank-account facts as Paysafe's sepa/bacs/ach/eft payload objects echo them. */
export interface PaysafeBankAccountLike {
  lastDigits?: string;
  accountHolderName?: string;
  bic?: string;
  sortCode?: string;
  routingNumber?: string;
  transitNumber?: string;
  institutionId?: string;
  mandateReference?: string;
  bankReference?: string;
}

export interface PaysafePaymentLike {
  id: string;
  merchantRefNum?: string;
  /** The handle the payment spent: how a replay tells its own payment from earlier attempts under the key. */
  paymentHandleToken?: string;
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
  amount?: number;
  currencyCode?: string;
  status?: string;
  /** "REDIRECT" when the customer must authenticate at the provider. */
  action?: string;
  paymentType?: string;
  sepa?: PaysafeBankAccountLike;
  bacs?: PaysafeBankAccountLike;
  ach?: PaysafeBankAccountLike;
  eft?: PaysafeBankAccountLike;
  /** Interac: the alias Paysafe collects from, echoed as the handle was minted (the spelling of Paysafe's examples). */
  interacEtransfer?: { consumerId?: string; type?: string };
  /** The same echo as the handle lookup's item schema spells it. */
  interacETransfer?: { consumerId?: string; type?: string };
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

/**
 * Plan as the Payment Scheduler API (subscriptionsplans/v1) reports it.
 * `amount` is integer minor units, exactly like the Payments API; the cadence
 * lives in billingCycle (frequency DAILY/MONTHLY/YEARLY, interval 1-365,
 * numberOfCycles 0 = infinite).
 */
export interface PaysafePlanLike {
  id?: string;
  name?: string;
  amount?: number;
  currencyCode?: string;
  billingCycle?: { frequency?: string; interval?: number; numberOfCycles?: number };
  status?: string;
}

/** One scheduled charge as paymentsInformation.nextPayment/previousPayment report it. */
export interface PaysafeScheduledPaymentLike {
  id?: string;
  amount?: number;
  scheduledTime?: string;
}

/**
 * Subscription as the Payment Scheduler API reports it. amount/currency ride
 * the nested plan (the subscription itself carries neither); plan,
 * customerProfile, and paymentsInformation are requestable sub-components.
 */
export interface PaysafeSubscriptionLike {
  id: string;
  merchantRefNum?: string;
  accountId?: string;
  /** The MULTI_USE token the scheduler charges each installment against. */
  paymentHandleToken?: string;
  status?: string;
  startTime?: string;
  creationTime?: string;
  paymentType?: string;
  plan?: PaysafePlanLike;
  customerProfile?: {
    id?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    locale?: string;
  };
  paymentsInformation?: {
    nextPayment?: PaysafeScheduledPaymentLike;
    previousPayment?: PaysafeScheduledPaymentLike;
  };
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

/**
 * The rails Paysafe does not refund: SEPA "Refunds | Not Supported", Bacs
 * "Refunds | NA". The ACH, EFT and Interac pages say nothing about refunds,
 * so those go to Paysafe, which decides.
 */
const NON_REFUNDABLE_RAILS: Record<string, string> = {
  SEPA: "SEPA Direct Debit",
  BACS: "Bacs Direct Debit",
};

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
 * Payment Scheduler path prefix. The scheduler lives beside the Payments API
 * on the same hosts (api.test.paysafe.com / api.paysafe.com) under its own
 * version root, and authenticates with the same Basic server-to-server API
 * key — the docs' "Back Office" is where that key is retrieved, not a
 * separate credential.
 */
const SCHEDULER_BASE = "/subscriptionsplans/v1";

/**
 * plan/customerProfile/paymentsInformation are requestable sub-components
 * (`fields`) and the spec never promises them by default — requested
 * explicitly on every read so amount/currency/period facts cannot silently
 * vanish behind a provider-side default.
 */
const SUBSCRIPTION_FIELDS = "fields=plan,customerProfile,paymentsInformation";

/** GET /subscriptions paging bounds per the scheduler spec: default 10, max 50. */
const SUBSCRIPTION_LIST_DEFAULT_LIMIT = 10;
const SUBSCRIPTION_LIST_MAX_LIMIT = 50;

/**
 * The scheduler bills DAILY/MONTHLY/YEARLY only — WEEKLY does not exist, so
 * interval "week" (like any RRULE schedule) is rejected, never approximated.
 */
const INTERVAL_TO_FREQUENCY: Partial<Record<NativeSubscriptionInterval, string>> = {
  day: "DAILY",
  month: "MONTHLY",
  year: "YEARLY",
};

const FREQUENCY_TO_INTERVAL: Record<string, NativeSubscriptionInterval> = {
  DAILY: "day",
  MONTHLY: "month",
  YEARLY: "year",
};

/**
 * Wire statuses -> unified: ACTIVE -> active, CANCELLED (double L, final) ->
 * canceled, SUSPENDED (reversible, no charges while suspended) -> paused,
 * COMPLETED (a finite schedule ran all its cycles) -> completed. Anything new
 * on the wire stays "unknown" — never dropped, never guessed.
 */
const SUBSCRIPTION_STATUS_MAP: Record<string, NativeSubscriptionStatus> = {
  ACTIVE: "active",
  CANCELLED: "canceled",
  SUSPENDED: "paused",
  COMPLETED: "completed",
};

function mapSubscriptionStatus(status: string | undefined): NativeSubscriptionStatus {
  return SUBSCRIPTION_STATUS_MAP[(status ?? "").toUpperCase()] ?? "unknown";
}

/** The scheduler cadence a create input resolves to: plan billingCycle terms. */
interface SchedulerCadence {
  frequency: string;
  interval: number;
}

function toSchedulerCadence(input: CreateNativeSubscriptionInput): SchedulerCadence {
  if (input.schedule !== undefined) {
    throw PayFanoutError.invalidRequest(
      "Paysafe's Payment Scheduler accepts no RRULE schedule — express the cadence as interval day/month/year",
    );
  }
  if (!input.interval) {
    throw PayFanoutError.invalidRequest(
      "createNativeSubscription requires a billing interval (day, month, or year)",
    );
  }
  const frequency = INTERVAL_TO_FREQUENCY[input.interval];
  if (!frequency) {
    throw PayFanoutError.invalidRequest(
      `Paysafe's Payment Scheduler bills daily, monthly, or yearly — interval "${input.interval}" cannot be expressed faithfully`,
    );
  }
  const interval = input.intervalCount ?? 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
    throw PayFanoutError.invalidRequest(
      `intervalCount must be an integer between 1 and 365 for Paysafe, got: ${String(input.intervalCount)}`,
    );
  }
  return { frequency, interval };
}

function resolveSubscriptionListLimit(limit: number | undefined): number {
  if (limit === undefined) return SUBSCRIPTION_LIST_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw PayFanoutError.invalidRequest(
      `listNativeSubscriptions limit must be a positive integer, got: ${String(limit)}`,
    );
  }
  // The PSP's own maximum wins — an oversized hint is clamped, not rejected.
  return Math.min(limit, SUBSCRIPTION_LIST_MAX_LIMIT);
}

/** The scheduler pages by offset; the opaque cursor is the next offset as a string. */
function parseSubscriptionCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d{1,9}$/.test(cursor)) {
    throw PayFanoutError.invalidRequest(
      `listNativeSubscriptions cursor is not one this adapter issued: ${cursor}`,
    );
  }
  return Number(cursor);
}

function isIsoParseable(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Epoch milliseconds a Paysafe time is read as: from 1973 (1e11) to the last instant a Date holds. */
const MIN_EPOCH_MS = 1e11;
const MAX_EPOCH_MS = 8.64e15;

/**
 * A Paysafe txnTime as ISO 8601, or undefined when it cannot be read. The
 * schema types every txnTime as a date-time string, but Paysafe's payment
 * examples send an embedded settlement's as epoch milliseconds
 * (1674814529000), so a number, or a string of digits, is read as that when
 * it lies between MIN_EPOCH_MS and MAX_EPOCH_MS. Epoch seconds, or a
 * digits-only date such as "20260704", fall below and are left out rather
 * than read as an instant in 1970.
 */
function paysafeTime(value: unknown): string | undefined {
  const epoch = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof epoch === "number") {
    return epoch >= MIN_EPOCH_MS && epoch <= MAX_EPOCH_MS ? new Date(epoch).toISOString() : undefined;
  }
  return isIsoParseable(epoch) ? normalizeTime(epoch) : undefined;
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

/** The response timeout of Paysafe's own SDKs. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Lookups page ("limit" defaults to 10, at most 50) in an undocumented
 * order, so each asks for the maximum and a full page is refused rather than
 * read as everything the key holds.
 */
const REF_NUM_LOOKUP_LIMIT = 50;

/**
 * Paysafe's lookup for each mutating endpoint: `GET /paymenthub/v1/<path>
 * ?merchantRefNum=` answers `{ <key>: [...] }` and covers the last 30 days
 * by default ("Default = 30 days before the endDate"). Replay recovery reads
 * originals back through these, because Paysafe answers a reused
 * merchantRefNum with a rejection, never with the original response. The
 * lookups are account-wide: a settlement, refund or void record names no
 * payment, so their keys must be unique across the account.
 */
const REF_NUM_LOOKUPS = {
  payment: { path: "payments", key: "payments", noun: "payment" },
  paymentHandle: { path: "paymenthandles", key: "paymentHandles", noun: "payment handle" },
  settlement: { path: "settlements", key: "settlements", noun: "settlement" },
  refund: { path: "refunds", key: "refunds", noun: "refund" },
  verification: { path: "verifications", key: "verifications", noun: "verification" },
  voidAuth: { path: "voidauths", key: "voidAuths", noun: "authorization void" },
} as const;

/** 409: "The transaction you have submitted has already been processed." — a reused merchantRefNum under dupCheck. */
const DUPLICATE_REF_NUM_CODE = "5031";
/** 402: "There is already another request being processed on the transaction referenced for this request." */
const IN_PROGRESS_CODE = "3417";
/** Answers that the request, or another one on its transaction, is already processed or in progress (3044: "You have submitted a duplicate request."). */
const REPLAY_CODES = new Set<string>([DUPLICATE_REF_NUM_CODE, "3044", IN_PROGRESS_CODE]);
/**
 * 400: the handle is no longer PAYABLE. A payments call spends a single-use
 * handle whatever its outcome, so this can also mean the call already ran.
 */
const HANDLE_NOT_PAYABLE_CODE = "5283";
/** "Entity not found": how a lookup may answer a merchantRefNum it has never seen. */
const NOT_FOUND_CODE = "5269";

/**
 * Reads of an original Paysafe reported as processed, or whose outcome is
 * unknown. The lookup can trail the write it indexes; the bound keeps an
 * unreadable original from stalling the call.
 */
const REPLAY_READ_ATTEMPTS = 3;

/**
 * The way out of a bank-debit key Paysafe refuses with nothing to read back:
 * its payment may still show, and when the portal shows no live payment, no
 * retry under that key gets past the refusal. A debit still in progress is
 * live: only failed or cancelled payments, or none, let a new key follow, and
 * only after a later retry, because the portal can trail the refused request.
 */
const RETRY_OR_START_AGAIN =
  "Retry later with the same idempotency key, which returns the payment once the lookup shows it. Start again " +
  "under a new idempotency key only once such a later retry still ends in this error and the Paysafe portal " +
  "shows every payment under that key as failed or cancelled, or none at all: a payment received, pending, " +
  "processing, held or completed there is live, and a new key would debit again";

/**
 * Paysafe's internal and gateway failures (the 500, 502 and 504 rows of its
 * error tables). A record filed with one of them failed for good, so reading
 * it back is a processing error, not a card decline.
 */
const INTERNAL_ERROR_CODES = new Set<string>([
  "1000", "1001", "1002", "1003", "1007", "1008", "1020", "1100",
  "3028", "3420", "3423", "3424", "3505", "5050", "9000",
]);

/**
 * What identifies the original of a replayed call: its merchantRefNum, plus
 * what the request carried. A record under the same merchantRefNum that
 * disagrees was made by a different request, and returning it would pass
 * another money movement off as this call's.
 */
interface ReplayKey {
  lookup: keyof typeof REF_NUM_LOOKUPS;
  merchantRefNum: string;
  amount?: number;
  currency?: string;
  paymentType?: string;
  /** The handle the request charges or verifies; a record made with another one is not this call's. */
  paymentHandleToken?: string;
  /**
   * The request spends a single-use handle (a card, Interac or bank-debit
   * completion). Records made with other handles under the key are then
   * earlier attempts rather than foreign requests: a failed one leaves the
   * key open to a new attempt, a live one is the key's payment. Without a
   * handle (a bank-debit key read before its handle exists) every record is
   * such an attempt.
   */
  singleUse?: boolean;
}

/** How one write finds and returns its original. */
interface ReplayableWrite<T> extends ReplayKey {
  /**
   * Payments, settlements and refunds are never re-sent while an attempt's
   * outcome is unknown: only Paysafe's duplicate check would stop a second
   * one, and Paysafe does not document that check for a request still in
   * flight. Their key held by a live record of another request is refused
   * outcomeUnknown (see differentRequest).
   */
  movesMoney?: boolean;
  /**
   * Look for the original before writing at all: for payment handles, which
   * the adapter mints without dupCheck, and for writes whose pre-read shows
   * the work already done.
   */
  lookupFirst?: boolean;
  /**
   * Also read back, patiently, after a business rejection: for endpoints
   * where a replay may hit a state check before the merchantRefNum check (a
   * replayed capture can exceed the remaining authorization first), or that
   * have no duplicate rejection at all (voidauths).
   */
  readBackOnRejection?: boolean;
  /**
   * A single-use spend sent with dupCheck: true. A duplicate or in-progress
   * rejection then says an earlier request under the key stands instead of
   * this one, so the key's live payment answers the call whichever handle it
   * spent. That request may also be a failed attempt older than the lookup
   * reaches, which only the Paysafe portal shows.
   */
  duplicateChecked?: boolean;
  /** Turns a record read back into this call's answer; may throw. Defaults to recordedFailure. */
  recovered?: (record: T) => T;
  /** Payment handles: which one the key minted to reuse; none mints a new one. */
  choose?: (records: T[]) => T | undefined;
}

/** The lookup-record fields a replay is checked against. */
interface RefNumRecord {
  merchantRefNum?: string;
  amount?: number;
  currencyCode?: string;
  paymentType?: string;
  paymentHandleToken?: string;
  status?: string;
  error?: { code?: string; message?: string };
}

/** What a lookup shows about a call's original. */
interface ReadBack<T> {
  /** This call's own record. */
  found?: T;
  /** Single-use spends: agreeing records made with another handle that did not fail — the key's payment. */
  live: T[];
  /** Single-use spends: earlier attempts under the key that failed. */
  failed: T[];
  /** The lookup itself failed, so the outcome stays unknown. */
  unreadable?: boolean;
}

/** POST /voidauths answer, and the `voidAuths` lookup record. */
interface PaysafeVoidAuthLike {
  id: string;
  merchantRefNum?: string;
  status?: string;
  amount?: number;
}

/** POST /refunds answer, and the `refunds` lookup record. */
interface PaysafeRefundLike {
  id: string;
  merchantRefNum?: string;
  status?: string;
  amount?: number;
  currencyCode?: string;
  error?: { code?: string; message?: string };
}

/**
 * POST /payments. `singleUse`: the handle is a Paysafe.js token, an Interac
 * handle or a bank-debit handle, which the call spends; saved-method charges
 * use a MULTI_USE token instead.
 */
function paymentWrite(
  merchantRefNum: string,
  amount: number,
  currency: string,
  paymentHandleToken: string | undefined,
  singleUse: boolean,
): ReplayableWrite<PaysafePaymentLike> {
  return {
    lookup: "payment",
    merchantRefNum,
    amount,
    currency,
    ...(paymentHandleToken !== undefined ? { paymentHandleToken } : {}),
    singleUse,
    movesMoney: true,
  };
}

/**
 * /paymenthandles accepts dupCheck (Paysafe's handle examples send it true
 * and false), but the adapter sends none: an attempt that follows a failed,
 * expired or spent handle under the same key needs a new handle, which a
 * duplicate check could refuse, and the schema gives the field no meaning
 * (only the EFT instrument defines it). A handle moves no money, so a
 * bank-debit replay is guarded at its payment instead. Nothing at Paysafe is
 * relied on to reject a second handle under one merchantRefNum, so the
 * handle a replay already minted is looked up first, and `choose` picks the
 * one to reuse.
 */
function handleWrite(
  merchantRefNum: string,
  amount: number,
  currency: string,
  paymentType: string,
  choose: (handles: PaysafePaymentHandleLike[]) => PaysafePaymentHandleLike | undefined,
): ReplayableWrite<PaysafePaymentHandleLike> {
  return { lookup: "paymentHandle", merchantRefNum, amount, currency, paymentType, lookupFirst: true, choose };
}

/**
 * Interac handle statuses a replayed session can still use, most advanced
 * first: spent by a payment, payable, authorized by the customer and
 * awaiting the provider, or a redirect still pending.
 */
const USABLE_INTERAC_HANDLE_STATUSES = ["COMPLETED", "PAYABLE", "PROCESSING", "INITIATED"];

/**
 * A replayed Interac session reuses the handle its first attempt minted for
 * the same customer email, the most advanced one when there are several. A
 * failed or expired handle is minted anew, and so is one minted for another
 * email: its redirect would collect from someone else's alias. Paysafe's
 * examples spell the echo interacEtransfer and the lookup's item schema
 * interacETransfer, so both are read, and either naming another alias rules
 * the handle out.
 */
function usableInteracHandle(
  handles: PaysafePaymentHandleLike[],
  consumerId: string,
): PaysafePaymentHandleLike | undefined {
  const same = handles.filter(
    (h) =>
      sameInteracConsumer(h.interacEtransfer?.consumerId, consumerId) &&
      sameInteracConsumer(h.interacETransfer?.consumerId, consumerId),
  );
  for (const status of USABLE_INTERAC_HANDLE_STATUSES) {
    const handle = same.find((h) => (h.status ?? "").toUpperCase() === status);
    if (handle) return handle;
  }
  return undefined;
}

/** An echo that states no alias cannot contradict; addresses compare trimmed and case-insensitively. */
function sameInteracConsumer(echo: string | undefined, consumerId: string): boolean {
  return echo === undefined || echo.trim().toLowerCase() === consumerId.trim().toLowerCase();
}

/** Where a handle echoes its bank object: the paymentType in lowercase, as sent. */
const BANK_ECHO_FIELDS = { SEPA: "sepa", ACH: "ach", BACS: "bacs", EFT: "eft" } as const;

/** The routing coordinates an echo may state, compared as sent. */
const BANK_ROUTING_FIELDS = ["routingNumber", "sortCode", "transitNumber", "institutionId", "bic"] as const;

/**
 * The handle an earlier attempt of a bank-debit completion minted and never
 * charged: PAYABLE, and minted from the same bank details as far as its
 * echo shows. A spent handle belongs to a payment the key lookup has
 * already accounted for, and one minted from other details would debit
 * another account.
 */
function reusableBankHandle(
  handles: PaysafePaymentHandleLike[],
  paymentType: BankDebitPaymentType,
  details: ParsedBankDetails,
): PaysafePaymentHandleLike | undefined {
  return handles.find(
    (h) => (h.status ?? "").toUpperCase() === "PAYABLE" && sameBankAccount(h[BANK_ECHO_FIELDS[paymentType]], details),
  );
}

/** Letters and digits only, uppercased: how account coordinates compare across formatting. */
function compactAccountValue(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

function normalizedHolder(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Nothing the handle's bank echo states contradicts the envelope: holder,
 * routing coordinates and last digits (Paysafe echoes `lastDigits`, never
 * the full number). An echo that states nothing cannot contradict.
 */
function sameBankAccount(echo: PaysafeBankAccountLike | undefined, details: ParsedBankDetails): boolean {
  if (!echo) return true;
  if (echo.accountHolderName !== undefined && normalizedHolder(echo.accountHolderName) !== normalizedHolder(details.accountHolderName)) {
    return false;
  }
  for (const field of BANK_ROUTING_FIELDS) {
    const stated = echo[field];
    const sent = details.bank[field];
    if (stated !== undefined && sent !== undefined && compactAccountValue(stated) !== compactAccountValue(sent)) {
      return false;
    }
  }
  const account = details.bank["accountNumber"] ?? details.bank["iban"];
  return !(
    echo.lastDigits !== undefined &&
    account !== undefined &&
    !compactAccountValue(account).endsWith(compactAccountValue(echo.lastDigits))
  );
}

/** A record agrees unless it states an amount, currency or type the request did not carry. */
function agreesWith(record: RefNumRecord, replay: ReplayKey): boolean {
  if (replay.amount !== undefined && typeof record.amount === "number" && record.amount !== replay.amount) {
    return false;
  }
  if (
    replay.currency !== undefined &&
    typeof record.currencyCode === "string" &&
    record.currencyCode.toUpperCase() !== replay.currency
  ) {
    return false;
  }
  return !(
    replay.paymentType !== undefined &&
    typeof record.paymentType === "string" &&
    record.paymentType.toUpperCase() !== replay.paymentType
  );
}

/** A record of an attempt that failed: Paysafe files a declined request together with its error. */
function isFailedRecord(record: RefNumRecord): boolean {
  if (record.error?.code) return true;
  const status = (record.status ?? "").toUpperCase();
  return status === "FAILED" || status === "ERROR";
}

/**
 * Voided, cancelled or expired: a payment, settlement or refund in one of
 * these moved no money, as the Payments API describes them. RETRY_OR_START_AGAIN
 * reads them that way too, and so do the settlement sums on a PaymentInfo and
 * the choice of the settlement a refund comes out of.
 */
const NO_MONEY_STATUSES = new Set(["CANCELLED", "EXPIRED"]);

/** A payment, settlement or refund record that failed, or otherwise moved no money. */
function movedNoMoney(record: RefNumRecord): boolean {
  return isFailedRecord(record) || NO_MONEY_STATUSES.has((record.status ?? "").toUpperCase());
}

/**
 * A spent handle under a bank-debit key that none of the key's failed
 * payments accounts for, so a payment the lookup may not show yet. Paysafe
 * marks a handle COMPLETED "regardless of the payments call response status",
 * and a failed payment that names no handle accounts for one spent handle.
 */
function hiddenSpend(
  handles: PaysafePaymentHandleLike[],
  failed: PaysafePaymentLike[],
): PaysafePaymentHandleLike | undefined {
  const charged = new Set(failed.map((p) => p.paymentHandleToken).filter((t) => t !== undefined));
  const unattributed = failed.filter((p) => p.paymentHandleToken === undefined).length;
  const spent = handles.filter(
    (h) => (h.status ?? "").toUpperCase() === "COMPLETED" && !charged.has(h.paymentHandleToken),
  );
  return spent[unattributed];
}

/**
 * A record Paysafe filed with its error is that failure, read back: a
 * declined payment stays a decline, never a pending payment. The record
 * carries no HTTP status, so its code and status decide: a mapped code maps
 * as its answer would have; an internal or gateway error, or status ERROR
 * (failed "for non-business reason", as Paysafe defines it), is a
 * processing error; anything else is a decline, Paysafe's 402. Never
 * retryable: replaying the call reads the same final record.
 */
function recordedFailure<T extends RefNumRecord>(record: T): T {
  const pspCode = record.error?.code;
  if (!pspCode) return record;
  const nonBusiness = INTERNAL_ERROR_CODES.has(pspCode) || (record.status ?? "").toUpperCase() === "ERROR";
  const code = paysafeCodeFor(pspCode) ?? (nonBusiness ? "processing_error" : "card_declined");
  throw new PayFanoutError({
    code,
    message: getUserMessage(code),
    retryable: false,
    raw: record,
    pspName: PAYSAFE_PSP_NAME,
  });
}

/** The Paysafe code on a mapped error: its `raw` is the Paysafe error body. */
function paysafeErrorCode(err: unknown): string | undefined {
  return (err as { raw?: { error?: { code?: string } } } | undefined)?.raw?.error?.code;
}

/** Timeout, network failure or 5xx: the write may or may not have been processed. */
function isOutcomeUnknown(err: unknown): boolean {
  return isPayFanoutError(err) && err.code === "psp_unavailable";
}

function isRateLimited(err: unknown): boolean {
  return isPayFanoutError(err) && err.code === "rate_limited";
}

/** A best-effort read inside recovery. */
async function orUndefined<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch {
    // The read failing proves nothing: the caller's original error stands.
    return undefined;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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
      supportsPaymentRetrieval: true, // GET /paymenthub/v1/payments/{id}
      supportsRefunds: true,
      supportsPartialRefunds: true,
      supportsRefundRetrieval: true, // GET /paymenthub/v1/refunds/{id}
      supportsManualCapture: true,
      // Settlements are partial-able: several captures (distinct idempotency
      // keys) can settle one authorization up to availableToSettle.
      supportsMultiCapture: true,
      modificationOutcome: "synchronous",
      supportsPaymentMethodVerification: true,
      // Customer Vault: single-use handles convert
      // to MULTI_USE tokens under a customer; charged with storedCredential.
      supportsSavedPaymentMethods: true,
      supportsSessionUpdate: true, // stateless re-issue: verify -> merge -> re-sign
      supportsEventPolling: false, // Paysafe exposes no public events-list API
      supportsListing: false, // /payments and /settlements query by merchantRefNum only
      // Payment Scheduler (subscriptionsplans/v1): the full surface — paged
      // list, retrieve, server-only create against a MULTI_USE token, and
      // cancel — behind the same Basic API key as the Payments API, so no
      // extra credential gates the flags.
      nativeSubscriptions: { list: true, retrieve: true, create: true, cancel: true },
      // base64(HMAC-SHA256(hmacKey, rawJsonBody)) over the delivered bytes.
      webhookSignatureScope: "raw-bytes",
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
    // A replayed session reuses the handle it minted instead of opening a second redirect.
    const minted = handleWrite(
      input.idempotencyKey,
      context.amount,
      context.currency,
      INTERAC_PAYMENT_TYPE,
      (handles) => usableInteracHandle(handles, consumerId),
    );
    const handle = await this.sendWrite(minted, "/paymenthub/v1/paymenthandles", {
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
    const replay = paymentWrite(input.idempotencyKey, context.amount, context.currency, paymentHandleToken, true);
    const earlier = await this.keyPayment(replay);
    if (earlier) return this.toPaymentInfo(earlier, context.id);
    const payment = await this.sendWrite(replay, "/paymenthub/v1/payments", {
      merchantRefNum: input.idempotencyKey,
      // The handle is single-use, so its own replay answers 5283 and is read
      // back: dupCheck would instead refuse a new card after a decline under
      // the same key. Paysafe's card payment examples send it false too.
      dupCheck: false,
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
   * the envelope's bank details, then charge it. Both carry the caller's
   * idempotencyKey as merchantRefNum, as Paysafe's own EFT examples do. A
   * payment the key already made answers a replayed completion before any
   * handle is touched; otherwise a handle an earlier attempt minted from the
   * same details and never charged is reused, and a new one is minted when
   * there is none. Attempts that each mint a handle slip past the
   * spent-handle refusal that guards a card replay, so while the key shows no
   * failed attempt the payment carries dupCheck: Paysafe refuses a later
   * payment under the key (5031), and the one it already holds answers the
   * call once the lookup shows it. Once a failed attempt shows, dupCheck
   * would refuse other bank details for 90 days, so the check is off: two
   * attempts sent together, or one resubmitted before the lookup shows the
   * other's payment or handle, can both be debited.
   */
  private async completeBankDebitPayment(
    context: PaysafeSessionContextV1,
    paymentType: BankDebitPaymentType,
    input: CompletePaymentInput,
  ): Promise<PaymentInfo> {
    const details = parseBankEnvelope(input.clientToken, paymentType);
    const billingDetails = mergeBillingDetails(context.billingDetails, input.billingDetails);
    const keyed = paymentWrite(input.idempotencyKey, context.amount, context.currency, undefined, true);
    const minted: ReplayableWrite<PaysafePaymentHandleLike> = {
      ...handleWrite(input.idempotencyKey, context.amount, context.currency, paymentType, (handles) =>
        reusableBankHandle(handles, paymentType, details),
      ),
      // bankDebitKey has read the handles already.
      lookupFirst: false,
    };
    const earlier = await this.bankDebitKey(keyed, minted);
    if (earlier.payment) return this.toPaymentInfo(earlier.payment, context.id);
    const handle =
      earlier.handle ??
      (await this.sendWrite(minted, "/paymenthub/v1/paymenthandles", {
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
      }));
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
    const dupCheck = earlier.failed.length === 0;
    const replay: ReplayableWrite<PaysafePaymentLike> = {
      ...paymentWrite(input.idempotencyKey, context.amount, context.currency, handle.paymentHandleToken, true),
      duplicateChecked: dupCheck,
    };
    const payment = await this.sendWrite(replay, "/paymenthub/v1/payments", {
      merchantRefNum: input.idempotencyKey,
      // The handle's use of the key does not count: Paysafe's EFT examples mint
      // the handle and send this payment under one merchantRefNum, dupCheck true.
      dupCheck,
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
    // the payment echo omits it, the handle's, but only for a payment that names
    // this handle: the key's earlier payment may answer instead, and a record
    // that names no handle cannot show which one it spent.
    const spentThisHandle = payment.paymentHandleToken === handle.paymentHandleToken;
    return this.toPaymentInfo(payment, context.id, undefined, spentThisHandle ? bankMandateReference(handle) : undefined);
  }

  /**
   * What a single-use completion's key already holds, read before anything
   * is sent: this handle's own record (a replay, and a decline stays that
   * decline), or a live payment another handle made under the key, which is
   * how a completion retried with a fresh tokenization, after the first one
   * went through, reads that first payment instead of charging again. Failed
   * attempts with other handles leave the key open to a new one.
   */
  private async keyPayment(replay: ReplayableWrite<PaysafePaymentLike>): Promise<PaysafePaymentLike | undefined> {
    const { found, live } = this.classify(await this.recordsByRefNum<PaysafePaymentLike>(replay, false), replay);
    return found ? recordedFailure(found) : live[0];
  }

  /**
   * keyPayment for a bank-debit completion, whose handle does not exist yet,
   * plus the key's handles: the uncharged one minted from the same bank
   * details is returned for reuse. A handle a payments call spent (Paysafe
   * marks it COMPLETED "regardless of the payments call response status")
   * with no payment of its own in the lookup is a payment the lookup does not
   * show yet, or an attempt Paysafe refused, whose call spent the handle all
   * the same. The payments are read again patiently, and the call ends rather
   * than debit again while no payment shows. A key holding another request's
   * handle is refused, with outcomeUnknown while such a spent handle is under
   * it. `failed` holds the key's failed attempts, which switch the duplicate
   * check off.
   */
  private async bankDebitKey(
    keyed: ReplayableWrite<PaysafePaymentLike>,
    minted: ReplayableWrite<PaysafePaymentHandleLike>,
  ): Promise<{ payment?: PaysafePaymentLike; handle?: PaysafePaymentHandleLike; failed: PaysafePaymentLike[] }> {
    let read = this.classify(await this.recordsByRefNum<PaysafePaymentLike>(keyed, false), keyed);
    if (read.live[0]) return { payment: read.live[0], failed: read.failed };
    const handles = await this.recordsByRefNum<PaysafePaymentHandleLike>(minted, false);
    const foreign = handles.filter((h) => !agreesWith(h, minted));
    if (foreign.length > 0) {
      throw this.differentRequest(minted, foreign, hiddenSpend(handles, read.failed) !== undefined);
    }
    for (let attempt = 1; ; attempt += 1) {
      const hidden = hiddenSpend(handles, read.failed);
      if (!hidden) break;
      if (attempt >= REPLAY_READ_ATTEMPTS) throw this.spentWithoutPayment(keyed, hidden);
      await this.backoff(attempt);
      read = await this.readBack<PaysafePaymentLike>(keyed);
      if (read.live[0]) return { payment: read.live[0], failed: read.failed };
    }
    const handle = minted.choose?.(handles);
    return handle ? { handle, failed: read.failed } : { failed: read.failed };
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
    // Nothing left to settle may be this very capture's work, replayed: its
    // settlement is looked up before a zero settlement is sent. "Capture
    // everything" leaves the amount unchecked — it was the remainder then.
    // The lookup is account-wide and settlements name no payment, so the key
    // must be unique across the account.
    const replay: ReplayableWrite<PaysafeSettlementLike> = {
      lookup: "settlement",
      merchantRefNum: idempotencyKey,
      amount,
      movesMoney: true,
      lookupFirst: captureAmount === 0,
      readBackOnRejection: true,
    };
    await this.sendWrite(replay, `/paymenthub/v1/payments/${encodeURIComponent(pspPaymentId)}/settlements`, {
      merchantRefNum: idempotencyKey, // one settlement per key: a replay is rejected (5031) and read back
      dupCheck: true,
      amount: captureAmount,
    });
    return this.retrievePayment(pspPaymentId);
  }

  /**
   * Voids the remaining authorization. This also works AFTER partial
   * settlements (multi-capture flows) — settled funds stay settled and the
   * returned PaymentInfo reports them (status "succeeded"), derived from the
   * amount the void released; only a payment with no settlements at all comes back
   * "canceled". Caller-keyed settlements are not rediscoverable statelessly,
   * so LATER retrievePayment calls lose that split once the void has consumed
   * availableToSettle (documented limitation).
   */
  async cancelPayment(pspPaymentId: string, idempotencyKey: string): Promise<PaymentInfo> {
    const payment = await this.fetchPayment(pspPaymentId);
    // Voidauths also require an explicit amount (full remaining authorization).
    const remaining = remainingToSettle(payment);
    // Voidauths take no dupCheck, so a replay is caught by lookup alone: an
    // authorization with nothing left to void may be this very void's work.
    // Void records name no payment either: the key must be unique across the
    // account. A void moves no money, so it is re-sent once a lookup after a
    // lost answer shows nothing.
    const replay: ReplayableWrite<PaysafeVoidAuthLike> = {
      lookup: "voidAuth",
      merchantRefNum: idempotencyKey,
      lookupFirst: remaining === 0,
      readBackOnRejection: true,
    };
    const voided = await this.sendWrite(replay, `/paymenthub/v1/payments/${encodeURIComponent(pspPaymentId)}/voidauths`, {
      merchantRefNum: idempotencyKey,
      amount: remaining,
    });
    const fresh = await this.fetchPayment(pspPaymentId);
    const settlements = fresh.settlements?.length ? fresh.settlements : await this.findSettlements(fresh);
    // Post-void the amount/availableToSettle derivation would count the voided
    // funds as settled — what the void released is the last stateless witness.
    const released = typeof voided.amount === "number" ? voided.amount : remaining;
    const settledBeforeVoid = Math.max(0, (payment.amount ?? 0) - released);
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

  /**
   * Paysafe refunds settle against a settlement, not the payment — resolved
   * here so callers keep one API. A SEPA or Bacs payment is refused once the
   * payment read shows its type, before anything else is sent: Paysafe
   * refunds neither rail.
   */
  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    if (req.amount !== undefined) assertMinorUnitAmount(req.amount, "refund amount");
    const payment = await this.fetchPayment(req.pspPaymentId);
    const rail = NON_REFUNDABLE_RAILS[(payment.paymentType ?? "").toUpperCase()];
    if (rail) {
      throw new PayFanoutError({
        code: "unsupported_operation",
        message: `Paysafe does not refund ${rail} payments — refund the customer by other means`,
        retryable: false,
        raw: payment,
        pspName: this.pspName,
      });
    }
    const settlements = payment.settlements?.length ? payment.settlements : await this.findSettlements(payment);
    // Refund records name no settlement or payment and the lookup is
    // account-wide, so the key must be unique across the account.
    const replay: ReplayableWrite<PaysafeRefundLike> = {
      lookup: "refund",
      merchantRefNum: req.idempotencyKey,
      amount: req.amount,
      currency: payment.currencyCode?.toUpperCase(),
      movesMoney: true,
      readBackOnRejection: true,
    };
    const settlement = settlements.find((s) => !movedNoMoney(s) && (s.availableToRefund ?? s.amount ?? 0) > 0);
    if (!settlement) {
      // Nothing left to refund may be this very refund's work, replayed:
      // answer with that refund instead of rejecting the replay.
      const earlier = await this.findReplayed<PaysafeRefundLike>(replay);
      if (earlier) {
        const refund = recordedFailure(earlier);
        return {
          refundId: refund.id,
          status: mapRefundStatus(refund.status),
          amount: refund.amount ?? req.amount ?? 0,
          raw: refund,
        };
      }
      throw PayFanoutError.invalidRequest(
        `Payment ${req.pspPaymentId} has no refundable settlement — either it is only authorized (cancel it ` +
          "instead), the sandbox settlement batch has not run yet, or it was captured with a custom " +
          "idempotency key PayFanout cannot rediscover statelessly",
        payment,
      );
    }
    const refund = await this.sendWrite(
      replay,
      `/paymenthub/v1/settlements/${encodeURIComponent(settlement.id)}/refunds`,
      {
        merchantRefNum: req.idempotencyKey,
        // One refund per key: a replay is rejected (5031) and read back.
        dupCheck: true,
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
    const createdAt = paysafeTime(refund.txnTime);
    return {
      refundId: refund.id,
      status: mapRefundStatus(refund.status),
      amount: refund.amount ?? 0,
      ...(refund.paymentId ? { pspPaymentId: refund.paymentId } : {}),
      ...(createdAt ? { createdAt } : {}),
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
    // Verification refNums must be unique per ATTEMPT: dupCheck defaults to
    // true here, so a replay answers 409/5031 and is read back. Verification
    // does not spend the handle, so no 5283 can stand in for it, and a
    // verification of another handle under the key is another request.
    const replay: ReplayableWrite<PaysafePaymentLike> = {
      lookup: "verification",
      merchantRefNum: input.idempotencyKey,
      currency: context.currency,
      paymentHandleToken: input.clientToken,
    };
    const verification = await this.sendWrite(replay, "/paymenthub/v1/verifications", {
      merchantRefNum: input.idempotencyKey,
      dupCheck: true,
      paymentHandleToken: input.clientToken,
      ...(context.merchantAccountId ? { accountId: context.merchantAccountId } : {}),
      currencyCode: context.currency,
    });
    return {
      id: context.id ?? verification.id,
      pspName: this.pspName,
      pspPaymentId: verification.id,
      status: mapVerificationStatus(verification.status),
      amount: 0,
      amountRefunded: 0,
      currency: context.currency,
      paymentMethodType: "card",
      createdAt: normalizeTime(paysafeTime(verification.txnTime)),
      raw: verification,
    };
  }

  // --- Customer Vault ------

  async createCustomer(input: CreateCustomerInput): Promise<CustomerRef> {
    const [firstName, ...rest] = (input.name ?? "").trim().split(/\s+/).filter(Boolean);
    const merchantCustomerId = input.id ?? input.idempotencyKey;
    const lookupPath = `/paymenthub/v1/customers?merchantCustomerId=${encodeURIComponent(merchantCustomerId)}`;
    type CustomerLike = { id: string; merchantCustomerId?: string; status?: string };
    let customer: CustomerLike;
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
      if (isDuplicateCustomerError(err)) {
        customer = await this.request("GET", lookupPath);
      } else {
        // A lost answer may hide a created profile: look it up by its unique
        // key before surfacing the failure.
        const created = isOutcomeUnknown(err)
          ? await orUndefined(this.requestOnce<CustomerLike>("GET", lookupPath))
          : undefined;
        if (!created) throw err;
        customer = created;
      }
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
      // A lost answer may hide a vaulted handle: vault handles carry the
      // merchantRefNum they were created under.
      if (isOutcomeUnknown(err)) {
        const handles = (await orUndefined(this.storedHandles(input.pspCustomerId, true))) ?? [];
        const vaulted = handles.find(
          (h) => h.merchantRefNum === input.idempotencyKey && (h.status ?? "PAYABLE") === "PAYABLE",
        );
        if (vaulted) return toStoredMethod(this.pspName, input.pspCustomerId, vaulted);
      }
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
    try {
      await this.request(
        "DELETE",
        `/paymenthub/v1/customers/${encodeURIComponent(pspCustomerId)}/paymenthandles/${encodeURIComponent(match.id)}`,
      );
    } catch (err) {
      // A lost answer may hide a completed delete: a token gone from the vault is deleted.
      if (!isOutcomeUnknown(err)) throw err;
      const left = await orUndefined(this.storedHandles(pspCustomerId, true));
      if (!left || left.some((h) => h.paymentHandleToken === token)) throw err;
    }
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
    const replay = paymentWrite(input.idempotencyKey, input.amount, currency, input.savedPaymentMethodToken, false);
    const payment = await this.sendWrite(replay, "/paymenthub/v1/payments", {
      merchantRefNum: input.idempotencyKey,
      // A MULTI_USE token is never spent, so no 5283 guards it: without
      // dupCheck nothing would stop a replay from charging it twice.
      dupCheck: true,
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

  /**
   * GET /customers/{id}?fields=paymenthandles — the collection route itself
   * 405s. `once` skips transport retries for reads inside replay recovery.
   */
  private async storedHandles(pspCustomerId: string, once = false): Promise<PaysafeStoredHandleLike[]> {
    const path = `/paymenthub/v1/customers/${encodeURIComponent(pspCustomerId)}?fields=paymenthandles`;
    type CustomerWithHandles = { id: string; paymentHandles?: PaysafeStoredHandleLike[] };
    const customer = once
      ? await this.requestOnce<CustomerWithHandles>("GET", path)
      : await this.request<CustomerWithHandles>("GET", path);
    return customer.paymentHandles ?? [];
  }

  // --- PSP-native subscriptions (Payment Scheduler) ------

  /**
   * Pages the Payment Scheduler's subscriptions as unified records. The
   * scheduler paginates by offset (limit default 10, max 50); the opaque
   * cursor is the next offset. A full page always yields a nextCursor — the
   * follow-up page comes back empty with none — because the spec does not pin
   * whether meta.numberOfRecords counts the total or the page, and a wrong
   * guess would either drop records or never terminate.
   */
  async listNativeSubscriptions(
    input?: ListNativeSubscriptionsInput,
  ): Promise<ListNativeSubscriptionsResult> {
    const limit = resolveSubscriptionListLimit(input?.limit);
    const offset = parseSubscriptionCursor(input?.cursor);
    const result = await this.request<{ subscriptions?: PaysafeSubscriptionLike[] }>(
      "GET",
      `${SCHEDULER_BASE}/subscriptions?limit=${limit}&offset=${offset}&${SUBSCRIPTION_FIELDS}`,
    );
    const records = result.subscriptions ?? [];
    return {
      subscriptions: records.map((s) => this.toNativeSubscription(s)),
      ...(records.length === limit ? { nextCursor: String(offset + records.length) } : {}),
    };
  }

  /** GET /subscriptions/{id}. Paysafe keys by id alone — savedPaymentMethodToken is not needed. */
  async retrieveNativeSubscription(
    input: RetrieveNativeSubscriptionInput,
  ): Promise<NativeSubscriptionRecord> {
    if (!input.subscriptionId) {
      throw PayFanoutError.invalidRequest("retrieveNativeSubscription requires subscriptionId");
    }
    return this.toNativeSubscription(await this.fetchSubscription(input.subscriptionId));
  }

  /**
   * Creates a subscription the scheduler bills itself, against an
   * already-vaulted MULTI_USE token (savePaymentMethod's output — a
   * single-use Paysafe.js token is rejected by the scheduler). Subscriptions
   * attach to a PLAN: pass `planId` to bill from a host-managed plan (the
   * input amount/currency/cadence must match it — the adapter verifies and
   * rejects a mismatch rather than silently billing something else), or omit
   * it and the adapter creates a dedicated open-ended plan
   * (numberOfCycles 0 = infinite) from the input inline.
   *
   * Idempotency: `merchantRefNum` is the scheduler's dedupe field ("unique
   * for this accountId") and doubles as the lookup key, so input.merchantRefNum
   * wins when supplied — passing it transfers the idempotency duty to it —
   * and idempotencyKey fills it otherwise. A replayed create, or one whose
   * answer was lost, recovers the existing subscription by that refNum
   * instead of failing; neither POST is re-sent after a timeout or 5xx. The
   * inline PLAN has no refNum channel, so a creation retried after a lost
   * answer can leave an orphan plan behind; the subscription itself stays
   * exactly-once, so no double billing can result.
   *
   * `pspCustomerId` and `metadata` have no scheduler channel and are
   * withheld: the customer profile derives from the vaulted token, and the
   * subscription object carries no metadata field.
   */
  async createNativeSubscription(
    input: CreateNativeSubscriptionInput,
  ): Promise<NativeSubscriptionRecord> {
    assertMinorUnitAmount(input.amount, "amount");
    if (input.amount < 1) {
      throw PayFanoutError.invalidRequest("Paysafe subscription installments must be at least 1 minor unit");
    }
    const currency = normalizeCurrency(input.currency);
    if (!input.savedPaymentMethodToken) {
      throw PayFanoutError.invalidRequest(
        "createNativeSubscription requires savedPaymentMethodToken — the MULTI_USE token savePaymentMethod returned",
      );
    }
    const cadence = toSchedulerCadence(input);
    const merchantRefNum = input.merchantRefNum ?? input.idempotencyKey;
    const accountId = this.config.merchantAccountResolver(currency, undefined) || undefined;
    const plan = input.planId
      ? await this.validatedPlan(input.planId, input.amount, currency, cadence)
      : await this.request<PaysafePlanLike>("POST", `${SCHEDULER_BASE}/plans`, {
          // Plan names are 4-50 chars; the refNum keeps the plan traceable to
          // its subscription in the Paysafe portal.
          name: `payfanout-${merchantRefNum}`.slice(0, 50),
          amount: input.amount,
          currencyCode: currency,
          billingCycle: {
            frequency: cadence.frequency,
            interval: cadence.interval,
            numberOfCycles: 0,
          },
          // Subscriptions attach to ACTIVE plans only (plans default INITIAL).
          status: "ACTIVE",
        });
    const planId = input.planId ?? plan.id;
    if (!planId) {
      throw new PayFanoutError({
        code: "processing_error",
        message: "Paysafe returned a subscription plan without an id",
        retryable: false,
        raw: plan,
        pspName: this.pspName,
      });
    }
    try {
      const created = await this.request<PaysafeSubscriptionLike>(
        "POST",
        `${SCHEDULER_BASE}/plans/${encodeURIComponent(planId)}/subscriptions`,
        {
          merchantRefNum,
          paymentHandleToken: input.savedPaymentMethodToken,
          status: "ACTIVE",
          ...(accountId ? { accountId } : {}),
          // The scheduler bills from "now" when startTime is omitted and
          // rejects instants in the past.
          ...(input.startAt ? { startTime: input.startAt } : {}),
        },
      );
      return this.toNativeSubscription(created, plan);
    } catch (err) {
      if (!(err instanceof PayFanoutError)) throw err;
      // merchantRefNum is "unique for this accountId": whatever shape the
      // rejection takes, an existing subscription under this refNum means the
      // create already happened — return it instead of failing the replay.
      const existing = await this.findSubscriptionByRefNum(merchantRefNum);
      if (existing) return this.toNativeSubscription(existing, plan);
      throw err;
    }
  }

  /**
   * PATCH /subscriptions/{id} to CANCELLED — the FINAL status ("cannot be
   * re-activated"); SUSPENDED is the reversible pause and is deliberately not
   * used here. Verified-idempotent: the scheduler does not document patching
   * an already-terminal subscription, so on any rejection the adapter
   * re-fetches and treats CANCELLED/COMPLETED as success — billing that is
   * already stopped can never fail a replayed cancel. The PATCH carries no
   * merchantRefNum (the scheduler has none there); replay safety comes from
   * CANCELLED being absorbing plus that re-fetch, which is why the required
   * idempotencyKey has no wire mapping on this call.
   */
  async cancelNativeSubscription(
    input: CancelNativeSubscriptionInput,
  ): Promise<NativeSubscriptionRecord> {
    if (!input.subscriptionId) {
      throw PayFanoutError.invalidRequest("cancelNativeSubscription requires subscriptionId");
    }
    try {
      const patched = await this.request<PaysafeSubscriptionLike>(
        "PATCH",
        `${SCHEDULER_BASE}/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
        { status: "CANCELLED" },
      );
      if (patched.plan) return this.toNativeSubscription(patched);
      // PATCH takes no `fields`, so its response is not guaranteed to carry
      // the plan sub-component — re-read so the canceled record still reports
      // its money facts, and fall back to the PATCH echo if that read fails
      // (the cancellation itself already succeeded).
      try {
        return this.toNativeSubscription(await this.fetchSubscription(input.subscriptionId));
      } catch {
        return this.toNativeSubscription(patched);
      }
    } catch (err) {
      if (!(err instanceof PayFanoutError)) throw err;
      let current: PaysafeSubscriptionLike;
      try {
        current = await this.fetchSubscription(input.subscriptionId);
      } catch {
        // The re-fetch failing adds nothing — the PATCH rejection is the fact.
        throw err;
      }
      const record = this.toNativeSubscription(current);
      if (record.status === "canceled" || record.status === "completed") return record;
      throw err;
    }
  }

  private fetchSubscription(subscriptionId: string): Promise<PaysafeSubscriptionLike> {
    return this.request<PaysafeSubscriptionLike>(
      "GET",
      `${SCHEDULER_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}?${SUBSCRIPTION_FIELDS}`,
    );
  }

  /**
   * The create-with-planId guard: the host stated an amount/currency/cadence,
   * and the plan is what actually bills — a mismatch must reject before a
   * subscription exists, never bill silently different terms.
   */
  private async validatedPlan(
    planId: string,
    amount: MinorUnitAmount,
    currency: string,
    cadence: SchedulerCadence,
  ): Promise<PaysafePlanLike> {
    const plan = await this.request<PaysafePlanLike>(
      "GET",
      `${SCHEDULER_BASE}/plans/${encodeURIComponent(planId)}`,
    );
    const mismatches: string[] = [];
    if (plan.amount !== amount) {
      mismatches.push(`amount (plan bills ${String(plan.amount)}, input says ${amount})`);
    }
    if ((plan.currencyCode ?? "").toUpperCase() !== currency) {
      mismatches.push(`currency (plan bills ${String(plan.currencyCode)}, input says ${currency})`);
    }
    const planFrequency = (plan.billingCycle?.frequency ?? "").toUpperCase();
    const planInterval = plan.billingCycle?.interval ?? 1;
    if (planFrequency !== cadence.frequency || planInterval !== cadence.interval) {
      mismatches.push(
        `cadence (plan bills every ${planInterval} ${planFrequency || "unknown"}, input says every ${cadence.interval} ${cadence.frequency})`,
      );
    }
    if (mismatches.length > 0) {
      throw PayFanoutError.invalidRequest(
        `Plan ${planId} does not match the requested subscription: ${mismatches.join("; ")}`,
        plan,
      );
    }
    return plan;
  }

  /** Replay recovery: the scheduler's list endpoint looks subscriptions up by refNum. */
  private async findSubscriptionByRefNum(
    merchantRefNum: string,
  ): Promise<PaysafeSubscriptionLike | undefined> {
    try {
      const result = await this.request<{ subscriptions?: PaysafeSubscriptionLike[] }>(
        "GET",
        `${SCHEDULER_BASE}/subscriptions?merchantRefNum=${encodeURIComponent(merchantRefNum)}&${SUBSCRIPTION_FIELDS}`,
      );
      const matches = result.subscriptions ?? [];
      return matches.length === 1 ? matches[0] : undefined;
    } catch {
      // Recovery is best-effort; the caller rethrows the original rejection.
      return undefined;
    }
  }

  /**
   * amount/currency come from the nested plan — the scheduler's own statement
   * of the next charge wins where present, since it reflects
   * discount/quantity adjustments the plan amount does not. The period bounds
   * are the previous and next scheduled charges.
   */
  private toNativeSubscription(
    sub: PaysafeSubscriptionLike,
    fallbackPlan?: PaysafePlanLike,
  ): NativeSubscriptionRecord {
    const plan = sub.plan ?? fallbackPlan;
    const interval = FREQUENCY_TO_INTERVAL[(plan?.billingCycle?.frequency ?? "").toUpperCase()];
    const planInterval = plan?.billingCycle?.interval;
    const intervalCount =
      typeof planInterval === "number" && Number.isInteger(planInterval) && planInterval >= 1
        ? planInterval
        : undefined;
    const nextPayment = sub.paymentsInformation?.nextPayment;
    const previousPayment = sub.paymentsInformation?.previousPayment;
    const periodStart = previousPayment?.scheduledTime;
    const periodEnd = nextPayment?.scheduledTime;
    const profile = sub.customerProfile;
    const customer = {
      ...(profile?.email ? { email: profile.email } : {}),
      ...(profile?.firstName ? { firstName: profile.firstName } : {}),
      ...(profile?.lastName ? { lastName: profile.lastName } : {}),
      ...(profile?.phone ? { phone: profile.phone } : {}),
      ...(profile?.locale ? { locale: profile.locale } : {}),
    };
    return {
      id: sub.id,
      pspName: this.pspName,
      status: mapSubscriptionStatus(sub.status),
      amount: nextPayment?.amount ?? plan?.amount ?? 0,
      currency: (plan?.currencyCode ?? "").toUpperCase() || "USD",
      // An unrecognized frequency yields NO interval (absent = "no faithful
      // projection"), and intervalCount only rides along with one.
      ...(interval ? { interval } : {}),
      ...(interval && intervalCount !== undefined ? { intervalCount } : {}),
      ...(isIsoParseable(periodStart) ? { currentPeriodStart: periodStart } : {}),
      ...(isIsoParseable(periodEnd) ? { currentPeriodEnd: periodEnd } : {}),
      ...(sub.paymentHandleToken ? { savedPaymentMethodToken: sub.paymentHandleToken } : {}),
      ...(profile?.id ? { pspCustomerId: profile.id } : {}),
      ...(Object.keys(customer).length > 0 ? { customer } : {}),
      ...(sub.merchantRefNum ? { merchantRefNum: sub.merchantRefNum } : {}),
      ...(plan?.id ? { planId: plan.id } : {}),
      raw: sub,
    };
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
    const settlements = (payment.settlements ?? []).filter((s) => !movedNoMoney(s));
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
    const capturedAt =
      amountCaptured !== undefined && amountCaptured > 0 ? paysafeTime(settlements[0]?.txnTime) : undefined;
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
      createdAt: normalizeTime(paysafeTime(payment.txnTime)),
      ...(capturedAt ? { capturedAt } : {}),
      raw: payment,
    };
  }

  private isKnownMethodType(type: string): boolean {
    return (this.config.paymentMethods ?? DEFAULT_METHODS).some((m) => m.type === type);
  }

  /**
   * Transport with timeout. A GET is replayed on transport trouble (network,
   * timeout, 5xx, 429), as Paysafe's own SDKs do — they retry GETs only. A
   * write is re-sent here only after a 429, which Paysafe refuses unprocessed;
   * any other failure of a write is resolved by lookup (sendWrite) or by its
   * caller, never by a blind re-send. Business errors never repeat — core's
   * isTransportRetryable deliberately ignores `error.retryable` (3406,
   * unbatched settlement, is retryable *hours* later, not milliseconds).
   */
  private request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    return withTransportRetries(() => this.requestOnce<T>(method, path, body), {
      attempts: this.transportAttempts(),
      sleep: this.config.sleep,
      ...(method === "GET" ? {} : { isRetryable: isRateLimited }),
    });
  }

  /**
   * Sends a Paysafe write so that no replay can move money twice. Paysafe
   * rejects a reused merchantRefNum under dupCheck (409/5031, or 402/3044 "You
   * have submitted a duplicate request.") rather than answering with the
   * original, may refuse a request while another one on its transaction is in
   * progress (402/3417), and a payments call spends a single-use handle
   * whatever its outcome (5283 afterwards). Each of those is answered with the
   * original read back by merchantRefNum. After a timeout, network failure or
   * 5xx the original is looked up the same way, and only a write that moves
   * no money is re-sent when nothing is found. A 429 is re-sent after backoff
   * with no lookup: Paysafe refused it unprocessed. Re-sends share the
   * maxNetworkRetries budget. Once an attempt's outcome is unknown, no later
   * answer (a rejection, or a 429 when the budget runs out) is taken for the
   * whole story: the original is looked for, and without it the call ends as
   * "retry later with the same key".
   */
  private async sendWrite<T extends RefNumRecord>(
    write: ReplayableWrite<T>,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const recovered = write.recovered ?? recordedFailure;
    if (write.lookupFirst) {
      const earlier = await this.findReplayed<T>(write);
      if (earlier) return recovered(earlier);
    }
    let resends = 0;
    let outcomeUnknown = false;
    for (;;) {
      // requestOnce only ever rejects with a mapped PayFanoutError.
      let failure: unknown;
      try {
        return await this.requestOnce<T>("POST", path, body);
      } catch (err) {
        failure = err;
      }
      const pspCode = paysafeErrorCode(failure);
      if (
        pspCode !== undefined &&
        (REPLAY_CODES.has(pspCode) || (write.singleUse === true && pspCode === HANDLE_NOT_PAYABLE_CODE))
      ) {
        const takeLive = write.duplicateChecked === true && REPLAY_CODES.has(pspCode);
        const original = await this.readBackPatiently<T>(write, takeLive);
        if (original) return recovered(original);
        const cause = (failure as PayFanoutError).raw;
        throw takeLive && pspCode !== IN_PROGRESS_CODE
          ? this.refusedDuplicate(write, cause)
          : this.unreadableOriginal(write, pspCode, cause);
      }
      if (isOutcomeUnknown(failure)) {
        outcomeUnknown = true;
        if (write.movesMoney) return this.settleUnknownOutcome(write, failure, recovered);
        const read = await this.readBack<T>(write);
        if (read.found) return recovered(read.found);
        if (read.unreadable || resends >= this.maxResends()) throw failure;
      } else if (isRateLimited(failure)) {
        if (resends >= this.maxResends()) {
          if (outcomeUnknown) return this.settleUnknownOutcome(write, failure, recovered);
          throw failure;
        }
      } else {
        // An earlier attempt whose outcome is unknown may be what this rejection is about.
        if (outcomeUnknown) return this.settleUnknownOutcome(write, failure, recovered);
        if (write.readBackOnRejection) {
          const original = await this.readBackPatiently<T>(write);
          if (original) return recovered(original);
        }
        throw failure;
      }
      resends += 1;
      await this.backoff(resends);
    }
  }

  /**
   * An attempt of this call may have been processed and nothing says whether
   * it was: only the lookup can tell, and without the original the call ends
   * instead of repeating the write. Only this call's own record settles it:
   * a payment another handle made under the key does not say whether this
   * one was processed too.
   */
  private async settleUnknownOutcome<T extends RefNumRecord>(
    write: ReplayableWrite<T>,
    failure: unknown,
    recovered: (record: T) => T,
  ): Promise<T> {
    const original = await this.readBackPatiently<T>(write);
    if (original) return recovered(original);
    throw this.unknownOutcome(write, (failure as PayFanoutError).raw);
  }

  /** A replayed call's original, read with the usual GET retries. */
  private async findReplayed<T extends RefNumRecord>(write: ReplayableWrite<T>): Promise<T | undefined> {
    return this.classify(await this.recordsByRefNum<T>(write, false), write).found;
  }

  /**
   * One lookup of what an earlier attempt may have created, without
   * transport retries: recovery bounds its own reads. `unreadable` means the
   * lookup itself failed, so the outcome stays unknown.
   */
  private async readBack<T extends RefNumRecord>(write: ReplayableWrite<T>): Promise<ReadBack<T>> {
    let records: T[];
    try {
      records = await this.recordsByRefNum<T>(write, true);
    } catch {
      return { live: [], failed: [], unreadable: true };
    }
    return this.classify(records, write);
  }

  /**
   * The lookup can trail the write it indexes, so an original is read up to
   * three times. `takeLive` also takes the key's live payment made with
   * another handle.
   */
  private async readBackPatiently<T extends RefNumRecord>(
    write: ReplayableWrite<T>,
    takeLive = false,
  ): Promise<T | undefined> {
    for (let read = 1; ; read += 1) {
      const { found, live } = await this.readBack<T>(write);
      const original = found ?? (takeLive ? live[0] : undefined);
      if (original !== undefined || read >= REPLAY_READ_ATTEMPTS) return original;
      await this.backoff(read);
    }
  }

  private async recordsByRefNum<T extends RefNumRecord>(replay: ReplayKey, once: boolean): Promise<T[]> {
    const { path, key } = REF_NUM_LOOKUPS[replay.lookup];
    const url = `/paymenthub/v1/${path}?merchantRefNum=${encodeURIComponent(replay.merchantRefNum)}&limit=${REF_NUM_LOOKUP_LIMIT}`;
    let result: Record<string, unknown> | undefined;
    try {
      result = once
        ? await this.requestOnce<Record<string, unknown> | undefined>("GET", url)
        : await this.request<Record<string, unknown> | undefined>("GET", url);
    } catch (err) {
      if (paysafeErrorCode(err) === NOT_FOUND_CODE) return [];
      throw err;
    }
    const records = result?.[key];
    if (!Array.isArray(records)) return [];
    if (records.length >= REF_NUM_LOOKUP_LIMIT) throw this.fullLookupPage(replay);
    // Only records filed under this very merchantRefNum can be this call's.
    return records.filter(
      (record): record is T =>
        typeof record === "object" &&
        record !== null &&
        ((record as RefNumRecord).merchantRefNum ?? replay.merchantRefNum) === replay.merchantRefNum,
    );
  }

  /**
   * Sorts the records filed under a call's merchantRefNum. The call's own
   * record agrees with the request and was made with its handle; several
   * cannot be told apart. A record that disagrees means the key was reused
   * for a different request. For a single-use spend, a record made with
   * another handle is an earlier attempt instead: a failed one, or a live one
   * that is the key's payment. A record that omits its handle is taken as
   * the call's own, except a failed one on a single-use spend: Paysafe's
   * decline example names no handle, so such a failure is taken as an
   * earlier attempt's and never as this call's answer.
   */
  private classify<T extends RefNumRecord>(records: T[], write: ReplayableWrite<T>): ReadBack<T> {
    const mine: T[] = [];
    const live: T[] = [];
    const failed: T[] = [];
    const foreign: T[] = [];
    for (const record of records) {
      const own =
        write.paymentHandleToken === undefined
          ? write.singleUse !== true
          : record.paymentHandleToken === write.paymentHandleToken ||
            // A failure that names no handle (Paysafe's decline example) cannot be
            // this spend's own: it is an earlier attempt's, never this card's answer.
            (record.paymentHandleToken === undefined && !(write.singleUse === true && isFailedRecord(record)));
      if (!own && write.singleUse && isFailedRecord(record)) failed.push(record);
      else if (!agreesWith(record, write)) foreign.push(record);
      else if (own) mine.push(record);
      else if (write.singleUse) live.push(record);
      else foreign.push(record);
    }
    if (write.choose) {
      if (foreign.length > 0) throw this.differentRequest(write, foreign);
      const found = write.choose(mine);
      return found ? { found, live, failed } : { live, failed };
    }
    if (mine.length > 1) throw this.severalRecords(write, mine);
    if (mine.length === 1) return { found: mine[0], live, failed };
    if (foreign.length > 0) throw this.differentRequest(write, foreign);
    if (live.length > 1) throw this.severalRecords(write, live);
    return { live, failed };
  }

  /**
   * A key another request holds. On a payment, settlement or refund, a record
   * under it that may have moved money (not failed, voided, cancelled or
   * expired) may be the money this call was meant to move (the same renewal
   * sent by an overlapping run with a card set meanwhile, say): the refusal
   * then carries outcomeUnknown, so no new key follows until that record is
   * known to be another one. `hiddenPayment` marks a bank-debit key holding a
   * spent handle whose payment the lookup does not show (see hiddenSpend).
   */
  private differentRequest<T>(
    write: ReplayableWrite<T>,
    foreign: RefNumRecord[],
    hiddenPayment = false,
  ): PayFanoutError {
    const { noun } = REF_NUM_LOOKUPS[write.lookup];
    const live = write.movesMoney === true && foreign.some((record) => !movedNoMoney(record));
    const refused =
      `merchantRefNum "${write.merchantRefNum}" already belongs to a different Paysafe ${noun} ` +
      "(amount, currency, type or payment handle differ)";
    return new PayFanoutError({
      code: "invalid_request",
      message: hiddenPayment
        ? `${refused}, and a payment handle under it is spent while no payment made with it shows in the ` +
          "lookup: that payment may be the one this request was meant to make, so use a new idempotency key " +
          "only once it is known to be another one"
        : live
          ? `${refused} that has not failed: it may be the ${noun} this request was meant to make, so use a new ` +
            `idempotency key only once that ${noun} is known to be another one`
          : `${refused} — every new request needs its own idempotency key`,
      retryable: false,
      outcomeUnknown: live || hiddenPayment,
      raw: {
        merchantRefNum: write.merchantRefNum,
        expected: { amount: write.amount, currency: write.currency, paymentType: write.paymentType },
        found: foreign,
      },
      pspName: this.pspName,
    });
  }

  /** A key holding a full lookup page may hold more than this call can see. */
  private fullLookupPage(replay: ReplayKey): PayFanoutError {
    const { noun } = REF_NUM_LOOKUPS[replay.lookup];
    return new PayFanoutError({
      code: "processing_error",
      message:
        `Paysafe holds at least ${REF_NUM_LOOKUP_LIMIT} ${noun} records under merchantRefNum ` +
        `"${replay.merchantRefNum}", more than one lookup reads — reconcile them in the Paysafe portal, and start ` +
        "over under a new key only once every one of them has failed or been cancelled",
      retryable: false,
      outcomeUnknown: true,
      raw: { merchantRefNum: replay.merchantRefNum },
      pspName: this.pspName,
    });
  }

  private severalRecords(replay: ReplayKey, records: RefNumRecord[]): PayFanoutError {
    const { noun } = REF_NUM_LOOKUPS[replay.lookup];
    return new PayFanoutError({
      code: "processing_error",
      message:
        `Paysafe holds ${records.length} ${noun}s under merchantRefNum "${replay.merchantRefNum}", so this ` +
        "call cannot tell which one it produced — reconcile them in the Paysafe portal",
      retryable: false,
      outcomeUnknown: true,
      raw: records,
      pspName: this.pspName,
    });
  }

  /**
   * Paysafe answers that the request was processed, is still in progress, or
   * that its handle is spent, but the lookup cannot show this call's
   * original: not yet, or never once the original is older than the
   * lookup's 30-day default window (dupCheck looks back 90). Not retryable:
   * an automatic retry or a failover cannot know whether money moved.
   * Replaying the call under the same key later recovers the original once
   * it is visible; a new key would repeat it. A bank debit that the
   * duplicate check refused, or whose key holds a spent handle with no
   * payment, ends in refusedDuplicate or spentWithoutPayment instead.
   */
  private unreadableOriginal(replay: ReplayKey, pspCode: string, cause: unknown): PayFanoutError {
    const { noun } = REF_NUM_LOOKUPS[replay.lookup];
    const ref = `merchantRefNum "${replay.merchantRefNum}"`;
    const answer =
      pspCode === HANDLE_NOT_PAYABLE_CODE
        ? `Paysafe reports the payment handle as no longer payable (spent, expired or failed), but no ${noun} made with it under ${ref} can be read back`
        : pspCode === IN_PROGRESS_CODE
          ? `Paysafe is still processing another request on this transaction, and no ${noun} under ${ref} can be read back`
          : `Paysafe reports the ${noun} with ${ref} as already processed, but it cannot be read back`;
    return this.retryLater(
      `${answer} — retry later with the same idempotency key, never a new one. Paysafe's lookup only reaches ` +
        "30 days back, so an original older than that can never be read back: reconcile it in the Paysafe portal",
      replay,
      cause,
    );
  }

  /**
   * A bank debit sent with dupCheck: true that Paysafe refused as a
   * duplicate, with no live payment in the lookup to answer it. The request
   * in the way can be a payment the lookup does not show yet or, since the
   * check covers 90 days and the lookup 30, a failed attempt the lookup no
   * longer shows. Not retryable, for the same reason as unreadableOriginal.
   */
  private refusedDuplicate(replay: ReplayKey, cause: unknown): PayFanoutError {
    const { noun } = REF_NUM_LOOKUPS[replay.lookup];
    return this.retryLater(
      `Paysafe refused the ${noun} under merchantRefNum "${replay.merchantRefNum}" as a duplicate, and no ${noun} ` +
        "under that key other than a failed attempt can be read back. What stands in the way may be a payment " +
        "the lookup does not show yet, or a failed attempt older than the lookup: Paysafe's duplicate check covers " +
        "90 days, while its lookup reaches only 30. " +
        RETRY_OR_START_AGAIN,
      replay,
      cause,
    );
  }

  /**
   * A bank-debit key holding a spent handle with no payment of its own in
   * the lookup, after patient reads: the payment may not show yet, or a
   * refused attempt spent the handle. Not retryable, for the same reason as
   * unreadableOriginal.
   */
  private spentWithoutPayment(replay: ReplayKey, cause: unknown): PayFanoutError {
    return this.retryLater(
      `A payment handle under merchantRefNum "${replay.merchantRefNum}" is spent, but no payment made with it can ` +
        "be read back: the lookup may not show that payment yet, and a refused attempt can leave a spent handle, " +
        `since Paysafe marks a handle COMPLETED whatever its payments call answers. ${RETRY_OR_START_AGAIN}`,
      replay,
      cause,
    );
  }

  /**
   * An attempt went unanswered and the lookup does not show it, so whether
   * Paysafe processed it is unknown and it is not repeated. Not retryable,
   * for the same reason as unreadableOriginal.
   */
  private unknownOutcome(replay: ReplayKey, cause: unknown): PayFanoutError {
    const { noun } = REF_NUM_LOOKUPS[replay.lookup];
    return this.retryLater(
      `An attempt of the ${noun} request with merchantRefNum "${replay.merchantRefNum}" went unanswered and ` +
        "cannot be read back, so whether Paysafe processed it is unknown — retry later with the same " +
        "idempotency key, never a new one",
      replay,
      cause,
    );
  }

  /**
   * outcomeUnknown on every retry-later ending, as on the several-records and
   * full-page refusals: money may have moved under the key without the lookup
   * showing it, so nothing automatic may start over under a new key.
   */
  private retryLater(message: string, replay: ReplayKey, cause: unknown): PayFanoutError {
    return new PayFanoutError({
      code: "processing_error",
      message,
      retryable: false,
      outcomeUnknown: true,
      raw: { merchantRefNum: replay.merchantRefNum, cause },
      pspName: this.pspName,
    });
  }

  /** The transport backoff (250ms doubling, capped at 2s), for write re-sends and replay reads. */
  private backoff(attempt: number): Promise<void> {
    return (this.config.sleep ?? defaultSleep)(Math.min(2000, 250 * 2 ** (attempt - 1)));
  }

  private maxResends(): number {
    return this.config.maxNetworkRetries ?? 2;
  }

  private transportAttempts(): number {
    return 1 + this.maxResends();
  }

  private async requestOnce<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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

/**
 * Paysafe cardType codes → lowercase brand names hosts can render. The
 * Payments API lists AM, DI, JC, MC, MD ("Maestro"), SO ("Solo"), VI, VD and VE.
 */
const PAYSAFE_CARD_TYPE_TO_BRAND: Record<string, string> = {
  VI: "visa",
  VD: "visa", // Visa Debit
  VE: "visa", // Visa Electron
  MC: "mastercard",
  MD: "maestro",
  SO: "solo",
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
  const expMonth = expiryPart(card.cardExpiry?.month, 1, 12);
  const expYear = expiryPart(card.cardExpiry?.year, 1000, 9999);
  const details: PaymentMethodDetails = {
    ...(brand ? { brand } : {}),
    ...(card.lastDigits ? { last4: card.lastDigits } : {}),
    ...(expMonth !== undefined ? { expMonth } : {}),
    ...(expYear !== undefined ? { expYear } : {}),
  };
  return Object.keys(details).length > 0 ? details : undefined;
}

/**
 * An expiry month or year as an integer in its range, sent either as the
 * schema's number or as the examples' string; anything else is left out.
 */
function expiryPart(value: number | string | undefined, min: number, max: number): number | undefined {
  const part = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof part === "number" && Number.isInteger(part) && part >= min && part <= max ? part : undefined;
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
    case "EXPIRED": // "The transaction request is expired.": nothing went back to the customer
    case "DECLINED":
    case "ERROR":
      return "failed";
    default: // RECEIVED / PENDING / PROCESSING / INITIATED
      return "pending";
  }
}

/**
 * Verification statuses: FAILED is a 402 decline and ERROR a failure "for
 * non-business reason"; RECEIVED has not reached the gateway yet.
 */
function mapVerificationStatus(status: string | undefined): UnifiedPaymentStatus {
  switch ((status ?? "").toUpperCase()) {
    case "COMPLETED":
      return "succeeded";
    case "FAILED":
    case "ERROR":
      return "failed";
    default:
      return "processing";
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

/**
 * Paysafe error body: { error: { code, message } } with meaningful HTTP
 * statuses (402 = declined), per the card errors table. The replay answers
 * (5031, 3044, 3417, 5283) stay on their HTTP fallback: sendWrite
 * recognizes them by the Paysafe code on `raw`, not by what they map to.
 */
const PAYSAFE_CODE_MAP: Record<string, UnifiedErrorCode> = {
  "3022": "insufficient_funds",
  "3006": "expired_card",
  // An invalid card number or brand (3002, 3017), CVV (3005) or expiry date
  // (3012), or a failed CVV (3019) or AVS (3007) check: data the customer
  // can correct.
  "3002": "invalid_card_data",
  "3005": "invalid_card_data",
  "3007": "invalid_card_data",
  "3012": "invalid_card_data",
  "3017": "invalid_card_data",
  "3019": "invalid_card_data",
  // 3004: the zip/billing data Paysafe requires is missing from the request —
  // a data-quality error (fixed by supplying billingDetails), not a decline.
  "3004": "invalid_request",
  "3009": "card_declined",
  // "Strong Customer Authentication is required" (3060), or the
  // authentication value is invalid (3039): the customer comes back
  // on-session; replaying the call cannot help.
  "3039": "authentication_required",
  "3060": "authentication_required",
  // Declined for suspected fraud (3054), as a card that may be lost or stolen
  // (3016), by Paysafe's negative database (4001) or by its Risk Management
  // department (4002).
  "3016": "fraud_suspected",
  "3054": "fraud_suspected",
  "4001": "fraud_suspected",
  "4002": "fraud_suspected",
  // In no current Paysafe error table; kept in case an account still gets them.
  "8000": "fraud_suspected",
  "8001": "fraud_suspected",
  // 3406: settlement not batched yet — a timing state, retry later.
  "3406": "processing_error",
  // Capture, refund and void state checks (402): the authorization or
  // settlement cannot take the request — not a card decline.
  "3202": "invalid_request", // the authorization has had its maximum number of settlements
  "3203": "invalid_request", // the authorization is fully settled or cancelled
  "3204": "invalid_request", // the settlement exceeds the remaining authorization
  "3205": "invalid_request", // the authorization has expired
  "3402": "invalid_request", // the refund exceeds the remaining settlement
  "3403": "invalid_request", // the settlement has had its maximum number of refunds
  "3404": "invalid_request", // the settlement is already fully refunded
  "3405": "invalid_request", // the settlement has expired
  "3501": "invalid_request", // the void exceeds the remaining authorization
  "3502": "invalid_request", // the authorization has been settled
  "3506": "invalid_request", // the void exceeds the remaining authorization
  // Operations the transaction, its card type or the account's gateway does
  // not support (402): refused as PaymentService refuses a capability an
  // adapter lacks, not as a card decline.
  "3416": "unsupported_operation", // the gateway takes no partial settlement
  "3418": "unsupported_operation", // the gateway takes no partial refund
  "3419": "unsupported_operation", // this type of transaction cannot be refunded
  "3503": "unsupported_operation", // the authorization's card type takes no void
  "3504": "unsupported_operation", // the gateway takes no partial void
  "3507": "unsupported_operation", // the authorization takes no partial void
};

/** Own keys only: the code is Paysafe's text, and "constructor" names no mapping. */
function paysafeCodeFor(pspCode: string | undefined): UnifiedErrorCode | undefined {
  return pspCode !== undefined && Object.hasOwn(PAYSAFE_CODE_MAP, pspCode) ? PAYSAFE_CODE_MAP[pspCode] : undefined;
}

/**
 * Maps a non-2xx Paysafe answer onto the unified taxonomy. A 429 or a 5xx is
 * `rate_limited` or `psp_unavailable`, retryable, whatever code it carries:
 * sendWrite reads a 5xx as an outcome it must look up, and a code must not
 * turn that into a final answer. Otherwise a mapped code decides, then a
 * 402 is `card_declined` and any other status `invalid_request`. The message
 * is the catalog's, never Paysafe's own; the body stays untouched on `raw`.
 */
export function mapPaysafeError(httpStatus: number, body: unknown): PayFanoutError {
  const mapped = paysafeCodeFor((body as { error?: { code?: string } } | undefined)?.error?.code);
  let code: UnifiedErrorCode;
  let retryable = false;
  if (httpStatus === 429 || httpStatus >= 500) {
    ({ code, retryable } = classifyHttpFallback(httpStatus));
  } else if (mapped) {
    code = mapped;
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
