import type { MinorUnitAmount } from "./currency.js";

export const PAYMENT_STATUSES = [
  "requires_payment_method",
  "requires_confirmation",
  "requires_action", // e.g. 3DS challenge in progress
  "requires_capture", // authorized, awaiting manual capture
  "processing",
  "succeeded",
  "canceled",
  "failed",
] as const;

export type UnifiedPaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function isUnifiedPaymentStatus(value: unknown): value is UnifiedPaymentStatus {
  return typeof value === "string" && (PAYMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * Refund state is NOT part of the payment status enum: PSPs
 * (Stripe included) do not flip a payment's status to "refunded". Refund state
 * is derived from amountRefunded vs amount — see getRefundState().
 */

export const PAYMENT_METHOD_FLOWS = [
  "embedded", // card-style: fields rendered inline, no navigation
  "redirect", // e.g. iDEAL, some bank redirects
  "popup", // e.g. some wallet auth flows
  "voucher_code", // e.g. PaysafeCard — user pays with a code, out of band
  "qr_code",
] as const;

export type PaymentMethodFlow = (typeof PAYMENT_METHOD_FLOWS)[number];

export const PAYMENT_METHOD_TYPES = [
  "card",
  "apple_pay",
  "google_pay",
  "paypal",
  "ideal",
  "sepa_debit",
  "ach",
  "bacs_debit",
  // Pre-Authorized Debit, the Payments Canada scheme for pulling debits from
  // Canadian accounts. PSPs name it inconsistently — Stripe "acss_debit",
  // GoCardless "pad", Paysafe "EFT" — so the scheme name is the neutral one.
  "pad",
  "interac_etransfer",
  "skrill",
  "neteller",
  "paysafecard",
  "paysafecash",
  "bank_redirect_generic",
  "voucher_generic",
  "other",
] as const;

export type UnifiedPaymentMethodType = (typeof PAYMENT_METHOD_TYPES)[number];

export interface PaymentMethodCapability {
  type: UnifiedPaymentMethodType;
  flow: PaymentMethodFlow;
  supported: boolean;
  /**
   * Hard per-method currency constraint (ISO 4217, uppercase) — a rail that
   * settles in one currency only (SEPA in EUR, Bacs in GBP). ABSENT means
   * unrestricted; the PSP-wide `AdapterCapabilities.supportedCurrencies` still
   * applies on top. Declared rather than guarded privately so the router can
   * pre-screen: a currency-ineligible rail must be skipped in favour of an
   * eligible PSP, not attempted and rejected at the PSP.
   */
  currencies?: string[];
  /**
   * Hard per-method CUSTOMER-country constraint (ISO 3166-1 alpha-2,
   * uppercase) — a rail only customers in specific countries can pay with
   * (Bacs needs a UK bank account, Interac a Canadian one). ABSENT or empty
   * means unrestricted. Screening consults it only when the session states
   * `customerCountry`; with no country stated the rail passes — a best-effort
   * pre-filter, never an eligibility guarantee, because the true constraint
   * is the bank account the customer brings. Declare only what the provider
   * documents as a country (or a short closed list); a zone rail (SEPA) stays
   * undeclared — encoding the zone's membership would screen out valid
   * payments the day it drifts.
   */
  countries?: string[];
}

export interface AdapterCapabilities {
  pspName: string;
  /**
   * Hard PSP currency constraints (ISO 4217, uppercase). ABSENT means
   * unrestricted. When present, the router pre-screens candidates by it —
   * without it, a PSP-local currency rejection (invalid_request) aborts the
   * failover cascade before an eligible PSP is tried.
   */
  supportedCurrencies?: string[];
  supportsRefunds: boolean;
  supportsPartialRefunds: boolean;
  /** Authorize now, capture later. */
  supportsManualCapture: boolean;
  /**
   * More than one partial capture against a single authorization (each with its
   * own idempotency key). Single-capture PSPs settle once and release the rest.
   */
  supportsMultiCapture: boolean;
  /** Zero/low-amount validation, no charge, no storage. */
  supportsPaymentMethodVerification: boolean;
  /**
   * PSP-side vaulting: cards are stored by the PSP ONLY (SAQ-A unchanged),
   * PayFanout and the host handle nothing but opaque tokens. When true, the
   * adapter implements the customer/saved-method surface and off-session
   * charging (the foundation of recurring payments / subscriptions).
   */
  supportsSavedPaymentMethods: boolean;
  /**
   * updatePaymentSession is available (amount/metadata amendments after
   * creation). NOTE: some PSPs re-issue the session — always use the returned
   * PaymentSession's pspSessionId/clientSecret after an update.
   */
  supportsSessionUpdate: boolean;
  /** fetchEvents() is available for missed-webhook reconciliation. */
  supportsEventPolling: boolean;
  /** listPayments()/listRefunds() reconciliation passthroughs are available. */
  supportsListing: boolean;
  /**
   * True if the PSP flow is client-tokenize-first and the server must finalize
   * the payment via completePayment (Paysafe: true, Stripe: false).
   */
  requiresServerCompletion: boolean;
  paymentMethods: PaymentMethodCapability[];
}

export interface PaymentSession {
  /** Caller-supplied or generated internal id — PayFanout does NOT persist it. */
  id: string;
  pspName: string;
  /** e.g. Stripe PaymentIntent id / Paysafe payment-handle session context. */
  pspSessionId: string;
  /** Token the client SDK needs to mount/confirm. */
  clientSecret?: string;
  amount: MinorUnitAmount;
  /** ISO 4217. */
  currency: string;
  status: UnifiedPaymentStatus;
  metadata?: Record<string, string>;
}

/**
 * Normalized display facts about the instrument used — what receipts and
 * order pages show ("Visa •••• 4242"). Never enough data to charge with.
 */
export interface PaymentMethodDetails {
  /** Lowercase card brand ("visa", "mastercard", "amex", …) when known. */
  brand?: string;
  /** Last 4 digits of the card / account, when the PSP reports them. */
  last4?: string;
  /** Wallet that wrapped the card ("apple_pay", "google_pay", "link", …). */
  wallet?: string;
  /** Card expiry month (1-12), when the PSP reports it — display/renewal warnings only. */
  expMonth?: number;
  /** Card expiry year (4 digits), when the PSP reports it. */
  expYear?: number;
}

export interface PaymentInfo {
  id: string;
  pspName: string;
  pspPaymentId: string;
  status: UnifiedPaymentStatus;
  amount: MinorUnitAmount;
  /** Source of truth for refund state — see getRefundState(). */
  amountRefunded: MinorUnitAmount;
  /**
   * Total captured so far, when the PSP reports it — the running sum under
   * partial/multi-capture. Absent on PSPs that don't report it.
   */
  amountCaptured?: MinorUnitAmount;
  /** Authorized-but-uncaptured remainder, when the PSP reports it. */
  amountCapturable?: MinorUnitAmount;
  currency: string;
  paymentMethodType: UnifiedPaymentMethodType;
  /**
   * The host metadata stored on the PSP object, echoed back where the PSP
   * supports it (adapters that carry metadata only in signed session tokens
   * cannot echo it on retrieve).
   */
  metadata?: Record<string, string>;
  /** Present once the PSP reports instrument facts (post-confirmation). */
  paymentMethodDetails?: PaymentMethodDetails;
  /**
   * Debit-rail mandate reference (SEPA/BACS/ACH), when the PSP reports one —
   * merchants must be able to quote it in customer communication.
   */
  mandateReference?: string;
  /**
   * Present when this payment ALSO vaulted the instrument (session created
   * with `customer` + `savePaymentMethod: true`): the SavedPaymentMethod.token
   * to store for future off-session charges.
   */
  savedPaymentMethodToken?: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, when known. */
  capturedAt?: string;
  raw: unknown;
}

export interface RefundRequest {
  /**
   * The PSP's payment id — PayFanout has no internal-id store, so the host app
   * resolves its own id -> pspPaymentId first.
   */
  pspPaymentId: string;
  /** Omit for a full refund. */
  amount?: MinorUnitAmount;
  /**
   * Best-effort per PSP: mapped to the provider's own vocabulary where one
   * exists (Stripe accepts exactly these), passed through or withheld where
   * none does.
   */
  reason?: RefundReason;
  idempotencyKey: string;
}

export type RefundReason = "duplicate" | "fraudulent" | "requested_by_customer";

export const REFUND_STATUSES = ["succeeded", "pending", "failed"] as const;

export type RefundStatus = (typeof REFUND_STATUSES)[number];

export interface RefundResult {
  refundId: string;
  status: RefundStatus;
  amount: MinorUnitAmount;
  raw: unknown;
}

/**
 * Snapshot returned by retrieveRefund — refundPayment can come back "pending"
 * (async refunds), and this is how the host polls it to a terminal state.
 */
export interface RefundInfo extends RefundResult {
  /** The PSP payment the refund belongs to, when the PSP reports it. */
  pspPaymentId?: string;
  /** ISO 8601, when known. */
  createdAt?: string;
}

/**
 * A PSP-side customer record — the anchor saved payment methods attach to.
 * The HOST owns the mapping `its user id -> pspCustomerId` (PayFanout persists
 * nothing); the card itself lives at the PSP only.
 */
export interface CustomerRef {
  pspName: string;
  pspCustomerId: string;
  /** Host-app id round-tripped via PSP metadata where supported. */
  id?: string;
  raw: unknown;
}

/**
 * A vaulted instrument. `token` is the ONE identifier hosts store and pass
 * back (charge, delete) — PSP-internal ids stay inside the adapter. Never
 * contains card data beyond display facts.
 */
export interface SavedPaymentMethod {
  /** Opaque, PSP-scoped. Charge with it, delete by it, store it like an order id. */
  token: string;
  pspName: string;
  pspCustomerId: string;
  paymentMethodType: UnifiedPaymentMethodType;
  /** "visa •••• 4242"-grade display facts, when the PSP reports them. */
  details?: PaymentMethodDetails;
  /** ISO 8601, when known. */
  createdAt?: string;
  raw: unknown;
}

export const WEBHOOK_EVENT_TYPES = [
  "payment.succeeded",
  "payment.failed",
  "payment.requires_action",
  /**
   * Async rails (SEPA/ACH/…): the payment is underway but not final. The
   * terminal payment.succeeded / payment.failed follows days later.
   */
  "payment.processing",
  "payment.refunded",
  /** An async refund that later failed — funds did NOT return to the customer. */
  "payment.refund_failed",
  "payment.canceled",
  /** A dispute/chargeback was opened against the payment. */
  "payment.chargeback",
  /** The dispute closed in the merchant's favor — funds retained/returned. */
  "payment.chargeback_won",
  /** The dispute closed against the merchant — funds gone. */
  "payment.chargeback_lost",
  "unknown",
] as const;

export type UnifiedWebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isUnifiedWebhookEventType(value: unknown): value is UnifiedWebhookEventType {
  return typeof value === "string" && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

export function isUnifiedPaymentMethodType(value: unknown): value is UnifiedPaymentMethodType {
  return typeof value === "string" && (PAYMENT_METHOD_TYPES as readonly string[]).includes(value);
}

export interface UnifiedWebhookEvent {
  /**
   * Stable dedupe key. The consuming application owns the "have I already
   * processed this event id" store — PayFanout persists nothing.
   */
  id: string;
  pspName: string;
  type: UnifiedWebhookEventType;
  pspPaymentId?: string;
  /**
   * Money facts, normalized where the PSP payload carries them — a stateless
   * host should not need a retrievePayment round-trip to know how much a
   * payment.refunded event refunded. Integer minor units.
   */
  amount?: MinorUnitAmount;
  /** ISO 4217, when the payload reports it alongside `amount`. */
  currency?: string;
  /** The PSP refund id, on refund-shaped events. */
  refundId?: string;
  /** ISO 8601. Webhook delivery is unordered on every PSP — treat events as unordered facts. */
  occurredAt: string;
  raw: unknown;
}
