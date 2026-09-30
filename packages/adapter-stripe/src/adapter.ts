import {
  assertBrowser,
  brandMountedFieldsHandle,
  getUserMessage,
  injectScript,
  isValidCspNonce,
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

/** `window.Stripe`: the `Stripe(publishableKey, options?)` initializer. */
export interface StripeJsFactory {
  (publishableKey: string, options?: Record<string, unknown>): StripeJsLike;
  /**
   * The build the global belongs to, as the served Stripe.js files set it and
   * Stripe's own `@stripe/stripe-js` loader reads it: `3` for v3, the release
   * name (`"dahlia"`) for a versioned build, `2` for the legacy v2.
   */
  version?: number | string;
  /**
   * Beside a Stripe.js v2 global, v3 and the versioned builds attach
   * themselves here instead of replacing `window.Stripe`.
   */
  StripeV3?: StripeJsFactory;
}

export interface StripeClientAdapterConfig {
  publishableKey: string;
  /** Explicit, mirrors the server adapter — never inferred from key prefixes. */
  environment: "sandbox" | "live";
  /**
   * The Stripe API version the server adapter pins, such as
   * `"2026-08-26.dahlia"` or `"2024-06-20"`, or, while the server is on a
   * release this adapter does not know yet, a version of the newest release it
   * knows. Required: it picks the Stripe.js build, which decides the API
   * version the browser half speaks.
   *
   * - A version with a release name loads that release's build,
   *   `https://js.stripe.com/<release>/stripe.js`, for the releases this
   *   adapter knows: acacia, basil, clover and dahlia. Stripe pins each build
   *   to an API version of its release and lets nothing override it, so the
   *   browser speaks the release, not necessarily the date: a field or code a
   *   later monthly version of the release added may reach the server and not
   *   the browser.
   * - A date alone, the form of every version before 2024-09-30.acacia, loads
   *   `https://js.stripe.com/v3` and passes the version to `Stripe()` as
   *   `apiVersion`, an option only v3 takes, so the browser speaks exactly it.
   *
   * A Stripe.js the page already runs is used instead of loading this build
   * (see `loadSdk()`). The constructor refuses with `invalid_request` a missing
   * or malformed version, a date alone from 2024-09-30 on, a release this
   * adapter knows no build for, a preview version and a version carrying beta
   * headers (`"…; name=v1"`), as no Stripe.js build speaks the last two.
   */
  apiVersion: string;
  /** Used for redirect-based methods; card/3DS flows stay inline (redirect: "if_required"). */
  returnUrl?: string;
  locale?: string;
  /** Override the capability list per account/currency instead of hardcoding. */
  paymentMethods?: PaymentMethodCapability[];
  /**
   * A Content-Security-Policy nonce for the Stripe.js `<script>` the adapter
   * injects, set as its `nonce` attribute before the tag is inserted, so a
   * `script-src` that allows scripts by nonce without `'strict-dynamic'` runs
   * it. Stripe.js reads no nonce itself: it loads its lazy chunks from
   * `https://js.stripe.com` without one, which such a policy blocks unless it
   * also lists that host. Pass the value alone, as in the policy's
   * `'nonce-<value>'` source; the constructor refuses anything else. The
   * adapter never reads a nonce from the page, and a `loadScript` seam loads
   * the script without it.
   */
  cspNonce?: string;
  /**
   * Hides the testing assistant Stripe.js shows at the bottom right of a
   * sandbox page with Elements, on by default for the Payment Intents API from
   * the clover build on, by passing `developerTools: { assistant: { enabled:
   * false } }` to `Stripe()`. Live mode never shows it. Unset or `false` leaves
   * Stripe's default.
   */
  hideTestingAssistant?: boolean;
  /**
   * Test seams: script injection + global lookup. `loadScript` receives the
   * URL of the build `apiVersion` names, and is called again by the next
   * loadSdk() after an attempt that rejects or leaves the SDK global missing,
   * so it must be safe to call more than once. What `getStripeGlobal` returns
   * is used as `window.Stripe` is.
   */
  loadScript?: (url: string) => Promise<void>;
  getStripeGlobal?: () => StripeJsFactory | undefined;
}

const STRIPE_JS_V3_URL = "https://js.stripe.com/v3";

/**
 * The releases docs.stripe.com documents a versioned Stripe.js build for, the
 * newest last; the builds began with acacia. A release Stripe adds later loads
 * once it is added here, after reading its changelog.
 */
const STRIPE_JS_RELEASES: readonly string[] = ["acacia", "basil", "clover", "dahlia"];

/** Every Stripe API version from this date on carries a release name. */
const FIRST_RELEASE_DATE = "2024-09-30";

/** A date, then the release name every version from 2024-09-30.acacia on carries. */
const STRIPE_API_VERSION = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:\.([a-z]+))?$/;

/**
 * How long loadSdk() waits for a `<script>` the page added for the build to
 * load, the bound the REST adapters give a request by default.
 */
const PAGE_SCRIPT_WAIT_MS = 30_000;

/** The Stripe.js build an API version needs. */
interface StripeJsBuild {
  url: string;
  /** `"v3"`, or the release name. */
  name: string;
}

function stripeJsBuild(apiVersion: unknown): StripeJsBuild {
  if (apiVersion === undefined || apiVersion === null || apiVersion === "") {
    throw PayFanoutError.invalidRequest(
      "StripeClientAdapter config.apiVersion is required: pass the apiVersion your StripeServerAdapter pins",
    );
  }
  if (typeof apiVersion === "string" && apiVersion.includes(";")) {
    throw PayFanoutError.invalidRequest(
      'StripeClientAdapter config.apiVersion carries beta headers after ";", which Stripe.js no longer takes in an API version: pass the version before the ";"',
    );
  }
  const match = typeof apiVersion === "string" ? STRIPE_API_VERSION.exec(apiVersion) : null;
  if (!match) {
    throw PayFanoutError.invalidRequest(
      'StripeClientAdapter config.apiVersion must be a Stripe API version: a date, with or without a release name, such as "2026-08-26.dahlia" or "2024-06-20"',
    );
  }
  const [version, release] = match;
  if (release === undefined) {
    if (version >= FIRST_RELEASE_DATE) {
      throw PayFanoutError.invalidRequest(
        `StripeClientAdapter config.apiVersion "${version}" has no release name, which every Stripe API version from ${FIRST_RELEASE_DATE} on carries, as in "${FIRST_RELEASE_DATE}.acacia"`,
      );
    }
    return { url: STRIPE_JS_V3_URL, name: "v3" };
  }
  const newest = STRIPE_JS_RELEASES[STRIPE_JS_RELEASES.length - 1];
  if (release === "preview") {
    throw PayFanoutError.invalidRequest(
      `StripeClientAdapter config.apiVersion "${version}" is a preview API version, which no Stripe.js build speaks: pass a generally available version, such as one of ${newest}, the newest release this adapter knows`,
    );
  }
  if (!STRIPE_JS_RELEASES.includes(release)) {
    throw PayFanoutError.invalidRequest(
      `StripeClientAdapter config.apiVersion names the release "${release}", for which this adapter knows no Stripe.js build (it knows ${STRIPE_JS_RELEASES.join(", ")}): while the server is on "${release}", pass a version of ${newest}, the newest release this adapter knows`,
    );
  }
  return { url: `https://js.stripe.com/${release}/stripe.js`, name: release };
}

/**
 * The build a global's `version` names, as the served files set it and
 * Stripe's own loader reads it: `3` is v3, a lowercase word a release.
 */
function buildName(version: unknown): string | undefined {
  if (version === 3) return "v3";
  return typeof version === "string" && /^[a-z]+$/.test(version) ? version : undefined;
}

/**
 * Waits for a `<script>` the page added for the build, which core's
 * injectScript reuses at once whether or not it has loaded: resolves on its
 * `load`, and rejects with a retryable `psp_unavailable` on its `error`, or
 * after PAGE_SCRIPT_WAIT_MS. A tag that failed ran nothing, so it is removed
 * for the next call to fetch the file again, as Stripe's own loader does.
 */
function waitForPageScript(tag: HTMLScriptElement, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const unavailable = (message: string) =>
      new PayFanoutError({ code: "psp_unavailable", message, retryable: true, raw: undefined, pspName: "stripe" });
    const settle = (error?: PayFanoutError) => {
      clearTimeout(timer);
      tag.removeEventListener("load", onLoad);
      tag.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onLoad = () => settle();
    const onError = () => {
      tag.remove();
      settle(unavailable(`Failed to load ${url}`));
    };
    const timer = setTimeout(
      () => settle(unavailable(`The page's Stripe.js at ${url} did not load within ${PAGE_SCRIPT_WAIT_MS / 1000} seconds`)),
      PAGE_SCRIPT_WAIT_MS,
    );
    tag.addEventListener("load", onLoad);
    tag.addEventListener("error", onError);
  });
}

/** Mirrors the server adapter's defaults, currency and country gates included. */
const DEFAULT_METHODS: PaymentMethodCapability[] = [
  { type: "card", flow: "embedded", supported: true },
  { type: "apple_pay", flow: "popup", supported: true },
  { type: "google_pay", flow: "popup", supported: true },
  { type: "ideal", flow: "redirect", supported: true, currencies: ["EUR"], countries: ["NL"] },
  { type: "sepa_debit", flow: "embedded", supported: true, currencies: ["EUR"] },
  { type: "ach", flow: "embedded", supported: true, currencies: ["USD"], countries: ["US"] },
  { type: "bacs_debit", flow: "embedded", supported: true, currencies: ["GBP"], countries: ["GB"] },
];

interface StripeHandle {
  pspName: "stripe";
  stripe: StripeJsLike;
  elements: StripeJsElementsLike;
  element: StripeJsElementLike;
  clientSecret: string;
  /** The locale Stripe.js was given for this mount, if any. */
  locale: string | undefined;
}

/**
 * Stripe's Payment Element in the browser, confirm-on-client: `confirm()`
 * finalizes the PaymentIntent the server adapter created. Stripe.js loads
 * lazily from `https://js.stripe.com`, in the build of `config.apiVersion`, so
 * the browser follows the host's pin, not the account's default version.
 */
export class StripeClientAdapter implements ClientPaymentAdapter {
  readonly pspName = "stripe";
  private readonly config: StripeClientAdapterConfig;
  private readonly build: StripeJsBuild;
  private sdkPromise?: Promise<void>;
  private warnedOtherBuild = false;

  constructor(config: StripeClientAdapterConfig) {
    if (!config.publishableKey) {
      throw PayFanoutError.invalidRequest("StripeClientAdapter config.publishableKey is required");
    }
    if (config.environment !== "sandbox" && config.environment !== "live") {
      throw PayFanoutError.invalidRequest('StripeClientAdapter config.environment must be "sandbox" or "live"');
    }
    // The removed sdkUrl, refused rather than ignored: a JavaScript config still
    // naming a URL would otherwise load another file than it says.
    if ((config as { sdkUrl?: unknown }).sdkUrl !== undefined) {
      throw PayFanoutError.invalidRequest(
        "StripeClientAdapter config.sdkUrl is no longer supported: Stripe.js loads from https://js.stripe.com in the build config.apiVersion names",
      );
    }
    this.build = stripeJsBuild(config.apiVersion);
    if (config.cspNonce !== undefined && !isValidCspNonce(config.cspNonce)) {
      throw PayFanoutError.invalidRequest(
        "StripeClientAdapter config.cspNonce must be the value of the policy's 'nonce-…' source: base64 or base64url characters",
      );
    }
    if (config.hideTestingAssistant !== undefined && typeof config.hideTestingAssistant !== "boolean") {
      throw PayFanoutError.invalidRequest("StripeClientAdapter config.hideTestingAssistant must be a boolean");
    }
    this.config = config;
  }

  /**
   * Loads Stripe.js once, in the build `config.apiVersion` names, with
   * `cspNonce` on the tag; `mount()` and `handleRedirectReturn()` call it
   * first. A page runs one Stripe.js build, as a second copy leaves
   * `window.Stripe` to the first, so the adapter uses the Stripe.js it finds,
   * as Stripe's own loader does, whether the page had it before the call or
   * another script defined it while the adapter's own was loading. Its
   * `version` decides how: v3 is given `config.apiVersion`, a release's
   * version included, and then speaks exactly it; another versioned build
   * speaks the API version Stripe pins it to, and in a sandbox the adapter
   * warns once on the console; a global whose `version` names no build is
   * used as if it were the build `config.apiVersion` names. Beside a Stripe.js
   * v2 global, the build loads and attaches itself as `window.Stripe.StripeV3`,
   * which the adapter uses. A `<script>` the page added for the build's URL
   * and that is still loading is waited for, for up to 30 seconds, and one
   * that fails is removed. A load that fails or leaves the global missing is
   * not kept: the next call loads again.
   */
  async loadSdk(): Promise<void> {
    assertBrowser("StripeClientAdapter", "loadSdk");
    if (this.stripeFactory()) return;
    const url = this.build.url;
    this.sdkPromise ??= this.config.loadScript ? this.config.loadScript(url) : this.injectStripeJs(url);
    const loading = this.sdkPromise;
    try {
      await loading;
      if (!this.stripeFactory()) {
        throw new PayFanoutError({
          code: "psp_unavailable",
          message: "Stripe.js loaded but window.Stripe is missing",
          retryable: true,
          raw: undefined,
          pspName: this.pspName,
        });
      }
    } catch (err) {
      // Drop this attempt, if still cached, whether it rejected or left the global
      // missing, so the next loadSdk() calls the loader again: a cached failure
      // would fail every later mount until the page reloads.
      if (this.sdkPromise === loading) this.sdkPromise = undefined;
      throw err;
    }
  }

  async mount(container: HTMLElement, options: MountOptions): Promise<MountedFieldsHandle> {
    assertBrowser("StripeClientAdapter", "mount");
    await this.loadSdk();
    const locale = options.locale ?? this.config.locale;
    const stripe = this.createStripe(locale);
    const appearance = toStripeAppearance(options.appearance);
    const elements = stripe.elements({
      clientSecret: options.clientSecret,
      ...(appearance ? { appearance } : {}),
    });
    // fieldOptions = the full Payment Element option surface (layout,
    // paymentMethodOrder, fields, defaultValues, terms, wallets, …), passed
    // through untouched so future SDK options need no library release.
    const element = elements.create("payment", options.fieldOptions);
    element.on("ready", () => options.onReady?.());
    element.on("loaderror", (payload) => options.onError?.(mapStripeJsError(payload?.error, locale)));
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
    const handle: StripeHandle = { pspName: "stripe", stripe, elements, element, clientSecret: options.clientSecret, locale };
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
      return { status: "failed", error: mapStripeJsError(result.error, h.locale) };
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

    assertBrowser("StripeClientAdapter", "handleRedirectReturn");
    await this.loadSdk();
    const stripe = this.createStripe(this.config.locale);
    const result = piSecret
      ? await stripe.retrievePaymentIntent(piSecret)
      : await stripe.retrieveSetupIntent(setiSecret!);
    if (result.error) {
      return { status: "failed", error: mapStripeJsError(result.error, this.config.locale) };
    }
    const status = (result.paymentIntent ?? result.setupIntent)?.status;
    if (!status) {
      return { status: "failed", error: mapStripeJsError(undefined, this.config.locale) };
    }
    return { status: toUnifiedStatus(status) };
  }

  listPaymentMethodCapabilities(): PaymentMethodCapability[] {
    return this.config.paymentMethods ?? DEFAULT_METHODS;
  }

  /** Call after loadSdk(), which confirmed the global. */
  private createStripe(locale: string | undefined): StripeJsLike {
    const factory = this.stripeFactory()!;
    const running = buildName(factory.version);
    if (running !== undefined && running !== "v3" && running !== this.build.name) this.warnOtherBuild(running);
    // v3 takes any version, a release's included; a versioned build throws on one.
    const runsV3 = running === undefined ? this.build.name === "v3" : running === "v3";
    const options = {
      ...(locale ? { locale } : {}),
      ...(runsV3 ? { apiVersion: this.config.apiVersion } : {}),
      ...(this.config.hideTestingAssistant === true ? { developerTools: { assistant: { enabled: false } } } : {}),
    };
    return factory(this.config.publishableKey, Object.keys(options).length > 0 ? options : undefined);
  }

  /** In a sandbox only, as Stripe's own loader warns only for test keys. */
  private warnOtherBuild(running: string): void {
    if (this.config.environment !== "sandbox" || this.warnedOtherBuild) return;
    this.warnedOtherBuild = true;
    console.warn(
      `[payfanout] This page runs Stripe.js ${running}, not ${this.build.name} (${this.build.url}), the build ` +
        `config.apiVersion "${this.config.apiVersion}" names. The Stripe adapter uses the page's copy, so the ` +
        `browser speaks the API version Stripe pins ${running} to. Load ${this.build.url} on the page instead, ` +
        "or no Stripe.js at all and let the adapter load it.",
    );
  }

  /** core's injectScript, then the wait for a `<script>` the page added for the same URL. */
  private async injectStripeJs(url: string): Promise<void> {
    const pageTag = document.querySelector<HTMLScriptElement>(`script[src="${url}"]`);
    await injectScript(url, this.pspName, { nonce: this.config.cspNonce });
    if (pageTag !== null && !this.stripeFactory()) await waitForPageScript(pageTag, url);
  }

  /** The Stripe.js in use: `window.Stripe`, or beside a v2 global the build attached as `StripeV3`. */
  private stripeFactory(): StripeJsFactory | undefined {
    const global = this.stripeGlobal();
    return global?.version === 2 ? global.StripeV3 : global;
  }

  private stripeGlobal(): StripeJsFactory | undefined {
    if (this.config.getStripeGlobal) return this.config.getStripeGlobal();
    if (typeof window === "undefined") return undefined;
    return (window as unknown as { Stripe?: StripeJsFactory }).Stripe;
  }
}

/** Cross-PSP appearance tokens → Stripe Appearance API `variables`. */
const COMMON_APPEARANCE_TO_STRIPE_VARIABLE: Record<string, string> = {
  colorPrimary: "colorPrimary",
  colorText: "colorText",
  colorDanger: "colorDanger",
  colorBackground: "colorBackground",
  fontFamily: "fontFamily",
  fontSize: "fontSizeBase",
};

/**
 * Translates PaymentFields `appearance` into the Stripe Appearance API. The small
 * cross-PSP token set (colorPrimary/colorText/colorDanger/colorBackground/
 * fontFamily/fontSize) is mapped into `variables` so one `appearance` styles either
 * PSP; native Stripe keys (`theme`, `variables`, `rules`, `labels`) pass through
 * untouched, and an explicit native `variables` value wins over a translated token.
 */
function toStripeAppearance(appearance: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!appearance) return undefined;
  const translated: Record<string, unknown> = {};
  const native: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(appearance)) {
    const variable = COMMON_APPEARANCE_TO_STRIPE_VARIABLE[key];
    if (variable !== undefined && typeof value === "string") translated[variable] = value;
    else native[key] = value;
  }
  if (Object.keys(translated).length === 0) return native;
  const nv = native["variables"];
  const nativeVariables = (nv !== null && typeof nv === "object" ? nv : {}) as Record<string, unknown>;
  return { ...native, variables: { ...translated, ...nativeVariables } };
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

/** Card details the customer can correct, as error codes or as the issuer's decline codes. */
const INVALID_CARD_DATA_CODES = new Set([
  "incorrect_number",
  "invalid_number",
  "incorrect_cvc",
  "invalid_cvc",
  "invalid_expiry_month",
  "invalid_expiry_year",
  "incorrect_address",
  "incorrect_zip",
  "incorrect_postal_code",
  // Stripe.js refuses incomplete fields before anything is sent.
  "incomplete_number",
  "incomplete_cvc",
  "incomplete_expiry",
]);

/** Decline codes Stripe asks to present as a generic decline; the last is a local payment method's. */
const FRAUD_DECLINE_CODES = new Set(["fraudulent", "stolen_card", "lost_card", "merchant_blacklist", "lost_or_stolen_card"]);

/** A failed 3-D Secure: the general code 2026-08-26.dahlia added and the intent-specific forms before it. */
const AUTHENTICATION_FAILURE_CODES = new Set([
  "authentication_failure",
  "payment_intent_authentication_failure",
  "setup_intent_authentication_failure",
]);

/**
 * In the server adapter's order, so a decline maps the same way whichever half
 * reports it. The issuer's decline code counts like the error code wherever
 * Stripe uses the same word for both.
 */
function classifyStripeJsError(error: StripeJsErrorLike | undefined): UnifiedErrorCode {
  const code = error?.code;
  const decline = error?.decline_code;
  const either = (test: (value: string) => boolean) =>
    (code !== undefined && test(code)) || (decline !== undefined && test(decline));
  if (either((value) => value === "insufficient_funds")) return "insufficient_funds";
  if (code === "expired_payment_method" || either((value) => value === "expired_card")) return "expired_card";
  if (either((value) => INVALID_CARD_DATA_CODES.has(value))) return "invalid_card_data";
  // authentication_not_handled is only a decline code: the issuer declines again when
  // the required authentication was skipped.
  if (either((value) => value === "authentication_required") || decline === "authentication_not_handled") {
    return "authentication_required";
  }
  if (decline !== undefined && FRAUD_DECLINE_CODES.has(decline)) return "fraud_suspected";
  if (code !== undefined && AUTHENTICATION_FAILURE_CODES.has(code)) return "authentication_required";
  if (either((value) => value === "processing_error")) return "processing_error";
  if (code === "card_declined" || error?.type === "card_error" || error?.type === "validation_error") {
    return "card_declined";
  }
  return "unknown";
}

/**
 * The locale a message for the customer is in: Stripe.js's own, which is the
 * browser's under "auto" or when none was given.
 */
function customerLocale(locale: string | undefined): string | undefined {
  // An empty locale gives Stripe.js none, so it detects the browser's, as under "auto".
  if (locale && locale !== "auto") return locale;
  return typeof navigator === "undefined" ? undefined : navigator.language;
}

function mapStripeJsError(error: StripeJsErrorLike | undefined, locale: string | undefined): UnifiedError {
  const code = classifyStripeJsError(error);
  return new PayFanoutError({
    code,
    // Stripe asks never to tell the customer more than a generic decline for
    // these; core's catalog message follows the customer's locale where core or
    // the host has one, and English otherwise.
    message:
      code === "fraud_suspected"
        ? getUserMessage("fraud_suspected", customerLocale(locale))
        : (error?.message ?? "Payment failed."),
    // authentication_required is resolved on-session (a 3DS challenge), never by replay.
    retryable: code === "processing_error",
    raw: error,
    pspName: "stripe",
  });
}

