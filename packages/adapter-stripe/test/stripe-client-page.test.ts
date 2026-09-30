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
    // The 30-second bound and the poll for a Stripe.js another script defines.
    expect(vi.getTimerCount()).toBe(2);
    setGlobal(pageStripe("dahlia"));
    tag.dispatchEvent(new Event("load"));
    await expect(loading).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves as soon as another script defines Stripe.js during the wait", async () => {
    vi.useFakeTimers();
    const tag = pageTag();
    const calls: Calls = [];
    const stripe = adapter();
    const outcome = stripe.loadSdk().then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    // The page's own v3, from another tag, runs while the build's tag never settles.
    setGlobal(pageStripe(3, calls));
    await vi.advanceTimersByTimeAsync(100);
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("resolved");
    expect(vi.getTimerCount()).toBe(0);
    expect(tag.isConnected).toBe(true);
    await stripe.mount(document.createElement("div"), { clientSecret: "pi_1_secret_x" });
    expect(calls).toEqual([{ apiVersion: API_VERSION }]);
  });

  it("resolves when the page's tag fails but another script has defined Stripe.js", async () => {
    const tag = pageTag();
    const loading = adapter().loadSdk();
    expect(await settled(loading)).toBe(false);
    setGlobal(pageStripe(3));
    tag.dispatchEvent(new Event("error"));
    await expect(loading).resolves.toBeUndefined();
    expect(tag.isConnected).toBe(false);
  });

  it("resolves when the wait ends just after another script defined Stripe.js", async () => {
    vi.useFakeTimers();
    pageTag();
    const outcome = adapter().loadSdk().then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(29_950);
    setGlobal(pageStripe("dahlia"));
    // The bound and the poll fall due together; the bound, set first, runs first.
    await vi.advanceTimersByTimeAsync(50);
    expect(await outcome).toBe("resolved");
  });

  it("replaces a page tag that failed before it looked: the first call times out, the next injects a fresh copy", async () => {
    vi.useFakeTimers();
    const tag = pageTag();
    // The page's tag failed before the adapter looked, so nothing reports it.
    tag.dispatchEvent(new Event("error"));
    const stripe = adapter();
    const first = stripe.loadSdk().then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await first).toMatchObject({
      code: "psp_unavailable",
      message: `The page's Stripe.js at ${STRIPE_JS_URL} did not load within 30 seconds`,
    });
    expect(tag.isConnected).toBe(true);

    const insertions = recordInsertions();
    const second = stripe.loadSdk();
    expect(tag.isConnected).toBe(false);
    expect(insertions).toEqual([expect.objectContaining({ src: STRIPE_JS_URL, nonce: NONCE })]);
    setGlobal(pageStripe("dahlia"));
    document.querySelector(`script[src="${STRIPE_JS_URL}"]`)!.dispatchEvent(new Event("load"));
    await expect(second).resolves.toBeUndefined();
  });

  it("replaces its own tag that loaded without Stripe.js instead of waiting on it", async () => {
    vi.useFakeTimers();
    const stripe = adapter();
    const first = stripe.loadSdk();
    const own = document.querySelector(`script[src="${STRIPE_JS_URL}"]`)!;
    own.dispatchEvent(new Event("load"));
    await expect(first).rejects.toMatchObject({ code: "psp_unavailable", message: "Stripe.js loaded but window.Stripe is missing" });

    const insertions = recordInsertions();
    // The fresh copy loads without Stripe.js too: the call fails at once, waiting on no tag.
    const second = stripe.loadSdk().then(
      () => "resolved",
      (err: unknown) => err,
    );
    expect(own.isConnected).toBe(false);
    expect(insertions).toHaveLength(1);
    const fresh = document.querySelector(`script[src="${STRIPE_JS_URL}"]`)!;
    fresh.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([second, Promise.resolve("pending")])).toMatchObject({
      code: "psp_unavailable",
      message: "Stripe.js loaded but window.Stripe is missing",
    });

    const third = stripe.loadSdk().then(() => "resolved");
    expect(fresh.isConnected).toBe(false);
    expect(insertions).toHaveLength(2);
    setGlobal(pageStripe("dahlia"));
    document.querySelector(`script[src="${STRIPE_JS_URL}"]`)!.dispatchEvent(new Event("load"));
    // No timer to run: the call does not wait on a stale tag.
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([third, Promise.resolve("pending")])).toBe("resolved");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a second page tag for the URL, still loading when the first failed, and waits on it next", async () => {
    const first = pageTag();
    const second = pageTag();
    const stripe = adapter();
    const attempt = stripe.loadSdk();
    expect(await settled(attempt)).toBe(false);
    first.dispatchEvent(new Event("error"));
    await expect(attempt).rejects.toMatchObject({ code: "psp_unavailable", message: `Failed to load ${STRIPE_JS_URL}` });
    expect(first.isConnected).toBe(false);
    expect(second.isConnected).toBe(true);

    const insertions = recordInsertions();
    const retry = stripe.loadSdk();
    expect(await settled(retry)).toBe(false);
    // The attempt watched only the first tag, so the second is waited on, not replaced.
    expect(second.isConnected).toBe(true);
    expect(insertions).toHaveLength(0);
    setGlobal(pageStripe("dahlia"));
    second.dispatchEvent(new Event("load"));
    await expect(retry).resolves.toBeUndefined();
  });

  it("replaces a tag another adapter saw load without Stripe.js, instead of waiting on it", async () => {
    vi.useFakeTimers();
    const attempt = adapter().loadSdk();
    const loaded = document.querySelector(`script[src="${STRIPE_JS_URL}"]`)!;
    loaded.dispatchEvent(new Event("load"));
    await expect(attempt).rejects.toMatchObject({ message: "Stripe.js loaded but window.Stripe is missing" });

    const insertions = recordInsertions();
    const other = adapter().loadSdk().then(() => "resolved");
    expect(loaded.isConnected).toBe(false);
    expect(insertions).toEqual([expect.objectContaining({ src: STRIPE_JS_URL, nonce: NONCE })]);
    setGlobal(pageStripe("dahlia"));
    document.querySelector(`script[src="${STRIPE_JS_URL}"]`)!.dispatchEvent(new Event("load"));
    // No timer to run: the second adapter does not wait on the tag the first saw settle.
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([other, Promise.resolve("pending")])).toBe("resolved");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wait on another adapter's tag once it has loaded Stripe.js", async () => {
    vi.useFakeTimers();
    const first = adapter();
    const second = adapter();
    const a = first.loadSdk();
    const b = second.loadSdk().then(() => "resolved");
    // The second adapter found the first one's tag still loading.
    expect(document.querySelectorAll(`script[src="${STRIPE_JS_URL}"]`)).toHaveLength(1);
    setGlobal(pageStripe("dahlia"));
    document.querySelector(`script[src="${STRIPE_JS_URL}"]`)!.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(a).resolves.toBeUndefined();
    expect(await Promise.race([b, Promise.resolve("pending")])).toBe("resolved");
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
