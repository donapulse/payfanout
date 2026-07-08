/**
 * Structural subset of the `stripe` Node SDK that the adapter uses. Keeping it
 * structural lets tests inject an in-memory client and keeps the adapter's
 * compile-time surface independent of SDK version bumps; the real SDK is
 * loaded lazily at runtime when no client is injected.
 */
export interface StripeRequestOptions {
  idempotencyKey?: string;
}

export interface StripeChargeLike {
  id: string;
  amount_refunded?: number;
  refunded?: boolean;
  captured?: boolean;
  created?: number;
  /** The instrument used — becomes savedPaymentMethodToken when the session vaulted it. */
  payment_method?: string | { id: string } | null;
  /**
   * `type` names the rail; the same-named sub-object carries its facts
   * (card.brand/last4/wallet, sepa_debit.mandate, us_bank_account.mandate, …).
   */
  payment_method_details?: {
    type?: string;
    card?: {
      brand?: string;
      last4?: string;
      wallet?: { type?: string } | null;
      exp_month?: number;
      exp_year?: number;
    } | null;
    [rail: string]: unknown;
  } | null;
}

export interface StripePaymentIntentLike {
  id: string;
  object: "payment_intent";
  status:
    | "requires_payment_method"
    | "requires_confirmation"
    | "requires_action"
    | "processing"
    | "requires_capture"
    | "succeeded"
    | "canceled";
  amount: number;
  /** What was actually collected — differs from `amount` after partial capture. */
  amount_received?: number;
  /** Authorized-but-uncaptured remainder on manual-capture intents. */
  amount_capturable?: number;
  currency: string;
  created: number;
  client_secret?: string | null;
  metadata?: Record<string, string>;
  latest_charge?: string | StripeChargeLike | null;
  last_payment_error?: unknown;
  payment_method_types?: string[];
  /** "off_session" when the session was asked to vault the instrument. */
  setup_future_usage?: string | null;
}

export interface StripeCustomerLike {
  id: string;
  email?: string | null;
  name?: string | null;
  metadata?: Record<string, string>;
}

export interface StripePaymentMethodLike {
  id: string;
  type?: string;
  customer?: string | { id: string } | null;
  created?: number;
  card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } | null;
}

export interface StripeSetupIntentLike {
  id: string;
  object: "setup_intent";
  status:
    | "requires_payment_method"
    | "requires_confirmation"
    | "requires_action"
    | "processing"
    | "succeeded"
    | "canceled";
  created: number;
  client_secret?: string | null;
  metadata?: Record<string, string>;
  payment_method?: string | { id: string } | null;
  /** Present when the SetupIntent vaults for a customer (save mode — never detach). */
  customer?: string | { id: string } | null;
  last_setup_error?: unknown;
}

export interface StripeRefundLike {
  id: string;
  amount: number;
  status: "succeeded" | "pending" | "failed" | "canceled" | "requires_action" | null;
  payment_intent?: string | { id: string } | null;
  created?: number;
}

/** Stripe list envelope (auto-pagination is not used — cursors stay explicit). */
export interface StripeListLike<T> {
  data: T[];
  has_more?: boolean;
}

/** Event objects from GET /v1/events — same shape webhooks deliver. */
export interface StripeEventLike {
  id: string;
  type: string;
  created?: number;
  data?: { object?: Record<string, unknown> };
}

export interface StripeClientLike {
  paymentIntents: {
    create(params: Record<string, unknown>, opts?: StripeRequestOptions): Promise<StripePaymentIntentLike>;
    retrieve(id: string, params?: Record<string, unknown>): Promise<StripePaymentIntentLike>;
    update(id: string, params: Record<string, unknown>, opts?: StripeRequestOptions): Promise<StripePaymentIntentLike>;
    capture(id: string, params?: Record<string, unknown>, opts?: StripeRequestOptions): Promise<StripePaymentIntentLike>;
    cancel(id: string, params?: Record<string, unknown>, opts?: StripeRequestOptions): Promise<StripePaymentIntentLike>;
    list(params?: Record<string, unknown>): Promise<StripeListLike<StripePaymentIntentLike>>;
  };
  setupIntents: {
    create(params: Record<string, unknown>, opts?: StripeRequestOptions): Promise<StripeSetupIntentLike>;
    retrieve(id: string, params?: Record<string, unknown>): Promise<StripeSetupIntentLike>;
  };
  paymentMethods: {
    retrieve(id: string): Promise<StripePaymentMethodLike>;
    detach(id: string): Promise<unknown>;
  };
  customers: {
    create(params: Record<string, unknown>, opts?: StripeRequestOptions): Promise<StripeCustomerLike>;
    listPaymentMethods(
      id: string,
      params?: Record<string, unknown>,
    ): Promise<StripeListLike<StripePaymentMethodLike>>;
  };
  refunds: {
    create(params: Record<string, unknown>, opts?: StripeRequestOptions): Promise<StripeRefundLike>;
    retrieve(id: string): Promise<StripeRefundLike>;
    list(params?: Record<string, unknown>): Promise<StripeListLike<StripeRefundLike>>;
  };
  events: {
    list(params?: Record<string, unknown>): Promise<StripeListLike<StripeEventLike>>;
  };
}

export interface StripeServerAdapterConfig {
  secretKey: string;
  /**
   * Explicit Stripe API version (e.g. "2024-06-20"). Required: the account
   * default changes silently between accounts — never rely on it.
   */
  apiVersion: string;
  /**
   * One secret, or several during rotation (Stripe keeps the old endpoint
   * secret valid for a grace window — list both and rotation needs no cutover).
   */
  webhookSigningSecret: string | string[];
  /** Explicit, never inferred from key prefixes. */
  environment: "sandbox" | "live";
  /**
   * Zero-amount verification on Stripe uses a SetupIntent, which attaches a
   * saved PaymentMethod — colliding with the no-vaulting constraint. The
   * default strategy detaches the PaymentMethod immediately (guaranteed, even
   * on failure paths). Set "disabled" to switch the capability off instead.
   */
  verifyPaymentMethodStrategy?: "setup_intent_detach" | "disabled";
  /** Webhook timestamp tolerance in seconds (replay protection). Default 300. */
  webhookToleranceSeconds?: number;
  /**
   * Automatic network-level retries inside the Stripe SDK (idempotency keys
   * make them safe). Default 2. Only applies when the SDK is loaded lazily —
   * an injected client keeps its own configuration.
   */
  maxNetworkRetries?: number;
  /** Injected client for tests; defaults to lazily importing the `stripe` SDK. */
  client?: StripeClientLike;
  /** Injected clock (ms since epoch) for webhook tolerance tests. */
  now?: () => number;
}
