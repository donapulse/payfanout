import {
  assertBrowser,
  brandMountedFieldsHandle,
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
 * Structural subset of Paysafe.js (hosted iframe fields). Injected in tests,
 * loaded from hosted.paysafe.com in browsers. The field-event surface is
 * optional — SDK builds without it simply never fire onChange (degrade, not
 * break).
 */
export interface PaysafeFieldsInstanceLike {
  tokenize(options: Record<string, unknown>): Promise<{ token: string }>;
  /** True once every hosted field holds valid input. */
  areAllFieldsValid?(): boolean;
  /** Per-field validity event registration ("cardNumber" | "expiryDate" | "cvv"). */
  fields?(selector: string): {
    valid?(handler: (...args: unknown[]) => void): void;
    invalid?(handler: (...args: unknown[]) => void): void;
  };
}

export interface PaysafeJsLike {
  fields: {
    setup(apiKey: string, options: Record<string, unknown>): Promise<PaysafeFieldsInstanceLike>;
  };
}

export interface PaysafeClientAdapterConfig {
  /** Public (single-use-token) Base64 API key — safe for the browser, holds no secrets. */
  apiKey: string;
  /** Explicit; mapped to Paysafe's TEST/LIVE. */
  environment: "sandbox" | "live";
  /** Passed through to tokenize() so 3DS challenges run inline (iframe), never full navigation. */
  threeDs?: Record<string, unknown>;
  /** Account capabilities vary per merchant account/currency — override the conservative default. */
  paymentMethods?: PaymentMethodCapability[];
  /** Test seams. */
  loadScript?: (url: string) => Promise<void>;
  getPaysafeGlobal?: () => PaysafeJsLike | undefined;
  sdkUrl?: string;
}

const PAYSAFE_JS_URL = "https://hosted.paysafe.com/js/v1/latest/paysafe.min.js";

const DEFAULT_METHODS: PaymentMethodCapability[] = [
  { type: "card", flow: "embedded", supported: true },
  { type: "apple_pay", flow: "popup", supported: false },
  { type: "google_pay", flow: "popup", supported: false },
  { type: "skrill", flow: "redirect", supported: false },
  { type: "neteller", flow: "redirect", supported: false },
  { type: "paysafecard", flow: "voucher_code", supported: false },
  { type: "paysafecash", flow: "voucher_code", supported: false },
];

/** The payload half of the server's signed session context (signature verified server-side only). */
interface PaysafeSessionPayload {
  v: number;
  amount: number;
  currency: string;
  merchantAccountId?: string;
  id?: string;
}

interface PaysafeHandle {
  pspName: "paysafe";
  instance: PaysafeFieldsInstanceLike;
  session: PaysafeSessionPayload;
  cleanup: () => void;
}

let mountCounter = 0;

export class PaysafeClientAdapter implements ClientPaymentAdapter {
  readonly pspName = "paysafe";
  private readonly config: PaysafeClientAdapterConfig;
  private sdkPromise?: Promise<void>;

  constructor(config: PaysafeClientAdapterConfig) {
    if (!config.apiKey) throw PayFanoutError.invalidRequest("PaysafeClientAdapter config.apiKey is required");
    if (config.environment !== "sandbox" && config.environment !== "live") {
      throw PayFanoutError.invalidRequest('PaysafeClientAdapter config.environment must be "sandbox" or "live"');
    }
    this.config = config;
  }

  async loadSdk(): Promise<void> {
    assertBrowser("PaysafeClientAdapter", "loadSdk");
    if (this.paysafeGlobal()) return;
    const url = this.config.sdkUrl ?? PAYSAFE_JS_URL;
    this.sdkPromise ??= this.config.loadScript ? this.config.loadScript(url) : injectScript(url, this.pspName);
    await this.sdkPromise;
    if (!this.paysafeGlobal()) {
      throw new PayFanoutError({
        code: "psp_unavailable",
        message: "Paysafe.js loaded but the paysafe global is missing",
        retryable: true,
        raw: undefined,
        pspName: this.pspName,
      });
    }
  }

  /**
   * Renders Paysafe's hosted iframe fields (SAQ-A eligible: card data never
   * touches the host DOM). Layout is host-controllable: elements inside the
   * container carrying data-payfanout-field="cardNumber|expiryDate|cvv" become
   * the mount points (the host owns rows/grid/spacing); missing slots fall
   * back to adapter-created stacked containers. Placeholders and any other
   * per-field or SDK option come from MountOptions.fieldOptions / locale.
   */
  async mount(container: HTMLElement, options: MountOptions): Promise<MountedFieldsHandle> {
    assertBrowser("PaysafeClientAdapter", "mount");
    await this.loadSdk();
    const session = decodeSessionPayload(options.clientSecret);
    const suffix = `payfanout-psf-${++mountCounter}`;
    const created: HTMLElement[] = [];
    const selectors: Record<string, string> = {};
    for (const name of HOSTED_FIELD_NAMES) {
      const slot = container.querySelector?.(`[data-payfanout-field="${name}"]`) as HTMLElement | null;
      // Always mount into a wrapper WE own — appended inside the host's slot
      // when one exists (the host keeps full layout control), else stacked in
      // the container. Per-mount wrappers keep concurrent mounts isolated
      // (React 18 StrictMode runs two overlapping mounts; sharing the slot
      // element directly lets the canceled mount's cleanup destroy the
      // survivor's iframes) and cleanup can never touch host elements.
      const div = document.createElement("div");
      div.id = `${suffix}-${name}`;
      (slot ?? container).appendChild(div);
      created.push(div);
      selectors[name] = div.id;
    }

    // Host customization: fieldOptions.fields carries per-field Paysafe options
    // (placeholder, …); every other fieldOptions key passes through to setup.
    // The adapter keeps only what it must own to function.
    const { fields: hostFields, ...hostSetupOptions } = (options.fieldOptions ?? {}) as {
      fields?: Record<string, Record<string, unknown>>;
    } & Record<string, unknown>;
    const fieldConfig = (name: string, defaults: Record<string, unknown>): Record<string, unknown> => ({
      ...defaults,
      ...(hostFields?.[name] ?? {}),
      selector: `#${selectors[name]}`, // non-negotiable: the mount point is ours
    });

    try {
      const instance = await this.paysafeGlobal()!.fields.setup(this.config.apiKey, {
        // Paysafe locales use underscores ("fr_CA"); accept BCP-47 from hosts.
        ...(options.locale ? { locale: options.locale.replace(/-/g, "_") } : {}),
        ...hostSetupOptions,
        // Non-negotiables the host cannot clobber — the session decides them.
        environment: this.config.environment === "live" ? "LIVE" : "TEST",
        // Required by Paysafe.js — omitting it fails setup with error 9055
        // "Invalid currency parameter".
        currencyCode: session.currency,
        ...(session.merchantAccountId ? { accountId: session.merchantAccountId } : {}),
        fields: {
          cardNumber: fieldConfig("cardNumber", { placeholder: "Card number" }),
          expiryDate: fieldConfig("expiryDate", { placeholder: "MM/YY" }),
          cvv: fieldConfig("cvv", { placeholder: "CVV" }),
        },
        ...(toPaysafeStyle(options.appearance) ?? {}),
      });
      options.onReady?.();
      registerFieldStateEvents(instance, options);
      const handle: PaysafeHandle = {
        pspName: "paysafe",
        instance,
        session,
        // Removes ONLY our wrappers (and the iframes inside them) — host
        // slot elements are never touched.
        cleanup: () => created.forEach((el) => el.remove()),
      };
      return brandMountedFieldsHandle(handle);
    } catch (err) {
      created.forEach((el) => el.remove());
      const mapped = mapPaysafeJsError(err);
      options.onError?.(mapped);
      throw mapped;
    }
  }

  /**
   * Tokenize-first shape (§4a): resolves with requires_confirmation plus the
   * Payment Handle token. The host passes that clientToken to the server's
   * completePayment — <PayButton> wires this automatically. 3DS runs inline
   * inside Paysafe.js during tokenize (challenge iframe), never a navigation.
   */
  async confirm(handle: MountedFieldsHandle): Promise<ConfirmResult> {
    const h = asPaysafeHandle(handle);
    try {
      const { token } = await h.instance.tokenize({
        transactionType: "PAYMENT",
        paymentType: "CARD",
        amount: h.session.amount,
        currencyCode: h.session.currency,
        ...(h.session.merchantAccountId ? { accountId: h.session.merchantAccountId } : {}),
        ...(h.session.id ? { merchantRefNum: h.session.id } : {}),
        ...(this.config.threeDs ? { threeDs: this.config.threeDs } : {}),
      });
      if (!token) {
        return { status: "failed", error: mapPaysafeJsError(new Error("Paysafe tokenize returned no token")) };
      }
      return { status: "requires_confirmation", clientToken: token };
    } catch (err) {
      return { status: "failed", error: mapPaysafeJsError(err) };
    }
  }

  unmount(handle: MountedFieldsHandle): void {
    asPaysafeHandle(handle).cleanup();
  }

  listPaymentMethodCapabilities(): PaymentMethodCapability[] {
    return this.config.paymentMethods ?? DEFAULT_METHODS;
  }

  private paysafeGlobal(): PaysafeJsLike | undefined {
    if (this.config.getPaysafeGlobal) return this.config.getPaysafeGlobal();
    if (typeof window === "undefined") return undefined;
    return (window as unknown as { paysafe?: PaysafeJsLike }).paysafe;
  }
}

const HOSTED_FIELD_NAMES = ["cardNumber", "expiryDate", "cvv"] as const;

/**
 * Bridges Paysafe.js per-field valid/invalid events into the unified
 * onChange({ complete }) stream. Tracks validity per field and prefers the
 * SDK's own areAllFieldsValid() verdict when available. Everything here is
 * defensive: an SDK build without the event surface, or a registration that
 * throws, leaves onChange initialized to { complete: false } — buttons stay
 * usable via the host's own judgment, mounting never breaks.
 */
function registerFieldStateEvents(instance: PaysafeFieldsInstanceLike, options: MountOptions): void {
  options.onChange?.({ complete: false, empty: true });
  if (!options.onChange || typeof instance.fields !== "function") return;
  const validity = new Map<string, boolean>();
  const notify = (): void => {
    const complete =
      typeof instance.areAllFieldsValid === "function"
        ? instance.areAllFieldsValid()
        : HOSTED_FIELD_NAMES.every((name) => validity.get(name) === true);
    options.onChange?.({ complete });
  };
  try {
    for (const name of HOSTED_FIELD_NAMES) {
      const registrar = instance.fields(name);
      registrar?.valid?.(() => {
        validity.set(name, true);
        notify();
      });
      registrar?.invalid?.(() => {
        validity.set(name, false);
        notify();
      });
    }
  } catch {
    // Event registration is best-effort — SDK variations must not break mount.
  }
}

/**
 * Paysafe's `style` option is a map of CSS selectors to property objects and
 * hard-fails (error 9021) on scalar values — e.g. Stripe-shaped tokens like
 * `theme: "flat"`. Forward only entries in the shape Paysafe accepts.
 */
function toPaysafeStyle(appearance: Record<string, unknown> | undefined): { style: Record<string, unknown> } | undefined {
  if (!appearance) return undefined;
  const style: Record<string, unknown> = {};
  for (const [selector, value] of Object.entries(appearance)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) style[selector] = value;
  }
  return Object.keys(style).length > 0 ? { style } : undefined;
}

function asPaysafeHandle(handle: MountedFieldsHandle): PaysafeHandle {
  const h = handle as unknown as PaysafeHandle;
  if (h?.pspName !== "paysafe" || !h.instance) {
    throw PayFanoutError.invalidRequest("Handle was not produced by PaysafeClientAdapter.mount");
  }
  return h;
}

/**
 * Reads the payload half of `payloadB64url.signatureB64url`. The signature is
 * NOT verified here — the browser has no key. Tampering is caught
 * server-side when completePayment verifies the full token.
 */
export function decodeSessionPayload(clientSecret: string): PaysafeSessionPayload {
  const payloadPart = clientSecret.split(".")[0] ?? "";
  let parsed: PaysafeSessionPayload;
  try {
    parsed = JSON.parse(base64UrlDecode(payloadPart)) as PaysafeSessionPayload;
  } catch (err) {
    throw PayFanoutError.invalidRequest(
      "clientSecret is not a Paysafe session context — pass PaymentSession.clientSecret from createPaymentSession",
      err,
    );
  }
  if (typeof parsed?.amount !== "number" || typeof parsed?.currency !== "string") {
    throw PayFanoutError.invalidRequest("Paysafe session payload is missing amount/currency", parsed);
  }
  return parsed;
}

function base64UrlDecode(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  // atob is a global across every supported runtime (browsers, Node >=18.17,
  // edge), so this client-safe adapter decodes without Node's Buffer; TextDecoder
  // handles UTF-8 payloads correctly.
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const PAYSAFE_JS_CODE_MAP: Record<string, UnifiedErrorCode> = {
  "9003": "invalid_card_data", // invalid card number/format
  "9004": "invalid_card_data",
  "9042": "invalid_card_data",
  "9125": "psp_unavailable",
  "9201": "authentication_required", // 3DS not completed
  "9202": "authentication_required",
};

function mapPaysafeJsError(err: unknown): UnifiedError {
  const e = err as { code?: string | number; error?: { code?: string | number; message?: string }; message?: string };
  const rawCode = String(e?.error?.code ?? e?.code ?? "");
  const code: UnifiedErrorCode = PAYSAFE_JS_CODE_MAP[rawCode] ?? "processing_error";
  return new PayFanoutError({
    code,
    message:
      code === "invalid_card_data"
        ? "The card details are invalid."
        : code === "authentication_required"
          ? "Additional authentication is required."
          : "The payment could not be processed. Please try again.",
    retryable: code === "processing_error" || code === "psp_unavailable",
    raw: err,
    pspName: "paysafe",
  });
}
