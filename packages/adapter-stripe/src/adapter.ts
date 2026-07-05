import {
  brandMountedFieldsHandle,
  PayFanoutError,
  type ClientPaymentAdapter,
  type ConfirmResult,
  type MountedFieldsHandle,
  type MountOptions,
  type PaymentMethodCapability,
  type RedirectReturnLocation,
  type UnifiedError,
  type UnifiedErrorCode,
  type UnifiedPaymentStatus,
} from "@payfanout/core";

/** Structural subset of Stripe.js — injected in tests, loaded from js.stripe.com in browsers. */
export interface StripeJsElementLike {
  mount(container: HTMLElement | string): void;
  unmount(): void;
  destroy(): void;
  on(
    event: "ready" | "loaderror" | "change",
    handler: (payload?: { error?: StripeJsErrorLike; complete?: boolean; empty?: boolean }) => void,
  ): void;
}

export interface StripeJsElementsLike {
  create(type: "payment", options?: Record<string, unknown>): StripeJsElementLike;
}

export interface StripeJsErrorLike {
  type?: string;
  code?: string;
  decline_code?: string;
  message?: string;
}

export interface StripeJsConfirmResult {
  error?: StripeJsErrorLike;
  paymentIntent?: { status: string };
  setupIntent?: { status: string };
}

export interface StripeJsLike {
  elements(options: Record<string, unknown>): StripeJsElementsLike;
  confirmPayment(options: Record<string, unknown>): Promise<StripeJsConfirmResult>;
  confirmSetup(options: Record<string, unknown>): Promise<StripeJsConfirmResult>;
  retrievePaymentIntent(clientSecret: string): Promise<StripeJsConfirmResult>;
  retrieveSetupIntent(clientSecret: string): Promise<StripeJsConfirmResult>;
}

export type StripeJsFactory = (publishableKey: string, options?: Record<string, unknown>) => StripeJsLike;

export interface StripeClientAdapterConfig {
  publishableKey: string;
  /** Explicit, mirrors the server adapter — never inferred from key prefixes. */
  environment: "sandbox" | "live";
  /** Used for redirect-based methods; card/3DS flows stay inline (redirect: "if_required"). */
  returnUrl?: string;
  locale?: string;
  /** Override the capability list per account/currency instead of hardcoding. */
  paymentMethods?: PaymentMethodCapability[];
  /** Test seams: script injection + global lookup. */
  loadScript?: (url: string) => Promise<void>;
  getStripeGlobal?: () => StripeJsFactory | undefined;
  sdkUrl?: string;
}

const STRIPE_JS_URL = "https://js.stripe.com/v3";

const DEFAULT_METHODS: PaymentMethodCapability[] = [
  { type: "card", flow: "embedded", supported: true },
  { type: "apple_pay", flow: "popup", supported: true },
  { type: "google_pay", flow: "popup", supported: true },
  { type: "ideal", flow: "redirect", supported: true },
  { type: "sepa_debit", flow: "embedded", supported: true },
  { type: "ach", flow: "embedded", supported: true },
  { type: "bacs_debit", flow: "embedded", supported: true },
];

interface StripeHandle {
  pspName: "stripe";
  stripe: StripeJsLike;
  elements: StripeJsElementsLike;
  element: StripeJsElementLike;
  clientSecret: string;
}

export class StripeClientAdapter implements ClientPaymentAdapter {
  readonly pspName = "stripe";
  private readonly config: StripeClientAdapterConfig;
  private sdkPromise?: Promise<void>;

  constructor(config: StripeClientAdapterConfig) {
    if (!config.publishableKey) {
      throw PayFanoutError.invalidRequest("StripeClientAdapter config.publishableKey is required");
    }
    if (config.environment !== "sandbox" && config.environment !== "live") {
      throw PayFanoutError.invalidRequest('StripeClientAdapter config.environment must be "sandbox" or "live"');
    }
    this.config = config;
  }

  async loadSdk(): Promise<void> {
    assertBrowser("loadSdk");
    if (this.stripeGlobal()) return;
    this.sdkPromise ??= (this.config.loadScript ?? injectScript)(this.config.sdkUrl ?? STRIPE_JS_URL);
    await this.sdkPromise;
    if (!this.stripeGlobal()) {
      throw new PayFanoutError({
        code: "psp_unavailable",
        message: "Stripe.js loaded but window.Stripe is missing",
        retryable: true,
        raw: undefined,
        pspName: this.pspName,
      });
    }
  }

  async mount(container: HTMLElement, options: MountOptions): Promise<MountedFieldsHandle> {
    assertBrowser("mount");
    await this.loadSdk();
    const factory = this.stripeGlobal()!;
    const locale = options.locale ?? this.config.locale;
    const stripe = factory(this.config.publishableKey, locale ? { locale } : undefined);
    const elements = stripe.elements({
      clientSecret: options.clientSecret,
      ...(options.appearance ? { appearance: options.appearance } : {}),
    });
    // fieldOptions = the full Payment Element option surface (layout,
    // paymentMethodOrder, fields, defaultValues, terms, wallets, …), passed
    // through untouched so future SDK options need no library release.
    const element = elements.create("payment", options.fieldOptions);
    element.on("ready", () => options.onReady?.());
    element.on("loaderror", (payload) => options.onError?.(mapStripeJsError(payload?.error)));
    // Field-state stream: hosts disable Pay until complete. Initialized false
    // so button state is deterministic before the customer types anything.
    options.onChange?.({ complete: false });
    element.on("change", (payload) =>
      options.onChange?.({
        complete: payload?.complete ?? false,
        ...(payload?.empty !== undefined ? { empty: payload.empty } : {}),
      }),
    );
    element.mount(container);
    const handle: StripeHandle = { pspName: "stripe", stripe, elements, element, clientSecret: options.clientSecret };
    return brandMountedFieldsHandle(handle);
  }

  /**
   * Confirm-on-client shape (§4a): Stripe finalizes here, including inline 3DS
   * (redirect: "if_required" keeps card flows in an iframe/modal — no navigation).
   * Never returns a clientToken.
   */
  async confirm(handle: MountedFieldsHandle): Promise<ConfirmResult> {
    const h = asStripeHandle(handle);
    const params = {
      elements: h.elements,
      redirect: "if_required",
      confirmParams: this.config.returnUrl ? { return_url: this.config.returnUrl } : {},
    };
    const isSetup = h.clientSecret.startsWith("seti_");
    const result = isSetup ? await h.stripe.confirmSetup(params) : await h.stripe.confirmPayment(params);
    if (result.error) {
      return { status: "failed", error: mapStripeJsError(result.error) };
    }
    const status = (result.paymentIntent ?? result.setupIntent)?.status;
    return { status: toUnifiedStatus(status) };
  }

  unmount(handle: MountedFieldsHandle): void {
    const h = asStripeHandle(handle);
    try {
      h.element.unmount();
    } finally {
      h.element.destroy();
    }
  }

  /**
   * Return-trip completion for redirect methods (iDEAL, bank redirects):
   * Stripe lands the customer on returnUrl with payment_intent_client_secret
   * (or setup_intent_client_secret) + redirect_status in the query string.
   * Resolves the actual outcome from the intent itself — redirect_status alone
   * is a hint, not the source of truth. Returns null when the URL carries no
   * Stripe return params, so callers can probe every adapter safely.
   */
  async handleRedirectReturn(location: RedirectReturnLocation): Promise<ConfirmResult | null> {
    const params = new URLSearchParams(
      location.search.startsWith("?") ? location.search.slice(1) : location.search,
    );
    const piSecret = params.get("payment_intent_client_secret");
    const setiSecret = params.get("setup_intent_client_secret");
    if (!piSecret && !setiSecret) return null;

    assertBrowser("handleRedirectReturn");
    await this.loadSdk();
    const stripe = this.stripeGlobal()!(
      this.config.publishableKey,
      this.config.locale ? { locale: this.config.locale } : undefined,
    );
    const result = piSecret
      ? await stripe.retrievePaymentIntent(piSecret)
      : await stripe.retrieveSetupIntent(setiSecret!);
    if (result.error) {
      return { status: "failed", error: mapStripeJsError(result.error) };
    }
    const status = (result.paymentIntent ?? result.setupIntent)?.status;
    if (!status) {
      return { status: "failed", error: mapStripeJsError(undefined) };
    }
    return { status: toUnifiedStatus(status) };
  }

  listPaymentMethodCapabilities(): PaymentMethodCapability[] {
    return this.config.paymentMethods ?? DEFAULT_METHODS;
  }

  private stripeGlobal(): StripeJsFactory | undefined {
    if (this.config.getStripeGlobal) return this.config.getStripeGlobal();
    if (typeof window === "undefined") return undefined;
    return (window as unknown as { Stripe?: StripeJsFactory }).Stripe;
  }
}

function assertBrowser(operation: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw PayFanoutError.invalidRequest(
      `StripeClientAdapter.${operation} is browser-only — never call it during SSR`,
    );
  }
}

function asStripeHandle(handle: MountedFieldsHandle): StripeHandle {
  const h = handle as unknown as StripeHandle;
  if (h?.pspName !== "stripe" || !h.stripe || !h.elements) {
    throw PayFanoutError.invalidRequest("Handle was not produced by StripeClientAdapter.mount");
  }
  return h;
}

function toUnifiedStatus(status: string | undefined): UnifiedPaymentStatus {
  switch (status) {
    case "requires_payment_method":
    case "requires_confirmation":
    case "requires_action":
    case "requires_capture":
    case "processing":
    case "succeeded":
    case "canceled":
      return status;
    default:
      return "processing";
  }
}

const CLIENT_CODE_MAP: Record<string, UnifiedErrorCode> = {
  insufficient_funds: "insufficient_funds",
  expired_card: "expired_card",
  incorrect_number: "invalid_card_data",
  invalid_number: "invalid_card_data",
  incorrect_cvc: "invalid_card_data",
  invalid_cvc: "invalid_card_data",
  invalid_expiry_month: "invalid_card_data",
  invalid_expiry_year: "invalid_card_data",
  incomplete_number: "invalid_card_data",
  incomplete_cvc: "invalid_card_data",
  incomplete_expiry: "invalid_card_data",
  authentication_required: "authentication_required",
  payment_intent_authentication_failure: "authentication_required",
  setup_intent_authentication_failure: "authentication_required",
  processing_error: "processing_error",
  card_declined: "card_declined",
};

function mapStripeJsError(error: StripeJsErrorLike | undefined): UnifiedError {
  const code =
    (error?.decline_code ? CLIENT_CODE_MAP[error.decline_code] : undefined) ??
    (error?.code ? CLIENT_CODE_MAP[error.code] : undefined) ??
    (error?.type === "card_error" || error?.type === "validation_error" ? "card_declined" : "unknown");
  return new PayFanoutError({
    code,
    message: error?.message ?? "Payment failed.",
    retryable: code === "processing_error" || code === "authentication_required",
    raw: error,
    pspName: "stripe",
  });
}

function injectScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${url}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(
        new PayFanoutError({
          code: "psp_unavailable",
          message: `Failed to load ${url}`,
          retryable: true,
          raw: undefined,
          pspName: "stripe",
        }),
      );
    document.head.appendChild(script);
  });
}
