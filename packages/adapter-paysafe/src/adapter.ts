import {
  assertBrowser,
  brandMountedFieldsHandle,
  injectScript,
  PayFanoutError,
  utf8ToBase64Url,
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
  // Bank-debit rails, mirroring the server adapter: implemented, but off by
  // default — enablement is per merchant account, and an opt-in override via
  // config.paymentMethods must carry its own gates. ACH and EFT declare no
  // currencies (Paysafe documents none for either) and SEPA no countries (a
  // zone, not a country). The currency/country literals are kept in step with
  // adapter-paysafe-server — the packages share no code, since a client-safe
  // package cannot depend on a server one.
  { type: "sepa_debit", flow: "embedded", supported: false, currencies: ["EUR"] },
  { type: "ach", flow: "embedded", supported: false },
  { type: "bacs_debit", flow: "embedded", supported: false, currencies: ["GBP"], countries: ["GB"] },
  { type: "pad", flow: "embedded", supported: false, countries: ["CA"] },
  // Mirrors the server adapter: implemented, but off by default — per-account
  // enablement and Canada/CAD only. Canadian merchants opt in via
  // config.paymentMethods, and their override carries the gates. The CAD/CA
  // literals are kept in step with adapter-paysafe-server — the packages share
  // no code, since a client-safe package cannot depend on a server one.
  { type: "interac_etransfer", flow: "redirect", supported: false, currencies: ["CAD"], countries: ["CA"] },
];

/** The payload half of the server's signed session context (signature verified server-side only). */
interface PaysafeSessionPayload {
  v: number;
  amount: number;
  currency: string;
  merchantAccountId?: string;
  id?: string;
  /**
   * Paysafe paymentType for rails Paysafe.js cannot tokenize: the minted
   * handle's type on redirect rails, the rail to collect bank details for on
   * bank-debit sessions (SEPA/ACH/BACS/EFT). Absent on card sessions.
   */
  paymentType?: string;
  /**
   * Present only for redirect rails (Interac e-Transfer): the server already
   * minted the handle, and this is where the customer authenticates.
   */
  redirectUrl?: string;
}

/**
 * The bank-debit rails, by the paymentType the server stamps into the session
 * context. Paysafe.js cannot tokenize any of them (Payments API only), so the
 * adapter collects the details with its own plain inputs and confirm() packs
 * them into the envelope the server's completePayment parses. Kept in step
 * with BANK_DEBIT_PAYMENT_TYPES in adapter-paysafe-server — the packages share
 * no code, since a client-safe package cannot depend on a server one.
 */
const BANK_DEBIT_PAYMENT_TYPES = ["SEPA", "ACH", "BACS", "EFT"] as const;

type BankDebitPaymentType = (typeof BANK_DEBIT_PAYMENT_TYPES)[number];

const BANK_DEBIT_TYPE_SET = new Set<string>(BANK_DEBIT_PAYMENT_TYPES);

function isBankDebitPaymentType(paymentType: string | undefined): paymentType is BankDebitPaymentType {
  return paymentType !== undefined && BANK_DEBIT_TYPE_SET.has(paymentType);
}

/**
 * Wire prefix of the bank-details envelope confirm() produces on bank-debit
 * sessions: "paysafe-bank." + base64url(JSON). Kept in step with the server
 * adapter, which parses it.
 */
const BANK_ENVELOPE_PREFIX = "paysafe-bank.";

/**
 * The envelope, mirroring the server's PaysafeBankEnvelopeV1 field for field.
 * Bank details are not card data (SAQ-A is unaffected), but they get the same
 * discipline: never logged, never echoed into errors, alive only in the DOM
 * until confirm() reads them.
 */
interface PaysafeBankEnvelopeV1 {
  v: 1;
  paymentType: BankDebitPaymentType;
  accountHolderName: string;
  iban?: string;
  bic?: string;
  routingNumber?: string;
  accountNumber?: string;
  sortCode?: string;
  transitNumber?: string;
  institutionId?: string;
  /** SEPA/BACS: the customer ticked the direct-debit mandate consent box. */
  mandateConsent?: boolean;
}

type BankFieldName = Exclude<keyof PaysafeBankEnvelopeV1, "v" | "paymentType" | "mandateConsent">;

interface BankFieldSpec {
  name: BankFieldName;
  label: string;
  /** No autocomplete tokens exist for bank coordinates — only the holder's name has one. */
  autocomplete: "name" | "off";
  /** Digit-only coordinates get the numeric keyboard on touch devices. */
  numeric?: boolean;
  /** SEPA's bic is the one optional field; blank means omitted from the envelope. */
  optional?: boolean;
}

/**
 * Per-rail inputs, in render order. Names triple as envelope keys, input
 * names, and host slot names ([data-payfanout-field="iban"]); the required
 * sets are kept in step with the server's BANK_REQUIRED_FIELDS. Presence is
 * the only client-side validation — IBAN/sort-code substance is for the
 * server and Paysafe to judge, and a local checksum would reject valid
 * accounts the day it drifted.
 */
const BANK_FIELDS: Record<BankDebitPaymentType, readonly BankFieldSpec[]> = {
  SEPA: [
    { name: "accountHolderName", label: "Account holder name", autocomplete: "name" },
    { name: "iban", label: "IBAN", autocomplete: "off" },
    { name: "bic", label: "BIC (optional)", autocomplete: "off", optional: true },
  ],
  ACH: [
    { name: "accountHolderName", label: "Account holder name", autocomplete: "name" },
    { name: "routingNumber", label: "Routing number", autocomplete: "off", numeric: true },
    { name: "accountNumber", label: "Account number", autocomplete: "off", numeric: true },
  ],
  BACS: [
    { name: "accountHolderName", label: "Account holder name", autocomplete: "name" },
    { name: "sortCode", label: "Sort code", autocomplete: "off", numeric: true },
    { name: "accountNumber", label: "Account number", autocomplete: "off", numeric: true },
  ],
  EFT: [
    { name: "accountHolderName", label: "Account holder name", autocomplete: "name" },
    { name: "institutionId", label: "Institution number", autocomplete: "off", numeric: true },
    { name: "transitNumber", label: "Transit number", autocomplete: "off", numeric: true },
    { name: "accountNumber", label: "Account number", autocomplete: "off", numeric: true },
  ],
};

/** Mandate schemes: SEPA and BACS collect an explicit direct-debit consent. */
const BANK_MANDATE_PAYMENT_TYPES = new Set<BankDebitPaymentType>(["SEPA", "BACS"]);

/**
 * Deliberately generic — the mandate's legal text is the host's to provide
 * (fieldOptions.mandateText); this line only makes the checkbox meaningful.
 */
const DEFAULT_MANDATE_TEXT =
  "I authorise this payment to be collected by direct debit from the account above.";

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

/** Bank-debit rails render adapter-owned plain inputs — no SDK, no iframes. */
interface PaysafeBankHandle {
  pspName: "paysafe";
  kind: "bank";
  paymentType: BankDebitPaymentType;
  inputs: ReadonlyMap<BankFieldName, HTMLInputElement>;
  /** Present on mandate rails (SEPA/BACS) only. */
  consent?: HTMLInputElement;
  cleanup: () => void;
}

type PaysafeHandle = PaysafeCardHandle | PaysafeRedirectHandle | PaysafeBankHandle;

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
    // Bank-debit rails skip Paysafe.js too — it cannot tokenize them, so the
    // adapter's own inputs collect the details.
    if (isBankDebitPaymentType(session.paymentType)) {
      return this.mountBankFields(container, options, session.paymentType);
    }
    // The server never mints a typed session outside the rails above (card
    // sessions carry no paymentType at all), so a type this adapter does not
    // recognize is version skew. Falling through would tokenize a CARD
    // payment against a session created for another rail, so fail cleanly
    // instead — the type names a rail, never account data.
    if (session.paymentType !== undefined) {
      throw PayFanoutError.invalidRequest(
        `This Paysafe session collects "${session.paymentType}" details, which this version of the adapter cannot mount`,
      );
    }
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
   * Bank-debit rails (SEPA/ACH/BACS/EFT) collect the customer's bank details
   * with adapter-owned plain inputs — Paysafe.js cannot tokenize these rails,
   * which is exactly why they exist as Payments-API envelopes. Bank account
   * data is not card data (SAQ-A is unaffected), but it gets the same
   * discipline: values live only in the DOM until confirm() reads them.
   *
   * Layout follows the card path's slot convention: host elements carrying
   * data-payfanout-field="accountHolderName|iban|…|mandateConsent" become the
   * mount points; missing slots fall back to adapter-created stacked wrappers.
   * fieldOptions.fields.<name>.label/.placeholder override the texts (the
   * whole honest surface of a plain input), fieldOptions.mandateText replaces
   * the consent line, and the `appearance` translation the card path uses is
   * applied inline to the inputs.
   */
  private mountBankFields(
    container: HTMLElement,
    options: MountOptions,
    paymentType: BankDebitPaymentType,
  ): MountedFieldsHandle {
    const suffix = `payfanout-psf-${++mountCounter}`;
    const created: HTMLElement[] = [];
    // Same ownership rule as the card path: our wrapper inside the host's
    // slot (or stacked in the container), so cleanup never touches host
    // elements and concurrent mounts stay isolated.
    const mountPoint = (name: string): HTMLElement => {
      const slot = container.querySelector?.(`[data-payfanout-field="${name}"]`) as HTMLElement | null;
      const div = document.createElement("div");
      div.id = `${suffix}-${name}`;
      (slot ?? container).appendChild(div);
      created.push(div);
      return div;
    };

    const hostFields = (options.fieldOptions?.["fields"] ?? {}) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    const hostText = (name: string, key: "label" | "placeholder"): string | undefined => {
      const value = hostFields[name]?.[key];
      return typeof value === "string" ? value : undefined;
    };
    // The card path's appearance translation, applied to our own inputs: the
    // `input` selector's properties go inline (pseudo-class selectors have no
    // inline equivalent and are ignored).
    const inputCss = toPaysafeStyle(options.appearance)?.style["input"] as
      | Record<string, unknown>
      | undefined;

    const inputs = new Map<BankFieldName, HTMLInputElement>();
    for (const spec of BANK_FIELDS[paymentType]) {
      const wrapper = mountPoint(spec.name);
      const input = document.createElement("input");
      input.type = "text"; // never "number" — account coordinates keep leading zeros
      input.id = `${wrapper.id}-input`;
      input.name = spec.name;
      input.autocomplete = spec.autocomplete;
      input.spellcheck = false;
      if (spec.numeric) input.inputMode = "numeric";
      const placeholder = hostText(spec.name, "placeholder");
      if (placeholder !== undefined) input.placeholder = placeholder;
      for (const [prop, value] of Object.entries(inputCss ?? {})) {
        if (typeof value === "string") input.style.setProperty(prop, value);
      }
      const label = document.createElement("label");
      label.htmlFor = input.id;
      label.textContent = hostText(spec.name, "label") ?? spec.label;
      wrapper.appendChild(label);
      wrapper.appendChild(input);
      inputs.set(spec.name, input);
    }

    let consent: HTMLInputElement | undefined;
    if (BANK_MANDATE_PAYMENT_TYPES.has(paymentType)) {
      const wrapper = mountPoint("mandateConsent");
      consent = document.createElement("input");
      consent.type = "checkbox";
      consent.id = `${wrapper.id}-input`;
      consent.name = "mandateConsent";
      const label = document.createElement("label");
      label.htmlFor = consent.id;
      const mandateText = options.fieldOptions?.["mandateText"];
      label.textContent = typeof mandateText === "string" ? mandateText : DEFAULT_MANDATE_TEXT;
      wrapper.appendChild(consent);
      wrapper.appendChild(label);
    }

    options.onReady?.();
    options.onChange?.({ complete: false, empty: true });
    if (options.onChange) {
      const notify = (): void =>
        options.onChange?.({ complete: isBankFormComplete(paymentType, inputs, consent) });
      for (const input of inputs.values()) input.addEventListener("input", notify);
      consent?.addEventListener("change", notify);
    }

    const handle: PaysafeBankHandle = {
      pspName: "paysafe",
      kind: "bank",
      paymentType,
      inputs,
      ...(consent ? { consent } : {}),
      // Removing our wrappers drops the inputs — and the typed account
      // details with them — along with their listeners.
      cleanup: () => created.forEach((el) => el.remove()),
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
   *
   * Bank-debit rails tokenize nothing: confirm() reads the typed details and
   * packs them into the envelope the server's completePayment mints the
   * handle from.
   */
  async confirm(handle: MountedFieldsHandle): Promise<ConfirmResult> {
    const h = asPaysafeHandle(handle);
    if (h.kind === "redirect") {
      assertBrowser("PaysafeClientAdapter", "confirm");
      window.location.assign(h.redirectUrl);
      // The navigation unloads the page, so this promise intentionally never settles.
      return new Promise<ConfirmResult>(() => {});
    }
    if (h.kind === "bank") return confirmBankDetails(h);
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

/** Required inputs filled (whitespace is not a value) and the mandate ticked, where one exists. */
function isBankFormComplete(
  paymentType: BankDebitPaymentType,
  inputs: ReadonlyMap<BankFieldName, HTMLInputElement>,
  consent: HTMLInputElement | undefined,
): boolean {
  for (const spec of BANK_FIELDS[paymentType]) {
    if (!spec.optional && (inputs.get(spec.name)?.value ?? "").trim() === "") return false;
  }
  return consent === undefined || consent.checked;
}

/**
 * Reads the typed details, validates presence per rail (naming fields, never
 * values — account numbers do not belong in error messages or `raw`), and
 * packs the envelope the server parses. Failures resolve as
 * { status: "failed" }, exactly like the card path's tokenize failures.
 */
function confirmBankDetails(h: PaysafeBankHandle): ConfirmResult {
  const values: Partial<Record<BankFieldName, string>> = {};
  const missing: string[] = [];
  for (const spec of BANK_FIELDS[h.paymentType]) {
    const value = (h.inputs.get(spec.name)?.value ?? "").trim();
    if (value !== "") values[spec.name] = value;
    else if (!spec.optional) missing.push(spec.name);
  }
  if (h.consent && !h.consent.checked) missing.push("mandateConsent");
  if (missing.length > 0) {
    return {
      status: "failed",
      error: new PayFanoutError({
        code: "invalid_request",
        message: `The ${h.paymentType} details are incomplete — missing: ${missing.join(", ")}`,
        retryable: false,
        raw: { paymentType: h.paymentType, missing },
        pspName: "paysafe",
      }),
    };
  }
  const envelope: PaysafeBankEnvelopeV1 = {
    v: 1,
    paymentType: h.paymentType,
    ...values,
    // Required on every rail, so the missing gate above guarantees it here.
    accountHolderName: values.accountHolderName!,
    // The consent gate above makes this unconditionally true when present.
    ...(h.consent ? { mandateConsent: true } : {}),
  };
  return {
    status: "requires_confirmation",
    clientToken: `${BANK_ENVELOPE_PREFIX}${utf8ToBase64Url(JSON.stringify(envelope))}`,
  };
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
    ((h.kind === "card" && !!h.instance) ||
      (h.kind === "redirect" && typeof h.redirectUrl === "string") ||
      (h.kind === "bank" && !!h.inputs));
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
