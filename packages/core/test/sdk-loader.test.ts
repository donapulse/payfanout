import { afterEach, describe, expect, it, vi } from "vitest";
import { PayFanoutError } from "../src/errors.js";
import { injectScript } from "../src/sdk-loader.js";

const SDK_URL = "https://sdk.acme.test/v1/acme.js";
const OTHER_URL = "https://sdk.acme.test/v1/acme-extra.js";
const HASH = `sha384-${"a".repeat(64)}`;
const OTHER_HASH = `sha384-${"b".repeat(64)}`;

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
  /** Takes the tag off the page, as Element.remove() does; set by the page stub. */
  remove: (() => void) | undefined;
  private srcValue = "";

  get src(): string {
    return this.srcValue;
  }

  set src(value: string) {
    this.srcValue = value;
    this.srcSetWith ??= Object.fromEntries(this.attributes);
  }

  setAttribute(name: string, value: string): void {
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
        head.push(script);
        injected.push(script);
      },
    },
  });
  return { injected };
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

  it("reuses a script carrying the same integrity, even while it is still loading", async () => {
    // A tag already on the page resolves the call at once, whatever its state.
    const { injected } = stubPage();
    const first = injectScript(SDK_URL, "acme", { integrity: HASH });
    await expect(injectScript(SDK_URL, "acme", { integrity: HASH })).resolves.toBeUndefined();
    await expect(injectScript(SDK_URL, "acme")).resolves.toBeUndefined();
    expect(injected).toHaveLength(1);
    injected[0]!.onload!();
    await expect(first).resolves.toBeUndefined();
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
