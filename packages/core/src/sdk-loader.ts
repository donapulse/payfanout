import { PayFanoutError } from "./errors.js";

/**
 * Guards a client adapter method against SSR: PSP browser SDKs need a real
 * `window`/`document`. `adapterName` names the throwing class in the message
 * (e.g. "StripeClientAdapter"), `operation` the method.
 */
export function assertBrowser(adapterName: string, operation: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw PayFanoutError.invalidRequest(
      `${adapterName}.${operation} is browser-only — never call it during SSR`,
    );
  }
}

/**
 * Injects a PSP SDK `<script>` once per page (idempotent via DOM lookup) and
 * resolves on load. A load failure rejects with a retryable psp_unavailable
 * attributed to `pspName`. Adapters keep their own poll-for-global logic —
 * this only gets the script tag onto the page.
 */
export function injectScript(url: string, pspName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${url}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(
        new PayFanoutError({
          code: "psp_unavailable",
          message: `Failed to load ${url}`,
          retryable: true,
          raw: undefined,
          pspName,
        }),
      );
    document.head.appendChild(script);
  });
}
