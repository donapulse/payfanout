// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { StripeClientAdapter, type StripeJsFactory, type StripeJsLike } from "../src/index.js";

// jsdom fetches no subresource here, so a script loads only when a test says so.
const API_VERSION = "2026-08-26.dahlia";
const STRIPE_JS_URL = "https://js.stripe.com/dahlia/stripe.js";
const NONCE = "cmFuZG9tLW5vbmNlLXZhbHVl";

type Calls = Array<Record<string, unknown> | undefined>;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.head.innerHTML = "";
  delete (window as { Stripe?: unknown }).Stripe;
});

const fakeStripe: StripeJsLike = {
  elements: () => ({ create: () => ({ mount: () => {}, unmount: () => {}, destroy: () => {}, on: () => {} }) }),
  confirmPayment: async () => ({ paymentIntent: { status: "succeeded" } }),
  confirmSetup: async () => ({ setupIntent: { status: "succeeded" } }),
  retrievePaymentIntent: async () => ({ paymentIntent: { status: "succeeded" } }),
  retrieveSetupIntent: async () => ({ setupIntent: { status: "succeeded" } }),
};

/** A global as the served Stripe.js files leave it: the initializer, carrying its build's version. */
function pageStripe(version: number | string, calls: Calls = []): StripeJsFactory {
  const factory: StripeJsFactory = (_key, options) => {
    calls.push(options);
    return fakeStripe;
  };
  factory.version = version;
  return factory;
}

function setGlobal(factory: StripeJsFactory): void {
  (window as { Stripe?: unknown }).Stripe = factory;
}

/** The attributes of every element inserted into the head from now on, as they stood at insertion. */
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

/** A `<script>` the page itself added for the build, which has neither loaded nor failed yet. */
function pageTag(): HTMLScriptElement {
  const tag = document.createElement("script");
  tag.src = STRIPE_JS_URL;
  document.head.appendChild(tag);
  return tag;
}

function adapter(): StripeClientAdapter {
  return new StripeClientAdapter({ publishableKey: "pk_test_unit", environment: "sandbox", apiVersion: API_VERSION, cspNonce: NONCE });
}

/** Whether the promise has settled once pending callbacks have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

describe("StripeClientAdapter and a window.Stripe already on the page", () => {
  it("uses the page's Stripe.js when it is the pinned build, injecting nothing", async () => {
    const insertions = recordInsertions();
    setGlobal(pageStripe("dahlia"));
    await expect(adapter().loadSdk()).resolves.toBeUndefined();
    expect(insertions).toHaveLength(0);
  });

  it("uses the page's v3 for a pinned release without loading another copy, giving it the pinned version", async () => {
    const insertions = recordInsertions();
    const calls: Calls = [];
    setGlobal(pageStripe(3, calls));
    const stripe = adapter();
    await stripe.mount(document.createElement("div"), { clientSecret: "pi_1_secret_x" });
    expect(insertions).toHaveLength(0);
    expect(calls).toEqual([{ apiVersion: API_VERSION }]);
  });

  it("loads the build beside a v2 global and uses what the build attached as StripeV3", async () => {
    const insertions = recordInsertions();
    const v2 = pageStripe(2);
    setGlobal(v2);
    const stripe = adapter();
    const loading = stripe.loadSdk();
    expect(insertions).toEqual([expect.objectContaining({ src: STRIPE_JS_URL, nonce: NONCE })]);
    // What the served build does beside v2, instead of replacing window.Stripe.
    const calls: Calls = [];
    v2.StripeV3 = pageStripe("dahlia", calls);
    document.querySelector(`script[src="${STRIPE_JS_URL}"]`)!.dispatchEvent(new Event("load"));
    await expect(loading).resolves.toBeUndefined();
    await stripe.mount(document.createElement("div"), { clientSecret: "pi_1_secret_x" });
    expect(calls).toEqual([undefined]);
  });
});

describe("StripeClientAdapter and a Stripe.js tag the page added", () => {
  it("waits for the page's tag that has not loaded yet instead of failing at once", async () => {
    const tag = pageTag();
    const insertions = recordInsertions();
    const loading = adapter().loadSdk();
    expect(await settled(loading)).toBe(false);
    // core's injectScript reused the page's tag: nothing was injected.
    expect(insertions).toHaveLength(0);
    setGlobal(pageStripe("dahlia"));
    tag.dispatchEvent(new Event("load"));
    await expect(loading).resolves.toBeUndefined();
    expect(document.querySelectorAll("script")).toHaveLength(1);
  });

  it("rejects when the page's tag fails, and removes it so the next call fetches the file again", async () => {
    const tag = pageTag();
    const stripe = adapter();
    const loading = stripe.loadSdk();
    expect(await settled(loading)).toBe(false);
    tag.dispatchEvent(new Event("error"));
    await expect(loading).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
      pspName: "stripe",
      message: `Failed to load ${STRIPE_JS_URL}`,
    });
    expect(tag.isConnected).toBe(false);

    const insertions = recordInsertions();
    const retry = stripe.loadSdk();
    expect(insertions).toEqual([expect.objectContaining({ src: STRIPE_JS_URL, nonce: NONCE })]);
    setGlobal(pageStripe("dahlia"));
    document.querySelector(`script[src="${STRIPE_JS_URL}"]`)!.dispatchEvent(new Event("load"));
    await expect(retry).resolves.toBeUndefined();
  });

  it("gives up after 30 seconds on a page tag that neither loads nor fails, and keeps it", async () => {
    vi.useFakeTimers();
    const tag = pageTag();
    const loading = adapter().loadSdk();
    const outcome = loading.then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({
      code: "psp_unavailable",
      retryable: true,
      message: `The page's Stripe.js at ${STRIPE_JS_URL} did not load within 30 seconds`,
    });
    expect(tag.isConnected).toBe(true);
  });

  it("confirms the global after the page's tag loads", async () => {
    const tag = pageTag();
    const loading = adapter().loadSdk();
    expect(await settled(loading)).toBe(false);
    tag.dispatchEvent(new Event("load"));
    await expect(loading).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
      message: "Stripe.js loaded but window.Stripe is missing",
    });
  });

  it("leaves no timer behind once the page's tag has loaded", async () => {
    vi.useFakeTimers();
    const tag = pageTag();
    const loading = adapter().loadSdk();
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(1);
    setGlobal(pageStripe("dahlia"));
    tag.dispatchEvent(new Event("load"));
    await expect(loading).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wait on its own tag, which loaded without defining the global", async () => {
    const loading = adapter().loadSdk();
    document.querySelector(`script[src="${STRIPE_JS_URL}"]`)!.dispatchEvent(new Event("load"));
    await expect(loading).rejects.toMatchObject({
      code: "psp_unavailable",
      message: "Stripe.js loaded but window.Stripe is missing",
    });
  });
});
