// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import { PayPalClientAdapter, type PayPalJsLike } from "../src/index.js";

// jsdom fetches no subresource here, so the script loads only when a test says so.
const PAYPAL_SDK_URL = "https://www.paypal.com/sdk/js";
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

describe("PayPalClientAdapter cspNonce", () => {
  it("puts the same nonce in the SDK script's nonce and data-csp-nonce attributes before inserting it", async () => {
    const insertions = recordInsertions();
    let paypal: PayPalJsLike | undefined = undefined;
    const adapter = new PayPalClientAdapter({
      clientId: "test-client-id",
      environment: "sandbox",
      cspNonce: NONCE,
      getPayPalGlobal: () => paypal,
    });
    const loading = adapter.loadSdk();
    expect(insertions).toHaveLength(1);
    expect(insertions[0]).toMatchObject({ nonce: NONCE, "data-csp-nonce": NONCE });
    expect(insertions[0]!["src"]).toMatch(new RegExp(`^${PAYPAL_SDK_URL}\\?client-id=test-client-id&`));
    paypal = { Buttons: () => ({ render: () => undefined }) };
    document.querySelector("script")!.dispatchEvent(new Event("load"));
    await expect(loading).resolves.toBeUndefined();
  });

  it("sets neither attribute when no nonce is configured", () => {
    const insertions = recordInsertions();
    const adapter = new PayPalClientAdapter({
      clientId: "test-client-id",
      environment: "sandbox",
      getPayPalGlobal: () => undefined,
    });
    void adapter.loadSdk();
    expect(insertions).toHaveLength(1);
    expect(insertions[0]).not.toHaveProperty("nonce");
    expect(insertions[0]).not.toHaveProperty("data-csp-nonce");
  });

  it("hands a loadScript seam only the URL, so it loads without the nonce", async () => {
    const calls: unknown[][] = [];
    let paypal: PayPalJsLike | undefined;
    const adapter = new PayPalClientAdapter({
      clientId: "test-client-id",
      environment: "sandbox",
      cspNonce: NONCE,
      getPayPalGlobal: () => paypal,
      loadScript: async (...args: unknown[]) => {
        calls.push(args);
        paypal = { Buttons: () => ({ render: () => undefined }) };
      },
    });
    await adapter.loadSdk();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(document.querySelector("script")).toBeNull();
  });

  it("refuses a malformed cspNonce at construction, without echoing it", () => {
    for (const cspNonce of ["", "a b", "'nonce-abc'", "abc==="]) {
      let err: unknown;
      try {
        new PayPalClientAdapter({ clientId: "test-client-id", environment: "sandbox", cspNonce });
      } catch (caught) {
        err = caught;
      }
      expect(isPayFanoutError(err), JSON.stringify(cspNonce)).toBe(true);
      expect(err).toMatchObject({
        code: "invalid_request",
        retryable: false,
        message:
          "PayPalClientAdapter config.cspNonce must be the value of the policy's 'nonce-…' source: base64 or base64url characters",
      });
    }
  });
});
