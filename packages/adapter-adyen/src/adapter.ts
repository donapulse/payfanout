import {
  assertBrowser,
  base64UrlToUtf8,
  brandMountedFieldsHandle,
  getUserMessage,
  injectScript,
  injectStylesheet,
  isValidCspNonce,
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
    /** The browser characteristics Adyen's 3-D Secure 2 needs from a web page. */
    browserInfo?: Record<string, unknown>;
    /** `window.location.origin` of the page the fields are on. */
    origin?: string;
    /** Present when `billingAddressRequired` is set on the Card. */
    billingAddress?: Record<string, unknown>;
    /** Adyen Web's device fingerprint, as `{ clientData }`. */
    riskData?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface AdyenComponentLike {
  mount(target: HTMLElement | string): unknown;
  /**
   * Resolves an action returned by /payments. The component unmounts itself and
   * mounts the action in its place: a threeDS2 action runs inline, a redirect
   * navigates the page away.
   */
  handleAction?(action: Record<string, unknown>): unknown;
  /** Shows the fields' own validation errors. */
  showValidation?(): unknown;
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
  /**
   * Browser-safe client key; its origins are allowlisted in the Customer Area.
   * Adyen prefixes every client key with its environment, and the constructor
   * refuses a client key that does not start with `test_` on sandbox or
   * `live_` on live (a legacy origin key included).
   */
  clientKey: string;
  /** Explicit; selects the client key prefix, the CDN host and the SDK's own environment value. */
  environment: "sandbox" | "live";
  /** ISO 3166-1 alpha-2. Adyen Web v6 requires it on the checkout instance. */
  countryCode: string;
  /** BCP-47 locale for Adyen's own field texts. MountOptions.locale wins per mount. */
  locale?: string;
  /**
   * The environment value handed to Adyen Web, which also selects the CDN host
   * the SDK loads from (`checkoutshopper-{value}.cdn.adyen.com`): Adyen requires
   * both to match the region of the account's live endpoints. Defaults to
   * `"test"` on sandbox and `"live"` (Europe) on live; a live account served
   * from another region sets `"live-us"`, `"live-au"`, `"live-nea"`, `"live-in"`
   * or `"live-apse"`. The value is lowercased first, as Adyen Web does itself.
   * `"live-apse"` is accepted because Adyen Web types it and maps it to its own
   * hosts, which serve the pinned build, though Adyen's v6 integration guides
   * do not list it. Any other value, or one that contradicts `environment`, is
   * refused at construction.
   */
  adyenEnvironment?: string;
  /** Account capabilities vary per contract — override the conservative default. */
  paymentMethods?: PaymentMethodCapability[];
  /**
   * Adyen Web version to load from the CDN instead of ADYEN_WEB_VERSION. Pinned,
   * never floating. The adapter carries Adyen's integrity hashes for its own
   * pinned build only, so with this set both files load without an integrity
   * check.
   */
  sdkVersion?: string;
  /** Self-hosting: the script URL to load instead of Adyen's CDN copy, without an integrity check. */
  sdkUrl?: string;
  /**
   * Self-hosting: the stylesheet URL to load instead of Adyen's CDN copy,
   * without an integrity check. An empty string loads no stylesheet, for a page
   * that ships Adyen Web's styles itself. `loadSdk()` waits for the sheet to
   * load or fail, and with it for every sheet it `@import`s, so a sheet that
   * imports from a slow host delays the first mount on each page load.
   */
  stylesheetUrl?: string;
  /**
   * A Content-Security-Policy nonce for the two tags the adapter injects, the
   * Adyen Web `<script>` and the stylesheet `<link>`, set as their `nonce`
   * attribute before insertion, so a `script-src` and a `style-src` that allow
   * them by nonce load them; a `'strict-dynamic'` `script-src` allows the
   * script without one, and never applies to styles. The Card component
   * reads no nonce and adds no script or `<style>` of its own, unless
   * `fieldOptions` configures a wallet such as Click to Pay. Pass the value
   * alone, as in the policy's `'nonce-<value>'` source; the constructor
   * refuses anything else. The adapter never reads a nonce from the page, and
   * the `loadScript` and `loadStylesheet` seams load their file without it.
   */
  cspNonce?: string;
  /** Test seam: loads the script in place of the adapter's injection, which carries the integrity check. */
  loadScript?: (url: string) => Promise<void>;
  /** Test seam: loads the stylesheet in place of the adapter's injection, which carries the integrity check. */
  loadStylesheet?: (url: string) => Promise<void>;
  /** Test seam: returns the SDK in place of `window.AdyenWeb`. */
  getAdyenGlobal?: () => AdyenWebGlobal | undefined;
}

/**
 * Adyen Web version the adapter loads by default. Moving it means reading
 * Adyen's release notes for the gap and replacing both integrity hashes below —
 * the CDN path is versioned precisely so a checkout never floats onto an
 * untested SDK. This build requires Checkout API v69 or later, which the server
 * adapter's pinned version satisfies.
 */
export const ADYEN_WEB_VERSION = "6.45.2";

/**
 * The Subresource Integrity hash Adyen publishes for ADYEN_WEB_VERSION's
 * adyen.js (release notes, "Updating to this version"), which the adapter puts
 * on the script it loads from its default URL. Adyen asks for the same hash on
 * its test and regional hosts, which serve identical files. A `<script>` the
 * page adds itself for that URL must carry it, with a `crossorigin` attribute,
 * or loadSdk() rejects with invalid_request while `window.AdyenWeb` is not
 * defined yet.
 */
export const ADYEN_WEB_SCRIPT_INTEGRITY = "sha384-crX4Byf88JpnQfdUaDuwVOj3qlk5tmSa3rhIalmJIyo1kC49EDIcnNQ9fY5blVUV";

/**
 * The Subresource Integrity hash Adyen publishes for ADYEN_WEB_VERSION's
 * adyen.css, which the adapter puts on the stylesheet it loads from its
 * default URL. A `<link>` the page adds itself for that URL is used as it is,
 * so it keeps the check only if it carries this hash and a `crossorigin`
 * attribute.
 */
export const ADYEN_WEB_STYLESHEET_INTEGRITY = "sha384-KhV4iC2YVQosq5vzx0xN0yGDVMZA++mbd6obc2JKUszVBdXmexFTRHOXKh5DcqDF";

/**
 * The `environment` values Adyen Web 6.45.2 types and maps to their own API
 * and CDN hosts; for any other value it falls back to the European live hosts.
 * Adyen's v6 integration guides document all but `live-apse`, which Adyen's
 * release notes last list for 5.72.0 and whose CDN host serves the pinned build.
 */
const ADYEN_ENVIRONMENTS: readonly string[] = [
  "test", "live", "live-us", "live-au", "live-nea", "live-in", "live-apse",
];

const DEFAULT_METHODS: PaymentMethodCapability[] = [{ type: "card", flow: "embedded", supported: true }];

interface AdyenHandle {
  pspName: "adyen";
  /** Absent only between creating the container and the component mounting into it. */
  component?: AdyenComponentLike;
  /** Latest onChange state — confirm() reads the encrypted blob from it. */
  state?: AdyenCardState;
  /** Set while handleAction waits for the component's additional details. */
  pendingDetails?: (result: ConfirmResult) => void;
  /** Set once handleAction ran: the Card was unmounted to make room for the action. */
  cardReplaced?: boolean;
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
  /** The validated value handed to Adyen Web; it also names the CDN host. */
  private readonly adyenEnvironment: string;
  private sdkPromise?: Promise<void>;

  constructor(config: AdyenClientAdapterConfig) {
    if (config.environment !== "sandbox" && config.environment !== "live") {
      throw PayFanoutError.invalidRequest('AdyenClientAdapter config.environment must be "sandbox" or "live"');
    }
    if (typeof config.clientKey !== "string" || !config.clientKey) {
      throw PayFanoutError.invalidRequest("AdyenClientAdapter config.clientKey is required");
    }
    if (!config.countryCode) {
      throw PayFanoutError.invalidRequest(
        "AdyenClientAdapter config.countryCode is required (Adyen Web takes it on the checkout instance)",
      );
    }
    const live = config.environment === "live";
    const keyPrefix = live ? "live_" : "test_";
    if (!config.clientKey.startsWith(keyPrefix)) {
      const otherPrefix = live ? "test_" : "live_";
      throw PayFanoutError.invalidRequest(
        config.clientKey.startsWith(otherPrefix)
          ? `AdyenClientAdapter config.clientKey is a ${otherPrefix} key, ` +
              `but config.environment "${config.environment}" takes a ${keyPrefix} key`
          : `AdyenClientAdapter config.clientKey must start with ${keyPrefix} ` +
              `for config.environment "${config.environment}"`,
      );
    }
    const requested: unknown = config.adyenEnvironment ?? (live ? "live" : "test");
    if (typeof requested !== "string") {
      throw PayFanoutError.invalidRequest(
        `AdyenClientAdapter config.adyenEnvironment must be a string, not ${typeof requested}`,
      );
    }
    // Adyen Web lowercases the value before reading it; the CDN host follows the same form.
    const adyenEnvironment = requested.toLowerCase();
    if (!ADYEN_ENVIRONMENTS.includes(adyenEnvironment)) {
      throw PayFanoutError.invalidRequest(
        `AdyenClientAdapter config.adyenEnvironment ${JSON.stringify(requested)} is not an environment value ` +
          `Adyen Web supports: ${ADYEN_ENVIRONMENTS.map((value) => `"${value}"`).join(", ")}`,
      );
    }
    if ((adyenEnvironment === "test") === live) {
      throw PayFanoutError.invalidRequest(
        `AdyenClientAdapter config.adyenEnvironment ${JSON.stringify(requested)} contradicts config.environment ` +
          `"${config.environment}", which takes ${live ? '"live" or a regional "live-…" value' : '"test"'}`,
      );
    }
    if (config.cspNonce !== undefined && !isValidCspNonce(config.cspNonce)) {
      throw PayFanoutError.invalidRequest(
        "AdyenClientAdapter config.cspNonce must be the value of the policy's 'nonce-…' source: base64 or base64url characters",
      );
    }
    this.config = config;
    this.adyenEnvironment = adyenEnvironment;
  }

  /**
   * Loads Adyen Web's script and stylesheet once, from the CDN host of the
   * configured Adyen environment. Loaded from their default URLs, both files
   * carry the Subresource Integrity hash Adyen publishes for ADYEN_WEB_VERSION;
   * `sdkVersion` turns the check off for both, `sdkUrl` for the script and
   * `stylesheetUrl` for the stylesheet. With `cspNonce` both carry the nonce.
   * If the script fails to load, the next call fetches it again; a stylesheet
   * that failed stays on the page and is reused, as core's `injectStylesheet`
   * keeps every link it injects. If the script loaded without defining
   * `window.AdyenWeb`, the next call checks again instead of failing from a
   * cached result.
   */
  async loadSdk(): Promise<void> {
    assertBrowser("AdyenClientAdapter", "loadSdk");
    if (this.adyenGlobal()) return;
    const pinnedBuild = this.config.sdkVersion === undefined;
    const url = this.config.sdkUrl ?? `${this.cdnBase()}/adyen.js`;
    const stylesheet = this.config.stylesheetUrl ?? `${this.cdnBase()}/adyen.css`;
    const scriptIntegrity = pinnedBuild && this.config.sdkUrl === undefined ? ADYEN_WEB_SCRIPT_INTEGRITY : undefined;
    const stylesheetIntegrity =
      pinnedBuild && this.config.stylesheetUrl === undefined ? ADYEN_WEB_STYLESHEET_INTEGRITY : undefined;
    const nonce = this.config.cspNonce;
    const loading = (this.sdkPromise ??= Promise.all([
      this.config.loadScript
        ? this.config.loadScript(url)
        : injectScript(url, this.pspName, { integrity: scriptIntegrity, nonce }),
      // A sheet that fails to load resolves too: styling must never block the fields.
      this.config.loadStylesheet
        ? this.config.loadStylesheet(stylesheet)
        : injectStylesheet(stylesheet, this.pspName, { integrity: stylesheetIntegrity, nonce }),
    ])
      .then(() => undefined)
      .catch((err: unknown) => {
        // A flaky script load must not poison every later mount — clear the
        // cached promise so the next loadSdk() retries the injection.
        this.sdkPromise = undefined;
        throw err;
      }));
    await loading;
    if (!this.adyenGlobal()) {
      // The load can resolve without the global: a script the page added itself
      // for the URL is reused at once, even while it is still loading or after
      // it failed, and a file can load without defining it. Forget this load so
      // the next call checks again instead of failing from a cached result (a
      // host loadScript runs again).
      if (this.sdkPromise === loading) this.sdkPromise = undefined;
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
   *
   * Two Card defaults differ from Adyen Web's, and `fieldOptions` still wins
   * over both: the cardholder name is shown and required (`hasHolderName`,
   * `holderNameRequired`), since Adyen's native 3-D Secure 2 guide lists it as
   * required for Visa and JCB — `hasHolderName: false` alone hides it, and
   * Adyen Web then drops the requirement too — and `onEnterKeyPressed` does
   * nothing, since Adyen Web's default handler calls submit(), which has no
   * `onSubmit` to call here.
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
        // A pending action can no longer finish once its fields are gone.
        settlePendingDetails(handle, {
          status: "failed",
          error: buildError("authentication_required", { reason: "unmounted before the action finished" }),
        });
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
        environment: this.adyenEnvironment,
        countryCode: this.config.countryCode,
        ...(options.locale ?? this.config.locale ? { locale: options.locale ?? this.config.locale } : {}),
        ...(session ? { amount: { value: session.amount, currency: session.currency } } : {}),
        onAdditionalDetails: (state: { data?: Record<string, unknown> }) => {
          settlePendingDetails(handle, {
            status: "requires_confirmation",
            clientToken: JSON.stringify(state?.data ?? {}),
          });
        },
        onError: (err: unknown) => {
          // An error during an action is the shopper's authentication failing,
          // not the card data the fields validate.
          const mapped = mapAdyenClientError(err, handle.pendingDetails ? "authentication_required" : "invalid_card_data");
          // Adyen Web's 3-D Secure 2 elements report timeouts through
          // onAdditionalDetails and call onError only when they stop, so a
          // pending challenge will never deliver its details.
          settlePendingDetails(handle, { status: "failed", error: mapped });
          options.onError?.(mapped);
        },
      });
      const component = new Card(checkout, {
        hasHolderName: true,
        holderNameRequired: true,
        onEnterKeyPressed: () => undefined,
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
   * Tokenize-first shape: resolves requires_confirmation plus a JSON
   * clientToken, `{ paymentMethod, browserInfo?, origin?, billingAddress?,
   * riskData? }` — the encrypted card blob and the browser data Adyen's 3-D
   * Secure 2 asks the page for, taken from Adyen Web's state. The host passes
   * it to the server's completePayment (<PayButton> / completionEndpoint wire
   * it automatically), which creates the Adyen payment.
   *
   * Incomplete fields resolve `failed` after asking the Card to show its own
   * validation errors. Once handleAction ran on the handle the Card is gone —
   * Adyen Web replaced it with the action — so confirm() resolves `failed` with
   * invalid_request rather than resubmit card data a payment already used;
   * remount the fields to pay again.
   */
  async confirm(handle: MountedFieldsHandle): Promise<ConfirmResult> {
    const h = asAdyenHandle(handle);
    if (h.cardReplaced) {
      return {
        status: "failed",
        error: buildError("invalid_request", {
          reason: "handleAction replaced the Card with the action; remount the fields to pay again",
        }),
      };
    }
    const data = h.state?.data;
    if (h.state?.isValid !== true || !data || !isPlainObject(data.paymentMethod)) {
      try {
        h.component.showValidation?.();
      } catch {
        // Showing the field errors is a courtesy; the failed result stands either way.
      }
      return {
        status: "failed",
        error: buildError("invalid_card_data", { isValid: h.state?.isValid ?? false }),
      };
    }
    return { status: "requires_confirmation", clientToken: JSON.stringify(toClientTokenEnvelope(data)) };
  }

  /**
   * Resolves an Adyen `action` — the object completePayment surfaced on
   * `PaymentInfo.raw` when it answered requires_action. Adyen Web unmounts the
   * Card and mounts the action in its node: a threeDS2 action runs INLINE and
   * resolves with a fresh clientToken carrying the additional details, which
   * the host completes the payment with exactly as it did the first token; a
   * redirect action navigates the page to Adyen, so this promise never settles
   * and the payment finishes on the return page (see adyenRedirectResultToken).
   *
   * Adapter-specific: the unified contract has no action-handling method, since
   * most PSPs resolve challenges inside confirm().
   *
   * One challenge at a time per mounted handle: the returned promise settles
   * when Adyen reports the shopper's additional details, or `failed` when Adyen
   * Web reports an error through onError meanwhile or the fields are unmounted
   * first, so a second call while one is outstanding is refused rather than
   * replacing the pending resolver (which would strand the first caller's
   * promise forever). An error raised while the action runs is
   * `authentication_required`, unless Adyen Web names it a network or script
   * error, or its message reads as one (`psp_unavailable`). A host that wants a
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
      // Set before the call: a build that throws may already have unmounted the Card.
      h.cardReplaced = true;
      try {
        h.component.handleAction!(action);
      } catch (err) {
        settlePendingDetails(h, { status: "failed", error: mapAdyenClientError(err, "authentication_required") });
      }
    });
  }

  unmount(handle: MountedFieldsHandle): void {
    asAdyenHandle(handle).cleanup();
  }

  listPaymentMethodCapabilities(): PaymentMethodCapability[] {
    return this.config.paymentMethods ?? DEFAULT_METHODS;
  }

  /** Adyen requires the files to come from the region the environment value names. */
  private cdnBase(): string {
    const version = this.config.sdkVersion ?? ADYEN_WEB_VERSION;
    return `https://checkoutshopper-${this.adyenEnvironment}.cdn.adyen.com/checkoutshopper/sdk/${version}`;
  }

  private adyenGlobal(): AdyenWebGlobal | undefined {
    if (this.config.getAdyenGlobal) return this.config.getAdyenGlobal();
    if (typeof window === "undefined") return undefined;
    return (window as unknown as { AdyenWeb?: AdyenWebGlobal }).AdyenWeb;
  }
}

/**
 * The clientToken the return page of Adyen's 3-D Secure redirect flow
 * completes the payment with. Adyen sends the shopper back to the session's
 * returnUrl with a `redirectResult` query parameter appended; pass its value
 * as `URLSearchParams.get("redirectResult")` returns it (already decoded) and
 * complete with the result like any other clientToken — the server adapter
 * sends it to /payments/details, within the signed session's expiry.
 */
export function adyenRedirectResultToken(redirectResult: string): string {
  if (typeof redirectResult !== "string" || redirectResult.length === 0) {
    throw PayFanoutError.invalidRequest(
      "adyenRedirectResultToken takes the redirectResult query parameter Adyen appends to the returnUrl",
      { reason: "missing redirectResult" },
    );
  }
  return JSON.stringify({ details: { redirectResult } });
}

function asAdyenHandle(handle: MountedFieldsHandle): MountedAdyenHandle {
  const h = handle as unknown as AdyenHandle;
  if (h?.pspName !== "adyen" || !h.component) {
    throw PayFanoutError.invalidRequest("Handle was not produced by AdyenClientAdapter.mount");
  }
  return h as MountedAdyenHandle;
}

/** Clears the resolver before calling it, so a callback that fires twice settles the promise once. */
function settlePendingDetails(handle: AdyenHandle, result: ConfirmResult): void {
  const resolve = handle.pendingDetails;
  handle.pendingDetails = undefined;
  resolve?.(result);
}

/**
 * The part of Adyen Web's state the server adapter forwards to /payments. It
 * reads nothing else, so the rest of the state (installments,
 * storePaymentMethod, …) is not sent.
 */
function toClientTokenEnvelope(data: NonNullable<AdyenCardState["data"]>): Record<string, unknown> {
  return {
    paymentMethod: data.paymentMethod,
    ...(isPlainObject(data.browserInfo) ? { browserInfo: data.browserInfo } : {}),
    ...(typeof data.origin === "string" ? { origin: data.origin } : {}),
    ...(isPlainObject(data.billingAddress) ? { billingAddress: data.billingAddress } : {}),
    ...(isPlainObject(data.riskData) ? { riskData: data.riskData } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  name?: unknown;
  message?: string;
  errorText?: string;
  error?: { message?: string };
}

function extractMessage(err: unknown): string {
  if (typeof err === "string") return err;
  const e = err as AdyenClientErrorLike | undefined;
  return e?.message ?? e?.errorText ?? e?.error?.message ?? "";
}

function extractName(err: unknown): string | undefined {
  const name = typeof err === "object" && err !== null ? (err as AdyenClientErrorLike).name : undefined;
  return typeof name === "string" ? name : undefined;
}

/**
 * Maps an Adyen Web failure onto the unified taxonomy. The browser only
 * validates and encrypts card DATA — the authorisation happens server-side at
 * completePayment — so a client-side failure is `fallback` (a card-data
 * problem, or an authentication one while an action runs) unless it is an SDK
 * load or network failure (`psp_unavailable`).
 *
 * The `name` Adyen Web gives its errors decides first: `NETWORK_ERROR` (a call
 * to Adyen failed; Adyen asks for the shopper to try again) and `SCRIPT_ERROR`
 * (a script failed to load) are `psp_unavailable`, and `IMPLEMENTATION_ERROR`
 * (a method or parameter Adyen Web does not support) is `invalid_request`,
 * though still `authentication_required` while an action runs. The generic
 * `ERROR`, the other names (`CANCEL`, `API_ERROR`, `SDK_ERROR`) and errors
 * without one are read by their message, as a load or network failure or as
 * `fallback`.
 */
function mapAdyenClientError(
  err: unknown,
  fallback: "invalid_card_data" | "authentication_required" = "invalid_card_data",
): UnifiedError {
  const name = extractName(err);
  let code: UnifiedErrorCode;
  if (name === "NETWORK_ERROR" || name === "SCRIPT_ERROR") {
    code = "psp_unavailable";
  } else if (name === "IMPLEMENTATION_ERROR") {
    code = fallback === "authentication_required" ? fallback : "invalid_request";
  } else {
    code = /load|network|script|timeout|unavailable/i.test(extractMessage(err)) ? "psp_unavailable" : fallback;
  }
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
