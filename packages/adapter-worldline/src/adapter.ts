import {
  assertBrowser,
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
 * Structural subset of Worldline's Hosted Tokenization `Tokenizer`. Injected in
 * tests, loaded from the Worldline payment host in browsers. It renders a single
 * hosted iframe (card data never touches the host DOM) and, on submit, resolves
 * a hostedTokenizationId the server uses to create the payment.
 */
export interface WorldlineTokenizerResult {
  success: boolean;
  hostedTokenizationId?: string;
  error?: unknown;
}

export interface WorldlineTokenizerInstanceLike {
  /** Renders the hosted tokenization iframe into the mount container. */
  initialize(): Promise<unknown>;
  /**
   * Tokenizes the entered card and resolves the hostedTokenizationId. The
   * Tokenizer stores the token for later payments unless `storePermanently` is
   * `false`; a `cardholderName` is handed to the iframe as the cardholder's
   * name.
   */
  submitTokenization(options?: { storePermanently?: boolean; cardholderName?: string }): Promise<WorldlineTokenizerResult>;
  /** Tears the iframe down, where the SDK build exposes it. */
  destroy?(): void;
}

export type WorldlineTokenizerConstructor = new (
  hostedTokenizationUrl: string,
  containerId: string,
  config?: Record<string, unknown>,
) => WorldlineTokenizerInstanceLike;

export interface WorldlineClientAdapterConfig {
  /** Explicit; selects the Worldline host the Tokenizer script loads from. */
  environment: "sandbox" | "live";
  /** Account capabilities vary per contract — override the conservative default. */
  paymentMethods?: PaymentMethodCapability[];
  /** Test seams. */
  loadScript?: (url: string) => Promise<void>;
  getWorldlineGlobal?: () => WorldlineTokenizerConstructor | undefined;
  /**
   * Another Worldline-served Tokenizer script URL. Worldline requires the
   * script to load from its own servers, so this never points at a self-hosted
   * copy.
   */
  sdkUrl?: string;
}

const DEFAULT_METHODS: PaymentMethodCapability[] = [{ type: "card", flow: "embedded", supported: true }];

interface WorldlineHandle {
  pspName: "worldline";
  tokenizer: WorldlineTokenizerInstanceLike;
  cleanup: () => void;
}

let mountCounter = 0;

export class WorldlineClientAdapter implements ClientPaymentAdapter {
  readonly pspName = "worldline";
  private readonly config: WorldlineClientAdapterConfig;
  private sdkPromise?: Promise<void>;

  constructor(config: WorldlineClientAdapterConfig) {
    if (config.environment !== "sandbox" && config.environment !== "live") {
      throw PayFanoutError.invalidRequest('WorldlineClientAdapter config.environment must be "sandbox" or "live"');
    }
    this.config = config;
  }

  async loadSdk(): Promise<void> {
    assertBrowser("WorldlineClientAdapter", "loadSdk");
    if (this.worldlineGlobal()) return;
    const url = this.config.sdkUrl ?? this.defaultSdkUrl();
    this.sdkPromise ??= (this.config.loadScript ? this.config.loadScript(url) : injectScript(url, this.pspName)).catch(
      (err) => {
        // A flaky script load must not poison every later mount — clear the
        // cached promise so the next loadSdk() retries the injection.
        this.sdkPromise = undefined;
        throw err;
      },
    );
    await this.sdkPromise;
    if (!this.worldlineGlobal()) {
      throw new PayFanoutError({
        code: "psp_unavailable",
        message: "Worldline Tokenizer loaded but the Tokenizer global is missing",
        retryable: true,
        raw: undefined,
        pspName: this.pspName,
      });
    }
  }

  /**
   * Renders Worldline's Hosted Tokenization iframe (SAQ-A eligible: card data
   * never touches the host DOM) into a generated child of `container`. The
   * iframe is addressed entirely by the session's clientSecret (the
   * hostedTokenizationUrl) — no client key is needed.
   *
   * `options.fieldOptions` passes through to the Tokenizer untouched (the host
   * wins), with one adapter default and one adapter-owned key:
   *
   * - `hideCardholderName` defaults to `false`. Worldline requires the
   *   cardholder name yet hides its field unless told otherwise, and the
   *   adapter never makes the `useCardholderName` call that would supply the
   *   name from the host page, so the field stays visible unless the host
   *   overrides it.
   * - `validationCallback` is owned by the adapter: `onChange` is driven from
   *   the Tokenizer's validity reports. A callback the host passes there still
   *   runs, after `onChange`, with the same result.
   */
  async mount(container: HTMLElement, options: MountOptions): Promise<MountedFieldsHandle> {
    assertBrowser("WorldlineClientAdapter", "mount");
    await this.loadSdk();
    const Tokenizer = this.worldlineGlobal()!;
    const child = document.createElement("div");
    child.id = `payfanout-wl-${++mountCounter}`;
    container.appendChild(child);
    // Initialize the host's "disable Pay until complete" state: the Tokenizer
    // reports validity only when it changes, and a build that never reports
    // leaves the state here rather than breaking the mount.
    options.onChange?.({ complete: false, empty: true });
    const fieldOptions = options.fieldOptions ?? {};
    const hostValidationCallback = fieldOptions["validationCallback"];
    try {
      const tokenizer = new Tokenizer(options.clientSecret, child.id, {
        ...fieldOptions,
        // An explicit undefined keeps the default, so the mandatory name field
        // never disappears by accident.
        hideCardholderName: fieldOptions["hideCardholderName"] ?? false,
        validationCallback: (result?: { valid?: boolean }) => {
          // A throwing onChange must not keep the host's own callback from running.
          try {
            options.onChange?.({ complete: result?.valid === true });
          } finally {
            if (typeof hostValidationCallback === "function") hostValidationCallback(result);
          }
        },
      });
      await tokenizer.initialize();
      options.onReady?.();
      const handle: WorldlineHandle = {
        pspName: "worldline",
        tokenizer,
        cleanup: () => {
          try {
            tokenizer.destroy?.();
          } catch {
            // Destroy is best-effort — SDK variants must not break unmount.
          }
          child.remove();
        },
      };
      return brandMountedFieldsHandle(handle);
    } catch (err) {
      child.remove();
      const mapped = mapWorldlineTokenizerError(err);
      options.onError?.(mapped);
      throw mapped;
    }
  }

  /**
   * Tokenize-first shape: resolves requires_confirmation plus a clientToken the
   * host passes to the server's completePayment (<PayButton> /
   * completionEndpoint wire it automatically). The clientToken is a JSON
   * envelope, `{"hostedTokenizationId":"…","device":{…}}`: the
   * hostedTokenizationId, plus the browser characteristics Worldline lists
   * among the mandatory 3-D Secure properties (`order.customer.device`), which
   * only the browser can read. A characteristic the browser does not expose is
   * left out; `device` is absent outside a browser. The server adapter release
   * that decodes the envelope must be deployed before this one.
   *
   * The card is tokenized with `storePermanently: false`: the adapter never
   * vaults (no saved-payment-method surface), so Worldline keeps no token for
   * later payments.
   */
  async confirm(handle: MountedFieldsHandle): Promise<ConfirmResult> {
    const h = asWorldlineHandle(handle);
    try {
      const result = await h.tokenizer.submitTokenization({ storePermanently: false });
      if (result?.success && result.hostedTokenizationId) {
        return {
          status: "requires_confirmation",
          clientToken: encodeClientToken(result.hostedTokenizationId, collectDeviceData()),
        };
      }
      return {
        status: "failed",
        error: mapWorldlineTokenizerError(
          result?.error ?? new Error("Worldline tokenization returned no hostedTokenizationId"),
        ),
      };
    } catch (err) {
      return { status: "failed", error: mapWorldlineTokenizerError(err) };
    }
  }

  unmount(handle: MountedFieldsHandle): void {
    asWorldlineHandle(handle).cleanup();
  }

  listPaymentMethodCapabilities(): PaymentMethodCapability[] {
    return this.config.paymentMethods ?? DEFAULT_METHODS;
  }

  private defaultSdkUrl(): string {
    const host =
      this.config.environment === "live"
        ? "https://payment.direct.worldline-solutions.com"
        : "https://payment.preprod.direct.worldline-solutions.com";
    return `${host}/hostedtokenization/js/client/tokenizer.min.js`;
  }

  private worldlineGlobal(): WorldlineTokenizerConstructor | undefined {
    if (this.config.getWorldlineGlobal) return this.config.getWorldlineGlobal();
    if (typeof window === "undefined") return undefined;
    return (window as unknown as { Tokenizer?: WorldlineTokenizerConstructor }).Tokenizer;
  }
}

function asWorldlineHandle(handle: MountedFieldsHandle): WorldlineHandle {
  const h = handle as unknown as WorldlineHandle;
  if (h?.pspName !== "worldline" || !h.tokenizer) {
    throw PayFanoutError.invalidRequest("Handle was not produced by WorldlineClientAdapter.mount");
  }
  return h;
}

interface WorldlineTokenizerErrorLike {
  message?: string;
  error?: { message?: string };
}

function extractMessage(err: unknown): string {
  if (typeof err === "string") return err;
  const e = err as WorldlineTokenizerErrorLike | undefined;
  return e?.message ?? e?.error?.message ?? "";
}

/**
 * Maps a Hosted Tokenization failure to the unified taxonomy. Tokenization only
 * validates card DATA in the browser — the authorization/decline happens
 * server-side at completePayment — so a client-side failure is a card-data
 * problem by default, unless it looks like an SDK/network load issue.
 */
function mapWorldlineTokenizerError(err: unknown): UnifiedError {
  const message = extractMessage(err);
  const code: UnifiedErrorCode = /load|network|script|timeout|unavailable/i.test(message)
    ? "psp_unavailable"
    : "invalid_card_data";
  return new PayFanoutError({
    code,
    message: getUserMessage(code),
    retryable: code === "psp_unavailable",
    raw: err,
    pspName: "worldline",
  });
}

/**
 * `order.customer.device` for CreatePayment, under Worldline's own key names
 * and types (the contract types the offset and screen size as strings) so the
 * server adapter forwards it without renaming. Browser characteristics only,
 * never card data.
 */
interface WorldlineDeviceData {
  locale?: string;
  timezoneOffsetUtcMinutes?: string;
  userAgent?: string;
  browserData: {
    colorDepth?: number;
    javaEnabled?: boolean;
    javaScriptEnabled: true;
    screenHeight?: string;
    screenWidth?: string;
  };
}

/** The window members the collector reads, typed loosely: any of them may be missing or odd. */
interface BrowserWindowLike {
  navigator?: { language?: unknown; userAgent?: unknown; javaEnabled?: () => unknown };
  screen?: { colorDepth?: unknown; height?: unknown; width?: unknown };
}

function encodeClientToken(hostedTokenizationId: string, device: WorldlineDeviceData | undefined): string {
  return JSON.stringify(device ? { hostedTokenizationId, device } : { hostedTokenizationId });
}

/**
 * Reads the device data at confirm() time. Every read is guarded: a missing
 * object, a throwing getter or a non-integer number leaves that field out,
 * because this data improves the authentication outcome but must never fail
 * the payment. Without a navigator there is no browser to describe.
 */
function collectDeviceData(): WorldlineDeviceData | undefined {
  const win = typeof window === "undefined" ? undefined : (window as unknown as BrowserWindowLike);
  const nav = safely(() => win?.navigator);
  if (!nav) return undefined;
  const display = safely(() => win?.screen);
  const locale = safely(() => nav.language);
  const userAgent = safely(() => nav.userAgent);
  const timezoneOffset = safely(() => new Date().getTimezoneOffset());
  const colorDepth = safely(() => display?.colorDepth);
  const screenHeight = safely(() => display?.height);
  const screenWidth = safely(() => display?.width);
  // Called on the navigator itself: detached, the method throws in browsers.
  const javaEnabled = safely(() => nav.javaEnabled?.() === true);
  return {
    ...(isNonEmptyString(locale) ? { locale } : {}),
    ...(isInteger(timezoneOffset) ? { timezoneOffsetUtcMinutes: String(timezoneOffset) } : {}),
    ...(isNonEmptyString(userAgent) ? { userAgent } : {}),
    browserData: {
      ...(isInteger(colorDepth) ? { colorDepth } : {}),
      ...(javaEnabled !== undefined ? { javaEnabled } : {}),
      javaScriptEnabled: true,
      ...(isInteger(screenHeight) ? { screenHeight: String(screenHeight) } : {}),
      ...(isInteger(screenWidth) ? { screenWidth: String(screenWidth) } : {}),
    },
  };
}

function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    // Privacy hardening and embedded browsers can make any of these reads throw.
    return undefined;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}
