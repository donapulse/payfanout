import {
  assertBrowser,
  base64UrlToUtf8,
  brandMountedFieldsHandle,
  getUserMessage,
  injectScript,
  PayFanoutError,
  type ClientPaymentAdapter,
  type ConfirmResult,
  type MountedFieldsHandle,
  type MountOptions,
  type PaymentMethodCapability,
  type UnifiedError,
  type UnifiedErrorCode,
} from "@payfanout/core";

/**
 * Structural subset of Adyen Web v6. Injected in tests, loaded from Adyen's
 * checkoutshopper CDN in browsers. Card fields render inside ADYEN-HOSTED
 * IFRAMES (SAQ A): the encrypted blob the component produces is all that ever
 * reaches the host page.
 */
export interface AdyenCardState {
  /** True once every hosted field is filled and passes Adyen's validation. */
  isValid?: boolean;
  data?: {
    /** The encrypted card blob — encryptedCardNumber, encryptedExpiryMonth/Year, encryptedSecurityCode. */
    paymentMethod?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface AdyenComponentLike {
  mount(target: HTMLElement | string): unknown;
  /** Resolves an action returned by /payments (a threeDS2 challenge runs inline). */
  handleAction?(action: Record<string, unknown>): unknown;
  unmount?(): void;
  remove?(): void;
}

export type AdyenComponentConstructor = new (
  checkout: unknown,
  options: Record<string, unknown>,
) => AdyenComponentLike;

/** `window.AdyenWeb`: AdyenCheckout is an async function, components are classes. */
export interface AdyenWebGlobal {
  AdyenCheckout: (config: Record<string, unknown>) => Promise<unknown>;
  Card: AdyenComponentConstructor;
}

export interface AdyenClientAdapterConfig {
  /** Browser-safe client key ("test_…"/"live_…"); its origins are allowlisted in the Customer Area. */
  clientKey: string;
  /** Explicit; selects the CDN host and the SDK's own environment value. */
  environment: "sandbox" | "live";
  /** ISO 3166-1 alpha-2. Adyen Web v6 requires it on the checkout instance. */
  countryCode: string;
  /** BCP-47 locale for Adyen's own field texts. MountOptions.locale wins per mount. */
  locale?: string;
  /**
   * Overrides the environment value handed to Adyen Web — for the regional live
   * values (e.g. a live account served from a specific region).
   */
  adyenEnvironment?: string;
  /** Account capabilities vary per contract — override the conservative default. */
  paymentMethods?: PaymentMethodCapability[];
  /** Adyen Web version to load from the CDN. Pinned, never floating. */
  sdkVersion?: string;
  /** Test seams / self-hosting. */
  sdkUrl?: string;
  stylesheetUrl?: string;
  loadScript?: (url: string) => Promise<void>;
  loadStylesheet?: (url: string) => Promise<void>;
  getAdyenGlobal?: () => AdyenWebGlobal | undefined;
}

/**
 * Adyen Web version the adapter loads by default. Moving it means reading
 * Adyen's release notes for the gap — the CDN path is versioned precisely so a
 * checkout never floats onto an untested SDK. This build requires Checkout API
 * v69 or later, which the server adapter's pinned version satisfies.
 */
export const ADYEN_WEB_VERSION = "6.41.0";

const DEFAULT_METHODS: PaymentMethodCapability[] = [{ type: "card", flow: "embedded", supported: true }];

interface AdyenHandle {
  pspName: "adyen";
  /** Absent only between creating the container and the component mounting into it. */
  component?: AdyenComponentLike;
  /** Latest onChange state — confirm() reads the encrypted blob from it. */
  state?: AdyenCardState;
  /** Set while handleAction waits for the component's additional details. */
  pendingDetails?: (result: ConfirmResult) => void;
  cleanup: () => void;
}

/** A handle that made it out of mount(), so its component exists. */
interface MountedAdyenHandle extends AdyenHandle {
  component: AdyenComponentLike;
}

let mountCounter = 0;

export class AdyenClientAdapter implements ClientPaymentAdapter {
  readonly pspName = "adyen";
  private readonly config: AdyenClientAdapterConfig;
  private sdkPromise?: Promise<void>;

  constructor(config: AdyenClientAdapterConfig) {
    if (config.environment !== "sandbox" && config.environment !== "live") {
      throw PayFanoutError.invalidRequest('AdyenClientAdapter config.environment must be "sandbox" or "live"');
    }
    if (!config.clientKey) {
      throw PayFanoutError.invalidRequest("AdyenClientAdapter config.clientKey is required");
    }
    if (!config.countryCode) {
      throw PayFanoutError.invalidRequest(
        "AdyenClientAdapter config.countryCode is required (Adyen Web takes it on the checkout instance)",
      );
    }
    this.config = config;
  }

  async loadSdk(): Promise<void> {
    assertBrowser("AdyenClientAdapter", "loadSdk");
    if (this.adyenGlobal()) return;
    const url = this.config.sdkUrl ?? `${this.cdnBase()}/adyen.js`;
    const stylesheet = this.config.stylesheetUrl ?? `${this.cdnBase()}/adyen.css`;
    this.sdkPromise ??= Promise.all([
      this.config.loadScript ? this.config.loadScript(url) : injectScript(url, this.pspName),
      this.injectStylesheet(stylesheet),
    ])
      .then(() => undefined)
      .catch((err: unknown) => {
        // A flaky script load must not poison every later mount — clear the
        // cached promise so the next loadSdk() retries the injection.
        this.sdkPromise = undefined;
        throw err;
      });
    await this.sdkPromise;
    if (!this.adyenGlobal()) {
      throw new PayFanoutError({
        code: "psp_unavailable",
        message: "Adyen Web loaded but the AdyenWeb global is missing",
        retryable: true,
        raw: undefined,
        pspName: this.pspName,
      });
    }
  }

  /**
   * Renders Adyen's Card component into a generated child of `container`. The
   * fields live in Adyen-hosted iframes, so no card data touches the host page.
   * `options.appearance` becomes Adyen's `styles` object and
   * `options.fieldOptions` passes through untouched (the host wins), except the
   * two keys the adapter must own: `showPayButton` (the host's own button drives
   * submission) and `onChange` (the encrypted blob arrives on it).
   */
  async mount(container: HTMLElement, options: MountOptions): Promise<MountedFieldsHandle> {
    assertBrowser("AdyenClientAdapter", "mount");
    await this.loadSdk();
    const { AdyenCheckout, Card } = this.adyenGlobal()!;
    const child = document.createElement("div");
    child.id = `payfanout-adyen-${++mountCounter}`;
    container.appendChild(child);
    // Initialize the host's "disable Pay until complete" state before the SDK
    // has said anything.
    options.onChange?.({ complete: false, empty: true });
    const handle: AdyenHandle = {
      pspName: "adyen",
      cleanup: () => {
        try {
          handle.component?.unmount?.();
          handle.component?.remove?.();
        } catch {
          // Teardown is best-effort — SDK variants must not break unmount.
        }
        child.remove();
      },
    };
    try {
      const session = readSessionPayload(options.clientSecret);
      const checkout = await AdyenCheckout({
        clientKey: this.config.clientKey,
        environment: this.adyenEnvironmentValue(),
        countryCode: this.config.countryCode,
        ...(options.locale ?? this.config.locale ? { locale: options.locale ?? this.config.locale } : {}),
        ...(session ? { amount: { value: session.amount, currency: session.currency } } : {}),
        onAdditionalDetails: (state: { data?: Record<string, unknown> }) => {
          handle.pendingDetails?.({
            status: "requires_confirmation",
            clientToken: JSON.stringify(state?.data ?? {}),
          });
          handle.pendingDetails = undefined;
        },
        onError: (err: unknown) => options.onError?.(mapAdyenClientError(err)),
      });
      const component = new Card(checkout, {
        ...(options.appearance ? { styles: options.appearance } : {}),
        ...(options.fieldOptions ?? {}),
        showPayButton: false,
        onChange: (state: AdyenCardState) => {
          handle.state = state;
          options.onChange?.({ complete: state?.isValid === true });
        },
      });
      component.mount(child);
      handle.component = component;
      options.onReady?.();
      return brandMountedFieldsHandle(handle);
    } catch (err) {
      handle.cleanup();
      const mapped = mapAdyenClientError(err);
      options.onError?.(mapped);
      throw mapped;
    }
  }

  /**
   * Tokenize-first shape: resolves requires_confirmation plus the encrypted
   * paymentMethod blob as the clientToken. The host passes it to the server's
   * completePayment (<PayButton> / completionEndpoint wire it automatically),
   * which creates the Adyen payment.
   */
  async confirm(handle: MountedFieldsHandle): Promise<ConfirmResult> {
    const h = asAdyenHandle(handle);
    const paymentMethod = h.state?.data?.paymentMethod;
    if (h.state?.isValid !== true || !paymentMethod) {
      return {
        status: "failed",
        error: buildError("invalid_card_data", { isValid: h.state?.isValid ?? false }),
      };
    }
    return { status: "requires_confirmation", clientToken: JSON.stringify(paymentMethod) };
  }

  /**
   * Resolves an Adyen `action` — the object completePayment surfaced on
   * `PaymentInfo.raw` when it answered requires_action. The component runs the
   * challenge INLINE (a threeDS2 action needs no navigation) and resolves with a
   * fresh clientToken carrying the additional details; the host completes the
   * payment with it exactly as it did the first token.
   *
   * Adapter-specific: the unified contract has no action-handling method, since
   * most PSPs resolve challenges inside confirm().
   *
   * One challenge at a time per mounted handle: the returned promise settles
   * when Adyen reports the shopper's additional details, so a second call while
   * one is outstanding is refused rather than replacing the pending resolver
   * (which would strand the first caller's promise forever). A host that wants a
   * deadline on an abandoned challenge races this promise against its own timer.
   */
  async handleAction(handle: MountedFieldsHandle, action: Record<string, unknown>): Promise<ConfirmResult> {
    const h = asAdyenHandle(handle);
    if (typeof h.component.handleAction !== "function") {
      return { status: "failed", error: buildError("psp_unavailable", { action }) };
    }
    if (h.pendingDetails) {
      return { status: "failed", error: buildError("invalid_request", { action }) };
    }
    return new Promise<ConfirmResult>((resolve) => {
      h.pendingDetails = resolve;
      try {
        h.component.handleAction!(action);
      } catch (err) {
        h.pendingDetails = undefined;
        resolve({ status: "failed", error: mapAdyenClientError(err) });
      }
    });
  }

  unmount(handle: MountedFieldsHandle): void {
    asAdyenHandle(handle).cleanup();
  }

  listPaymentMethodCapabilities(): PaymentMethodCapability[] {
    return this.config.paymentMethods ?? DEFAULT_METHODS;
  }

  private cdnBase(): string {
    const host = this.config.environment === "live" ? "checkoutshopper-live" : "checkoutshopper-test";
    return `https://${host}.cdn.adyen.com/checkoutshopper/sdk/${this.config.sdkVersion ?? ADYEN_WEB_VERSION}`;
  }

  private adyenEnvironmentValue(): string {
    return this.config.adyenEnvironment ?? (this.config.environment === "live" ? "live" : "test");
  }

  private injectStylesheet(url: string): Promise<void> {
    if (this.config.loadStylesheet) return this.config.loadStylesheet(url);
    return new Promise<void>((resolve) => {
      if (document.querySelector(`link[href="${url}"]`)) {
        resolve();
        return;
      }
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = url;
      // Styling is cosmetic: a stylesheet that fails to load must never block
      // the fields from mounting.
      link.onload = () => resolve();
      link.onerror = () => resolve();
      document.head.appendChild(link);
    });
  }

  private adyenGlobal(): AdyenWebGlobal | undefined {
    if (this.config.getAdyenGlobal) return this.config.getAdyenGlobal();
    if (typeof window === "undefined") return undefined;
    return (window as unknown as { AdyenWeb?: AdyenWebGlobal }).AdyenWeb;
  }
}

function asAdyenHandle(handle: MountedFieldsHandle): MountedAdyenHandle {
  const h = handle as unknown as AdyenHandle;
  if (h?.pspName !== "adyen" || !h.component) {
    throw PayFanoutError.invalidRequest("Handle was not produced by AdyenClientAdapter.mount");
  }
  return h as MountedAdyenHandle;
}

/**
 * The session facts the signed `pspSessionId` carries in its payload half. The
 * browser reads them without the signing key (it cannot forge the token, and the
 * server re-reads the signed copy at completion) so Adyen Web can show the right
 * amount.
 */
function readSessionPayload(clientSecret: string): { amount: number; currency: string } | undefined {
  const dot = clientSecret?.indexOf(".") ?? -1;
  if (dot <= 0) return undefined;
  try {
    const payload = JSON.parse(base64UrlToUtf8(clientSecret.slice(0, dot))) as {
      amount?: number;
      currency?: string;
    };
    if (typeof payload.amount !== "number" || typeof payload.currency !== "string") return undefined;
    return { amount: payload.amount, currency: payload.currency };
  } catch {
    // A host may hand a session shape from a future adapter version; the amount
    // is cosmetic here, so degrade instead of failing the mount.
    return undefined;
  }
}

interface AdyenClientErrorLike {
  message?: string;
  errorText?: string;
  error?: { message?: string };
}

function extractMessage(err: unknown): string {
  if (typeof err === "string") return err;
  const e = err as AdyenClientErrorLike | undefined;
  return e?.message ?? e?.errorText ?? e?.error?.message ?? "";
}

/**
 * Maps an Adyen Web failure onto the unified taxonomy. The browser only
 * validates and encrypts card DATA — the authorisation happens server-side at
 * completePayment — so a client-side failure is a card-data problem unless it
 * looks like an SDK/network load issue.
 */
function mapAdyenClientError(err: unknown): UnifiedError {
  const message = extractMessage(err);
  const code: UnifiedErrorCode = /load|network|script|timeout|unavailable/i.test(message)
    ? "psp_unavailable"
    : "invalid_card_data";
  return buildError(code, err);
}

function buildError(code: UnifiedErrorCode, raw: unknown): UnifiedError {
  return new PayFanoutError({
    code,
    message: getUserMessage(code),
    retryable: code === "psp_unavailable",
    raw,
    pspName: "adyen",
  });
}
