// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PayFanoutError } from "../src/errors.js";
import { injectScript, injectStylesheet } from "../src/sdk-loader.js";

// jsdom fetches no subresource here, so a tag loads or fails only when a test says so.
const SDK_URL = "https://sdk.acme.test/v1/acme.js";
const CSS_URL = "https://sdk.acme.test/v1/acme.css";
const HASH = `sha384-${"a".repeat(64)}`;
const NONCE = "cmFuZG9tLW5vbmNlLXZhbHVl";

interface Insertion {
  tagName: string;
  attributes: Record<string, string>;
  /** A script's async flag. */
  async?: boolean;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.head.innerHTML = "";
});

/** Records every element the loaders insert, with the attributes it carried at that moment. */
function recordInsertions(): Insertion[] {
  const insertions: Insertion[] = [];
  const append = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
    const element = node as unknown as Element;
    insertions.push({
      tagName: element.tagName,
      attributes: Object.fromEntries(Array.from(element.attributes, (attribute) => [attribute.name, attribute.value])),
      ...(element instanceof HTMLScriptElement ? { async: element.async } : {}),
    });
    return append(node);
  });
  return insertions;
}

async function rejection(loading: Promise<void>): Promise<PayFanoutError> {
  const error: unknown = await loading.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(PayFanoutError);
  return error as PayFanoutError;
}

describe("the SDK loaders against a DOM", () => {
  it("insert a script that already carries its nonce, attributes and async flag", () => {
    const insertions = recordInsertions();
    void injectScript(SDK_URL, "acme", {
      nonce: NONCE,
      attributes: { "kr-public-key": "69876357:testpublickey_Key", "kr-spa-mode": "true" },
      async: false,
    });
    void injectScript(`${SDK_URL}?async`, "acme", { nonce: NONCE });
    expect(insertions).toEqual([
      {
        tagName: "SCRIPT",
        attributes: {
          nonce: NONCE,
          "kr-public-key": "69876357:testpublickey_Key",
          "kr-spa-mode": "true",
          src: SDK_URL,
        },
        async: false,
      },
      { tagName: "SCRIPT", attributes: { nonce: NONCE, src: `${SDK_URL}?async` }, async: true },
    ]);
  });

  it("insert a stylesheet link that already carries its nonce, integrity and crossorigin", () => {
    const insertions = recordInsertions();
    void injectStylesheet(CSS_URL, "acme", { nonce: NONCE, integrity: HASH });
    expect(insertions).toEqual([
      {
        tagName: "LINK",
        attributes: { rel: "stylesheet", nonce: NONCE, integrity: HASH, crossorigin: "anonymous", href: CSS_URL },
      },
    ]);
  });

  it("refuse a name the DOM refuses with the DOM's own exception on raw, and insert nothing", async () => {
    const insertions = recordInsertions();
    const error = await rejection(injectScript(SDK_URL, "acme", { attributes: { "data ok": "1" } }));
    expect(error).toMatchObject({ code: "invalid_request", retryable: false, pspName: "acme" });
    expect(error.raw).toMatchObject({ name: "InvalidCharacterError" });
    expect(insertions).toEqual([]);
    expect(document.querySelector("script")).toBeNull();
  });

  it("make a second call wait for the script the first inserted, and reject both when it fails", async () => {
    const first = injectScript(SDK_URL, "acme", { nonce: NONCE });
    const second = injectScript(SDK_URL, "acme", { nonce: NONCE });
    const script = document.querySelector(`script[src="${SDK_URL}"]`)!;
    script.dispatchEvent(new Event("error"));
    await expect(first).rejects.toMatchObject({ code: "psp_unavailable", retryable: true });
    await expect(second).rejects.toMatchObject({ code: "psp_unavailable", retryable: true });
    expect(document.querySelector("script")).toBeNull();
  });

  it("make a second call wait for the link the first inserted, and resolve both when it loads", async () => {
    const first = injectStylesheet(CSS_URL, "acme", { nonce: NONCE });
    const second = injectStylesheet(CSS_URL, "acme", { nonce: NONCE });
    const link = document.querySelector(`link[href="${CSS_URL}"]`)!;
    expect(document.querySelectorAll("link")).toHaveLength(1);
    link.dispatchEvent(new Event("load"));
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(document.querySelector("link")).toBe(link);
  });

  it("keep a stylesheet link on the page when its error event fires, and let a later call reuse it", async () => {
    // Chromium fires error on a link whose own rules applied when one of its @imports fails.
    const first = injectStylesheet(CSS_URL, "acme");
    const link = document.querySelector(`link[href="${CSS_URL}"]`)!;
    link.dispatchEvent(new Event("error"));
    await expect(first).resolves.toBeUndefined();
    const insertions = recordInsertions();
    await expect(injectStylesheet(CSS_URL, "acme")).resolves.toBeUndefined();
    expect(insertions).toEqual([]);
    expect(Array.from(document.querySelectorAll("link"))).toEqual([link]);
  });

  it("insert a stylesheet beside a preload link for the same URL, and reuse a stylesheet link the page added", async () => {
    document.head.innerHTML = `<link rel="preload" as="style" href="${CSS_URL}">`;
    const insertions = recordInsertions();
    void injectStylesheet(CSS_URL, "acme", { nonce: NONCE });
    expect(insertions).toEqual([{ tagName: "LINK", attributes: { rel: "stylesheet", nonce: NONCE, href: CSS_URL } }]);

    document.head.innerHTML = `<link rel="stylesheet" href="${CSS_URL}">`;
    await expect(injectStylesheet(CSS_URL, "acme")).resolves.toBeUndefined();
    expect(insertions).toHaveLength(1);
  });
});
