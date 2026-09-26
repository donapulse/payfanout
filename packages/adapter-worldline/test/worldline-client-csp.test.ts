// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import { WorldlineClientAdapter, type WorldlineTokenizerConstructor } from "../src/index.js";

// jsdom fetches no subresource here, so the script loads only when a test says so.
const TOKENIZER_URL = "https://payment.preprod.direct.worldline-solutions.com/hostedtokenization/js/client/tokenizer.min.js";
/** A per-response Content-Security-Policy nonce, as a host server would mint it. */
const NONCE = "cmFuZG9tLW5vbmNlLXZhbHVl";

afterEach(() => {
  vi.restoreAllMocks();
  document.head.innerHTML = "";
});

/** The attributes of every element inserted into the head, as they stood at insertion. */
function recordInsertions(): Array<Record<string, string>> {
  const insertions: Array<Record<string, string>> = [];
  const append = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
    const element = node as unknown as Element;
    insertions.push(Object.fromEntries(Array.from(element.attributes, (attribute) => [attribute.name, attribute.value])));
    return append(node);
  });
  return insertions;
}

describe("WorldlineClientAdapter cspNonce", () => {
  it("puts the nonce on the Tokenizer script before inserting it", async () => {
    const insertions = recordInsertions();
    let tokenizer: WorldlineTokenizerConstructor | undefined = undefined;
    const adapter = new WorldlineClientAdapter({
      environment: "sandbox",
      cspNonce: NONCE,
      getWorldlineGlobal: () => tokenizer,
    });
    const loading = adapter.loadSdk();
    expect(insertions).toHaveLength(1);
    expect(insertions[0]).toMatchObject({ nonce: NONCE, src: TOKENIZER_URL });
    tokenizer = function Tokenizer() {} as unknown as WorldlineTokenizerConstructor;
    document.querySelector(`script[src="${TOKENIZER_URL}"]`)!.dispatchEvent(new Event("load"));
    await expect(loading).resolves.toBeUndefined();
  });

  it("injects the script without a nonce when none is configured", () => {
    const insertions = recordInsertions();
    const adapter = new WorldlineClientAdapter({ environment: "sandbox", getWorldlineGlobal: () => undefined });
    void adapter.loadSdk();
    expect(insertions).toHaveLength(1);
    expect(insertions[0]).not.toHaveProperty("nonce");
  });

  it("hands a loadScript seam only the URL, so it loads without the nonce", async () => {
    const calls: unknown[][] = [];
    let tokenizer: WorldlineTokenizerConstructor | undefined;
    const adapter = new WorldlineClientAdapter({
      environment: "sandbox",
      cspNonce: NONCE,
      getWorldlineGlobal: () => tokenizer,
      loadScript: async (...args: unknown[]) => {
        calls.push(args);
        tokenizer = function Tokenizer() {} as unknown as WorldlineTokenizerConstructor;
      },
    });
    await adapter.loadSdk();
    expect(calls).toEqual([[TOKENIZER_URL]]);
    expect(document.querySelector("script")).toBeNull();
  });

  it("refuses a malformed cspNonce at construction, without echoing it", () => {
    for (const cspNonce of ["", "a b", "'nonce-abc'", "abc==="]) {
      let err: unknown;
      try {
        new WorldlineClientAdapter({ environment: "sandbox", cspNonce });
      } catch (caught) {
        err = caught;
      }
      expect(isPayFanoutError(err), JSON.stringify(cspNonce)).toBe(true);
      expect(err).toMatchObject({
        code: "invalid_request",
        retryable: false,
        message:
          "WorldlineClientAdapter config.cspNonce must be the value of the policy's 'nonce-…' source: base64 or base64url characters",
      });
    }
  });
});
