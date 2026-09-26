// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import { StripeClientAdapter, type StripeJsFactory, type StripeJsLike } from "../src/index.js";

// jsdom fetches no subresource here, so the script loads only when a test says so.
const STRIPE_JS_URL = "https://js.stripe.com/v3";
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

describe("StripeClientAdapter cspNonce", () => {
  it("puts the nonce on the Stripe.js script before inserting it", async () => {
    const insertions = recordInsertions();
    let stripe: StripeJsFactory | undefined = undefined;
    const adapter = new StripeClientAdapter({
      publishableKey: "pk_test_unit",
      environment: "sandbox",
      cspNonce: NONCE,
      getStripeGlobal: () => stripe,
    });
    const loading = adapter.loadSdk();
    expect(insertions).toHaveLength(1);
    expect(insertions[0]).toMatchObject({ nonce: NONCE, src: STRIPE_JS_URL });
    stripe = () => ({}) as StripeJsLike;
    document.querySelector(`script[src="${STRIPE_JS_URL}"]`)!.dispatchEvent(new Event("load"));
    await expect(loading).resolves.toBeUndefined();
  });

  it("injects the script without a nonce when none is configured", () => {
    const insertions = recordInsertions();
    const adapter = new StripeClientAdapter({
      publishableKey: "pk_test_unit",
      environment: "sandbox",
      getStripeGlobal: () => undefined,
    });
    void adapter.loadSdk();
    expect(insertions).toHaveLength(1);
    expect(insertions[0]).not.toHaveProperty("nonce");
  });

  it("hands a loadScript seam only the URL, so it loads without the nonce", async () => {
    const calls: unknown[][] = [];
    let stripe: StripeJsFactory | undefined;
    const adapter = new StripeClientAdapter({
      publishableKey: "pk_test_unit",
      environment: "sandbox",
      cspNonce: NONCE,
      getStripeGlobal: () => stripe,
      loadScript: async (...args: unknown[]) => {
        calls.push(args);
        stripe = () => ({}) as StripeJsLike;
      },
    });
    await adapter.loadSdk();
    expect(calls).toEqual([[STRIPE_JS_URL]]);
    expect(document.querySelector("script")).toBeNull();
  });

  it("refuses a malformed cspNonce at construction, without echoing it", () => {
    for (const cspNonce of ["", "a b", "'nonce-abc'", "abc==="]) {
      let err: unknown;
      try {
        new StripeClientAdapter({ publishableKey: "pk_test_unit", environment: "sandbox", cspNonce });
      } catch (caught) {
        err = caught;
      }
      expect(isPayFanoutError(err), JSON.stringify(cspNonce)).toBe(true);
      expect(err).toMatchObject({
        code: "invalid_request",
        retryable: false,
        message:
          "StripeClientAdapter config.cspNonce must be the value of the policy's 'nonce-…' source: base64 or base64url characters",
      });
    }
  });
});
