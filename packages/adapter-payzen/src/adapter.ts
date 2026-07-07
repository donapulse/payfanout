import {
  brandMountedFieldsHandle,
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
  /** Test seam: full asset injection (stylesheet + script) override. */
  loadScript?: (scriptUrl: string, cssUrl: string) => Promise<void>;
  /** Test seam: KR global lookup override. */
  getKrGlobal?: () => KrLike | undefined;
}

const KR_SCRIPT_URL = "https://static.payzen.eu/static/js/krypton-client/V4.0/stable/kr-payment-form.min.js";
const KR_CSS_URL = "https://static.payzen.eu/static/js/krypton-client/V4.0/ext/neon-reset.min.css";

const PAYMENT_METHODS: PaymentMethodCapability[] = [{ type: "card", flow: "embedded", supported: true }];

interface PayZenMountState {
  /** Set synchronously at confirm() entry so overlapping confirms are refused deterministically. */
  confirming?: boolean;
  resolveConfirm?: (result: ConfirmResult) => void;
}

interface PayZenHandle {
  pspName: "payzen";
  kr: KrLike;
  state: PayZenMountState;
  cleanup: () => void;
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
    assertBrowser("loadSdk");
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
   * Renders PayZen's embedded card form (kr-pan / kr-expiry /
   * kr-security-code become Lyra-hosted iframes — SAQ-A eligible, card data
   * never touches the host DOM). KR is a single page-global managing forms
   * globally, so mounting tears down any previous form first; two PayZen
   * forms cannot coexist on one page.
   *
   * `fieldOptions` passes through to KR.setFormConfig untouched (placeholders
   * `kr-placeholder-*`, `kr-hide-debug-toolbar`, …). Protected keys the host
   * cannot override: `formToken` (from clientSecret), `kr-public-key`,
   * `kr-spa-mode`, and `language` when MountOptions.locale is given.
   * `appearance` is accepted but has no JS hook to land on: krypton mirrors
   * the host page's CSS into its iframes automatically, so theming is done
   * with plain CSS (or a cssUrl override) — documented no-op.
   */
  async mount(container: HTMLElement, options: MountOptions): Promise<MountedFieldsHandle> {
    assertBrowser("mount");
    await this.loadSdk();
    const kr = this.kr()!;
    const wrapper = document.createElement("div");
    wrapper.className = "kr-embedded";
    wrapper.id = `payfanout-payzen-${++mountCounter}`;
    // The standard embedded skeleton, minus kr-payment-button: submission is
    // driven programmatically by confirm() so the host's own button stays in
    // charge (a second PSP-rendered pay button would fight it).
    for (const cls of ["kr-pan", "kr-expiry", "kr-security-code", "kr-form-error"]) {
      const field = document.createElement("div");
      field.className = cls;
      wrapper.appendChild(field);
    }
    container.appendChild(wrapper);

    const state: PayZenMountState = {};
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
   * Confirm-on-client shape: KR.submit() makes the krypton form create the
   * transaction, with 3DS2 running INLINE in Lyra's pop-in (no navigation).
   * The outcome arrives via KR.onSubmit (accepted) or KR.onError (refused/
   * client error) — both resolve, never reject. The browser kr-answer is NOT
   * hash-verified here (the validation keys are server secrets); the host's
   * source of truth stays server-side (IPN / retrievePayment).
   */
  async confirm(handle: MountedFieldsHandle): Promise<ConfirmResult> {
    const h = asPayZenHandle(handle);
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
      if (typeof h.kr.validateForm === "function") {
        try {
          await h.kr.validateForm();
        } catch (err) {
          // Local validation rejects with { result: { errorCode, … } }.
          return { status: "failed", error: mapKrError((err as { result?: KrErrorLike })?.result ?? err) };
        }
      }
      return await new Promise<ConfirmResult>((resolve) => {
        h.state.resolveConfirm = resolve;
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
    asPayZenHandle(handle).cleanup();
  }

  listPaymentMethodCapabilities(): PaymentMethodCapability[] {
    // SmartForm wallets/APMs exist on the platform but use a different form
    // mode and per-contract enablement — card via the embedded form is v1.
    return PAYMENT_METHODS;
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
      if (resolve) {
        // A refused transaction (or an aborted 3DS pop-in) during confirm().
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
      }
      return false; // adapter-managed post-payment: never POST to a kr-post-url
    });
  } catch {
    // Best-effort — see above.
  }
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

/** Acquirer refusal codes (ACQ_001 detailedErrorCode) → decline refinement. */
const ACQUIRER_DECLINE_MAP: Record<string, UnifiedErrorCode> = {
  "51": "insufficient_funds",
  "33": "expired_card",
  "54": "expired_card",
  "14": "invalid_card_data",
  "43": "fraud_suspected",
  "59": "fraud_suspected",
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
  CLIENT_305: "invalid_card_data",
  CLIENT_997: "invalid_request", // endpoint/platform mismatch — the formToken came from a sister platform
  CLIENT_998: "invalid_request", // demo formToken used against a real shop
  CLIENT_999: "psp_unavailable",
  PSP_108: "invalid_request", // formToken expired (~15 min) — create a fresh session
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
  } else if (rawCode.startsWith("CLIENT_5")) {
    code = "invalid_request"; // integration errors (wrong DOM/config)
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

function assertBrowser(operation: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw PayFanoutError.invalidRequest(
      `PayZenClientAdapter.${operation} is browser-only — never call it during SSR`,
    );
  }
}

function asPayZenHandle(handle: MountedFieldsHandle): PayZenHandle {
  const h = handle as unknown as PayZenHandle;
  if (h?.pspName !== "payzen" || !h.kr) {
    throw PayFanoutError.invalidRequest("Handle was not produced by PayZenClientAdapter.mount");
  }
  return h;
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
