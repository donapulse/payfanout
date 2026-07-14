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
  /** Tokenizes the entered card and resolves the hostedTokenizationId. */
  submitTokenization(): Promise<WorldlineTokenizerResult>;
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
    this.sdkPromise ??= this.config.loadScript ? this.config.loadScript(url) : injectScript(url, this.pspName);
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
   * hostedTokenizationUrl) — no client key is needed. Host UI options pass
   * through untouched via MountOptions.fieldOptions.
   */
  async mount(container: HTMLElement, options: MountOptions): Promise<MountedFieldsHandle> {
    assertBrowser("WorldlineClientAdapter", "mount");
    await this.loadSdk();
    const Tokenizer = this.worldlineGlobal()!;
    const child = document.createElement("div");
    child.id = `payfanout-wl-${++mountCounter}`;
    container.appendChild(child);
    // Worldline's Tokenizer exposes no granular field-validity stream, so
    // initialize the host's "disable Pay until complete" state once and degrade
    // gracefully — the real decline outcome surfaces server-side at completion.
    options.onChange?.({ complete: false, empty: true });
    try {
      const tokenizer = new Tokenizer(options.clientSecret, child.id, { ...(options.fieldOptions ?? {}) });
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
   * Tokenize-first shape: resolves requires_confirmation plus the
   * hostedTokenizationId. The host passes that clientToken to the server's
   * completePayment (<PayButton> / completionEndpoint wire it automatically).
   */
  async confirm(handle: MountedFieldsHandle): Promise<ConfirmResult> {
    const h = asWorldlineHandle(handle);
    try {
      const result = await h.tokenizer.submitTokenization();
      if (result?.success && result.hostedTokenizationId) {
        return { status: "requires_confirmation", clientToken: result.hostedTokenizationId };
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
