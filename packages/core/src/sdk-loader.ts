import { PayFanoutError } from "./errors.js";

// Lowercase only: the SRI draft lowercases algorithm names, but Chromium and
// Firefox match them case-sensitively and skip a token they do not recognise,
// which leaves the file unchecked. The digest is base64 or base64url, options
// are printable ASCII, and tokens split only on the whitespace every engine
// splits on (Firefox does not split on a form feed).
const SRI_TOKEN = /^sha(?:256|384|512)-[A-Za-z0-9+/_-]+={0,2}(?:\?[!-~]*)?$/;

// CSP3's base64-value, the only form a policy's 'nonce-…' source can name.
const CSP_NONCE = /^[A-Za-z0-9+/_-]+={0,2}$/;

// Names injectScript sets itself or that change how the tag loads or runs.
// nomodule, language, and event with for can make the browser skip the script
// without a load or error event, which would leave the call pending.
// Compared in ASCII lowercase, as setAttribute lowercases names on HTML elements.
const MANAGED_SCRIPT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "src", "async", "defer", "integrity", "crossorigin", "nonce", "type",
  "nomodule", "language", "event", "for",
]);

function holdsUsableHash(integrity: string): boolean {
  return integrity.split(/[\t\n\r ]+/).some((token) => SRI_TOKEN.test(token));
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function refusal(message: string, pspName: string, raw?: unknown): PayFanoutError {
  return new PayFanoutError({ code: "invalid_request", message, retryable: false, raw, pspName });
}

function nonceRefusal(url: string, pspName: string): PayFanoutError {
  return refusal(
    `The nonce for ${url} is not a CSP nonce: base64 or base64url characters, with at most two trailing "="`,
    pspName,
  );
}

/**
 * The calls waiting on each tag injectScript or injectStylesheet added, from
 * insertion until the tag loads or fails. A tag without an entry has settled,
 * or the page added it.
 */
const loadingTags = new WeakMap<Element, Array<(loaded: boolean) => void>>();

/**
 * Tracks `tag`, about to be inserted, until its load or error event, then
 * settles every call waiting on it, `first` included. With `dropOnError`, a
 * failed tag is off the page before any of those calls carries on, so a call
 * made from their handlers fetches the file again.
 */
function watchLoad(
  tag: HTMLScriptElement | HTMLLinkElement,
  first: (loaded: boolean) => void,
  dropOnError: boolean,
): void {
  const settleCalls = [first];
  loadingTags.set(tag, settleCalls);
  const settleAll = (loaded: boolean) => {
    loadingTags.delete(tag);
    for (const settleCall of settleCalls) settleCall(loaded);
  };
  tag.onload = () => settleAll(true);
  tag.onerror = () => {
    settleAll(false);
    // Element doubles without remove(), like the bare objects adapter test
    // fakes may return, must not make this handler throw.
    if (dropOnError && typeof tag.remove === "function") tag.remove();
  };
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
 * Whether `value` can be a Content-Security-Policy nonce: a non-empty string
 * of CSP3's base64-value, `1*( ALPHA / DIGIT / "+" / "/" / "-" / "_" )
 * *2( "=" )`, which is what a policy's `'nonce-<value>'` source holds between
 * `'nonce-` and the closing quote. No other value can match a nonce source.
 * The check is on form only: a value that kept its `nonce-` prefix still fits
 * the grammar, yet matches no policy naming the value itself.
 */
export function isValidCspNonce(value: unknown): boolean {
  return typeof value === "string" && CSP_NONCE.test(value);
}

/**
 * Attributes {@link injectScript} puts on the `<script>` it creates, all set
 * before `src` and before insertion. Without options the tag carries only
 * `src` and `async`.
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
  /**
   * A Content-Security-Policy nonce, set as the tag's `nonce` attribute. The
   * browser reads it once, when it prepares the inserted script, and ignores a
   * nonce set later; a policy whose `script-src` lists `'nonce-<value>'` then
   * allows the tag. That matters under a policy allowing scripts by nonce
   * without `'strict-dynamic'`: `'strict-dynamic'` allows a script-created tag
   * without one, and a host source in `script-src` allows it anyway. A value
   * {@link isValidCspNonce} refuses rejects with a non-retryable
   * invalid_request, and nothing is injected.
   */
  nonce?: string;
  /**
   * Further attributes for the tag, set with `setAttribute`, such as the
   * configuration an SDK reads from its own `<script>`. A name the helper
   * manages (`src`, `async`, `defer`, `integrity`, `crossorigin`, `nonce`,
   * `type`, and `nomodule`, `language`, `event` and `for`, which can make the
   * browser skip the script without a load or error event, leaving the call
   * pending) or one that runs script (any name starting with `on`), compared
   * case-insensitively, rejects with a non-retryable invalid_request, as does a
   * name `setAttribute` refuses; either way nothing is injected.
   */
  attributes?: Readonly<Record<string, string>>;
  /**
   * The tag's `async` flag, `true` unless given `false`. A script-created tag
   * is async by default and runs as soon as it arrives; with `false` it runs
   * in insertion order among the scripts injected that way.
   */
  async?: boolean;
}

/**
 * Injects a PSP SDK `<script>` once per page (idempotent via DOM lookup) and
 * resolves on load. A load failure, including a file that fails its
 * `options.integrity` check, rejects with a retryable psp_unavailable
 * attributed to `pspName` and removes the tag this call injected, so a later
 * call fetches the file again. Adapters keep their own poll-for-global logic —
 * this only gets the script tag onto the page; an adapter that caches the
 * load promise must clear it when it rejects for that later call to happen.
 *
 * A `<script>` already on the page for `url` is reused and nothing is
 * injected. If an earlier call injected that tag and it is still loading, the
 * call waits for it: it resolves when the tag loads and, when the tag fails,
 * rejects with its own retryable psp_unavailable attributed to `pspName`. There
 * is no timeout: a tag that fires neither event keeps every call waiting on it
 * pending. Any other tag resolves the call at once: one that has loaded, or one
 * the page added itself, which the call never listens to or removes, whether it
 * is still loading or its load failed, so callers keep confirming the SDK
 * global. With `options.integrity` the call also detects a conflicting tag:
 * every `<script>` for `url` must carry exactly the same `integrity` string and
 * a `crossorigin` attribute, whatever its value, since without one a
 * cross-origin file is fetched without CORS and cannot pass the check. A
 * conflicting tag makes the call reject with a non-retryable invalid_request
 * attributed to `pspName`, as does an `integrity` holding no sha256, sha384 or
 * sha512 hash; either way nothing is injected, and the call rejects at once,
 * even while a tag for `url` is still loading.
 *
 * `options.nonce` and `options.attributes` are never compared with a tag
 * already on the page. The browser read that tag's nonce when it prepared it,
 * so nothing a later call sets changes whether it runs, and under a
 * header-delivered policy it hides the nonce of a connected tag, whose
 * `getAttribute("nonce")` then returns an empty string. A tag the page added
 * itself keeps the attributes the page gave it, so an SDK reading its
 * configuration from its own tag reads the page's. An invalid nonce or
 * attribute name rejects with a non-retryable invalid_request attributed to
 * `pspName` whatever the page holds, and nothing is injected.
 *
 * This is not a trust boundary: every shipped client adapter's `loadSdk()`
 * returns before calling `injectScript` once the SDK global exists, so a copy
 * the host page already loaded is used without any check.
 */
export function injectScript(url: string, pspName: string, options: InjectScriptOptions = {}): Promise<void> {
  const { integrity, nonce, attributes = {} } = options;
  const crossOrigin = options.crossOrigin ?? (integrity === undefined ? undefined : "anonymous");
  return new Promise((resolve, reject) => {
    const refuse = (message: string, raw?: unknown) => reject(refusal(message, pspName, raw));
    const settle = (loaded: boolean) => {
      if (loaded) {
        resolve();
        return;
      }
      reject(
        new PayFanoutError({
          code: "psp_unavailable",
          message: `Failed to load ${url}`,
          retryable: true,
          raw: undefined,
          pspName,
        }),
      );
    };
    if (nonce !== undefined && !isValidCspNonce(nonce)) {
      reject(nonceRefusal(url, pspName));
      return;
    }
    const names = Object.keys(attributes).map((name) => ({ name, lowercase: asciiLowercase(name) }));
    const managed = names.find(({ lowercase }) => MANAGED_SCRIPT_ATTRIBUTES.has(lowercase));
    if (managed) {
      refuse(
        `The ${JSON.stringify(managed.name)} attribute for ${url} is managed by injectScript, so attributes may not set it`,
      );
      return;
    }
    const handler = names.find(({ lowercase }) => lowercase.startsWith("on"));
    if (handler) {
      refuse(`The ${JSON.stringify(handler.name)} attribute for ${url} runs script, so attributes may not set it`);
      return;
    }
    if (integrity !== undefined && !holdsUsableHash(integrity)) {
      refuse(`The integrity for ${url} holds no sha256, sha384 or sha512 hash`);
      return;
    }
    // Built before the page lookup, so a name the DOM refuses rejects the call
    // whatever the page holds. Everything is set before src and insertion: a
    // browser may start fetching once src is set and discards that fetch if
    // crossorigin changes afterwards, and it reads the nonce once, when it
    // prepares the inserted script.
    const script = document.createElement("script");
    if (nonce !== undefined) script.setAttribute("nonce", nonce);
    for (const [name, value] of Object.entries(attributes)) {
      try {
        script.setAttribute(name, value);
      } catch (err) {
        refuse(`The DOM refuses ${JSON.stringify(name)} as an attribute name, so nothing was injected for ${url}`, err);
        return;
      }
    }
    if (integrity !== undefined) script.setAttribute("integrity", integrity);
    if (crossOrigin !== undefined) script.setAttribute("crossorigin", crossOrigin);
    script.async = options.async ?? true;
    const selector = `script[src="${url}"]`;
    let onPage: Element | null | undefined;
    if (integrity === undefined) {
      onPage = document.querySelector(selector);
    } else {
      const tags = Array.from(document.querySelectorAll(selector));
      if (tags.some((tag) => tag.getAttribute("integrity") !== integrity || tag.getAttribute("crossorigin") === null)) {
        refuse(
          `A conflicting <script> for ${url} is already on the page: it lacks the requested integrity or a crossorigin attribute`,
        );
        return;
      }
      onPage = tags[0];
    }
    if (onPage) {
      const waiting = loadingTags.get(onPage);
      if (waiting) waiting.push(settle);
      else resolve();
      return;
    }
    script.src = url;
    // A failed tag must not satisfy the next lookup, or the file would never be
    // fetched again.
    watchLoad(script, settle, true);
    document.head.appendChild(script);
  });
}

/**
 * Attributes {@link injectStylesheet} puts on the `<link rel="stylesheet">` it
 * creates, all set before `href` and before insertion. Without options the
 * link carries only `rel` and `href`.
 */
export interface InjectStylesheetOptions {
  /**
   * A Content-Security-Policy nonce, set as the link's `nonce` attribute. The
   * browser reads it when it starts fetching the sheet, as the link is
   * inserted, and does not fetch again for a nonce set later; a policy whose
   * `style-src` lists `'nonce-<value>'` then allows the sheet. A value
   * {@link isValidCspNonce} refuses rejects with a non-retryable
   * invalid_request, and nothing is injected.
   */
  nonce?: string;
  /**
   * Subresource Integrity metadata, set verbatim as the link's `integrity`
   * attribute. A sheet that does not match fails to load, and a value holding
   * no well-formed sha256, sha384 or sha512 token rejects with a non-retryable
   * invalid_request, as {@link InjectScriptOptions.integrity} does, and nothing
   * is injected.
   */
  integrity?: string;
  /**
   * The link's `crossorigin` attribute. Defaults to `"anonymous"` when
   * `integrity` is set, since the browser checks a cross-origin file only when
   * it is fetched in CORS mode; without `integrity` it is set only when given.
   */
  crossOrigin?: "anonymous" | "use-credentials";
}

/**
 * Injects a PSP stylesheet `<link rel="stylesheet">` once per page (idempotent
 * via DOM lookup on `href`) and resolves when the sheet loads. Styling is
 * cosmetic, so a load failure, including a sheet that fails its
 * `options.integrity` check, resolves as well. The link stays on the page
 * either way: a browser can also fire `error` on a link whose own rules
 * applied when one of the sheets it `@import`s fails, and the page cannot tell
 * that from a sheet that failed, so a later call for `url` finds the link and
 * resolves at once instead of fetching the sheet again. An empty `url` names no
 * sheet, and a link with an empty `href` fires neither event, so nothing is
 * injected and the call resolves at once. The call rejects for invalid options,
 * with a non-retryable invalid_request attributed to `pspName`, and nothing is
 * injected then; a `url` holding a double quote also rejects, with the DOM's
 * own error, since the page lookup cannot quote it.
 *
 * A `<link rel="stylesheet">` already on the page for `url` is reused as it
 * is, with nothing injected and none of its attributes compared: one the page
 * added itself keeps an integrity check only if it carries its own `integrity`
 * and `crossorigin`. A link of another type for `url`, such as
 * `rel="preload"`, is not a match. If an earlier call injected that link and
 * it is still loading, the call waits for it and resolves once it loads or
 * fails; any other link resolves the call at once. There is no timeout: a link
 * that fires neither event keeps every call waiting on it pending. A browser
 * fires `load` only once the sheets a stylesheet `@import`s have loaded or
 * failed, so a caller that must not wait on their hosts should not await the
 * call.
 */
export function injectStylesheet(url: string, pspName: string, options: InjectStylesheetOptions = {}): Promise<void> {
  const { integrity, nonce } = options;
  const crossOrigin = options.crossOrigin ?? (integrity === undefined ? undefined : "anonymous");
  return new Promise((resolve, reject) => {
    if (nonce !== undefined && !isValidCspNonce(nonce)) {
      reject(nonceRefusal(url, pspName));
      return;
    }
    if (integrity !== undefined && !holdsUsableHash(integrity)) {
      reject(refusal(`The integrity for ${url} holds no sha256, sha384 or sha512 hash`, pspName));
      return;
    }
    if (url === "") {
      resolve();
      return;
    }
    const onPage = document.querySelector(`link[rel~="stylesheet"][href="${url}"]`);
    if (onPage) {
      const waiting = loadingTags.get(onPage);
      if (waiting) waiting.push(() => resolve());
      else resolve();
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    // Set before href and insertion: the browser fetches the sheet once the link
    // is connected, reading the nonce then, and checks integrity only on a CORS
    // fetch.
    if (nonce !== undefined) link.setAttribute("nonce", nonce);
    if (integrity !== undefined) link.setAttribute("integrity", integrity);
    if (crossOrigin !== undefined) link.setAttribute("crossorigin", crossOrigin);
    link.href = url;
    watchLoad(link, () => resolve(), false);
    document.head.appendChild(link);
  });
}
