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
  type RedirectReturnLocation,
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

/**
 * Query parameter the SERVER adapter appends to the returnLinks it registers, so
 * the return trip is identifiable (Paysafe itself adds nothing). Kept in step
 * with PAYSAFE_RETURN_MARKER in adapter-paysafe-server — the packages share no
 * code, since a client-safe package cannot depend on a server one.
 */
const PAYSAFE_RETURN_MARKER = "payfanout_psp";

/**
 * What the marked return trip resolves as its clientToken. The value is a
 * placeholder: the real handle token rides the signed session context, and the
 * server adapter ignores the wire token for a session whose handle is already
 * minted. It still has to be non-empty — the react transport only invokes the
 * host's completion callback when a clientToken is present, and the standard
 * completion route rejects an empty string.
 */
const PAYSAFE_REDIRECT_CLIENT_TOKEN = "paysafe-redirect-return";

const DEFAULT_METHODS: PaymentMethodCapability[] = [
  { type: "card", flow: "embedded", supported: true },
  { type: "apple_pay", flow: "popup", supported: false },
  { type: "google_pay", flow: "popup", supported: false },
  { type: "skrill", flow: "redirect", supported: false },
  { type: "neteller", flow: "redirect", supported: false },
  { type: "paysafecard", flow: "voucher_code", supported: false },
  { type: "paysafecash", flow: "voucher_code", supported: false },
  // Mirrors the server adapter: implemented, but off by default — per-account
  // enablement and Canada/CAD only. Canadian merchants opt in via
  // config.paymentMethods, and their override carries the gate. The CAD literal
  // is kept in step with INTERAC_CURRENCIES in adapter-paysafe-server — the
  // packages share no code, since a client-safe package cannot depend on a
  // server one.
  { type: "interac_etransfer", flow: "redirect", supported: false, currencies: ["CAD"] },
];

/** The payload half of the server's signed session context (signature verified server-side only). */
interface PaysafeSessionPayload {
  v: number;
  amount: number;
  currency: string;
  merchantAccountId?: string;
  id?: string;
  /**
   * Present only for rails Paysafe.js cannot tokenize (Interac e-Transfer): the
   * server already minted the handle, and this is where the customer authenticates.
   */
  redirectUrl?: string;
}

interface PaysafeCardHandle {
  pspName: "paysafe";
  kind: "card";
  instance: PaysafeFieldsInstanceLike;
  session: PaysafeSessionPayload;
  cleanup: () => void;
}

/** Redirect rails have no SDK, no fields and no key in the browser — only the URL. */
interface PaysafeRedirectHandle {
  pspName: "paysafe";
  kind: "redirect";
  redirectUrl: string;
  cleanup: () => void;
}

type PaysafeHandle = PaysafeCardHandle | PaysafeRedirectHandle;

const DEFAULT_REDIRECT_PANEL_TEXT =
  "You will be redirected to Interac to authorise this payment with your bank.";

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
    const session = decodeSessionPayload(options.clientSecret);
    // A redirect session carries no card fields, so Paysafe.js is never loaded.
    if (session.redirectUrl) return this.mountRedirectPanel(container, options, session.redirectUrl);
    await this.loadSdk();
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
        ...(session.merchantAccountId ? { accountId: toPaysafeAccountId(session.merchantAccountId) } : {}),
        fields: {
          cardNumber: fieldConfig("cardNumber", { placeholder: "Card number" }),
          expiryDate: fieldConfig("expiryDate", { placeholder: "MM/YY" }),
          cvv: fieldConfig("cvv", { placeholder: "CVV" }),
        },
        ...(toPaysafeStyle(options.appearance) ?? {}),
      });
      options.onReady?.();
      registerFieldStateEvents(instance, options);
      const handle: PaysafeCardHandle = {
        pspName: "paysafe",
        kind: "card",
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
   * Nothing is collected here — the server already minted the handle — so the
   * panel is plain and unbranded and the fields report complete immediately
   * (initialized false first, so button state stays deterministic).
   * `fieldOptions.description` overrides the text; `appearance.panel` carries
   * inline CSS. The Interac page itself is not themeable from here.
   */
  private mountRedirectPanel(
    container: HTMLElement,
    options: MountOptions,
    redirectUrl: string,
  ): MountedFieldsHandle {
    const panel = document.createElement("div");
    panel.setAttribute("data-payfanout-paysafe-panel", "");
    const description = options.fieldOptions?.["description"];
    panel.textContent = typeof description === "string" ? description : DEFAULT_REDIRECT_PANEL_TEXT;
    const style = options.appearance?.["panel"];
    if (style !== null && typeof style === "object" && !Array.isArray(style)) {
      Object.assign(panel.style, style);
    }
    container.appendChild(panel);
    options.onChange?.({ complete: false, empty: true });
    options.onChange?.({ complete: true });
    options.onReady?.();
    const handle: PaysafeRedirectHandle = {
      pspName: "paysafe",
      kind: "redirect",
      redirectUrl,
      cleanup: () => panel.remove(),
    };
    return brandMountedFieldsHandle(handle);
  }

  /**
   * Tokenize-first shape (§4a): resolves with requires_confirmation plus the
   * Payment Handle token. The host passes that clientToken to the server's
   * completePayment — <PayButton> wires this automatically. 3DS runs inline
   * inside Paysafe.js during tokenize (challenge iframe), never a navigation.
   *
   * Redirect rails have no token to produce: confirm() hands the page to the
   * provider and the outcome resolves server-side after the return trip.
   */
  async confirm(handle: MountedFieldsHandle): Promise<ConfirmResult> {
    const h = asPaysafeHandle(handle);
    if (h.kind === "redirect") {
      assertBrowser("PaysafeClientAdapter", "confirm");
      window.location.assign(h.redirectUrl);
      // The navigation unloads the page, so this promise intentionally never settles.
      return new Promise<ConfirmResult>(() => {});
    }
    try {
      const { token } = await h.instance.tokenize({
        transactionType: "PAYMENT",
        paymentType: "CARD",
        amount: h.session.amount,
        currencyCode: h.session.currency,
        ...(h.session.merchantAccountId ? { accountId: toPaysafeAccountId(h.session.merchantAccountId) } : {}),
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

  /**
   * Paysafe documents no query parameters on the return trip — it signals the
   * outcome by WHICH returnLinks rel it sends the customer to, and the server
   * adapter deliberately points them all at the host's one returnUrl. So the
   * marker the server plants there is the only reliable evidence a Paysafe
   * redirect landed, and the landing spot never decides the outcome: the rail
   * is server-completed, so the host finalizes with completePayment. The
   * clientToken is a placeholder — the real handle token rides the signed
   * session context and the server ignores the wire value once a handle is
   * minted — but it must be present and non-empty, because the standard
   * completion transport only fires when a clientToken exists and the
   * completion route rejects an empty one.
   * Returns null on any other URL, so a router can probe every adapter safely.
   */
  async handleRedirectReturn(location: RedirectReturnLocation): Promise<ConfirmResult | null> {
    const params = new URLSearchParams(
      location.search.startsWith("?") ? location.search.slice(1) : location.search,
    );
    if (params.get(PAYSAFE_RETURN_MARKER) !== "paysafe") return null;
    return { status: "requires_confirmation", clientToken: PAYSAFE_REDIRECT_CLIENT_TOKEN };
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

/** The small cross-PSP appearance vocabulary hosts can pass regardless of PSP. */
const COMMON_APPEARANCE_TOKENS = new Set([
  "colorPrimary",
  "colorText",
  "colorDanger",
  "colorBackground",
  "fontFamily",
  "fontSize",
]);

/** Common tokens Paysafe.js can honestly apply to its hosted card inputs. */
const COMMON_APPEARANCE_TO_PAYSAFE: Record<string, string> = {
  colorText: "color",
  colorBackground: "background-color",
  fontFamily: "font-family",
  fontSize: "font-size",
};

/** Stripe Appearance API keys — meaningless to Paysafe.js; forwarding them breaks ALL styling. */
const STRIPE_APPEARANCE_KEYS = new Set(["variables", "rules", "theme", "labels"]);

/**
 * Translates PaymentFields `appearance` into Paysafe.js's `style` option (a map of
 * CSS selectors to property objects). It handles three kinds of entry:
 *
 * - **Common tokens** — the cross-PSP set is mapped onto the hosted `input`
 *   selector (colorText→color, colorBackground→background-color,
 *   fontFamily→font-family, fontSize→font-size) so one `appearance` styles either
 *   PSP. `colorPrimary`/`colorDanger` have no honest hosted-card-input surface in
 *   Paysafe.js, so they are recognized but not applied (never faked).
 * - **Native Paysafe selectors** — object-valued entries (`input`, `:focus`, …)
 *   pass through untouched for power users; a native `input` wins over the tokens.
 * - **Stripe Appearance keys / other unusable entries** — dropped with a clear
 *   warning; forwarding them makes Paysafe.js log a cryptic "Invalid css property"
 *   and silently drop ALL styling.
 */
function toPaysafeStyle(appearance: Record<string, unknown> | undefined): { style: Record<string, unknown> } | undefined {
  if (!appearance) return undefined;
  const style: Record<string, unknown> = {};
  const inputCss: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(appearance)) {
    if (COMMON_APPEARANCE_TOKENS.has(key)) {
      const cssProp = COMMON_APPEARANCE_TO_PAYSAFE[key];
      if (cssProp !== undefined && typeof value === "string") inputCss[cssProp] = value;
      // colorPrimary/colorDanger: recognized but not surfaced by Paysafe.js — ignore, don't warn.
    } else if (STRIPE_APPEARANCE_KEYS.has(key)) {
      dropped.push(key);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      style[key] = value;
    } else {
      dropped.push(key);
    }
  }
  if (Object.keys(inputCss).length > 0) {
    style["input"] = { ...inputCss, ...((style["input"] as Record<string, unknown> | undefined) ?? {}) };
  }
  if (dropped.length > 0) {
    console.warn(
      `[payfanout] Paysafe ignored appearance entries it cannot apply: ${dropped.join(", ")}. ` +
        `Paysafe hosted fields take a CSS selector-to-properties map (e.g. { input: { color, "font-family" } }) ` +
        `or the common tokens colorText/colorBackground/fontFamily/fontSize; Stripe Appearance API keys ` +
        `(variables/theme/rules/labels) do not apply to Paysafe.`,
    );
  }
  return Object.keys(style).length > 0 ? { style } : undefined;
}

/**
 * Paysafe.js validates `accountId` as a NUMBER — the string form produced by a
 * `merchantAccountResolver` (typed `=> string | undefined`) fails setup/tokenize with error
 * 9003 ("Invalid accountId parameter") before any card data is evaluated, even
 * though the Paysafe REST API accepts both. Coerce a digit-only id to its
 * numeric form; leave anything non-numeric, or too large to represent exactly
 * (a silently rounded id could route to the wrong merchant account), untouched.
 */
function toPaysafeAccountId(id: string): string | number {
  if (!/^\d+$/.test(id)) return id;
  const numeric = Number(id);
  return Number.isSafeInteger(numeric) ? numeric : id;
}

function asPaysafeHandle(handle: MountedFieldsHandle): PaysafeHandle {
  const h = handle as unknown as PaysafeHandle;
  const known =
    h?.pspName === "paysafe" &&
    ((h.kind === "card" && !!h.instance) || (h.kind === "redirect" && typeof h.redirectUrl === "string"));
  if (!known) {
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
  "9003": "invalid_card_data", // invalid card field — remapped to invalid_request for options.* failures (see mapPaysafeJsError)
  "9004": "invalid_card_data",
  "9042": "invalid_card_data",
  "9125": "psp_unavailable",
  "9201": "authentication_required", // 3DS not completed
  "9202": "authentication_required",
};

interface PaysafeJsErrorLike {
  code?: string | number;
  detailedMessage?: string;
  fieldErrors?: Array<{ message?: string } | undefined>;
  error?: { code?: string | number; message?: string; detailedMessage?: string };
  message?: string;
}

/**
 * True when a Paysafe.js failure names a setup/tokenize `options.*` parameter
 * (e.g. detailedMessage "Invalid fields: options.accountId.") rather than a
 * card field. Paysafe puts the offending field in detailedMessage; the top-level
 * message, any nested error, and the per-field fieldErrors are also scanned
 * defensively across SDK error shapes.
 */
function mentionsConfigOption(e: PaysafeJsErrorLike): boolean {
  const haystack = [
    e?.detailedMessage,
    e?.message,
    e?.error?.detailedMessage,
    e?.error?.message,
    ...(e?.fieldErrors ?? []).map((f) => f?.message),
  ]
    .filter((s): s is string => typeof s === "string")
    .join(" ");
  return /\boptions\./i.test(haystack);
}

function mapPaysafeJsError(err: unknown): UnifiedError {
  const e = err as PaysafeJsErrorLike;
  const rawCode = String(e?.error?.code ?? e?.code ?? "");
  let code: UnifiedErrorCode = PAYSAFE_JS_CODE_MAP[rawCode] ?? "processing_error";
  // Paysafe.js overloads 9003 for BOTH invalid card fields AND invalid
  // setup/tokenize OPTIONS (accountId, currencyCode, merchantRefNum, …). A
  // configuration failure must not tell the cardholder their card is invalid,
  // so a 9003 that names an `options.*` parameter surfaces as invalid_request
  // (non-retryable, clearly not the shopper's card) — hosts then alert on
  // configuration instead of the cardholder retyping a valid card.
  if (rawCode === "9003" && mentionsConfigOption(e)) {
    code = "invalid_request";
  }
  return new PayFanoutError({
    code,
    message:
      code === "invalid_card_data"
        ? "The card details are invalid."
        : code === "authentication_required"
          ? "Additional authentication is required."
          : code === "invalid_request"
            ? "The payment request was invalid."
            : "The payment could not be processed. Please try again.",
    retryable: code === "processing_error" || code === "psp_unavailable",
    raw: err,
    pspName: "paysafe",
  });
}
