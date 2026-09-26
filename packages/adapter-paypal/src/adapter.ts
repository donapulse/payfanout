import {
  assertBrowser,
  brandMountedFieldsHandle,
  injectScript,
  isValidCspNonce,
  normalizeCurrency,
  PayFanoutError,
  type ClientPaymentAdapter,
  type ConfirmResult,
  type MountedFieldsHandle,
  type MountOptions,
  type PaymentMethodCapability,
} from "@payfanout/core";

/**
 * Structural subset of the PayPal JS SDK's Buttons component. Injected in
 * tests, loaded from www.paypal.com/sdk/js in browsers.
 */
export interface PayPalButtonsInstanceLike {
  render(container: HTMLElement): Promise<void> | void;
  /** Tears down the rendered button — used by unmount (best-effort). */
  close?(): Promise<void> | void;
  /** Funding eligibility for this buyer/device. */
  isEligible?(): boolean;
}

export interface PayPalJsLike {
  Buttons(options: Record<string, unknown>): PayPalButtonsInstanceLike;
}

export interface PayPalClientAdapterConfig {
  /** REST app client id — public, holds no secret authority. */
  clientId: string;
  /**
   * Explicit and validated, like every PayFanout adapter — even though the
   * PayPal SDK infers sandbox vs live from the client id alone.
   */
  environment: "sandbox" | "live";
  /**
   * The JS SDK bakes the currency into its script URL and window.paypal is a
   * page-wide singleton, so one page LOAD serves ONE currency (default
   * "USD"). Another currency requires a full page navigation or reload — see
   * the PayPal guide.
   */
  currency?: string;
  /** SDK display locale — a load-time query param (e.g. "fr-FR"). */
  locale?: string;
  /**
   * SDK intent — load-time and page-wide like `currency`, must match the
   * order's intent: "capture" (default) for automatic capture, "authorize"
   * for manual-capture sessions.
   */
  intent?: "capture" | "authorize";
  /**
   * Client half of the server's `userAction`, sent as the SDK's `commit`
   * query param so the popup's final button matches what happens next:
   * "continue" (default, commit=false) shows "Continue" — PayFanout's Pay
   * button completes the payment afterwards; "pay_now" (commit=true) belongs
   * to capture-on-approval flows. Both adapters must agree.
   */
  userAction?: "continue" | "pay_now";
  /**
   * A Content-Security-Policy nonce for the JS SDK `<script>` the adapter
   * injects, set as both its `nonce` and its `data-csp-nonce` attribute before
   * the tag is inserted. The browser checks `nonce` against `script-src`; the
   * SDK reads only `data-csp-nonce` and sets it on the inline scripts and
   * styles it creates, which PayPal's nonce-based policy needs. Unlike
   * `nonce`, which the browser hides from CSS selectors once the tag is
   * connected under a header-delivered policy, `data-csp-nonce` stays readable
   * to attribute selectors, so only this tag carries it. Pass the value alone,
   * as in the policy's `'nonce-<value>'` source; the constructor refuses
   * anything else. The adapter never reads a nonce from the page, a
   * `loadScript` seam loads the script without it, and an SDK the page already
   * loaded is used as it is.
   */
  cspNonce?: string;
  /** Test seams. */
  sdkBaseUrl?: string;
  /**
   * Test seam. Called again by the next loadSdk() after an attempt that rejects
   * or leaves the SDK global missing, so it must be safe to call more than once.
   */
  loadScript?: (url: string) => Promise<void>;
  getPayPalGlobal?: () => PayPalJsLike | undefined;
}

// The JS SDK v5 loader; its reference lives under /sdk/js/v5/ (/sdk/js/reference is v6).
const PAYPAL_SDK_URL = "https://www.paypal.com/sdk/js";

interface PayPalApprovalState {
  /** Set once onApprove fires; cleared again by onCancel/onError. */
  approvedOrderId?: string;
  /** confirm() calls waiting for the popup outcome. */
  waiters: Array<(result: ConfirmResult) => void>;
  unmounted: boolean;
}

interface PayPalHandle {
  pspName: "paypal";
  orderId: string;
  buttons: PayPalButtonsInstanceLike;
  state: PayPalApprovalState;
  cleanup: () => void;
}

/**
 * PayPal's popup can only be opened by PayPal's own rendered button (the
 * click must originate inside their iframe), so for PayPal the rendered
 * button IS the approval step: the buyer clicks it, approves in the popup
 * ("Continue"), and `onChange({ complete: true })` fires. PayFanout's own Pay
 * button then runs confirm() -> completePayment on the server, which is where
 * the money actually moves.
 */
export class PayPalClientAdapter implements ClientPaymentAdapter {
  readonly pspName = "paypal";
  private readonly config: PayPalClientAdapterConfig;
  private sdkPromise?: Promise<void>;

  constructor(config: PayPalClientAdapterConfig) {
    if (!config.clientId) throw PayFanoutError.invalidRequest("PayPalClientAdapter config.clientId is required");
    if (config.environment !== "sandbox" && config.environment !== "live") {
      throw PayFanoutError.invalidRequest('PayPalClientAdapter config.environment must be "sandbox" or "live"');
    }
    if (config.intent !== undefined && config.intent !== "capture" && config.intent !== "authorize") {
      throw PayFanoutError.invalidRequest('PayPalClientAdapter config.intent must be "capture" or "authorize"');
    }
    if (config.userAction !== undefined && config.userAction !== "continue" && config.userAction !== "pay_now") {
      throw PayFanoutError.invalidRequest('PayPalClientAdapter config.userAction must be "continue" or "pay_now"');
    }
    if (config.currency !== undefined) normalizeCurrency(config.currency);
    if (config.cspNonce !== undefined && !isValidCspNonce(config.cspNonce)) {
      throw PayFanoutError.invalidRequest(
        "PayPalClientAdapter config.cspNonce must be the value of the policy's 'nonce-…' source: base64 or base64url characters",
      );
    }
    this.config = config;
  }

  async loadSdk(): Promise<void> {
    assertBrowser("PayPalClientAdapter", "loadSdk");
    // window.paypal is a page-wide singleton: whichever adapter loaded it
    // fixed currency/intent/commit for this page load, and later instances
    // reuse it as-is — one currency and intent per page load (see the guide).
    if (this.payPalGlobal()) return;
    const url = this.sdkUrl();
    const nonce = this.config.cspNonce;
    // The browser checks the nonce attribute and the SDK reads data-csp-nonce.
    // Only this tag carries the data- copy: under a header-delivered policy the
    // browser hides the nonce attribute from CSS selectors, never a data- one.
    this.sdkPromise ??= this.config.loadScript
      ? this.config.loadScript(url)
      : injectScript(url, this.pspName, nonce === undefined ? {} : { nonce, attributes: { "data-csp-nonce": nonce } });
    const loading = this.sdkPromise;
    try {
      await loading;
      if (!this.payPalGlobal()) {
        throw new PayFanoutError({
          code: "psp_unavailable",
          message: "PayPal JS SDK loaded but the paypal global is missing",
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

  /**
   * Renders paypal.Buttons into `container`. `options.clientSecret` is the
   * server-created order id. Button styling passes through untouched via
   * `options.fieldOptions` (`style`, `fundingSource`, …; `options.appearance`
   * is the style fallback) — the adapter owns ONLY the protected keys
   * `createOrder` / `onApprove` / `onCancel` / `onError`, because they ARE
   * the integration.
   */
  async mount(container: HTMLElement, options: MountOptions): Promise<MountedFieldsHandle> {
    assertBrowser("PayPalClientAdapter", "mount");
    if (!options.clientSecret) {
      throw PayFanoutError.invalidRequest(
        "PayPal mount requires clientSecret — pass PaymentSession.clientSecret (the PayPal order id)",
      );
    }
    await this.loadSdk();
    const paypal = this.payPalGlobal()!;
    // Approval hasn't happened yet — hosts initialize their Pay button disabled.
    options.onChange?.({ complete: false, empty: true });

    const state: PayPalApprovalState = { waiters: [], unmounted: false };
    const resolveWaiters = (result: ConfirmResult): void => {
      for (const waiter of state.waiters.splice(0)) waiter(result);
    };

    const { style: hostStyle, ...hostOptions } = (options.fieldOptions ?? {}) as {
      style?: Record<string, unknown>;
    } & Record<string, unknown>;
    const style = hostStyle ?? options.appearance;

    const wrapper = document.createElement("div");
    container.appendChild(wrapper);
    const cleanup = (): void => wrapper.remove();
    // PayPal's SDK reports a failed render through onError and then rejects
    // render() with the same failure: while render() is pending the callback
    // only keeps each distinct error, so the host hears of every failure once.
    let rendering = true;
    const held: PayFanoutError[] = [];

    let handle: PayPalHandle;
    try {
      const buttons = paypal.Buttons({
        ...hostOptions,
        ...(style ? { style } : {}),
        // A Promise of the order id, the form PayPal's SDK reference documents.
        createOrder: () => Promise.resolve(options.clientSecret),
        onApprove: (data?: { orderID?: string }) => {
          state.approvedOrderId = data?.orderID ?? options.clientSecret;
          options.onChange?.({ complete: true });
          resolveWaiters({ status: "requires_confirmation", clientToken: state.approvedOrderId });
        },
        onCancel: () => {
          // Buyer dismissed the popup. The order stays usable — they can click
          // the PayPal button again, so the state machine resets fully.
          state.approvedOrderId = undefined;
          options.onChange?.({ complete: false });
          resolveWaiters({ status: "requires_payment_method" });
        },
        onError: (err: unknown) => {
          state.approvedOrderId = undefined;
          options.onChange?.({ complete: false });
          // PayPal documents onError as a catch-all with nothing to handle
          // beyond a generic error message or page, so it is not retryable.
          const mapped = mapPayPalJsError(err, false);
          if (rendering) {
            if (!held.some((kept) => kept.raw === err)) held.push(mapped);
          } else if (state.waiters.length > 0) resolveWaiters({ status: "failed", error: mapped });
          else options.onError?.(mapped);
        },
      });
      if (typeof buttons.isEligible === "function" && !buttons.isEligible()) {
        throw PayFanoutError.invalidRequest(
          "PayPal Buttons report no eligible funding source for this buyer/device — offer another payment method",
        );
      }
      await buttons.render(wrapper);
      rendering = false;
      handle = { pspName: "paypal", orderId: options.clientSecret, buttons, state, cleanup };
    } catch (err) {
      rendering = false;
      cleanup();
      // The rejection stands for the failure the callback kept for the same
      // error; any other kept error is reported before it.
      const mapped = err instanceof PayFanoutError ? err : mapPayPalJsError(err, true);
      for (const kept of held) if (kept.raw !== mapped.raw) options.onError?.(kept);
      options.onError?.(mapped);
      throw mapped;
    }
    // The buttons are rendered: a host callback that throws from here on must
    // not tear them down, so its exception is reported as uncaught instead.
    for (const kept of held) callHost(() => options.onError?.(kept));
    callHost(() => options.onReady?.());
    return brandMountedFieldsHandle(handle);
  }

  /**
   * Tokenize-first shape: resolves with requires_confirmation plus the
   * APPROVED ORDER ID as clientToken — the host passes it to the server's
   * completePayment (<PayButton> wires this automatically). If the buyer has
   * not been through the popup yet, this waits for the button's outcome:
   * approval resolves it, cancel resolves requires_payment_method (the buyer
   * can click again), an SDK error resolves failed.
   */
  async confirm(handle: MountedFieldsHandle): Promise<ConfirmResult> {
    const h = asPayPalHandle(handle);
    if (h.state.approvedOrderId) {
      return { status: "requires_confirmation", clientToken: h.state.approvedOrderId };
    }
    if (h.state.unmounted) {
      return { status: "failed", error: unmountedError() };
    }
    return new Promise<ConfirmResult>((resolve) => h.state.waiters.push(resolve));
  }

  unmount(handle: MountedFieldsHandle): void {
    const h = asPayPalHandle(handle);
    h.state.unmounted = true;
    // Never leave a confirm() promise dangling.
    for (const waiter of h.state.waiters.splice(0)) {
      waiter({ status: "failed", error: unmountedError() });
    }
    try {
      const closing = h.buttons.close?.();
      if (closing && typeof (closing as Promise<void>).catch === "function") {
        (closing as Promise<void>).catch(() => undefined); // best-effort teardown
      }
    } catch {
      // close() throwing on an already-gone iframe is an SDK quirk — removing
      // our wrapper below is the real cleanup.
    }
    h.cleanup();
  }

  listPaymentMethodCapabilities(): PaymentMethodCapability[] {
    return [{ type: "paypal", flow: "popup", supported: true }];
  }

  private sdkUrl(): string {
    const params = new URLSearchParams({
      "client-id": this.config.clientId,
      currency: (this.config.currency ?? "USD").toUpperCase(),
      intent: this.config.intent ?? "capture",
      // commit=false keeps the popup's final button on "Continue" (the
      // server's user_action counterpart); "pay_now" flips it to commit=true.
      commit: String((this.config.userAction ?? "continue") === "pay_now"),
      components: "buttons",
    });
    // The SDK's locale query param uses underscores (fr_FR); accept BCP-47.
    if (this.config.locale) params.set("locale", this.config.locale.replace(/-/g, "_"));
    return `${this.config.sdkBaseUrl ?? PAYPAL_SDK_URL}?${params.toString()}`;
  }

  private payPalGlobal(): PayPalJsLike | undefined {
    if (this.config.getPayPalGlobal) return this.config.getPayPalGlobal();
    if (typeof window === "undefined") return undefined;
    return (window as unknown as { paypal?: PayPalJsLike }).paypal;
  }
}

function unmountedError(): PayFanoutError {
  return PayFanoutError.invalidRequest("PayPal buttons were unmounted before the buyer approved the payment");
}

function asPayPalHandle(handle: MountedFieldsHandle): PayPalHandle {
  const h = handle as unknown as PayPalHandle;
  if (h?.pspName !== "paypal" || !h.state) {
    throw PayFanoutError.invalidRequest("Handle was not produced by PayPalClientAdapter.mount");
  }
  return h;
}

/**
 * The SDK's errors are untyped Error objects with no stable codes —
 * processing_error with the raw preserved is the honest mapping. A mount
 * that throws is retryable (mounting again can succeed); onError is not.
 */
/** Runs a host callback; its exception surfaces as uncaught, as an event listener's does. */
function callHost(callback: () => void): void {
  try {
    callback();
  } catch (hostError) {
    if (typeof globalThis.reportError === "function") globalThis.reportError(hostError);
    else
      setTimeout(() => {
        throw hostError;
      }, 0);
  }
}

function mapPayPalJsError(err: unknown, retryable: boolean): PayFanoutError {
  return new PayFanoutError({
    code: "processing_error",
    message: "The PayPal payment could not be completed. Please try again.",
    retryable,
    raw: err,
    pspName: "paypal",
  });
}

