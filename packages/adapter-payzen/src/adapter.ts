import {
  assertBrowser,
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
  type UnifiedPaymentMethodType,
} from "@payfanout/core";

/**
 * Structural subset of PayZen's krypton-client (`window.KR`). Injected in
 * tests, loaded from static.payzen.eu in browsers. Only `setFormConfig`,
 * `renderElements`, `submit`, and `onSubmit` are load-bearing; everything
 * else is optional so SDK variations degrade instead of breaking mount.
 */
export interface KrErrorLike {
  errorCode?: string;
  errorMessage?: string;
  detailedErrorCode?: string | null;
  detailedErrorMessage?: string | null;
  children?: KrErrorLike[];
}

export interface KrClientAnswerLike {
  orderStatus?: string;
  orderDetails?: { orderId?: string | null };
  transactions?: Array<{
    uuid?: string;
    detailedStatus?: string;
    errorCode?: string | null;
    detailedErrorCode?: string | null;
  }>;
}

export interface KrPaymentResponseLike {
  clientAnswer?: KrClientAnswerLike;
  /** The signed kr-answer string — hashed server-side, never here (no key in the browser). */
  rawClientAnswer?: string;
  hash?: string;
  hashKey?: string;
}

export interface KrLike {
  setFormConfig(config: Record<string, unknown>): Promise<unknown> | unknown;
  renderElements(selector: string): Promise<unknown> | unknown;
  submit(): Promise<unknown> | unknown;
  /** Return false so the SDK never POSTs to a kr-post-url — the adapter owns post-payment. */
  onSubmit(callback: (response: KrPaymentResponseLike) => boolean): unknown;
  removeForms?(): Promise<unknown> | unknown;
  validateForm?(): Promise<unknown>;
  onFormValid?(callback: () => void): unknown;
  onError?(callback: (error: KrErrorLike) => void): unknown;
  /** Lists the shop's live payment methods — feeds fetchAvailablePaymentMethods(). */
  getPaymentMethods?(): Promise<unknown> | unknown;
}

/** Documented shape of KR.getPaymentMethods() — structural, SDK variations tolerated. */
export interface KrPaymentMethodsLike {
  paymentMethods?: string[];
  cardBrands?: string[];
}

/**
 * Which krypton form mount() renders:
 *   - "embedded"           — card-only embedded form; the HOST button drives
 *     submission through confirm() (the historical shape, and the default).
 *   - "smartform"          — the multi-method smartForm in list mode. The FORM
 *     owns method selection and its own pay buttons; confirm() awaits the
 *     outcome instead of submitting (call it right after mount and hide any
 *     host pay button).
 *   - "smartform-expanded" — smartForm in list mode with the card form
 *     pre-expanded (kr-card-form-expanded); same ownership as "smartform".
 * A smartForm whose token/shop resolves to cards only renders the plain card
 * fields, so "smartform" is safe to use for card-only sessions too.
 */
export type PayZenFormMode = "embedded" | "smartform" | "smartform-expanded";

/** The shop's live payment-method availability, from KR.getPaymentMethods(). */
export interface PayZenAvailablePaymentMethods {
  /** Unified types this adapter can request (the mappable subset of `methods`). */
  types: UnifiedPaymentMethodType[];
  /** Raw PayZen method codes, untouched (may exceed `types` — e.g. ALMA_3X). */
  methods: string[];
  /** Raw card brand codes (VISA, MASTERCARD, …) when reported. */
  cardBrands: string[];
}

export interface PayZenClientAdapterConfig {
  /** Back Office "Public key" (kr-public-key), format `shopId:testpublickey_…` — browser-safe. */
  publicKey: string;
  /** Explicit, mirrors the server adapter. PayZen selects TEST/LIVE by the key set. */
  environment: "sandbox" | "live";
  /** krypton-client script URL — per-shop config in the Back Office, not a constant. */
  scriptUrl?: string;
  /** Theme stylesheet URL; defaults to the neon reset (unthemed, host CSS styles the fields). */
  cssUrl?: string;
  /**
   * Form to render on mount — see PayZenFormMode. Default "embedded"
   * (card-only, host-button-driven), the pre-smartForm behavior.
   */
  form?: PayZenFormMode;
  /**
   * Wallet/APM enablement varies per shop contract — override the
   * conservative card-only default in lock-step with the server adapter once
   * the Back Office lists the contract. Overrides wholesale.
   */
  paymentMethods?: PaymentMethodCapability[];
  /** Test seam: full asset injection (stylesheet + script) override. */
  loadScript?: (scriptUrl: string, cssUrl: string) => Promise<void>;
  /** Test seam: KR global lookup override. */
  getKrGlobal?: () => KrLike | undefined;
}

const KR_SCRIPT_URL = "https://static.payzen.eu/static/js/krypton-client/V4.0/stable/kr-payment-form.min.js";
const KR_CSS_URL = "https://static.payzen.eu/static/js/krypton-client/V4.0/ext/neon-reset.min.css";

/**
 * Mirror of the server adapter's declaration: card is on every shop;
 * everything else is a per-shop contract, so it defaults to supported: false
 * until the host flips entries via `config.paymentMethods`. Flow "popup"
 * methods run inside the smartForm without leaving the page; flow "redirect"
 * methods (the bank rails) live on PayZen's hosted payment page — their
 * session's clientSecret is the page URL and confirm() is the redirect.
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

const DEFAULT_PANEL_TEXT = "You will be redirected to the payment page to complete this payment.";

/** KR.getPaymentMethods() code → unified type, for the methods this adapter maps. */
const PAYZEN_CODE_TO_UNIFIED: Record<string, UnifiedPaymentMethodType> = {
  CARDS: "card",
  APPLE_PAY: "apple_pay",
  PAYPAL: "paypal",
  PAYPAL_SB: "paypal", // the sandbox wallet's client-side selector
};

interface PayZenMountState {
  /** Set synchronously at confirm() entry so overlapping confirms are refused deterministically. */
  confirming?: boolean;
  resolveConfirm?: (result: ConfirmResult) => void;
  /**
   * Terminal outcome that arrived while no confirm() was pending — a
   * smartForm method completed through the form's OWN buttons before the
   * host awaited. The next confirm() consumes it, so the race between the
   * buyer and the host's wiring can never drop a payment result.
   */
  settled?: ConfirmResult;
  /** SmartForm: the form owns submission; confirm() awaits instead of driving KR.submit(). */
  smartForm?: boolean;
}

interface PayZenHandle {
  pspName: "payzen";
  kr: KrLike;
  state: PayZenMountState;
  cleanup: () => void;
}

/** Hosted-redirect sessions mount no krypton form — the handle carries the page URL. */
interface PayZenRedirectHandle {
  pspName: "payzen";
  paymentUrl: string;
  panel: HTMLElement;
}

let mountCounter = 0;

/** The mount whose form currently owns the single KR global (see mount()). */
let activeMountState: PayZenMountState | undefined;

/**
 * A form torn down mid-confirm (route change or PSP switch during the 3DS
 * pop-in) can never settle through KR.onSubmit/KR.onError — without this the
 * host's pay flow would await forever. Resolve (never reject) as a failure.
 */
function settlePendingConfirm(state: PayZenMountState | undefined): void {
  if (!state?.resolveConfirm) return;
  const resolve = state.resolveConfirm;
  state.resolveConfirm = undefined;
  resolve({
    status: "failed",
    error: PayFanoutError.invalidRequest("payment form was unmounted during confirmation"),
  });
}

export class PayZenClientAdapter implements ClientPaymentAdapter {
  readonly pspName = "payzen";
  private readonly config: PayZenClientAdapterConfig;
  private sdkPromise?: Promise<void>;

  constructor(config: PayZenClientAdapterConfig) {
    if (!config.publicKey) {
      throw PayFanoutError.invalidRequest("PayZenClientAdapter config.publicKey is required");
    }
    if (config.environment !== "sandbox" && config.environment !== "live") {
      throw PayFanoutError.invalidRequest('PayZenClientAdapter config.environment must be "sandbox" or "live"');
    }
    // PayZen selects TEST vs LIVE by the key — validate the declared
    // environment against the key family instead of inferring anything.
    if (config.environment === "sandbox" && config.publicKey.includes(":prodpublickey_")) {
      throw PayFanoutError.invalidRequest(
        'PayZenClientAdapter: environment is "sandbox" but config.publicKey is a production key',
      );
    }
    if (config.environment === "live" && config.publicKey.includes(":testpublickey_")) {
      throw PayFanoutError.invalidRequest(
        'PayZenClientAdapter: environment is "live" but config.publicKey is a test key',
      );
    }
    this.config = config;
  }

  async loadSdk(): Promise<void> {
    assertBrowser("PayZenClientAdapter", "loadSdk");
    if (this.kr()) return;
    this.sdkPromise ??= (this.config.loadScript ?? injectKrAssets(this.config.publicKey))(
      this.config.scriptUrl ?? KR_SCRIPT_URL,
      this.config.cssUrl ?? KR_CSS_URL,
    );
    await this.sdkPromise;
    if (!this.kr()) {
      throw new PayFanoutError({
        code: "psp_unavailable",
        message: "krypton-client loaded but the KR global is missing",
        retryable: true,
        raw: undefined,
        pspName: this.pspName,
      });
    }
  }

  /**
   * Renders PayZen's card fields or multi-method smartForm (per
   * `config.form`) as Lyra-hosted iframes — SAQ-A eligible, card data never
   * touches the host DOM. KR is a single page-global managing forms
   * globally, so mounting tears down any previous form first; two PayZen
   * forms cannot coexist on one page.
   *
   * `fieldOptions` passes through to KR.setFormConfig untouched (placeholders
   * `kr-placeholder-*`, `kr-hide-debug-toolbar`, …). Protected keys the host
   * cannot override: `formToken` (from clientSecret), `kr-public-key`,
   * `kr-spa-mode`, and `language` when MountOptions.locale is given.
   * `appearance` is accepted but has no JS hook to land on: krypton mirrors
   * the host page's CSS into its iframes automatically, so theming is done
   * with plain CSS (or a cssUrl override) — documented no-op. The smartForm
   * additionally rejects the material theme (CLIENT_505); the default neon
   * reset is compatible.
   */
  async mount(container: HTMLElement, options: MountOptions): Promise<MountedFieldsHandle> {
    assertBrowser("PayZenClientAdapter", "mount");
    // Hosted-redirect sessions (bank rails): the clientSecret is the hosted
    // payment page URL, not a formToken — nothing renders client-side, so
    // mount shows an informational panel and skips krypton entirely.
    // `fieldOptions.description` overrides the text; `appearance.panel`
    // carries inline CSS for it (the payment UI itself is PayZen-hosted).
    if (/^https:\/\//.test(options.clientSecret)) {
      const panel = document.createElement("div");
      panel.setAttribute("data-payfanout-payzen-panel", "");
      const description = options.fieldOptions?.["description"];
      panel.textContent = typeof description === "string" ? description : DEFAULT_PANEL_TEXT;
      const style = options.appearance?.["panel"];
      if (style !== null && typeof style === "object" && !Array.isArray(style)) {
        Object.assign(panel.style, style);
      }
      container.appendChild(panel);
      options.onChange?.({ complete: false });
      options.onChange?.({ complete: true }); // nothing to fill — the hosted page collects everything
      options.onReady?.();
      const handle: PayZenRedirectHandle = { pspName: "payzen", paymentUrl: options.clientSecret, panel };
      return brandMountedFieldsHandle(handle);
    }
    await this.loadSdk();
    const kr = this.kr()!;
    const form = this.config.form ?? "embedded";
    const wrapper = document.createElement("div");
    wrapper.id = `payfanout-payzen-${++mountCounter}`;
    if (form === "embedded") {
      // The standard embedded skeleton, minus kr-payment-button: submission is
      // driven programmatically by confirm() so the host's own button stays in
      // charge (a second PSP-rendered pay button would fight it).
      wrapper.className = "kr-embedded";
      for (const cls of ["kr-pan", "kr-expiry", "kr-security-code", "kr-form-error"]) {
        const field = document.createElement("div");
        field.className = cls;
        wrapper.appendChild(field);
      }
    } else {
      // The smartForm renders its whole surface (method list, card fields,
      // per-method pay buttons) into an EMPTY kr-smart-form element — the SPA
      // shape from Lyra's embedded-form-glue: selector wrapper > form element.
      // Its methods run without leaving the page; outcomes arrive through the
      // same KR callbacks as the embedded form.
      const smartForm = document.createElement("div");
      smartForm.className = "kr-smart-form";
      if (form === "smartform-expanded") smartForm.setAttribute("kr-card-form-expanded", "");
      wrapper.appendChild(smartForm);
    }
    container.appendChild(wrapper);

    const state: PayZenMountState = { smartForm: form !== "embedded" };
    try {
      settlePendingConfirm(activeMountState); // re-mount replaces a form that may still be confirming
      activeMountState = state;
      await kr.removeForms?.(); // clean slate — also clears stale event callbacks
      await kr.setFormConfig({
        ...(options.fieldOptions ?? {}),
        ...(options.locale ? { language: toKrLanguage(options.locale) } : {}),
        "kr-public-key": this.config.publicKey,
        "kr-spa-mode": true,
        formToken: options.clientSecret,
      });
      registerKrCallbacks(kr, state, options);
      options.onChange?.({ complete: false, empty: true });
      await kr.renderElements(`#${wrapper.id}`);
      options.onReady?.();
    } catch (err) {
      wrapper.remove();
      const mapped = mapKrError(err);
      options.onError?.(mapped);
      throw mapped;
    }
    const handle: PayZenHandle = {
      pspName: "payzen",
      kr,
      state,
      cleanup: () => {
        settlePendingConfirm(state);
        try {
          void kr.removeForms?.();
        } catch {
          // Defensive: a torn-down KR must not break host unmount.
        }
        wrapper.remove();
      },
    };
    return brandMountedFieldsHandle(handle);
  }

  /**
   * Confirm-on-client shape, submission ownership depending on the form:
   *
   *   - Embedded (default): KR.submit() makes the krypton form create the
   *     transaction, with 3DS2 running INLINE in Lyra's pop-in (no
   *     navigation).
   *   - SmartForm: the form owns its pay buttons, so confirm() SUBMITS
   *     NOTHING — it resolves with the outcome of the buyer's in-form
   *     completion (or immediately, when one already arrived before the
   *     call). Invoke it right after mount to start awaiting.
   *
   * Either way the outcome arrives via KR.onSubmit (accepted) or KR.onError
   * (refused/client error) — both resolve, never reject. The browser
   * kr-answer is NOT hash-verified here (the validation keys are server
   * secrets); the host's source of truth stays server-side (IPN /
   * retrievePayment).
   */
  async confirm(handle: MountedFieldsHandle): Promise<ConfirmResult> {
    const redirect = asRedirectHandle(handle);
    if (redirect) {
      // Bank rails complete on PayZen's hosted page — confirm IS the
      // redirect, and the promise never settles because the navigation
      // unloads the page. The outcome resolves on returnUrl via
      // handleRedirectReturn plus a server-side retrievePayment / the IPN.
      assertBrowser("PayZenClientAdapter", "confirm");
      window.location.assign(redirect.paymentUrl);
      return new Promise<ConfirmResult>(() => {});
    }
    const h = asPayZenHandle(handle);
    if (h.state.settled) {
      // The buyer completed through the form's own buttons before the host
      // awaited — hand over the buffered outcome.
      const settled = h.state.settled;
      h.state.settled = undefined;
      return settled;
    }
    if (h.state.confirming) {
      // A second submit would race the pending one on the single KR global.
      return {
        status: "failed",
        error: new PayFanoutError({
          code: "invalid_request",
          message: "A confirmation is already in progress for this form.",
          retryable: false,
          raw: undefined,
          pspName: "payzen",
        }),
      };
    }
    h.state.confirming = true;
    try {
      if (!h.state.smartForm && typeof h.kr.validateForm === "function") {
        try {
          await h.kr.validateForm();
        } catch (err) {
          // Local validation rejects with { result: { errorCode, … } }.
          return { status: "failed", error: mapKrError((err as { result?: KrErrorLike })?.result ?? err) };
        }
      }
      return await new Promise<ConfirmResult>((resolve) => {
        h.state.resolveConfirm = resolve;
        if (h.state.smartForm) return; // the smartForm's own buttons drive submission
        const fail = (err: unknown): void => {
          if (h.state.resolveConfirm === resolve) {
            h.state.resolveConfirm = undefined;
            resolve({ status: "failed", error: mapKrError(err) });
          }
        };
        try {
          Promise.resolve(h.kr.submit()).catch(fail);
        } catch (err) {
          fail(err);
        }
      });
    } finally {
      h.state.confirming = false;
      h.state.resolveConfirm = undefined;
    }
  }

  unmount(handle: MountedFieldsHandle): void {
    const redirect = asRedirectHandle(handle);
    if (redirect) {
      // Only the adapter-created panel — host elements are never touched.
      redirect.panel.remove();
      return;
    }
    asPayZenHandle(handle).cleanup();
  }

  /**
   * Return trip from the hosted payment page. Two documented return shapes
   * exist, and both resolve here:
   *
   *   - kr-* fields (the V4 return): the signed kr-answer is parsed for a
   *     UX-grade outcome — the signature is NOT checked here (its keys are
   *     server secrets), exactly like the embedded form's browser answer.
   *   - vads_* fields (the hosted page's classic return): the browser has no
   *     way to verify them, and the platform documents that return data must
   *     only display a visual context — so they resolve "processing" and the
   *     host confirms server-side via retrievePayment or the IPN.
   *
   * Returns null when the URL carries neither, so a router can probe every
   * registered adapter safely.
   */
  async handleRedirectReturn(location: RedirectReturnLocation): Promise<ConfirmResult | null> {
    const params = new URLSearchParams(
      location.search.startsWith("?") ? location.search.slice(1) : location.search,
    );
    const krAnswer = params.get("kr-answer");
    if (krAnswer) {
      try {
        return confirmResultFrom({ clientAnswer: JSON.parse(krAnswer) as KrClientAnswerLike });
      } catch {
        // Present but unreadable — still a PayZen return; the server decides.
        return { status: "processing" };
      }
    }
    if (params.get("vads_trans_uuid") || params.get("vads_trans_status") || params.get("vads_order_id")) {
      return { status: "processing" };
    }
    return null;
  }

  listPaymentMethodCapabilities(): PaymentMethodCapability[] {
    return this.config.paymentMethods ?? DEFAULT_METHODS;
  }

  /**
   * The shop's LIVE payment-method availability via KR.getPaymentMethods() —
   * what a dynamic method chooser should render, since wallet/APM enablement
   * is a per-shop contract invisible to the static capability list. Requires
   * the SDK (loads it on demand); browser-only like every KR surface.
   */
  async fetchAvailablePaymentMethods(): Promise<PayZenAvailablePaymentMethods> {
    await this.loadSdk();
    const kr = this.kr()!;
    if (typeof kr.getPaymentMethods !== "function") {
      throw new PayFanoutError({
        code: "psp_unavailable",
        message: "This krypton-client build does not expose KR.getPaymentMethods.",
        retryable: false,
        raw: undefined,
        pspName: this.pspName,
      });
    }
    let raw: KrPaymentMethodsLike;
    try {
      raw = ((await kr.getPaymentMethods()) ?? {}) as KrPaymentMethodsLike;
    } catch (err) {
      throw mapKrError(err);
    }
    const asStrings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    const methods = asStrings(raw.paymentMethods);
    const types = [...new Set(methods.map((m) => PAYZEN_CODE_TO_UNIFIED[m]).filter((t) => t !== undefined))];
    return { types, methods, cardBrands: asStrings(raw.cardBrands) };
  }

  private kr(): KrLike | undefined {
    if (this.config.getKrGlobal) return this.config.getKrGlobal();
    if (typeof window === "undefined") return undefined;
    return (window as unknown as { KR?: KrLike }).KR;
  }
}

/**
 * Routes the global KR callbacks into the active mount. KR.onFormValid is the
 * only documented validity event — there is no per-field or invalid-again
 * event, so onChange gets the initial { complete: false } plus the valid
 * edge. Registration is best-effort: an SDK build without an event surface
 * degrades, it never breaks mount.
 */
function registerKrCallbacks(kr: KrLike, state: PayZenMountState, options: MountOptions): void {
  try {
    kr.onFormValid?.(() => options.onChange?.({ complete: true }));
  } catch {
    // Best-effort — see above.
  }
  try {
    kr.onError?.((error) => {
      const mapped = mapKrError(error);
      const resolve = state.resolveConfirm;
      // CLIENT_-prefixed codes are browser-local and PRE-transaction (local
      // validation, integration warnings, an abandoned 3DS pop-in): on the
      // smartForm the buyer is still in front of a usable form, so they must
      // not settle a pending await — except the fatal ones, where the form
      // cannot recover and the await would otherwise hang forever.
      const recoverable =
        state.smartForm && resolve !== undefined && isRecoverableSmartFormError(error?.errorCode ?? "");
      if (resolve && !recoverable) {
        // A refused transaction (or, on the embedded form, any KR error)
        // during confirm().
        state.resolveConfirm = undefined;
        resolve({ status: "failed", error: mapped });
      } else {
        options.onError?.(mapped);
      }
    });
  } catch {
    // Best-effort — see above.
  }
  try {
    kr.onSubmit((response) => {
      const resolve = state.resolveConfirm;
      if (resolve) {
        state.resolveConfirm = undefined;
        resolve(confirmResultFrom(response));
      } else {
        // SmartForm race: the buyer completed through the form's own button
        // before the host called confirm() — buffer, never drop, the outcome.
        state.settled = confirmResultFrom(response);
      }
      return false; // adapter-managed post-payment: never POST to a kr-post-url
    });
  } catch {
    // Best-effort — see above.
  }
}

/**
 * SmartForm errors the buyer can recover from IN the form: local validation
 * (CLIENT_300–304), integration warnings (CLIENT_7xx), and the abandoned 3DS
 * pop-in (CLIENT_101 — the form returns to the method list). Fatal CLIENT_
 * codes (bad key/token, unusable form: 004, 100, 305, 5xx, 997–999) and every
 * gateway-side rejection (ACQ_/AUTH_/PSP_) settle the pending confirm.
 */
function isRecoverableSmartFormError(errorCode: string): boolean {
  if (errorCode === "CLIENT_101") return true;
  return /^CLIENT_(30[0-4]|7\d\d)$/.test(errorCode);
}

function confirmResultFrom(response: KrPaymentResponseLike): ConfirmResult {
  const answer = response?.clientAnswer;
  const orderStatus = (answer?.orderStatus ?? "").toUpperCase();
  if (orderStatus === "PAID") return { status: "succeeded" };
  if (orderStatus === "RUNNING" || orderStatus === "PARTIALLY_PAID") return { status: "processing" };
  const tx = answer?.transactions?.[answer.transactions.length - 1];
  return {
    status: "failed",
    error: new PayFanoutError({
      code: declineCode(tx?.errorCode, tx?.detailedErrorCode),
      message: userMessageFor(declineCode(tx?.errorCode, tx?.detailedErrorCode)),
      retryable: false,
      raw: response,
      pspName: "payzen",
    }),
  };
}

/** Acquirer refusal codes (ACQ_001 detailedErrorCode) → decline refinement (CB network table). */
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
  "1A": "authentication_required",
};

function declineCode(errorCode: string | null | undefined, detailedErrorCode: string | null | undefined): UnifiedErrorCode {
  if (errorCode?.startsWith("AUTH_")) return "authentication_required";
  return ACQUIRER_DECLINE_MAP[detailedErrorCode ?? ""] ?? "card_declined";
}

const KR_CLIENT_CODE_MAP: Record<string, UnifiedErrorCode> = {
  CLIENT_004: "invalid_request", // invalid public key
  CLIENT_100: "invalid_request", // invalid/expired formToken
  CLIENT_101: "authentication_required", // 3DS pop-in closed by the shopper
  CLIENT_300: "invalid_card_data",
  CLIENT_301: "invalid_card_data",
  CLIENT_302: "invalid_card_data",
  CLIENT_303: "invalid_card_data",
  CLIENT_304: "invalid_card_data",
  CLIENT_305: "invalid_request", // no formToken defined — integration error, not card data
  CLIENT_997: "invalid_request", // endpoint/platform mismatch — the formToken came from a sister platform
  CLIENT_998: "invalid_request", // demo formToken used against a real shop
  CLIENT_999: "psp_unavailable",
  PSP_108: "session_expired", // formToken outlived its ~15 min — create a fresh session
};

function mapKrError(err: unknown): UnifiedError {
  const e = err as KrErrorLike | undefined;
  const rawCode = e?.errorCode ?? "";
  let code: UnifiedErrorCode;
  if (KR_CLIENT_CODE_MAP[rawCode]) {
    code = KR_CLIENT_CODE_MAP[rawCode];
  } else if (rawCode.startsWith("ACQ_")) {
    code = declineCode(rawCode, e?.detailedErrorCode);
  } else if (rawCode.startsWith("AUTH_")) {
    code = "authentication_required";
  } else if (rawCode.startsWith("CLIENT_")) {
    // CLIENT_ = browser-side, pre-transaction by definition (integration
    // errors and warnings included) — retrying cannot help, unlike the
    // processing_error fallback below.
    code = "invalid_request";
  } else {
    code = "processing_error";
  }
  return new PayFanoutError({
    code,
    message: userMessageFor(code),
    retryable: code === "processing_error" || code === "psp_unavailable",
    raw: err,
    pspName: "payzen",
  });
}

function userMessageFor(code: UnifiedErrorCode): string {
  switch (code) {
    case "insufficient_funds":
      return "Your card has insufficient funds.";
    case "expired_card":
      return "Your card has expired.";
    case "invalid_card_data":
      return "The card details are invalid.";
    case "card_declined":
    case "fraud_suspected":
      return "Your card was declined.";
    case "authentication_required":
      return "Additional authentication is required.";
    case "session_expired":
      return "Your payment session has expired — please start again.";
    case "invalid_request":
      return "The payment form could not be set up.";
    case "psp_unavailable":
      return "The payment provider is temporarily unavailable.";
    default:
      return "The payment could not be processed. Please try again.";
  }
}

/** kr-language uses Culture format ("en-US") — normalize underscore variants, pass BCP-47 through. */
function toKrLanguage(locale: string): string {
  return locale.replace(/_/g, "-");
}

function asPayZenHandle(handle: MountedFieldsHandle): PayZenHandle {
  const h = handle as unknown as PayZenHandle;
  if (h?.pspName !== "payzen" || !h.kr) {
    throw PayFanoutError.invalidRequest("Handle was not produced by PayZenClientAdapter.mount");
  }
  return h;
}

/** The redirect-shaped sibling of asPayZenHandle — returns undefined for krypton handles. */
function asRedirectHandle(handle: MountedFieldsHandle): PayZenRedirectHandle | undefined {
  const h = handle as unknown as PayZenRedirectHandle;
  return h?.pspName === "payzen" && typeof h.paymentUrl === "string" && h.paymentUrl.length > 0 ? h : undefined;
}

/**
 * Default asset injection: the theme stylesheet plus the krypton script.
 * Idempotent per page via DOM lookup — KR is a single global, so a second
 * adapter instance reuses the same script element. The script deliberately
 * sets async = false (dynamically injected scripts default to async, and
 * PayZen documents that async loading breaks on older mobile browsers);
 * kr-spa-mode keeps the library from auto-scanning the DOM before mount().
 */
function injectKrAssets(publicKey: string): (scriptUrl: string, cssUrl: string) => Promise<void> {
  return (scriptUrl, cssUrl) =>
    new Promise((resolve, reject) => {
      if (!document.querySelector(`link[href="${cssUrl}"]`)) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = cssUrl;
        document.head.appendChild(link);
      }
      const existing = document.querySelector(`script[src="${scriptUrl}"]`);
      if (existing) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = scriptUrl;
      script.async = false;
      script.setAttribute("kr-public-key", publicKey);
      script.setAttribute("kr-spa-mode", "true");
      script.onload = () => resolve();
      script.onerror = () =>
        reject(
          new PayFanoutError({
            code: "psp_unavailable",
            message: `Failed to load ${scriptUrl}`,
            retryable: true,
            raw: undefined,
            pspName: "payzen",
          }),
        );
      document.head.appendChild(script);
    });
}
