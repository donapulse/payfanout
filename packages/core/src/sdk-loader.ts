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
 * Attributes {@link injectScript} puts on the `<script>` it creates. Without
 * options the tag carries neither attribute.
 */
export interface InjectScriptOptions {
  /**
   * Subresource Integrity metadata, set verbatim as the tag's `integrity`
   * attribute, e.g. `"sha384-<base64 digest>"`. The browser refuses to run a
   * file that does not match, and that refusal rejects like any other load
   * failure. A value holding no hash the browser recognizes (sha256, sha384,
   * sha512) checks nothing, so validate hashes where they are configured.
   */
  integrity?: string;
  /**
   * The tag's `crossorigin` attribute. Defaults to `"anonymous"` when
   * `integrity` is set: the browser checks a cross-origin file only when it
   * is fetched in CORS mode, which its server must allow, and blocks one it
   * cannot check. Without `integrity` it is set only when given.
   */
  crossOrigin?: "anonymous" | "use-credentials";
}

/**
 * Injects a PSP SDK `<script>` once per page (idempotent via DOM lookup) and
 * resolves on load. A load failure, including a file that fails its
 * `options.integrity` check, rejects with a retryable psp_unavailable
 * attributed to `pspName`. Adapters keep their own poll-for-global logic —
 * this only gets the script tag onto the page.
 *
 * A `<script>` already on the page for `url` is reused: the call resolves at
 * once and injects nothing. With `options.integrity`, reuse requires every
 * such tag to carry exactly the same `integrity` string; otherwise the call
 * rejects with a non-retryable invalid_request attributed to `pspName`, rather
 * than trust a copy that was never checked against that hash, and never
 * injects a second copy. `crossOrigin` plays no part in reuse.
 */
export function injectScript(url: string, pspName: string, options: InjectScriptOptions = {}): Promise<void> {
  const { integrity } = options;
  const crossOrigin = options.crossOrigin ?? (integrity === undefined ? undefined : "anonymous");
  return new Promise((resolve, reject) => {
    const selector = `script[src="${url}"]`;
    if (integrity !== undefined) {
      const tags = Array.from(document.querySelectorAll(selector));
      if (tags.some((tag) => tag.getAttribute("integrity") !== integrity)) {
        reject(
          new PayFanoutError({
            code: "invalid_request",
            message: `A <script> for ${url} is already on the page without the requested integrity`,
            retryable: false,
            raw: undefined,
            pspName,
          }),
        );
        return;
      }
    }
    const existing = document.querySelector(selector);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    // The browser reads both when the tag is inserted; setting them later has no effect.
    if (integrity !== undefined) script.setAttribute("integrity", integrity);
    if (crossOrigin !== undefined) script.setAttribute("crossorigin", crossOrigin);
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
