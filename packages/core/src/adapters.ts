import type { MinorUnitAmount } from "./currency.js";
import type { UnifiedError } from "./errors.js";
import type {
  AdapterCapabilities,
  CustomerRef,
  PaymentInfo,
  PaymentMethodCapability,
  PaymentSession,
  RefundInfo,
  RefundRequest,
  SavedPaymentMethod,
  RefundResult,
  UnifiedPaymentMethodType,
  UnifiedPaymentStatus,
  UnifiedWebhookEvent,
} from "./model.js";

export interface ShippingDetails {
  /** Recipient name — some PSPs (Stripe) require it whenever shipping is sent. */
  name?: string;
  phone?: string;
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
}

/**
 * SCA/3DS tuning. Best-effort per PSP: adapters map what their PSP supports
 * and ignore the rest (capability differences stay visible in docs, not
 * runtime surprises — exemptions are requests, never guarantees).
 */
export interface ScaPreference {
  /** "force" demands a 3DS challenge even when the PSP would skip it. */
  challenge?: "automatic" | "force";
  /** MOTO (mail order / telephone order) exemption request, where supported. */
  exemption?: "moto";
}

export interface CreatePaymentSessionInput {
  /**
   * Optional host-app internal id. PayFanout does not persist it — adapters stamp
   * it into PSP metadata (key "payfanout_id") so it round-trips via webhooks and
   * retrievePayment. Defaults to the PSP session id when omitted.
   */
  id?: string;
  amount: MinorUnitAmount;
  currency: string;
  /** Needed for merchant-account resolution (Paysafe). */
  country?: string;
  /** Restrict what the session accepts. */
  paymentMethodTypes?: UnifiedPaymentMethodType[];
  /** Only honored if getCapabilities().supportsManualCapture. */
  captureMethod?: "automatic" | "manual";
  /** Required by some 3DS / redirect completions. */
  returnUrl?: string;
  /**
   * Per-session webhook registration (Paysafe requires this at session/payment
   * init). Adapters that register webhooks globally (Stripe) ignore it.
   */
  webhookUrl?: string;
  /** For AVS / 3DS data quality — optional, never card data. */
  billingDetails?: {
    name?: string;
    email?: string;
    address?: {
      line1?: string;
      city?: string;
      postalCode?: string;
      country?: string;
    };
  };
  /**
   * What shows on the customer's bank statement. PSP rules apply (length,
   * charset) — adapters validate what they can and surface PSP rejections.
   */
  statementDescriptor?: string;
  /** Receipt/notification email, where the PSP sends receipts (Stripe). */
  receiptEmail?: string;
  /** Needed for wallets and fraud scoring. Never card data. */
  shippingDetails?: ShippingDetails;
  /** SCA/3DS tuning — request a challenge or an exemption where supported. */
  sca?: ScaPreference;
  /**
   * PSP customer id (from createCustomer) this payment belongs to. Required
   * when savePaymentMethod is true.
   */
  customer?: string;
  /**
   * Vault the instrument at the PSP during this checkout (with the customer's
   * consent — the host renders the "save my card" checkbox). The resulting
   * token arrives on PaymentInfo.savedPaymentMethodToken. Only honored if
   * getCapabilities().supportsSavedPaymentMethods.
   */
  savePaymentMethod?: boolean;
  metadata?: Record<string, string>;
  idempotencyKey: string;
}

export interface CreateCustomerInput {
  /** Host-app user id, round-tripped via PSP metadata where supported. */
  id?: string;
  email?: string;
  name?: string;
  metadata?: Record<string, string>;
  idempotencyKey: string;
}

/**
 * Standalone vaulting for tokenize-first PSPs (Paysafe): the client's
 * confirm() produced a single-use clientToken; this converts it into a
 * permanent stored instrument under the customer. Confirm-on-client PSPs
 * (Stripe) vault during checkout instead (savePaymentMethod on the session).
 */
export interface SavePaymentMethodInput {
  pspCustomerId: string;
  clientToken: string;
  idempotencyKey: string;
}

/**
 * Off-session charge of a vaulted instrument — the primitive under recurring
 * payments. No client, no card fields: the server charges the stored token.
 */
export interface ChargeSavedPaymentMethodInput {
  pspCustomerId: string;
  /** SavedPaymentMethod.token (or PaymentInfo.savedPaymentMethodToken). */
  savedPaymentMethodToken: string;
  amount: MinorUnitAmount;
  currency: string;
  /** Host-app payment id, round-tripped via PSP metadata where supported. */
  id?: string;
  /**
   * Credential-on-file semantics: "initial" for the first charge in an
   * agreement while the customer is present, "recurring" (default) for
   * merchant-initiated follow-ups, "unscheduled" for irregular one-offs
   * (top-ups). Networks require honest flags here.
   */
  occurrence?: "initial" | "recurring" | "unscheduled";
  /**
   * AVS data for customer-present ("initial") charges — Paysafe rejects them
   * without a zip (error 3004) when the stored token
   * originated from browser tokenization. Merchant-initiated follow-ups
   * don't need it.
   */
  billingDetails?: CreatePaymentSessionInput["billingDetails"];
  statementDescriptor?: string;
  metadata?: Record<string, string>;
  idempotencyKey: string;
}

/**
 * Amendments to a not-yet-completed session (cart total changed, address
 * arrived late). Fields omitted are left unchanged. Some PSPs re-issue the
 * session (new pspSessionId/clientSecret) — always continue with the RETURNED
 * PaymentSession, never the one captured before the update.
 */
export interface UpdatePaymentSessionInput {
  pspSessionId: string;
  amount?: MinorUnitAmount;
  currency?: string;
  metadata?: Record<string, string>;
  statementDescriptor?: string;
  receiptEmail?: string;
  shippingDetails?: ShippingDetails;
  idempotencyKey: string;
}

export interface FetchEventsInput {
  /** Only events created at/after this instant (ISO 8601 string or Date). */
  since?: string | Date;
  /** Page-size hint; the PSP's own maximum wins. */
  limit?: number;
  /** Opaque continuation cursor from a previous FetchEventsResult. */
  cursor?: string;
}

export interface FetchEventsResult {
  events: UnifiedWebhookEvent[];
  /** Present when another page exists — pass back as FetchEventsInput.cursor. */
  nextCursor?: string;
}

export interface ListPaymentsInput {
  createdAfter?: string | Date;
  createdBefore?: string | Date;
  limit?: number;
  cursor?: string;
}

export interface ListPaymentsResult {
  payments: PaymentInfo[];
  nextCursor?: string;
}

export interface ListRefundsInput {
  /** Restrict to refunds of one payment. */
  pspPaymentId?: string;
  createdAfter?: string | Date;
  createdBefore?: string | Date;
  limit?: number;
  cursor?: string;
}

export interface ListRefundsResult {
  refunds: RefundInfo[];
  nextCursor?: string;
}

export interface CompletePaymentInput {
  pspSessionId: string;
  /** Token produced by the client adapter's confirm() (e.g. Paysafe Payment Handle token). */
  clientToken: string;
  idempotencyKey: string;
  /**
   * AVS billing data gathered after the session was created — merged over the
   * session's own billingDetails at completion. Tokenize-first PSPs (Paysafe)
   * forward it to the charge; confirm-on-client PSPs (Stripe) never call
   * completePayment. Lets a host attach a postal code collected on the payment
   * step, which AVS-enforcing accounts require (Paysafe error 3004), without
   * recreating the session.
   */
  billingDetails?: CreatePaymentSessionInput["billingDetails"];
}

export interface VerifyPaymentMethodInput {
  pspSessionId: string;
  /** Required by tokenize-first PSPs (Paysafe); ignored by confirm-on-client PSPs. */
  clientToken?: string;
  /** Verification creates PSP-side objects — mutating, so the key is required. */
  idempotencyKey: string;
}

export interface ServerPaymentAdapter {
  readonly pspName: string;

  createPaymentSession(input: CreatePaymentSessionInput): Promise<PaymentSession>;

  /**
   * Required when getCapabilities().requiresServerCompletion is true (Paysafe).
   * Finalizes a payment using a client-produced token. Never called for
   * confirm-on-client PSPs (Stripe).
   */
  completePayment?(input: CompletePaymentInput): Promise<PaymentInfo>;

  retrievePayment(pspPaymentId: string): Promise<PaymentInfo>;

  /**
   * Only present if getCapabilities().supportsManualCapture. Capture is the
   * canonical double-charge operation — the idempotency key is REQUIRED, and
   * under supportsMultiCapture each partial capture is its own charge with its
   * own key.
   */
  capturePayment?(
    pspPaymentId: string,
    amount: MinorUnitAmount | undefined,
    idempotencyKey: string,
  ): Promise<PaymentInfo>;

  cancelPayment(pspPaymentId: string, idempotencyKey: string): Promise<PaymentInfo>;

  refundPayment(req: RefundRequest): Promise<RefundResult>;

  /**
   * Poll a refund to a terminal state. Required whenever
   * getCapabilities().supportsRefunds — refundPayment can return "pending".
   */
  retrieveRefund?(refundId: string): Promise<RefundInfo>;

  /**
   * Only present if getCapabilities().supportsSessionUpdate. May re-issue the
   * session — callers must continue with the returned PaymentSession.
   */
  updatePaymentSession?(input: UpdatePaymentSessionInput): Promise<PaymentSession>;

  /**
   * Missed-webhook recovery: page through the PSP's recent events as the same
   * normalized UnifiedWebhookEvents a webhook delivery would produce. Only
   * present if getCapabilities().supportsEventPolling.
   */
  fetchEvents?(input?: FetchEventsInput): Promise<FetchEventsResult>;

  /** Reconciliation passthrough. Only present if getCapabilities().supportsListing. */
  listPayments?(input?: ListPaymentsInput): Promise<ListPaymentsResult>;

  /** Reconciliation passthrough. Only present if getCapabilities().supportsListing. */
  listRefunds?(input?: ListRefundsInput): Promise<ListRefundsResult>;

  /** Zero-amount validation, no charge, no storage — see the vaulting caveat in the README. */
  verifyPaymentMethod?(input: VerifyPaymentMethodInput): Promise<PaymentInfo>;

  // --- Vaulting / recurring surface — present iff supportsSavedPaymentMethods ---

  /** Creates the PSP-side customer that saved instruments attach to. */
  createCustomer?(input: CreateCustomerInput): Promise<CustomerRef>;

  /**
   * Tokenize-first PSPs only: converts a single-use clientToken into a
   * permanent stored instrument. Confirm-on-client PSPs vault during checkout
   * (session `savePaymentMethod`) and don't implement this.
   */
  savePaymentMethod?(input: SavePaymentMethodInput): Promise<SavedPaymentMethod>;

  listSavedPaymentMethods?(pspCustomerId: string): Promise<SavedPaymentMethod[]>;

  /** Deletes by SavedPaymentMethod.token — the token is dead afterwards. */
  deleteSavedPaymentMethod?(pspCustomerId: string, token: string): Promise<void>;

  /** Off-session charge of a stored token — the recurring-payments primitive. */
  chargeSavedPaymentMethod?(input: ChargeSavedPaymentMethodInput): Promise<PaymentInfo>;

  getCapabilities(): AdapterCapabilities;

  /**
   * Webhook handling — same adapter, separate concerns. Both async: future
   * PSPs may need remote key retrieval; the contract stays uniform.
   * MUST operate on the RAW request body bytes/string — re-serializing a
   * parsed body breaks signatures (the conformance suite tests this).
   */
  verifyWebhookSignature(rawBody: string, headers: Record<string, string>): Promise<boolean>;

  /**
   * Throws PayFanoutError (code "invalid_request") on unparseable payloads; maps
   * genuinely unknown-but-valid event types to type "unknown" rather than throwing.
   */
  parseWebhookEvent(rawBody: string, headers: Record<string, string>): Promise<UnifiedWebhookEvent>;
}

/**
 * Opaque handle returned by ClientPaymentAdapter.mount. Each adapter brands
 * its own concrete type internally; consumers must treat it as opaque.
 */
declare const MountedFieldsBrand: unique symbol;
export interface MountedFieldsHandle {
  readonly [MountedFieldsBrand]: string; // pspName
}

/** Adapter-internal helper: the brand is type-level only, so this is a pure cast. */
export function brandMountedFieldsHandle<T extends object>(handle: T): T & MountedFieldsHandle {
  return handle as T & MountedFieldsHandle;
}

/**
 * The slot-attribute protocol for split-field PSPs: elements carrying
 * `data-payfanout-field="cardNumber|expiryDate|cvv"` inside the mount
 * container become the field mount points. One constant, three consumers
 * (core docs, adapters, react) — never retype the string.
 */
export const DATA_PAYFANOUT_FIELD = "data-payfanout-field";

/** Live validity state of the mounted fields — drives "disable Pay until complete" UX. */
export interface FieldsChangeState {
  /** True when every mounted field is filled and passes client-side validation. */
  complete: boolean;
  /** True when the customer has not typed anything yet, where the SDK reports it. */
  empty?: boolean;
}

export interface MountOptions {
  clientSecret: string;
  /** Design-token passthrough so fields match the host app's look. */
  appearance?: Record<string, unknown>;
  /**
   * PSP-vocabulary UI options, passed through to the SDK's field creation —
   * untyped so every present and future SDK option stays
   * reachable without a library release. The host wins on conflicts, except
   * for keys the adapter must own to function (documented per adapter).
   *
   *  - Stripe: Payment Element options — `layout` (tabs/accordion),
   *    `paymentMethodOrder`, `fields`, `defaultValues`, `terms`, `wallets`, …
   *  - Paysafe: per-field config under `fields` (placeholders, …), `locale`, …
   */
  fieldOptions?: Record<string, unknown>;
  /** BCP-47 locale for the PSP's own field texts, where the SDK supports one. */
  locale?: string;
  onReady?: () => void;
  onError?: (err: UnifiedError) => void;
  /**
   * Fires as the customer types, whenever field validity changes. Adapters
   * fire it with { complete: false } once on mount so hosts can initialize
   * button state, then on every SDK change event.
   */
  onChange?: (state: FieldsChangeState) => void;
}

export interface ConfirmResult {
  status: UnifiedPaymentStatus;
  /**
   * Present only for tokenize-first PSPs: the host must pass it to the
   * server's completePayment. <PayButton> handles this branching.
   */
  clientToken?: string;
  error?: UnifiedError;
}

/** window.location slice a redirect-return handler inspects — kept structural for tests/SSR. */
export interface RedirectReturnLocation {
  /** window.location.search (leading "?" optional). */
  search: string;
  /** window.location.hash, for PSPs that return state in the fragment. */
  hash?: string;
}

export interface ClientPaymentAdapter {
  readonly pspName: string;

  /** Dynamic script/SDK load — only pulled in if this PSP is active. */
  loadSdk(): Promise<void>;

  /**
   * Renders the PSP's hosted fields into `container`.
   *
   * Layout slot convention (split-field PSPs like Paysafe): when the host has
   * placed elements carrying `data-payfanout-field="<fieldName>"` inside the
   * container, the adapter mounts each hosted field INTO its slot — the host
   * fully owns the layout (grid, rows, spacing). Without slots, the adapter
   * falls back to its own stacked containers. Single-element PSPs (Stripe's
   * Payment Element) control layout via `MountOptions.fieldOptions` instead.
   */
  mount(container: HTMLElement, options: MountOptions): Promise<MountedFieldsHandle>;

  /**
   * Must resolve 3DS/next-action challenges INLINE (iframe/modal), never full
   * navigation. Confirm-on-client PSPs resolve with a terminal-ish status;
   * tokenize-first PSPs resolve with status "requires_confirmation" + clientToken.
   */
  confirm(handle: MountedFieldsHandle): Promise<ConfirmResult>;

  unmount(handle: MountedFieldsHandle): void;

  /**
   * Redirect payment methods only (flow: "redirect"): after the PSP sends the
   * customer back to returnUrl, this inspects the landing URL and resolves the
   * payment outcome. Returns null when the URL carries no return params for
   * this PSP (so a router can probe every registered adapter safely).
   */
  handleRedirectReturn?(location: RedirectReturnLocation): Promise<ConfirmResult | null>;

  listPaymentMethodCapabilities(): PaymentMethodCapability[];
}
