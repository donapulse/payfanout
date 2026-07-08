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
} from "@payfanout/core";

export interface GoCardlessClientAdapterConfig {
  /** Explicit, mirrors the server adapter — never inferred. */
  environment: "sandbox" | "live";
  /** Scheme enablement varies per account — override the conservative defaults. */
  paymentMethods?: PaymentMethodCapability[];
}

/**
 * Same honest list as the server adapter: GoCardless bank authorisation is
 * only permitted from GoCardless-hosted UIs, so every method is flow
 * "redirect" — an embedded flow cannot be claimed.
 */
const DEFAULT_METHODS: PaymentMethodCapability[] = [
  { type: "bank_redirect_generic", flow: "redirect", supported: true },
  { type: "sepa_debit", flow: "redirect", supported: true },
  { type: "bacs_debit", flow: "redirect", supported: true },
  { type: "ach", flow: "redirect", supported: false },
];

const DEFAULT_PANEL_TEXT = "You will be redirected to your bank to authorise this payment.";

interface GoCardlessHandle {
  pspName: "gocardless";
  panel: HTMLElement;
  /** The session's clientSecret: the GoCardless-hosted flow's authorisation_url. */
  authorisationUrl: string;
}

/**
 * GoCardless one-off bank payments run entirely on GoCardless-hosted pages,
 * so this adapter has no card fields and no browser SDK — the session's
 * clientSecret IS the hosted authorisation URL, and confirm() is the redirect.
 * There is no key of any kind on the client.
 */
export class GoCardlessClientAdapter implements ClientPaymentAdapter {
  readonly pspName = "gocardless";
  private readonly config: GoCardlessClientAdapterConfig;

  constructor(config: GoCardlessClientAdapterConfig) {
    if (config.environment !== "sandbox" && config.environment !== "live") {
      throw PayFanoutError.invalidRequest(
        'GoCardlessClientAdapter config.environment must be "sandbox" or "live"',
      );
    }
    this.config = config;
  }

  /** No script to inject — resolves once the browser guard passes (SSR parity with SDK adapters). */
  async loadSdk(): Promise<void> {
    assertBrowser("GoCardlessClientAdapter", "loadSdk");
  }

  /**
   * Nothing is filled client-side, so mount renders a plain, unbranded
   * informational panel and immediately reports the fields complete
   * (initialized { complete: false } first so button state stays
   * deterministic). `fieldOptions.description` overrides the panel text;
   * `appearance.panel` carries inline CSS for it — the payment UI itself is
   * GoCardless-hosted and not themeable from here.
   */
  async mount(container: HTMLElement, options: MountOptions): Promise<MountedFieldsHandle> {
    assertBrowser("GoCardlessClientAdapter", "mount");
    if (!options.clientSecret) {
      throw PayFanoutError.invalidRequest(
        "GoCardless mount requires PaymentSession.clientSecret (the hosted authorisation URL)",
        { missing: "clientSecret" },
      );
    }
    const panel = document.createElement("div");
    panel.setAttribute("data-payfanout-gocardless-panel", "");
    const description = options.fieldOptions?.["description"];
    panel.textContent = typeof description === "string" ? description : DEFAULT_PANEL_TEXT;
    const style = options.appearance?.["panel"];
    if (style !== null && typeof style === "object" && !Array.isArray(style)) {
      Object.assign(panel.style, style);
    }
    container.appendChild(panel);
    options.onChange?.({ complete: false });
    options.onChange?.({ complete: true });
    options.onReady?.();
    const handle: GoCardlessHandle = {
      pspName: "gocardless",
      panel,
      authorisationUrl: options.clientSecret,
    };
    return brandMountedFieldsHandle(handle);
  }

  /**
   * Redirect flow: every GoCardless method is flow "redirect", so confirm
   * hands the page to the hosted authorisation flow — the same treatment the
   * Stripe adapter gives its redirect methods. The returned promise never
   * settles (the navigation unloads the page); the outcome resolves on
   * returnUrl via handleRedirectReturn + a server-side retrievePayment.
   */
  async confirm(handle: MountedFieldsHandle): Promise<ConfirmResult> {
    const h = asGoCardlessHandle(handle);
    assertBrowser("GoCardlessClientAdapter", "confirm");
    if (!/^https:\/\//.test(h.authorisationUrl)) {
      return {
        status: "failed",
        error: PayFanoutError.invalidRequest(
          "clientSecret is not a GoCardless authorisation URL — pass PaymentSession.clientSecret from createPaymentSession",
          { clientSecret: h.authorisationUrl },
        ),
      };
    }
    window.location.assign(h.authorisationUrl);
    return new Promise<ConfirmResult>(() => {});
  }

  unmount(handle: MountedFieldsHandle): void {
    // Only the adapter-created panel — host elements are never touched.
    asGoCardlessHandle(handle).panel.remove();
  }

  /**
   * GoCardless lands the payer back with billing_request_id /
   * billing_request_flow_id query params and is explicit that the redirect
   * must NOT be used to decide the outcome ("Always use webhooks"). So a
   * GoCardless return resolves "processing": the host confirms server-side
   * via retrievePayment(billing_request_id) or waits for the webhook.
   * Returns null when the URL carries no GoCardless params, so a router can
   * probe every registered adapter safely.
   */
  async handleRedirectReturn(location: RedirectReturnLocation): Promise<ConfirmResult | null> {
    const params = new URLSearchParams(
      location.search.startsWith("?") ? location.search.slice(1) : location.search,
    );
    if (!params.get("billing_request_id")) return null;
    return { status: "processing" };
  }

  listPaymentMethodCapabilities(): PaymentMethodCapability[] {
    return this.config.paymentMethods ?? DEFAULT_METHODS;
  }
}

function asGoCardlessHandle(handle: MountedFieldsHandle): GoCardlessHandle {
  const h = handle as unknown as GoCardlessHandle;
  if (h?.pspName !== "gocardless" || !h.panel || typeof h.authorisationUrl !== "string") {
    throw PayFanoutError.invalidRequest("Handle was not produced by GoCardlessClientAdapter.mount");
  }
  return h;
}
