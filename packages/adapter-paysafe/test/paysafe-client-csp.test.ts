// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import { PaysafeClientAdapter, type PaysafeJsLike } from "../src/index.js";

// jsdom fetches no subresource here, so the script loads only when a test says so.
const PAYSAFE_JS_URL = "https://hosted.paysafe.com/js/v1/latest/paysafe.min.js";
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

describe("PaysafeClientAdapter cspNonce", () => {
  it("puts the nonce on the Paysafe.js script before inserting it", async () => {
    const insertions = recordInsertions();
    let paysafe: PaysafeJsLike | undefined = undefined;
    const adapter = new PaysafeClientAdapter({
      apiKey: "cHVibGljOmtleQ==",
      environment: "sandbox",
      cspNonce: NONCE,
      getPaysafeGlobal: () => paysafe,
    });
    const loading = adapter.loadSdk();
    expect(insertions).toHaveLength(1);
    expect(insertions[0]).toMatchObject({ nonce: NONCE, src: PAYSAFE_JS_URL });
    paysafe = {} as PaysafeJsLike;
    document.querySelector(`script[src="${PAYSAFE_JS_URL}"]`)!.dispatchEvent(new Event("load"));
    await expect(loading).resolves.toBeUndefined();
  });

  it("injects the script without a nonce when none is configured", () => {
    const insertions = recordInsertions();
    const adapter = new PaysafeClientAdapter({
      apiKey: "cHVibGljOmtleQ==",
      environment: "sandbox",
      getPaysafeGlobal: () => undefined,
    });
    void adapter.loadSdk();
    expect(insertions).toHaveLength(1);
    expect(insertions[0]).not.toHaveProperty("nonce");
  });

  it("hands a loadScript seam only the URL, so it loads without the nonce", async () => {
    const calls: unknown[][] = [];
    let paysafe: PaysafeJsLike | undefined;
    const adapter = new PaysafeClientAdapter({
      apiKey: "cHVibGljOmtleQ==",
      environment: "sandbox",
      cspNonce: NONCE,
      getPaysafeGlobal: () => paysafe,
      loadScript: async (...args: unknown[]) => {
        calls.push(args);
        paysafe = {} as PaysafeJsLike;
      },
    });
    await adapter.loadSdk();
    expect(calls).toEqual([[PAYSAFE_JS_URL]]);
    expect(document.querySelector("script")).toBeNull();
  });

  it("refuses a malformed cspNonce at construction, without echoing it", () => {
    for (const cspNonce of ["", "a b", "'nonce-abc'", "abc==="]) {
      let err: unknown;
      try {
        new PaysafeClientAdapter({ apiKey: "cHVibGljOmtleQ==", environment: "sandbox", cspNonce });
      } catch (caught) {
        err = caught;
      }
      expect(isPayFanoutError(err), JSON.stringify(cspNonce)).toBe(true);
      expect(err).toMatchObject({
        code: "invalid_request",
        retryable: false,
        message:
          "PaysafeClientAdapter config.cspNonce must be the value of the policy's 'nonce-…' source: base64 or base64url characters",
      });
    }
  });
});
