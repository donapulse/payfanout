import { afterEach, describe, expect, it, vi } from "vitest";
import { PayFanoutError } from "../src/errors.js";
import { injectScript, injectStylesheet, isValidCspNonce } from "../src/sdk-loader.js";

const SDK_URL = "https://sdk.acme.test/v1/acme.js";
const OTHER_URL = "https://sdk.acme.test/v1/acme-extra.js";
const CSS_URL = "https://sdk.acme.test/v1/acme.css";
const HASH = `sha384-${"a".repeat(64)}`;
const OTHER_HASH = `sha384-${"b".repeat(64)}`;
const NONCE = "cmFuZG9tLW5vbmNlLXZhbHVl";

afterEach(() => vi.unstubAllGlobals());

/**
 * The only DOM surface a call without options may touch, as in the adapters'
 * own test fakes: no setAttribute, getAttribute or querySelectorAll, so any
 * use of them throws.
 */
function stubBareDocument(scriptOnPage: boolean): Record<string, unknown>[] {
  const appended: Record<string, unknown>[] = [];
  vi.stubGlobal("document", {
    querySelector: () => (scriptOnPage ? {} : null),
    createElement: () => ({}),
    head: { appendChild: (el: Record<string, unknown>) => appended.push(el) },
  });
  return appended;
}

class FakeScript {
  async = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly attributes = new Map<string, string>();
  /** Attributes as they stood when `src` was first set, from which point a browser may start fetching. */
  srcSetWith: Record<string, string> | undefined;
  /** Attributes as they stood at insertion, which is when a browser reads them. */
  insertedWith: Record<string, string> | undefined;
  /** The async flag when `src` was first set and at insertion. */
  asyncWhenSrcSet: boolean | undefined;
  asyncWhenInserted: boolean | undefined;
  /** Takes the tag off the page, as Element.remove() does; set by the page stub. */
  remove: (() => void) | undefined;
  private srcValue = "";

  get src(): string {
    return this.srcValue;
  }

  set src(value: string) {
    this.srcValue = value;
    this.srcSetWith ??= Object.fromEntries(this.attributes);
    this.asyncWhenSrcSet ??= this.async;
  }

  /** Refuses what the DOM refuses as an attribute name: empty, or holding whitespace, "/", "=", ">" or NUL. */
  setAttribute(name: string, value: string): void {
    if (name === "" || /[\t\n\f\r /=>\0]/.test(name)) {
      throw new DOMException(`"${name}" is not a valid attribute name.`, "InvalidCharacterError");
    }
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

function scriptOnPage(src: string, attributes: Record<string, string> = {}): FakeScript {
  const script = new FakeScript();
  script.src = src;
  for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
  return script;
}

/** A page whose head already holds `onPage`; lookups answer the loader's `script[src="…"]` selector. */
function stubPage(...onPage: FakeScript[]): { injected: FakeScript[] } {
  const head = [...onPage];
  const injected: FakeScript[] = [];
  const matching = (selector: string) => {
    const src = /^script\[src="(.*)"\]$/.exec(selector)?.[1];
    return head.filter((script) => script.src === src);
  };
  vi.stubGlobal("document", {
    querySelector: (selector: string) => matching(selector)[0] ?? null,
    querySelectorAll: (selector: string) => matching(selector),
    createElement: (tagName: string) => {
      expect(tagName).toBe("script");
      const script = new FakeScript();
      script.remove = () => {
        const index = head.indexOf(script);
        if (index >= 0) head.splice(index, 1);
      };
      return script;
    },
    head: {
      appendChild: (script: FakeScript) => {
        script.insertedWith = Object.fromEntries(script.attributes);
        script.asyncWhenInserted = script.async;
        head.push(script);
        injected.push(script);
      },
    },
  });
  return { injected };
}

class FakeLink {
  rel = "";
  /** Set once the sheet's own rules apply, as a browser does whether or not its @imports load. */
  sheet: object | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly attributes = new Map<string, string>();
  /** Attributes and `rel` as they stood when `href` was first set. */
  hrefSetWith: Record<string, string> | undefined;
  relWhenHrefSet: string | undefined;
  /** Attributes as they stood at insertion, which is when a browser starts fetching the sheet. */
  insertedWith: Record<string, string> | undefined;
  /** Takes the link off the page, as Element.remove() does; set by the page stub. */
  remove: (() => void) | undefined;
  private hrefValue = "";

  get href(): string {
    return this.hrefValue;
  }

  set href(value: string) {
    this.hrefValue = value;
    this.hrefSetWith ??= Object.fromEntries(this.attributes);
    this.relWhenHrefSet ??= this.rel;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

function linkOnPage(href: string, attributes: Record<string, string> = {}, rel = "stylesheet"): FakeLink {
  const link = new FakeLink();
  link.rel = rel;
  link.href = href;
  for (const [name, value] of Object.entries(attributes)) link.setAttribute(name, value);
  return link;
}

/**
 * A page whose head already holds `onPage`. Lookups answer `link[href="…"]`,
 * which any link for the URL matches, and `link[rel~="stylesheet"][href="…"]`,
 * which only a stylesheet link does.
 */
function stubLinkPage(...onPage: FakeLink[]): { injected: FakeLink[]; head: FakeLink[] } {
  const head = [...onPage];
  const injected: FakeLink[] = [];
  vi.stubGlobal("document", {
    querySelector: (selector: string) => {
      const match = /^link(\[rel~="stylesheet"\])?\[href="(.*)"\]$/.exec(selector);
      if (!match) throw new Error(`unexpected selector ${selector}`);
      const [, stylesheetOnly, href] = match;
      return (
        head.find((link) => link.href === href && (!stylesheetOnly || link.rel.split(" ").includes("stylesheet"))) ??
        null
      );
    },
    createElement: (tagName: string) => {
      expect(tagName).toBe("link");
      const link = new FakeLink();
      link.remove = () => {
        const index = head.indexOf(link);
        if (index >= 0) head.splice(index, 1);
      };
      return link;
    },
    head: {
      appendChild: (link: FakeLink) => {
        link.insertedWith = Object.fromEntries(link.attributes);
        head.push(link);
        injected.push(link);
      },
    },
  });
  return { injected, head };
}

/** Whether `loading` has settled once every callback already queued has run. */
async function hasSettled(loading: Promise<void>): Promise<boolean> {
  let settled = false;
  void loading.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

async function rejection(loading: Promise<void>): Promise<PayFanoutError> {
  const error: unknown = await loading.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(PayFanoutError);
  return error as PayFanoutError;
}

/** The single load-failure shape, whether or not the tag carried integrity. */
async function expectLoadFailure(loading: Promise<void>, url: string): Promise<void> {
  const error = await rejection(loading);
  expect(error.toJSON()).toEqual({
    name: "PayFanoutError",
    code: "psp_unavailable",
    message: `Failed to load ${url}`,
    retryable: true,
    pspName: "acme",
  });
  expect(error.raw).toBeUndefined();
}

async function expectRefused(loading: Promise<void>, message: string): Promise<void> {
  const error = await rejection(loading);
  expect(error.toJSON()).toEqual({
    name: "PayFanoutError",
    code: "invalid_request",
    message,
    retryable: false,
    pspName: "acme",
  });
  expect(error.raw).toBeUndefined();
}

function expectReuseRefused(loading: Promise<void>): Promise<void> {
  return expectRefused(
    loading,
    `A conflicting <script> for ${SDK_URL} is already on the page: it lacks the requested integrity or a crossorigin attribute`,
  );
}

describe("injectScript without options", () => {
  it("injects one async script carrying nothing else and resolves when it loads", async () => {
    const appended = stubBareDocument(false);
    const loading = injectScript(SDK_URL, "acme");
    expect(appended).toHaveLength(1);
    expect(Object.keys(appended[0]!).sort()).toEqual(["async", "onerror", "onload", "src"]);
    expect(appended[0]).toMatchObject({ src: SDK_URL, async: true });
    (appended[0]!["onload"] as () => void)();
    await expect(loading).resolves.toBeUndefined();
  });

  it("rejects a failed load with a retryable psp_unavailable attributed to the psp", async () => {
    const appended = stubBareDocument(false);
    const loading = injectScript(SDK_URL, "acme");
    (appended[0]!["onerror"] as () => void)();
    await expectLoadFailure(loading, SDK_URL);
  });

  it("resolves at once without injecting when a script for the url is already on the page", async () => {
    const appended = stubBareDocument(true);
    await expect(injectScript(SDK_URL, "acme")).resolves.toBeUndefined();
    expect(appended).toHaveLength(0);
  });
});

describe("injectScript options", () => {
  it("sets integrity and a default crossorigin of anonymous before setting src and inserting the script", async () => {
    const { injected } = stubPage();
    const loading = injectScript(SDK_URL, "acme", { integrity: HASH });
    expect(injected).toHaveLength(1);
    expect(injected[0]!.srcSetWith).toEqual({ integrity: HASH, crossorigin: "anonymous" });
    expect(injected[0]!.insertedWith).toEqual({ integrity: HASH, crossorigin: "anonymous" });
    expect(injected[0]).toMatchObject({ src: SDK_URL, async: true });
    injected[0]!.onload!();
    await expect(loading).resolves.toBeUndefined();
  });

  it("honours an explicit crossOrigin alongside integrity", () => {
    const { injected } = stubPage();
    void injectScript(SDK_URL, "acme", { integrity: HASH, crossOrigin: "use-credentials" });
    expect(injected[0]!.srcSetWith).toEqual({ integrity: HASH, crossorigin: "use-credentials" });
  });

  it("sets crossorigin without integrity only when asked", () => {
    const { injected } = stubPage();
    void injectScript(SDK_URL, "acme", {});
    void injectScript(OTHER_URL, "acme", { crossOrigin: "anonymous" });
    expect(injected.map((script) => script.srcSetWith)).toEqual([{}, { crossorigin: "anonymous" }]);
  });

  it("rejects a file that fails its integrity check exactly like any other load failure", async () => {
    const { injected } = stubPage();
    const loading = injectScript(SDK_URL, "acme", { integrity: HASH });
    // A digest mismatch reaches the page only as the tag's error event.
    injected[0]!.onerror!();
    await expectLoadFailure(loading, SDK_URL);
  });

  it("refuses an integrity holding no sha256, sha384 or sha512 hash, and injects nothing", async () => {
    const { injected } = stubPage();
    // Chromium and Firefox skip every one of these, leaving the file unchecked.
    for (const integrity of [
      "",
      "   ",
      "sha348-abc",
      "md5-abc",
      "SHA384-abc",
      "Sha512-abc",
      "sha384-abc,",
      "sha384-?",
      "\u00A0sha384-abc",
      "md5-abc\u00A0sha384-abc",
      "\fsha384-abc",
      "sha384-abc?\u00E9",
    ]) {
      await expectRefused(
        injectScript(SDK_URL, "acme", { integrity }),
        `The integrity for ${SDK_URL} holds no sha256, sha384 or sha512 hash`,
      );
    }
    expect(injected).toHaveLength(0);
  });

  it("accepts an integrity holding a well-formed hash, alone or beside another token", () => {
    const { injected } = stubPage();
    const values = ["sha384-abc", "md5-abc sha512-abc", "md5-abc\tsha384-ab+/_-c==", "sha256-abc?opt"];
    for (const [index, integrity] of values.entries()) {
      void injectScript(`https://cdn.example/sdk-${index}.js`, "acme", { integrity });
    }
    expect(injected.map((script) => script.srcSetWith?.["integrity"])).toEqual(values);
  });
});

describe("injectScript reuse of a script already on the page", () => {
  it("lets a call without integrity reuse any script for the url, whatever it carries", async () => {
    const { injected } = stubPage(scriptOnPage(SDK_URL, { integrity: OTHER_HASH, crossorigin: "anonymous" }));
    await expect(injectScript(SDK_URL, "acme")).resolves.toBeUndefined();
    expect(injected).toHaveLength(0);
  });

  it("reuses a script carrying the same integrity, waiting for it while it is still loading", async () => {
    const { injected } = stubPage();
    const first = injectScript(SDK_URL, "acme", { integrity: HASH });
    const sameIntegrity = injectScript(SDK_URL, "acme", { integrity: HASH });
    const withoutOptions = injectScript(SDK_URL, "acme");
    expect(await hasSettled(sameIntegrity)).toBe(false);
    expect(await hasSettled(withoutOptions)).toBe(false);
    expect(injected).toHaveLength(1);
    injected[0]!.onload!();
    await expect(first).resolves.toBeUndefined();
    await expect(sameIntegrity).resolves.toBeUndefined();
    await expect(withoutOptions).resolves.toBeUndefined();
  });

  it("reuses several scripts for the url that all carry the same integrity", async () => {
    const { injected } = stubPage(
      scriptOnPage(SDK_URL, { integrity: HASH, crossorigin: "anonymous" }),
      scriptOnPage(SDK_URL, { integrity: HASH, crossorigin: "anonymous" }),
    );
    await expect(injectScript(SDK_URL, "acme", { integrity: HASH })).resolves.toBeUndefined();
    expect(injected).toHaveLength(0);
  });

  it("refuses a script for the url that carries no integrity, and injects nothing", async () => {
    const { injected } = stubPage(scriptOnPage(SDK_URL));
    await expectReuseRefused(injectScript(SDK_URL, "acme", { integrity: HASH }));
    expect(injected).toHaveLength(0);
  });

  it("refuses a script carrying the same integrity but no crossorigin, and injects nothing", async () => {
    // Fetched without CORS, a cross-origin file can never have passed its integrity check.
    const { injected } = stubPage(scriptOnPage(SDK_URL, { integrity: HASH }));
    await expectReuseRefused(injectScript(SDK_URL, "acme", { integrity: HASH }));
    expect(injected).toHaveLength(0);
  });

  it("refuses the script an earlier call without integrity injected, even while it is still loading", async () => {
    const { injected } = stubPage();
    void injectScript(SDK_URL, "acme");
    await expectReuseRefused(injectScript(SDK_URL, "acme", { integrity: HASH }));
    expect(injected).toHaveLength(1);
  });

  it("refuses a script carrying a different integrity", async () => {
    const { injected } = stubPage();
    void injectScript(SDK_URL, "acme", { integrity: HASH });
    await expectReuseRefused(injectScript(SDK_URL, "acme", { integrity: OTHER_HASH }));
    expect(injected).toHaveLength(1);
  });

  it("refuses when any one of several scripts for the url lacks the integrity", async () => {
    const { injected } = stubPage(
      scriptOnPage(SDK_URL, { integrity: HASH, crossorigin: "anonymous" }),
      scriptOnPage(SDK_URL),
    );
    await expectReuseRefused(injectScript(SDK_URL, "acme", { integrity: HASH }));
    expect(injected).toHaveLength(0);
  });

  it("does not compare the crossorigin value when reusing", async () => {
    const { injected } = stubPage(
      scriptOnPage(SDK_URL, { integrity: HASH, crossorigin: "use-credentials" }),
      scriptOnPage(SDK_URL, { integrity: HASH, crossorigin: "" }),
    );
    await expect(injectScript(SDK_URL, "acme", { integrity: HASH })).resolves.toBeUndefined();
    expect(injected).toHaveLength(0);
  });

  it("looks only at scripts for the same url", () => {
    const { injected } = stubPage(scriptOnPage(OTHER_URL));
    void injectScript(SDK_URL, "acme", { integrity: HASH });
    expect(injected.map((script) => script.src)).toEqual([SDK_URL]);
  });
});

describe("injectScript after a failed load", () => {
  it("removes the tag it injected, so the next call fetches the file again", async () => {
    const { injected } = stubPage();
    const first = injectScript(SDK_URL, "acme");
    injected[0]!.onerror!();
    await expectLoadFailure(first, SDK_URL);
    const second = injectScript(SDK_URL, "acme");
    expect(injected).toHaveLength(2);
    injected[1]!.onload!();
    await expect(second).resolves.toBeUndefined();
  });

  it("rejects a call that waited on the tag while it loaded, then drops the tag once it fails", async () => {
    const { injected } = stubPage();
    const first = injectScript(SDK_URL, "acme");
    const waiting = injectScript(SDK_URL, "acme");
    expect(await hasSettled(waiting)).toBe(false);
    injected[0]!.onerror!();
    await expectLoadFailure(first, SDK_URL);
    await expectLoadFailure(waiting, SDK_URL);
    const third = injectScript(SDK_URL, "acme");
    expect(injected).toHaveLength(2);
    injected[1]!.onload!();
    await expect(third).resolves.toBeUndefined();
  });

  it("rejects each call that waited on the tag with its own error, attributed to its pspName", async () => {
    const { injected } = stubPage();
    const first = injectScript(SDK_URL, "acme");
    const waiting = injectScript(SDK_URL, "acme-eu");
    injected[0]!.onerror!();
    await expectLoadFailure(first, SDK_URL);
    const error = await rejection(waiting);
    expect(error.toJSON()).toEqual({
      name: "PayFanoutError",
      code: "psp_unavailable",
      message: `Failed to load ${SDK_URL}`,
      retryable: true,
      pspName: "acme-eu",
    });
    expect(error).not.toBe(await rejection(first));
  });

  it("drops the failed tag before rejecting the calls that waited on it", async () => {
    // A caller retrying from its rejection handler must fetch the file again.
    const { injected } = stubPage();
    void injectScript(SDK_URL, "acme").catch(() => undefined);
    const retried = injectScript(SDK_URL, "acme").catch(() => injectScript(SDK_URL, "acme"));
    injected[0]!.onerror!();
    expect(await hasSettled(retried)).toBe(false);
    expect(injected).toHaveLength(2);
    injected[1]!.onload!();
    await expect(retried).resolves.toBeUndefined();
  });

  it("never takes over a tag the page added itself", async () => {
    const pageTag = scriptOnPage(SDK_URL);
    pageTag.remove = vi.fn();
    const { injected } = stubPage(pageTag);
    await expect(injectScript(SDK_URL, "acme")).resolves.toBeUndefined();
    expect(pageTag.onerror).toBeNull();
    expect(pageTag.onload).toBeNull();
    expect(pageTag.remove).not.toHaveBeenCalled();
    expect(injected).toHaveLength(0);
  });

  it("lets the file load under a new hash once the tag carrying the old one failed", async () => {
    const { injected } = stubPage();
    const first = injectScript(SDK_URL, "acme", { integrity: HASH });
    injected[0]!.onerror!();
    await expectLoadFailure(first, SDK_URL);
    const second = injectScript(SDK_URL, "acme", { integrity: OTHER_HASH });
    expect(injected).toHaveLength(2);
    expect(injected[1]!.srcSetWith).toEqual({ integrity: OTHER_HASH, crossorigin: "anonymous" });
    injected[1]!.onload!();
    await expect(second).resolves.toBeUndefined();
  });
});

describe("injectScript while the tag an earlier call injected is loading", () => {
  it("keeps every later call for the url pending until the tag loads, then resolves them", async () => {
    const { injected } = stubPage();
    const first = injectScript(SDK_URL, "acme");
    const second = injectScript(SDK_URL, "acme");
    const third = injectScript(SDK_URL, "acme");
    expect(await hasSettled(second)).toBe(false);
    expect(await hasSettled(third)).toBe(false);
    expect(injected).toHaveLength(1);
    injected[0]!.onload!();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    await expect(third).resolves.toBeUndefined();
  });

  it("resolves a later call at once after that tag has loaded", async () => {
    const { injected } = stubPage();
    const first = injectScript(SDK_URL, "acme", { integrity: HASH });
    injected[0]!.onload!();
    await expect(first).resolves.toBeUndefined();
    const later = injectScript(SDK_URL, "acme", { integrity: HASH });
    expect(await hasSettled(later)).toBe(true);
    await expect(later).resolves.toBeUndefined();
    expect(injected).toHaveLength(1);
  });

  it("runs the integrity checks first, refusing at once instead of waiting", async () => {
    const { injected } = stubPage();
    const first = injectScript(SDK_URL, "acme", { integrity: HASH });
    await expectReuseRefused(injectScript(SDK_URL, "acme", { integrity: OTHER_HASH }));
    await expectRefused(
      injectScript(SDK_URL, "acme", { integrity: "sha384-?" }),
      `The integrity for ${SDK_URL} holds no sha256, sha384 or sha512 hash`,
    );
    expect(injected).toHaveLength(1);
    injected[0]!.onload!();
    await expect(first).resolves.toBeUndefined();
  });
});

const NONCE_REFUSAL = (url: string) =>
  `The nonce for ${url} is not a CSP nonce: base64 or base64url characters, with at most two trailing "="`;

/** Values outside CSP3's base64-value, which no 'nonce-…' source can name. */
const MALFORMED_NONCES = ["", " ", "a b", " abc", "abc\n", "'abc'", "'nonce-abc'", "abc===", "=abc", "ab=c", "abc;", "été"];

describe("isValidCspNonce", () => {
  it("accepts CSP3's base64-value: base64 or base64url characters with up to two trailing padding signs", () => {
    for (const nonce of [NONCE, "abc", "ABCxyz019", "a+b/c-d_e", "abc=", "abc==", "-", "_"]) {
      expect(isValidCspNonce(nonce), nonce).toBe(true);
    }
  });

  it("refuses the empty string, anything outside the grammar, and non-strings", () => {
    for (const nonce of [...MALFORMED_NONCES, "=", "==", 123, null, undefined, {}, ["abc"]]) {
      expect(isValidCspNonce(nonce), String(nonce)).toBe(false);
    }
  });

  it("checks the form only, so a value that kept its nonce- prefix still passes", () => {
    expect(isValidCspNonce("nonce-abc")).toBe(true);
  });
});

describe("injectScript nonce, attributes and async", () => {
  it("sets the nonce, the further attributes and async before setting src and inserting the script", async () => {
    const { injected } = stubPage();
    const loading = injectScript(SDK_URL, "acme", {
      nonce: NONCE,
      attributes: { "data-csp-nonce": NONCE, "kr-spa-mode": "true" },
      async: false,
    });
    const expected = { nonce: NONCE, "data-csp-nonce": NONCE, "kr-spa-mode": "true" };
    expect(injected).toHaveLength(1);
    expect(injected[0]!.srcSetWith).toEqual(expected);
    expect(injected[0]!.insertedWith).toEqual(expected);
    expect([injected[0]!.asyncWhenSrcSet, injected[0]!.asyncWhenInserted]).toEqual([false, false]);
    injected[0]!.onload!();
    await expect(loading).resolves.toBeUndefined();
  });

  it("keeps async true unless told otherwise, set before src too", () => {
    const { injected } = stubPage();
    void injectScript(SDK_URL, "acme", { nonce: NONCE });
    void injectScript(OTHER_URL, "acme", { async: true });
    expect(injected.map((script) => [script.asyncWhenSrcSet, script.asyncWhenInserted])).toEqual([
      [true, true],
      [true, true],
    ]);
  });

  it("sets the nonce beside integrity and crossorigin, all before src", () => {
    const { injected } = stubPage();
    void injectScript(SDK_URL, "acme", { integrity: HASH, nonce: NONCE });
    expect(injected[0]!.srcSetWith).toEqual({ nonce: NONCE, integrity: HASH, crossorigin: "anonymous" });
  });

  it("refuses a nonce outside CSP3's base64-value and injects nothing", async () => {
    const { injected } = stubPage();
    for (const nonce of MALFORMED_NONCES) {
      await expectRefused(injectScript(SDK_URL, "acme", { nonce }), NONCE_REFUSAL(SDK_URL));
    }
    expect(injected).toHaveLength(0);
  });

  it("refuses an attribute the helper manages, in any letter case, and injects nothing", async () => {
    const { injected } = stubPage();
    for (const name of ["src", "SRC", "async", "Defer", "integrity", "crossOrigin", "NONCE", "type"]) {
      await expectRefused(
        injectScript(SDK_URL, "acme", { attributes: { "data-ok": "1", [name]: "x" } }),
        `The ${JSON.stringify(name)} attribute for ${SDK_URL} is managed by injectScript, so attributes may not set it`,
      );
    }
    expect(injected).toHaveLength(0);
  });

  it("refuses an attribute that can make the browser skip the script without an event, and injects nothing", async () => {
    // Each would leave the call pending: a script the browser skips fires neither load nor error.
    const { injected } = stubPage();
    const cases: Record<string, string>[] = [
      { nomodule: "" },
      { NoModule: "" },
      { language: "vbscript" },
      { Language: "vbscript" },
      { event: "onclick", for: "document" },
      { EVENT: "onclick" },
      { For: "document" },
    ];
    for (const attributes of cases) {
      const name = Object.keys(attributes)[0]!;
      const loading = injectScript(SDK_URL, "acme", { attributes: { "data-ok": "1", ...attributes } });
      // Settled at once, so a missing refusal fails here rather than by timeout.
      expect(await hasSettled(loading), name).toBe(true);
      await expectRefused(
        loading,
        `The ${JSON.stringify(name)} attribute for ${SDK_URL} is managed by injectScript, so attributes may not set it`,
      );
    }
    expect(injected).toHaveLength(0);
  });

  it("refuses an attribute that runs script, in any letter case, and injects nothing", async () => {
    const { injected } = stubPage();
    for (const name of ["onload", "ONERROR", "onClick", "on"]) {
      const loading = injectScript(SDK_URL, "acme", { attributes: { [name]: "alert(1)" } });
      expect(await hasSettled(loading), name).toBe(true);
      await expectRefused(
        loading,
        `The ${JSON.stringify(name)} attribute for ${SDK_URL} runs script, so attributes may not set it`,
      );
    }
    expect(injected).toHaveLength(0);
  });

  it("refuses a name the DOM refuses, whatever the page holds, keeping the DOM's error on raw", async () => {
    for (const onPage of [[], [scriptOnPage(SDK_URL)]]) {
      const { injected } = stubPage(...onPage);
      const error = await rejection(injectScript(SDK_URL, "acme", { attributes: { "data ok": "1" } }));
      expect(error.toJSON()).toEqual({
        name: "PayFanoutError",
        code: "invalid_request",
        message: `The DOM refuses "data ok" as an attribute name, so nothing was injected for ${SDK_URL}`,
        retryable: false,
        pspName: "acme",
      });
      expect(error.raw).toBeInstanceOf(DOMException);
      expect((error.raw as DOMException).name).toBe("InvalidCharacterError");
      expect(injected).toHaveLength(0);
    }
  });

  it("refuses invalid options at once, even while a tag for the url is still loading", async () => {
    const { injected } = stubPage();
    const first = injectScript(SDK_URL, "acme");
    await expectRefused(injectScript(SDK_URL, "acme", { nonce: "a b" }), NONCE_REFUSAL(SDK_URL));
    await expectRefused(
      injectScript(SDK_URL, "acme", { attributes: { onload: "x" } }),
      `The "onload" attribute for ${SDK_URL} runs script, so attributes may not set it`,
    );
    expect(injected).toHaveLength(1);
    injected[0]!.onload!();
    await expect(first).resolves.toBeUndefined();
  });

  it("reuses a script already on the page without comparing its nonce or attributes", async () => {
    // A connected tag's nonce reads as "" under a header-delivered policy.
    const { injected } = stubPage(scriptOnPage(SDK_URL, { nonce: "", "kr-public-key": "another-key" }));
    await expect(
      injectScript(SDK_URL, "acme", { nonce: NONCE, attributes: { "kr-public-key": "this-key" }, async: false }),
    ).resolves.toBeUndefined();
    expect(injected).toHaveLength(0);
  });

  it("makes a call carrying a nonce wait for the tag an earlier call injected without one", async () => {
    const { injected } = stubPage();
    const first = injectScript(SDK_URL, "acme");
    const second = injectScript(SDK_URL, "acme", { nonce: NONCE, attributes: { "data-csp-nonce": NONCE } });
    expect(await hasSettled(second)).toBe(false);
    expect(injected).toHaveLength(1);
    expect(injected[0]!.insertedWith).toEqual({});
    injected[0]!.onload!();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it("rejects a call carrying a nonce with the failure of the tag it waited on", async () => {
    const { injected } = stubPage();
    const first = injectScript(SDK_URL, "acme", { nonce: NONCE });
    const second = injectScript(SDK_URL, "acme", { nonce: NONCE, attributes: { "kr-spa-mode": "true" } });
    injected[0]!.onerror!();
    await expectLoadFailure(first, SDK_URL);
    await expectLoadFailure(second, SDK_URL);
    expect(injected).toHaveLength(1);
  });
});

describe("injectStylesheet", () => {
  it("injects one link carrying only rel and href without options, and resolves when it loads", async () => {
    // No setAttribute on the doubles: a call without options must not need it.
    const appended: Record<string, unknown>[] = [];
    vi.stubGlobal("document", {
      querySelector: () => null,
      createElement: () => ({}),
      head: { appendChild: (el: Record<string, unknown>) => appended.push(el) },
    });
    const loading = injectStylesheet(CSS_URL, "acme");
    expect(appended).toHaveLength(1);
    expect(Object.keys(appended[0]!).sort()).toEqual(["href", "onerror", "onload", "rel"]);
    expect(appended[0]).toMatchObject({ rel: "stylesheet", href: CSS_URL });
    (appended[0]!["onload"] as () => void)();
    await expect(loading).resolves.toBeUndefined();
  });

  it("sets rel, the nonce, integrity and a default crossorigin of anonymous before href and insertion", async () => {
    const { injected } = stubLinkPage();
    const loading = injectStylesheet(CSS_URL, "acme", { nonce: NONCE, integrity: HASH });
    const expected = { nonce: NONCE, integrity: HASH, crossorigin: "anonymous" };
    expect(injected).toHaveLength(1);
    expect(injected[0]!.relWhenHrefSet).toBe("stylesheet");
    expect(injected[0]!.hrefSetWith).toEqual(expected);
    expect(injected[0]!.insertedWith).toEqual(expected);
    injected[0]!.onload!();
    await expect(loading).resolves.toBeUndefined();
  });

  it("honours an explicit crossOrigin, and sets crossorigin without integrity only when asked", () => {
    const { injected } = stubLinkPage();
    void injectStylesheet(CSS_URL, "acme", { integrity: HASH, crossOrigin: "use-credentials" });
    void injectStylesheet(`${CSS_URL}?2`, "acme", { nonce: NONCE });
    void injectStylesheet(`${CSS_URL}?3`, "acme", { crossOrigin: "anonymous" });
    expect(injected.map((link) => link.hrefSetWith)).toEqual([
      { integrity: HASH, crossorigin: "use-credentials" },
      { nonce: NONCE },
      { crossorigin: "anonymous" },
    ]);
  });

  it("resolves when the sheet fails to load and keeps the link, which a later call reuses at once", async () => {
    const { injected, head } = stubLinkPage();
    const first = injectStylesheet(CSS_URL, "acme", { integrity: HASH });
    injected[0]!.remove = vi.fn();
    // A sheet failing its integrity check reaches the page only as the error event.
    injected[0]!.onerror!();
    await expect(first).resolves.toBeUndefined();
    expect(injected[0]!.remove).not.toHaveBeenCalled();
    expect(head).toEqual([injected[0]]);
    const second = injectStylesheet(CSS_URL, "acme", { integrity: HASH });
    expect(await hasSettled(second)).toBe(true);
    expect(injected).toHaveLength(1);
  });

  it("keeps a link whose error event fires after its own rules applied, as a failed @import makes it", async () => {
    // Chromium fires error on such a link: the page cannot tell it from a sheet that failed.
    const { injected, head } = stubLinkPage();
    const loading = injectStylesheet(CSS_URL, "acme", { nonce: NONCE });
    const link = injected[0]!;
    link.remove = vi.fn();
    link.sheet = { cssRules: [{ cssText: ".kr-embedded { display: block; }" }] };
    link.onerror!();
    await expect(loading).resolves.toBeUndefined();
    expect(link.remove).not.toHaveBeenCalled();
    expect(head).toEqual([link]);
  });

  it("makes a later call wait for the link an earlier call injected, and resolves both when it loads", async () => {
    const { injected } = stubLinkPage();
    const first = injectStylesheet(CSS_URL, "acme");
    const second = injectStylesheet(CSS_URL, "acme-eu", { nonce: NONCE });
    expect(await hasSettled(second)).toBe(false);
    expect(injected).toHaveLength(1);
    injected[0]!.onload!();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    const later = injectStylesheet(CSS_URL, "acme");
    expect(await hasSettled(later)).toBe(true);
    expect(injected).toHaveLength(1);
  });

  it("resolves the calls waiting on a link that fails, and a call made from their handlers reuses it", async () => {
    const { injected } = stubLinkPage();
    void injectStylesheet(CSS_URL, "acme");
    const retried = injectStylesheet(CSS_URL, "acme").then(() => injectStylesheet(CSS_URL, "acme"));
    injected[0]!.onerror!();
    await expect(retried).resolves.toBeUndefined();
    expect(injected).toHaveLength(1);
  });

  it("reuses a link already on the page at once, whatever it carries, and never takes it over", async () => {
    const pageLink = linkOnPage(CSS_URL, { integrity: OTHER_HASH });
    pageLink.remove = vi.fn();
    const { injected } = stubLinkPage(pageLink);
    await expect(injectStylesheet(CSS_URL, "acme", { nonce: NONCE, integrity: HASH })).resolves.toBeUndefined();
    expect(pageLink.onload).toBeNull();
    expect(pageLink.onerror).toBeNull();
    expect(pageLink.remove).not.toHaveBeenCalled();
    expect(injected).toHaveLength(0);
  });

  it("reuses a link whose rel lists stylesheet among other link types", async () => {
    const { injected } = stubLinkPage(linkOnPage(CSS_URL, {}, "stylesheet prefetch"));
    await expect(injectStylesheet(CSS_URL, "acme")).resolves.toBeUndefined();
    expect(injected).toHaveLength(0);
  });

  it("injects a stylesheet beside a link of another type for the url, such as a preload", async () => {
    // A preload fetches the sheet without applying it, so it must not stand in for the stylesheet.
    const preload = linkOnPage(CSS_URL, { as: "style" }, "preload");
    const { injected, head } = stubLinkPage(preload);
    const loading = injectStylesheet(CSS_URL, "acme", { nonce: NONCE });
    expect(injected).toHaveLength(1);
    expect(injected[0]).toMatchObject({ rel: "stylesheet", href: CSS_URL });
    expect(head).toEqual([preload, injected[0]]);
    injected[0]!.onload!();
    await expect(loading).resolves.toBeUndefined();
  });

  it("injects nothing and resolves at once for an empty url, which names no sheet", async () => {
    // A link with an empty href fetches nothing and fires neither event.
    const { injected } = stubLinkPage();
    const loading = injectStylesheet("", "acme", { nonce: NONCE, integrity: HASH });
    expect(await hasSettled(loading)).toBe(true);
    await expect(loading).resolves.toBeUndefined();
    expect(injected).toHaveLength(0);
  });

  it("checks the options of a call for an empty url all the same", async () => {
    const { injected } = stubLinkPage();
    await expectRefused(injectStylesheet("", "acme", { nonce: "a b" }), NONCE_REFUSAL(""));
    expect(injected).toHaveLength(0);
  });

  it("refuses an invalid nonce or integrity, even with a link for the url on the page, and injects nothing", async () => {
    const { injected } = stubLinkPage(linkOnPage(CSS_URL));
    for (const nonce of MALFORMED_NONCES) {
      await expectRefused(injectStylesheet(CSS_URL, "acme", { nonce }), NONCE_REFUSAL(CSS_URL));
    }
    for (const integrity of ["", "SHA384-abc", "sha384-?"]) {
      await expectRefused(
        injectStylesheet(CSS_URL, "acme", { integrity }),
        `The integrity for ${CSS_URL} holds no sha256, sha384 or sha512 hash`,
      );
    }
    expect(injected).toHaveLength(0);
  });

  it("keeps a link double without remove() when its load fails, without throwing", async () => {
    const appended: Record<string, unknown>[] = [];
    vi.stubGlobal("document", {
      querySelector: () => null,
      createElement: () => ({}),
      head: { appendChild: (el: Record<string, unknown>) => appended.push(el) },
    });
    const loading = injectStylesheet(CSS_URL, "acme");
    expect(() => (appended[0]!["onerror"] as () => void)()).not.toThrow();
    await expect(loading).resolves.toBeUndefined();
  });
});
