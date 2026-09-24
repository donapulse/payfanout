import { PayFanoutError } from "./errors.js";

// Lowercase only: the SRI draft lowercases algorithm names, but Chromium and
// Firefox match them case-sensitively and skip a token they do not recognise,
// which leaves the file unchecked. The digest is base64 or base64url, options
// are printable ASCII, and tokens split only on the whitespace every engine
// splits on (Firefox does not split on a form feed).
const SRI_TOKEN = /^sha(?:256|384|512)-[A-Za-z0-9+/_-]+={0,2}(?:\?[!-~]*)?$/;

function holdsUsableHash(integrity: string): boolean {
  return integrity.split(/[\t\n\r ]+/).some((token) => SRI_TOKEN.test(token));
}

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
   * failure. A value holding no well-formed sha256, sha384 or sha512 token —
   * lowercase algorithm name, base64 digest — rejects with a non-retryable
   * invalid_request, and nothing is injected: empty values, mistyped or
   * uppercase algorithm names and malformed digests are all skipped by Chromium
   * and Firefox, which would then run the file unchecked.
   *
   * With it, the call also detects a conflicting `<script>` already on the
   * page for the same URL (see {@link injectScript}). That is not a trust
   * boundary: every shipped client adapter returns from `loadSdk()` before
   * calling `injectScript` once the SDK global exists, so a copy the host page
   * already loaded is used without any check.
   */
  integrity?: string;
  /**
   * The tag's `crossorigin` attribute. Defaults to `"anonymous"` when
   * `integrity` is set: the browser checks a cross-origin file only when it
   * is fetched in CORS mode, which its server must allow, and blocks one it
   * cannot check. `"use-credentials"` fails against a CDN answering
   * `Access-Control-Allow-Origin: *`. Without `integrity` it is set only when
   * given. With `integrity`, a tag already on the page must have the
   * attribute to be reused; its value is not compared.
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
 * once and injects nothing, although that tag may still be loading or may
 * have failed (a failed tag stays on the page), so callers keep confirming
 * the SDK global. With `options.integrity` the call also detects a
 * conflicting tag: every `<script>` for `url` must carry exactly the same
 * `integrity` string and a `crossorigin` attribute, whatever its value, since
 * without one a cross-origin file is fetched without CORS and cannot pass the
 * check. A conflicting tag makes the call reject with a non-retryable
 * invalid_request attributed to `pspName`, as does an `integrity` holding no
 * sha256, sha384 or sha512 hash; either way nothing is injected.
 *
 * This is not a trust boundary: every shipped client adapter's `loadSdk()`
 * returns before calling `injectScript` once the SDK global exists, so a copy
 * the host page already loaded is used without any check.
 */
export function injectScript(url: string, pspName: string, options: InjectScriptOptions = {}): Promise<void> {
  const { integrity } = options;
  const crossOrigin = options.crossOrigin ?? (integrity === undefined ? undefined : "anonymous");
  return new Promise((resolve, reject) => {
    const refuse = (message: string) =>
      reject(
        new PayFanoutError({
          code: "invalid_request",
          message,
          retryable: false,
          raw: undefined,
          pspName,
        }),
      );
    const selector = `script[src="${url}"]`;
    let onPage: boolean;
    if (integrity === undefined) {
      onPage = Boolean(document.querySelector(selector));
    } else if (!holdsUsableHash(integrity)) {
      refuse(`The integrity for ${url} holds no sha256, sha384 or sha512 hash`);
      return;
    } else {
      const tags = Array.from(document.querySelectorAll(selector));
      if (tags.some((tag) => tag.getAttribute("integrity") !== integrity || tag.getAttribute("crossorigin") === null)) {
        refuse(
          `A conflicting <script> for ${url} is already on the page: it lacks the requested integrity or a crossorigin attribute`,
        );
        return;
      }
      onPage = tags.length > 0;
    }
    if (onPage) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    // Set before src and insertion: a browser may start fetching once src is set,
    // and discards that fetch if crossorigin changes afterwards.
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
