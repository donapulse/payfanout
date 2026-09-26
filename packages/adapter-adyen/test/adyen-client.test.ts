import { afterEach, describe, expect, it, vi } from "vitest";
import { isPayFanoutError, type ClientPaymentAdapter } from "@payfanout/core";
import { runClientAdapterConformanceTests } from "@payfanout/conformance";
import {
  AdyenClientAdapter,
  ADYEN_WEB_SCRIPT_INTEGRITY,
  ADYEN_WEB_STYLESHEET_INTEGRITY,
  ADYEN_WEB_VERSION,
  adyenRedirectResultToken,
  type AdyenCardState,
  type AdyenClientAdapterConfig,
} from "../src/index.js";

interface FakeAdyenWeb {
  AdyenWeb: unknown;
  checkoutConfigs: Array<Record<string, unknown>>;
  componentOptions: Array<Record<string, unknown>>;
  mountedOn: string[];
  handledActions: Array<Record<string, unknown>>;
  unmounted: number;
  removed: number;
  /** Set when the fake component should have no handleAction (an older build). */
  withoutHandleAction?: boolean;
}

function makeFakeAdyenWeb(options: { withoutHandleAction?: boolean } = {}): FakeAdyenWeb {
  const state: FakeAdyenWeb = {
    AdyenWeb: undefined,
    checkoutConfigs: [],
    componentOptions: [],
    mountedOn: [],
    handledActions: [],
    unmounted: 0,
    removed: 0,
  };
  const AdyenCheckout = async (config: Record<string, unknown>) => {
    state.checkoutConfigs.push(config);
    return { config };
  };
  function Card(this: Record<string, unknown>, checkout: { config: Record<string, unknown> }, opts: Record<string, unknown>) {
    state.componentOptions.push(opts);
    const component: Record<string, unknown> = {
      mount: (element: { id: string }) => state.mountedOn.push(element.id),
      unmount: () => state.unmounted++,
      remove: () => state.removed++,
    };
    if (!options.withoutHandleAction) {
      component["handleAction"] = (action: Record<string, unknown>) => {
        state.handledActions.push(action);
        // Adyen resolves a threeDS2 challenge inline and reports the details on
        // the checkout's own callback.
        (checkout.config["onAdditionalDetails"] as (s: unknown) => void)({
          data: { details: { threeDSResult: "eyJ0..." }, paymentData: "Ab02b4c0..." },
        });
      };
    }
    return component;
  }
  state.AdyenWeb = { AdyenCheckout, Card };
  return state;
}

function makeAdapter(fake = makeFakeAdyenWeb()): { adapter: AdyenClientAdapter; fake: FakeAdyenWeb } {
  const adapter = new AdyenClientAdapter({
    clientKey: "test_CLIENTKEY",
    environment: "sandbox",
    countryCode: "NL",
    getAdyenGlobal: () => fake.AdyenWeb as never,
    loadScript: async () => {},
    loadStylesheet: async () => {},
  });
  return { adapter, fake };
}

function stubBrowser(): void {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    createElement: () => ({ id: "", remove: vi.fn() }),
  });
}

function fakeContainer(): HTMLElement & { children: Array<{ id: string; remove: ReturnType<typeof vi.fn> }> } {
  const container = {
    children: [] as Array<{ id: string; remove: ReturnType<typeof vi.fn> }>,
    appendChild(element: { id: string; remove: ReturnType<typeof vi.fn> }) {
      container.children.push(element);
    },
  };
  return container as never;
}

/** A signed session token: base64url(payload) "." base64url(signature). */
const SESSION_TOKEN = `${Buffer.from(
  JSON.stringify({ v: 1, amount: 2500, currency: "EUR", captureMethod: "automatic", reference: "order-1" }),
).toString("base64url")}.signature`;

const VALID_STATE: AdyenCardState = {
  isValid: true,
  data: {
    paymentMethod: {
      type: "scheme",
      encryptedCardNumber: "test_4111111111111111",
      encryptedExpiryMonth: "test_03",
      encryptedExpiryYear: "test_2030",
      encryptedSecurityCode: "test_737",
    },
  },
};

function emitChange(fake: FakeAdyenWeb, state: AdyenCardState): void {
  (fake.componentOptions[0]!["onChange"] as (s: AdyenCardState) => void)(state);
}

/** An error as Adyen Web raises it: an Error named after one of AdyenCheckoutError's types. */
function adyenError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

runClientAdapterConformanceTests("adyen", () => makeAdapter().adapter, { expectedMethodTypes: ["card"] });

describe("AdyenClientAdapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mounts the Card component into a generated child and initializes button state", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const container = fakeContainer();
    let ready = false;
    const changes: Array<{ complete: boolean }> = [];
    await adapter.mount(container, {
      clientSecret: SESSION_TOKEN,
      onReady: () => (ready = true),
      onChange: (state) => changes.push(state),
    });
    expect(container.children).toHaveLength(1);
    expect(ready).toBe(true);
    expect(changes[0]).toEqual({ complete: false, empty: true });
    expect(fake.mountedOn[0]).toMatch(/^payfanout-adyen-\d+$/);
    expect(fake.checkoutConfigs[0]).toMatchObject({
      clientKey: "test_CLIENTKEY",
      environment: "test",
      countryCode: "NL",
      // Read out of the signed session token's payload half — no key needed.
      amount: { value: 2500, currency: "EUR" },
    });
    // The host's own button drives submission.
    expect(fake.componentOptions[0]).toMatchObject({ showPayButton: false });
  });

  it("forwards appearance as styles and fieldOptions untouched, host wins", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    await adapter.mount(fakeContainer(), {
      clientSecret: SESSION_TOKEN,
      appearance: { base: { color: "#111" } },
      fieldOptions: { hasHolderName: true, holderNameRequired: true },
      locale: "fr-FR",
    });
    expect(fake.componentOptions[0]).toMatchObject({
      styles: { base: { color: "#111" } },
      hasHolderName: true,
      holderNameRequired: true,
    });
    expect(fake.checkoutConfigs[0]).toMatchObject({ locale: "fr-FR" });
  });

  it("reports field validity as the shopper types", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const changes: Array<{ complete: boolean }> = [];
    await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN, onChange: (s) => changes.push(s) });
    emitChange(fake, { isValid: false });
    emitChange(fake, VALID_STATE);
    expect(changes).toEqual([{ complete: false, empty: true }, { complete: false }, { complete: true }]);
  });

  it("confirm() returns the tokenize-first shape carrying the encrypted blob", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const handle = await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
    emitChange(fake, VALID_STATE);
    const result = await adapter.confirm(handle);
    expect(result.status).toBe("requires_confirmation");
    expect(JSON.parse(result.clientToken!)).toMatchObject({
      paymentMethod: { type: "scheme", encryptedCardNumber: "test_4111111111111111" },
    });
  });

  it("confirm() resolves (never rejects) with a unified failure when the fields are incomplete", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const handle = await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
    const before = await adapter.confirm(handle);
    expect(before.status).toBe("failed");
    expect(before.error?.code).toBe("invalid_card_data");
    expect(isPayFanoutError(before.error)).toBe(true);
    emitChange(fake, { isValid: false, data: {} });
    expect((await adapter.confirm(handle)).status).toBe("failed");
  });

  it("resolves a 3-D Secure action inline and returns the details as a fresh clientToken", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const handle = await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
    const action = { type: "threeDS2", subtype: "challenge", token: "challenge-token" };
    const result = await adapter.handleAction(handle, action);
    expect(fake.handledActions).toEqual([action]);
    expect(result.status).toBe("requires_confirmation");
    expect(JSON.parse(result.clientToken!)).toEqual({
      details: { threeDSResult: "eyJ0..." },
      paymentData: "Ab02b4c0...",
    });
  });

  it("refuses a second challenge while one is outstanding instead of stranding the first", async () => {
    stubBrowser();
    const fake = makeFakeAdyenWeb();
    const { adapter } = makeAdapter(fake);
    const handle = await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
    // A build that starts the challenge without reporting details back yet.
    (handle as unknown as { component: { handleAction: () => void } }).component.handleAction = () => undefined;
    const first = adapter.handleAction(handle, { type: "threeDS2" });
    const second = await adapter.handleAction(handle, { type: "threeDS2" });
    expect(second.status).toBe("failed");
    expect(second.error?.code).toBe("invalid_request");
    // The first caller still owns the resolver, so its challenge can finish.
    (fake.checkoutConfigs[0]!["onAdditionalDetails"] as (state: unknown) => void)({
      data: { details: { threeDSResult: "eyJ0..." } },
    });
    expect((await first).status).toBe("requires_confirmation");
  });

  it("degrades when the SDK build cannot handle actions", async () => {
    stubBrowser();
    const { adapter } = makeAdapter(makeFakeAdyenWeb({ withoutHandleAction: true }));
    const handle = await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
    const result = await adapter.handleAction(handle, { type: "threeDS2" });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("psp_unavailable");
  });

  it("mounts without the session payload when the token cannot be read", async () => {
    stubBrowser();
    for (const clientSecret of [
      "not-a-token",
      "", // no token at all
      `${Buffer.from("{not json").toString("base64url")}.sig`,
      `${Buffer.from(JSON.stringify({ v: 1, reference: "r" })).toString("base64url")}.sig`,
    ]) {
      const { adapter, fake } = makeAdapter();
      await adapter.mount(fakeContainer(), { clientSecret });
      expect(fake.checkoutConfigs[0], clientSecret).not.toHaveProperty("amount");
    }
  });

  it("falls back to the configured locale and honors a regional live environment", async () => {
    stubBrowser();
    const fake = makeFakeAdyenWeb();
    const adapter = new AdyenClientAdapter({
      clientKey: "live_CLIENTKEY",
      environment: "live",
      countryCode: "AU",
      locale: "en-AU",
      adyenEnvironment: "live-au",
      getAdyenGlobal: () => fake.AdyenWeb as never,
      loadScript: async () => {},
      loadStylesheet: async () => {},
    });
    await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
    expect(fake.checkoutConfigs[0]).toMatchObject({ locale: "en-AU", environment: "live-au" });
  });

  it("reports an SDK error raised after mount through onError", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    let reported: { code?: string } | undefined;
    await adapter.mount(fakeContainer(), {
      clientSecret: SESSION_TOKEN,
      onError: (err) => (reported = err),
    });
    (fake.checkoutConfigs[0]!["onError"] as (err: unknown) => void)("Failed to load the payment form");
    expect(reported?.code).toBe("psp_unavailable");
  });

  it("resolves an action whose details arrive empty rather than hanging", async () => {
    stubBrowser();
    const fake = makeFakeAdyenWeb();
    const { adapter } = makeAdapter(fake);
    const handle = await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
    // A build that resolves the challenge without handing any details back.
    (handle as unknown as { component: { handleAction: () => void } }).component.handleAction = () => undefined;
    const pending = adapter.handleAction(handle, { type: "threeDS2" });
    (fake.checkoutConfigs[0]!["onAdditionalDetails"] as (state: unknown) => void)({});
    expect(JSON.parse((await pending).clientToken!)).toEqual({});
  });

  it("resolves an action that throws inside the SDK as a failed authentication", async () => {
    stubBrowser();
    const fake = makeFakeAdyenWeb();
    const { adapter } = makeAdapter(fake);
    const handle = await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
    // Replace the component's handler with one that throws, as a broken build would.
    (handle as unknown as { component: { handleAction: () => void } }).component.handleAction = () => {
      throw { errorText: "component is not ready" };
    };
    const result = await adapter.handleAction(handle, { type: "threeDS2" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "authentication_required", retryable: false });
  });

  it("reads the SDK from window.AdyenWeb when no test seam is configured", async () => {
    const fake = makeFakeAdyenWeb();
    vi.stubGlobal("window", { AdyenWeb: fake.AdyenWeb });
    vi.stubGlobal("document", { createElement: () => ({ id: "", remove: vi.fn() }) });
    const adapter = new AdyenClientAdapter({
      clientKey: "test_CLIENTKEY",
      environment: "sandbox",
      countryCode: "NL",
      loadScript: async () => {},
      loadStylesheet: async () => {},
    });
    // The global is already there, so loadSdk injects nothing.
    await expect(adapter.loadSdk()).resolves.toBeUndefined();
    await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
    expect(fake.mountedOn).toHaveLength(1);
  });

  it("injects the stylesheet once and never lets it block the fields", async () => {
    const links: Array<Record<string, unknown>> = [];
    let existing: unknown = undefined;
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {
      createElement: (tag: string) => {
        const element: Record<string, unknown> = { tag, id: "", remove: vi.fn(), setAttribute: vi.fn() };
        if (tag === "link") links.push(element);
        return element;
      },
      querySelector: () => existing,
      head: { appendChild: () => undefined },
    });
    const adapter = new AdyenClientAdapter({
      clientKey: "test_CLIENTKEY",
      environment: "sandbox",
      countryCode: "NL",
      getAdyenGlobal: () => makeFakeAdyenWeb().AdyenWeb as never,
      loadScript: async () => {},
    });
    await adapter.loadSdk();
    expect(links).toHaveLength(0); // the global was already present, nothing to inject

    let global: unknown;
    const fresh = new AdyenClientAdapter({
      clientKey: "test_CLIENTKEY",
      environment: "sandbox",
      countryCode: "NL",
      getAdyenGlobal: () => global as never,
      loadScript: async () => {
        global = makeFakeAdyenWeb().AdyenWeb;
      },
    });
    const loading = fresh.loadSdk();
    // A stylesheet that fails still resolves: styling is cosmetic.
    (links[0]!["onerror"] as () => void)();
    await expect(loading).resolves.toBeUndefined();
    expect(links[0]).toMatchObject({ rel: "stylesheet" });
    // The failed link is taken off the page, so it cannot satisfy a later lookup.
    expect(links[0]!["remove"]).toHaveBeenCalledTimes(1);

    let loadedGlobal: unknown;
    const styled = new AdyenClientAdapter({
      clientKey: "test_CLIENTKEY",
      environment: "sandbox",
      countryCode: "NL",
      getAdyenGlobal: () => loadedGlobal as never,
      loadScript: async () => {
        loadedGlobal = makeFakeAdyenWeb().AdyenWeb;
      },
    });
    const styling = styled.loadSdk();
    (links[1]!["onload"] as () => void)();
    await expect(styling).resolves.toBeUndefined();
    expect(links[1]!["remove"]).not.toHaveBeenCalled();

    // A second adapter finds the loaded link already in the document and skips it.
    existing = links[1];
    let secondGlobal: unknown;
    const again = new AdyenClientAdapter({
      clientKey: "test_CLIENTKEY",
      environment: "sandbox",
      countryCode: "NL",
      getAdyenGlobal: () => secondGlobal as never,
      loadScript: async () => {
        secondGlobal = makeFakeAdyenWeb().AdyenWeb;
      },
    });
    await expect(again.loadSdk()).resolves.toBeUndefined();
    expect(links).toHaveLength(2);
  });

  it("cleans up its generated container and tears the component down on unmount", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const container = fakeContainer();
    const handle = await adapter.mount(container, { clientSecret: SESSION_TOKEN });
    adapter.unmount(handle);
    expect(fake.unmounted).toBe(1);
    expect(fake.removed).toBe(1);
    expect(container.children[0]!.remove).toHaveBeenCalled();
  });

  it("surfaces a mount failure through onError and leaves no orphan container", async () => {
    stubBrowser();
    const fake = makeFakeAdyenWeb();
    fake.AdyenWeb = {
      AdyenCheckout: async () => {
        throw new Error("clientKey origin not allowed");
      },
      Card: class {},
    };
    const { adapter } = makeAdapter(fake);
    const container = fakeContainer();
    let reported: unknown;
    await expect(
      adapter.mount(container, { clientSecret: SESSION_TOKEN, onError: (err) => (reported = err) }),
    ).rejects.toMatchObject({ code: "invalid_card_data" });
    expect(reported).toBeDefined();
    expect(container.children[0]!.remove).toHaveBeenCalled();
  });

  it("rejects mount during SSR and rejects foreign handles", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.mount({} as HTMLElement, { clientSecret: SESSION_TOKEN })).rejects.toThrowError(
      /browser-only/,
    );
    await expect(adapter.confirm({} as never)).rejects.toThrowError(/not produced by AdyenClientAdapter/);
  });

  it("requires an explicit environment, a client key and a country code", () => {
    expect(() => new AdyenClientAdapter({ environment: "prod" as never, clientKey: "k", countryCode: "NL" })).toThrowError(
      /sandbox.*live/,
    );
    expect(() => new AdyenClientAdapter({ environment: "sandbox", clientKey: "", countryCode: "NL" })).toThrowError(
      /clientKey/,
    );
    expect(() => new AdyenClientAdapter({ environment: "sandbox", clientKey: "k", countryCode: "" })).toThrowError(
      /countryCode/,
    );
  });

  it("loads the pinned Adyen Web build from the environment's CDN host", async () => {
    stubBrowser();
    const loaded: string[] = [];
    const styles: string[] = [];
    let global: unknown;
    const adapter = new AdyenClientAdapter({
      clientKey: "live_CLIENTKEY",
      environment: "live",
      countryCode: "NL",
      getAdyenGlobal: () => global as never,
      loadScript: async (url) => {
        loaded.push(url);
        global = makeFakeAdyenWeb().AdyenWeb;
      },
      loadStylesheet: async (url) => {
        styles.push(url);
      },
    });
    await adapter.loadSdk();
    expect(loaded).toEqual([
      `https://checkoutshopper-live.cdn.adyen.com/checkoutshopper/sdk/${ADYEN_WEB_VERSION}/adyen.js`,
    ]);
    expect(styles).toEqual([
      `https://checkoutshopper-live.cdn.adyen.com/checkoutshopper/sdk/${ADYEN_WEB_VERSION}/adyen.css`,
    ]);
  });

  it("retries the SDK injection after a failed script load instead of caching the rejection", async () => {
    stubBrowser();
    let global: unknown;
    let loads = 0;
    const adapter = new AdyenClientAdapter({
      clientKey: "test_CLIENTKEY",
      environment: "sandbox",
      countryCode: "NL",
      getAdyenGlobal: () => global as never,
      loadStylesheet: async () => {},
      loadScript: async () => {
        loads++;
        if (loads === 1) throw new Error("network hiccup");
        global = makeFakeAdyenWeb().AdyenWeb;
      },
    });
    await expect(adapter.loadSdk()).rejects.toThrowError(/hiccup/);
    await expect(adapter.loadSdk()).resolves.toBeUndefined();
    expect(loads).toBe(2);
  });

  it("fails loudly when the script loads but the global never appears", async () => {
    stubBrowser();
    const adapter = new AdyenClientAdapter({
      clientKey: "test_CLIENTKEY",
      environment: "sandbox",
      countryCode: "NL",
      getAdyenGlobal: () => undefined,
      loadScript: async () => {},
      loadStylesheet: async () => {},
    });
    await expect(adapter.loadSdk()).rejects.toMatchObject({ code: "psp_unavailable", retryable: true });
  });

  it("lists only the embedded card method (no redirect flow, so no handleRedirectReturn)", () => {
    const { adapter } = makeAdapter();
    expect(adapter.listPaymentMethodCapabilities()).toEqual([{ type: "card", flow: "embedded", supported: true }]);
    expect((adapter as ClientPaymentAdapter).handleRedirectReturn).toBeUndefined();
  });
});

describe("AdyenClientAdapter 3-D Secure", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The state.data fields the server adapter forwards, as Adyen Web 6.45.2 reports them. */
  const STATE_DATA = {
    paymentMethod: VALID_STATE.data!.paymentMethod!,
    browserInfo: {
      acceptHeader: "*/*",
      javaEnabled: false,
      colorDepth: 24,
      language: "nl-NL",
      screenHeight: 723,
      screenWidth: 1536,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      timeZoneOffset: 0,
    },
    origin: "https://shop.example",
    billingAddress: { street: "Infinite Loop", houseNumberOrName: "1", postalCode: "1011DJ", city: "Amsterdam", country: "NL" },
    riskData: { clientData: "eyJ2ZXJzaW9uIjoiMS4wLjAifQ==" },
  };

  function componentOf(handle: unknown): Record<string, unknown> {
    return (handle as { component: Record<string, unknown> }).component;
  }

  it("confirm() resolves the envelope of Adyen Web's state the server forwards, and nothing else", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const handle = await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
    emitChange(fake, {
      isValid: true,
      data: { ...STATE_DATA, installments: { value: 3 }, storePaymentMethod: true, clientStateDataIndicator: true },
    });
    const result = await adapter.confirm(handle);
    expect(result.status).toBe("requires_confirmation");
    expect(JSON.parse(result.clientToken!)).toEqual(STATE_DATA);

    // A state that carries the card alone travels as the card alone.
    emitChange(fake, VALID_STATE);
    expect(JSON.parse((await adapter.confirm(handle)).clientToken!)).toEqual({ paymentMethod: STATE_DATA.paymentMethod });
  });

  it("confirm() asks the Card to show its validation errors when the fields are incomplete", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const handle = await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
    const showValidation = vi.fn();
    componentOf(handle)["showValidation"] = showValidation;
    emitChange(fake, { isValid: false, data: {} });
    await expect(adapter.confirm(handle)).resolves.toMatchObject({ status: "failed", error: { code: "invalid_card_data" } });
    expect(showValidation).toHaveBeenCalledTimes(1);
    componentOf(handle)["showValidation"] = () => {
      throw new Error("component is not ready");
    };
    await expect(adapter.confirm(handle)).resolves.toMatchObject({ status: "failed" });
  });

  it("shows a required cardholder name and ignores Enter by default, and the host still wins", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
    const defaults = fake.componentOptions[0]!;
    expect(defaults).toMatchObject({ hasHolderName: true, holderNameRequired: true });
    const submit = vi.fn();
    const onEnter = defaults["onEnterKeyPressed"] as (activeElement: unknown, component: unknown) => unknown;
    expect(onEnter({ blur: vi.fn() }, { submit })).toBeUndefined();
    expect(submit).not.toHaveBeenCalled();

    const onEnterKeyPressed = vi.fn();
    const { adapter: other, fake: otherFake } = makeAdapter();
    await other.mount(fakeContainer(), {
      clientSecret: SESSION_TOKEN,
      fieldOptions: { hasHolderName: false, holderNameRequired: false, onEnterKeyPressed },
    });
    expect(otherFake.componentOptions[0]).toMatchObject({ hasHolderName: false, holderNameRequired: false, onEnterKeyPressed });
  });

  it("refuses confirm() once handleAction has replaced the Card", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const handle = await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
    emitChange(fake, VALID_STATE);
    await adapter.handleAction(handle, { type: "threeDS2", subtype: "fingerprint", token: "fingerprint-token" });
    const result = await adapter.confirm(handle);
    expect(result).toMatchObject({ status: "failed", error: { code: "invalid_request" } });
    expect(result.clientToken).toBeUndefined();
  });

  it("settles a pending challenge as failed when Adyen Web reports an error, then accepts the next one", async () => {
    stubBrowser();
    const fake = makeFakeAdyenWeb();
    const { adapter } = makeAdapter(fake);
    const reported: unknown[] = [];
    const handle = await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN, onError: (err) => reported.push(err) });
    // A challenge that has started and not reported back yet.
    componentOf(handle)["handleAction"] = () => undefined;
    const pending = adapter.handleAction(handle, { type: "threeDS2", subtype: "challenge" });
    // Adyen Web's challenge raises this as an API_ERROR when the action carries no token.
    (fake.checkoutConfigs[0]!["onError"] as (err: unknown) => void)(
      adyenError("API_ERROR", "No authorisationToken received. 3DS2 Challenge cannot proceed"),
    );
    const failed = await pending;
    expect(failed.status).toBe("failed");
    expect(isPayFanoutError(failed.error)).toBe(true);
    // The shopper's authentication failed; the card data was never in question.
    expect(failed.error).toMatchObject({ code: "authentication_required", retryable: false });
    // The host's onError still hears about it, with the same error.
    expect(reported).toEqual([failed.error]);

    const next = adapter.handleAction(handle, { type: "threeDS2", subtype: "challenge" });
    (fake.checkoutConfigs[0]!["onAdditionalDetails"] as (state: unknown) => void)({
      data: { details: { threeDSResult: "eyJ0cmFuc1N0YXR1cyI6IlkifQ==" } },
    });
    await expect(next).resolves.toEqual({
      status: "requires_confirmation",
      clientToken: JSON.stringify({ details: { threeDSResult: "eyJ0cmFuc1N0YXR1cyI6IlkifQ==" } }),
    });
  });

  it("keeps an SDK load failure during a challenge a retryable psp_unavailable", async () => {
    stubBrowser();
    const fake = makeFakeAdyenWeb();
    const { adapter } = makeAdapter(fake);
    const handle = await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
    componentOf(handle)["handleAction"] = () => undefined;
    const pending = adapter.handleAction(handle, { type: "threeDS2", subtype: "challenge" });
    (fake.checkoutConfigs[0]!["onError"] as (err: unknown) => void)({ name: "NETWORK_ERROR", message: "Network error" });
    await expect(pending).resolves.toMatchObject({ status: "failed", error: { code: "psp_unavailable", retryable: true } });
  });

  it("keeps a pending challenge's error authentication_required unless Adyen Web names a network or script failure", async () => {
    stubBrowser();
    const fake = makeFakeAdyenWeb();
    const { adapter } = makeAdapter(fake);
    const handle = await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
    componentOf(handle)["handleAction"] = () => undefined;
    const onError = fake.checkoutConfigs[0]!["onError"] as (err: unknown) => void;
    const settleWith = async (err: unknown) => {
      const pending = adapter.handleAction(handle, { type: "threeDS2", subtype: "challenge" });
      onError(err);
      return (await pending).error;
    };
    // The name Adyen Web 6.45.2 gives a challenge action that arrives without its token.
    await expect(
      settleWith(adyenError("API_ERROR", "No authorisationToken received. 3DS2 Challenge cannot proceed")),
    ).resolves.toMatchObject({ code: "authentication_required", retryable: false });
    await expect(
      settleWith(
        adyenError(
          "IMPLEMENTATION_ERROR",
          'It can not submit the details. The callback "onAdditionalDetails" or the Session is not setup correctly.',
        ),
      ),
    ).resolves.toMatchObject({ code: "authentication_required", retryable: false });
    await expect(
      settleWith(adyenError("SCRIPT_ERROR", "Unable to find script container node: #payment")),
    ).resolves.toMatchObject({ code: "psp_unavailable", retryable: true });
    // The name decides even when the message, the API's own text, reads as nothing of the kind.
    await expect(settleWith(adyenError("NETWORK_ERROR", "Invalid Merchant Account"))).resolves.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
    });
  });

  it("settles a pending action as failed when the fields are unmounted", async () => {
    stubBrowser();
    const fake = makeFakeAdyenWeb();
    const { adapter } = makeAdapter(fake);
    const handle = await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
    componentOf(handle)["handleAction"] = () => undefined;
    const pending = adapter.handleAction(handle, { type: "threeDS2", subtype: "challenge" });
    adapter.unmount(handle);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "authentication_required", retryable: false });
    expect(fake.unmounted).toBe(1);
    // Details arriving afterwards settle nothing twice.
    (fake.checkoutConfigs[0]!["onAdditionalDetails"] as (state: unknown) => void)({
      data: { details: { threeDSResult: "eyJ0cmFuc1N0YXR1cyI6IlkifQ==" } },
    });
    await expect(pending).resolves.toBe(result);
    // With nothing pending, unmounting settles nothing.
    expect(() => adapter.unmount(handle)).not.toThrow();
  });

  it("builds the clientToken a 3-D Secure redirect return completes with", () => {
    // Adyen appends the URL-encoded redirectResult to the returnUrl; URLSearchParams decodes it.
    const redirectResult = new URLSearchParams("?shopperOrder=12xy&redirectResult=X6XtfGC3%21Y").get("redirectResult")!;
    expect(JSON.parse(adyenRedirectResultToken(redirectResult))).toEqual({ details: { redirectResult: "X6XtfGC3!Y" } });
    expect(() => adyenRedirectResultToken("")).toThrowError(/redirectResult/);
  });
});

/** The sha384 hashes Adyen's release notes publish for Adyen Web 6.45.2's adyen.js and adyen.css. */
const SCRIPT_INTEGRITY = "sha384-crX4Byf88JpnQfdUaDuwVOj3qlk5tmSa3rhIalmJIyo1kC49EDIcnNQ9fY5blVUV";
const STYLESHEET_INTEGRITY = "sha384-KhV4iC2YVQosq5vzx0xN0yGDVMZA++mbd6obc2JKUszVBdXmexFTRHOXKh5DcqDF";
/** A per-response Content-Security-Policy nonce, as a host server would mint it. */
const NONCE = "cmFuZG9tLW5vbmNlLXZhbHVl";

interface FakePage {
  /** The tags on the page, in insertion order. */
  head: FakeTag[];
}

/**
 * A `<script>` or `<link>` double. It records its attributes when its URL is
 * first set and when it is inserted, the two moments a browser may start
 * fetching.
 */
class FakeTag {
  readonly tagName: string;
  readonly attributes: Record<string, string> = {};
  rel = "";
  async = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  urlSetWith: Record<string, string> | undefined;
  insertedWith: Record<string, string> | undefined;
  readonly remove: ReturnType<typeof vi.fn>;
  private url = "";

  constructor(tagName: string, page: FakePage) {
    this.tagName = tagName;
    this.remove = vi.fn(() => {
      page.head = page.head.filter((tag) => tag !== this);
    });
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  // HTMLLinkElement reflects these two properties onto their attributes.
  set integrity(value: string) {
    this.attributes["integrity"] = value;
  }

  set crossOrigin(value: string) {
    this.attributes["crossorigin"] = value;
  }

  get src(): string {
    return this.url;
  }

  set src(value: string) {
    this.url = value;
    this.urlSetWith ??= { ...this.attributes };
  }

  get href(): string {
    return this.url;
  }

  set href(value: string) {
    this.url = value;
    this.urlSetWith ??= { ...this.attributes };
  }
}

/** Stubs a page that core's injectScript and the adapter's stylesheet injection both run against. */
function stubPage(): FakePage {
  const page: FakePage = { head: [] };
  const matching = (selector: string): FakeTag[] => {
    const match = /^(script|link)\[(?:src|href)="(.*)"\]$/.exec(selector);
    if (!match) throw new Error(`unexpected selector ${selector}`);
    return page.head.filter((tag) => tag.tagName === match[1] && tag.src === match[2]);
  };
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    createElement: (tagName: string) => new FakeTag(tagName, page),
    querySelector: (selector: string) => matching(selector)[0] ?? null,
    querySelectorAll: (selector: string) => matching(selector),
    head: {
      appendChild: (tag: FakeTag) => {
        tag.insertedWith = { ...tag.attributes };
        page.head.push(tag);
      },
    },
  });
  return page;
}

function tagOf(page: FakePage, tagName: "script" | "link"): FakeTag {
  const tag = page.head.find((candidate) => candidate.tagName === tagName);
  if (!tag) throw new Error(`no <${tagName}> on the page`);
  return tag;
}

/** An adapter on the stubbed page whose SDK global appears once `defineGlobal` runs. */
function pageAdapter(config: Partial<AdyenClientAdapterConfig> = {}): {
  adapter: AdyenClientAdapter;
  defineGlobal: () => FakeAdyenWeb;
} {
  let global: unknown;
  const adapter = new AdyenClientAdapter({
    clientKey: "test_CLIENTKEY",
    environment: "sandbox",
    countryCode: "NL",
    getAdyenGlobal: () => global as never,
    ...config,
  });
  const defineGlobal = () => {
    const fake = makeFakeAdyenWeb();
    global = fake.AdyenWeb;
    return fake;
  };
  return { adapter, defineGlobal };
}

function constructionError(config: AdyenClientAdapterConfig): unknown {
  try {
    new AdyenClientAdapter(config);
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("AdyenClientAdapter loading Adyen Web", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Lets every tag on the page load. */
  function loadAll(page: FakePage): void {
    for (const tag of page.head) tag.onload?.();
  }

  it("loads the pinned 6.45.2 build from the test CDN with the integrity hashes Adyen publishes", async () => {
    const page = stubPage();
    const { adapter, defineGlobal } = pageAdapter();
    const loading = adapter.loadSdk();
    const base = "https://checkoutshopper-test.cdn.adyen.com/checkoutshopper/sdk/6.45.2";
    expect(ADYEN_WEB_VERSION).toBe("6.45.2");
    // Exported for a host that adds its own tag for the default URL.
    expect([ADYEN_WEB_SCRIPT_INTEGRITY, ADYEN_WEB_STYLESHEET_INTEGRITY]).toEqual([SCRIPT_INTEGRITY, STYLESHEET_INTEGRITY]);
    const script = tagOf(page, "script");
    const link = tagOf(page, "link");
    expect(script.src).toBe(`${base}/adyen.js`);
    expect(link.href).toBe(`${base}/adyen.css`);
    expect(link.rel).toBe("stylesheet");
    // Both attributes are in place before the URL is set and at insertion.
    const scriptAttributes = { integrity: SCRIPT_INTEGRITY, crossorigin: "anonymous" };
    const linkAttributes = { integrity: STYLESHEET_INTEGRITY, crossorigin: "anonymous" };
    expect([script.urlSetWith, script.insertedWith]).toEqual([scriptAttributes, scriptAttributes]);
    expect([link.urlSetWith, link.insertedWith]).toEqual([linkAttributes, linkAttributes]);
    defineGlobal();
    loadAll(page);
    await expect(loading).resolves.toBeUndefined();
  });

  it("loads from the CDN host of each environment value Adyen Web supports, with the same hashes", async () => {
    const cases = [
      { environment: "sandbox", adyenEnvironment: undefined, value: "test" },
      { environment: "sandbox", adyenEnvironment: "test", value: "test" },
      { environment: "live", adyenEnvironment: undefined, value: "live" },
      { environment: "live", adyenEnvironment: "live", value: "live" },
      { environment: "live", adyenEnvironment: "live-us", value: "live-us" },
      { environment: "live", adyenEnvironment: "live-au", value: "live-au" },
      { environment: "live", adyenEnvironment: "live-nea", value: "live-nea" },
      { environment: "live", adyenEnvironment: "live-in", value: "live-in" },
      // Typed and mapped by Adyen Web, served by its own CDN host, absent from Adyen's v6 guides.
      { environment: "live", adyenEnvironment: "live-apse", value: "live-apse" },
      // Adyen Web lowercases the value itself, so the host and the value it gets are lowercase too.
      { environment: "live", adyenEnvironment: "LIVE-US", value: "live-us" },
      { environment: "sandbox", adyenEnvironment: "Test", value: "test" },
    ] as const;
    for (const { environment, adyenEnvironment, value } of cases) {
      const page = stubPage();
      const { adapter, defineGlobal } = pageAdapter({
        environment,
        clientKey: environment === "live" ? "live_CLIENTKEY" : "test_CLIENTKEY",
        ...(adyenEnvironment ? { adyenEnvironment } : {}),
      });
      const loading = adapter.loadSdk();
      const base = `https://checkoutshopper-${value}.cdn.adyen.com/checkoutshopper/sdk/${ADYEN_WEB_VERSION}`;
      expect(tagOf(page, "script").src).toBe(`${base}/adyen.js`);
      expect(tagOf(page, "script").attributes["integrity"]).toBe(SCRIPT_INTEGRITY);
      expect(tagOf(page, "link").href).toBe(`${base}/adyen.css`);
      expect(tagOf(page, "link").attributes["integrity"]).toBe(STYLESHEET_INTEGRITY);
      const fake = defineGlobal();
      loadAll(page);
      await loading;
      // Adyen Web gets the environment value the files were loaded for.
      await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN });
      expect(fake.checkoutConfigs[0], value).toMatchObject({ environment: value });
    }
  });

  it("loads a file the host overrides without an integrity check, and keeps it on the other file", async () => {
    const cdn = "https://checkoutshopper-test.cdn.adyen.com/checkoutshopper/sdk";
    const cases = [
      {
        config: { sdkVersion: "6.44.0" },
        script: `${cdn}/6.44.0/adyen.js`,
        stylesheet: `${cdn}/6.44.0/adyen.css`,
        scriptIntegrity: undefined,
        stylesheetIntegrity: undefined,
      },
      // Any sdkVersion drops the hashes, even one naming the pinned build.
      {
        config: { sdkVersion: ADYEN_WEB_VERSION },
        script: `${cdn}/${ADYEN_WEB_VERSION}/adyen.js`,
        stylesheet: `${cdn}/${ADYEN_WEB_VERSION}/adyen.css`,
        scriptIntegrity: undefined,
        stylesheetIntegrity: undefined,
      },
      {
        config: { sdkUrl: "https://assets.shop.example/adyen/adyen.js" },
        script: "https://assets.shop.example/adyen/adyen.js",
        stylesheet: `${cdn}/${ADYEN_WEB_VERSION}/adyen.css`,
        scriptIntegrity: undefined,
        stylesheetIntegrity: STYLESHEET_INTEGRITY,
      },
      {
        config: { stylesheetUrl: "https://assets.shop.example/adyen/adyen.css" },
        script: `${cdn}/${ADYEN_WEB_VERSION}/adyen.js`,
        stylesheet: "https://assets.shop.example/adyen/adyen.css",
        scriptIntegrity: SCRIPT_INTEGRITY,
        stylesheetIntegrity: undefined,
      },
    ];
    for (const { config, script, stylesheet, scriptIntegrity, stylesheetIntegrity } of cases) {
      const page = stubPage();
      const { adapter, defineGlobal } = pageAdapter(config);
      const loading = adapter.loadSdk();
      const label = JSON.stringify(config);
      expect(tagOf(page, "script").src, label).toBe(script);
      expect(tagOf(page, "script").attributes, label).toEqual(
        scriptIntegrity ? { integrity: scriptIntegrity, crossorigin: "anonymous" } : {},
      );
      expect(tagOf(page, "link").href, label).toBe(stylesheet);
      expect(tagOf(page, "link").attributes, label).toEqual(
        stylesheetIntegrity ? { integrity: stylesheetIntegrity, crossorigin: "anonymous" } : {},
      );
      defineGlobal();
      loadAll(page);
      await expect(loading).resolves.toBeUndefined();
    }
  });

  it("puts cspNonce on the script and the stylesheet link, before their URL is set and at insertion", async () => {
    const page = stubPage();
    const { adapter, defineGlobal } = pageAdapter({ cspNonce: NONCE });
    const loading = adapter.loadSdk();
    const script = tagOf(page, "script");
    const link = tagOf(page, "link");
    const scriptAttributes = { nonce: NONCE, integrity: SCRIPT_INTEGRITY, crossorigin: "anonymous" };
    const linkAttributes = { nonce: NONCE, integrity: STYLESHEET_INTEGRITY, crossorigin: "anonymous" };
    expect([script.urlSetWith, script.insertedWith]).toEqual([scriptAttributes, scriptAttributes]);
    expect([link.urlSetWith, link.insertedWith]).toEqual([linkAttributes, linkAttributes]);
    defineGlobal();
    loadAll(page);
    await expect(loading).resolves.toBeUndefined();
  });

  it("keeps the nonce on files loaded without an integrity check", async () => {
    const page = stubPage();
    const { adapter, defineGlobal } = pageAdapter({ cspNonce: NONCE, sdkVersion: "6.44.0" });
    const loading = adapter.loadSdk();
    expect(tagOf(page, "script").insertedWith).toEqual({ nonce: NONCE });
    expect(tagOf(page, "link").insertedWith).toEqual({ nonce: NONCE });
    defineGlobal();
    loadAll(page);
    await expect(loading).resolves.toBeUndefined();
  });

  it("hands the seams only the URL, so a host loadScript or loadStylesheet loads without the nonce", async () => {
    const page = stubPage();
    const scripts: string[] = [];
    const stylesheets: string[] = [];
    let global: unknown;
    const adapter = new AdyenClientAdapter({
      clientKey: "test_CLIENTKEY",
      environment: "sandbox",
      countryCode: "NL",
      cspNonce: NONCE,
      getAdyenGlobal: () => global as never,
      loadScript: async (...args: unknown[]) => {
        scripts.push(...(args as string[]));
        global = makeFakeAdyenWeb().AdyenWeb;
      },
      loadStylesheet: async (...args: unknown[]) => {
        stylesheets.push(...(args as string[]));
      },
    });
    await adapter.loadSdk();
    const base = `https://checkoutshopper-test.cdn.adyen.com/checkoutshopper/sdk/${ADYEN_WEB_VERSION}`;
    expect([scripts, stylesheets]).toEqual([[`${base}/adyen.js`], [`${base}/adyen.css`]]);
    expect(page.head).toEqual([]);
  });

  it("makes a second adapter wait for the stylesheet another one injected while it loads", async () => {
    const page = stubPage();
    const first = pageAdapter({ cspNonce: NONCE });
    const second = pageAdapter({ cspNonce: NONCE });
    const loadingFirst = first.adapter.loadSdk();
    const loadingSecond = second.adapter.loadSdk();
    first.defineGlobal();
    second.defineGlobal();
    const script = tagOf(page, "script");
    const link = tagOf(page, "link");
    script.onload!();
    let secondSettled = false;
    void loadingSecond.then(() => (secondSettled = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The script has loaded, the stylesheet has not: both loads wait for it.
    expect(secondSettled).toBe(false);
    link.onload!();
    await expect(loadingFirst).resolves.toBeUndefined();
    await expect(loadingSecond).resolves.toBeUndefined();
    expect(page.head).toEqual([script, link]);
  });

  it("removes a stylesheet it injected whose load failed, so the next load fetches it again", async () => {
    const page = stubPage();
    let loads = 0;
    let global: unknown;
    const adapter = new AdyenClientAdapter({
      clientKey: "test_CLIENTKEY",
      environment: "sandbox",
      countryCode: "NL",
      getAdyenGlobal: () => global as never,
      // The script fails with the stylesheet the first time, as it does when the network drops.
      loadScript: async () => {
        loads++;
        if (loads === 1) throw new Error("Failed to load adyen.js");
        global = makeFakeAdyenWeb().AdyenWeb;
      },
    });
    const first = adapter.loadSdk();
    const failed = tagOf(page, "link");
    // A stylesheet failing its integrity check fires the same error event.
    failed.onerror!();
    await expect(first).rejects.toThrowError(/Failed to load/);
    expect(failed.remove).toHaveBeenCalledTimes(1);
    expect(page.head).toEqual([]);

    const second = adapter.loadSdk();
    const retried = tagOf(page, "link");
    expect(retried).not.toBe(failed);
    expect(retried.attributes).toEqual({ integrity: STYLESHEET_INTEGRITY, crossorigin: "anonymous" });
    retried.onload!();
    await expect(second).resolves.toBeUndefined();
    expect(retried.remove).not.toHaveBeenCalled();
    expect(page.head).toEqual([retried]);
    expect(loads).toBe(2);
  });

  it("tolerates a stylesheet element without remove() when its load fails", async () => {
    const links: Array<Record<string, unknown>> = [];
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {
      createElement: () => {
        const link: Record<string, unknown> = { setAttribute: () => undefined };
        links.push(link);
        return link;
      },
      querySelector: () => null,
      head: { appendChild: () => undefined },
    });
    let global: unknown;
    const adapter = new AdyenClientAdapter({
      clientKey: "test_CLIENTKEY",
      environment: "sandbox",
      countryCode: "NL",
      getAdyenGlobal: () => global as never,
      loadScript: async () => {
        global = makeFakeAdyenWeb().AdyenWeb;
      },
    });
    const loading = adapter.loadSdk();
    expect(() => (links[0]!["onerror"] as () => void)()).not.toThrow();
    await expect(loading).resolves.toBeUndefined();
  });

  it("refuses a <script> the page added for the default URL without the integrity, and injects none", async () => {
    const page = stubPage();
    const own = new FakeTag("script", page);
    own.src = `https://checkoutshopper-test.cdn.adyen.com/checkoutshopper/sdk/${ADYEN_WEB_VERSION}/adyen.js`;
    own.setAttribute("crossorigin", "anonymous");
    page.head.push(own);
    const { adapter } = pageAdapter();
    const scripts = () => page.head.filter((tag) => tag.tagName === "script");
    for (let call = 1; call <= 2; call++) {
      const loading = adapter.loadSdk();
      loadAll(page);
      const err = await loading.then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(err, `call ${call}`).toMatchObject({ code: "invalid_request", retryable: false, pspName: "adyen" });
      expect((err as Error).message).toMatch(/conflicting <script>/);
      expect(scripts(), `call ${call}`).toEqual([own]);
    }
  });

  it("goes back through the loader when the script loaded but the global is missing", async () => {
    stubBrowser();
    let loads = 0;
    let global: unknown;
    const adapter = new AdyenClientAdapter({
      clientKey: "test_CLIENTKEY",
      environment: "sandbox",
      countryCode: "NL",
      getAdyenGlobal: () => global as never,
      loadStylesheet: async () => {},
      loadScript: async () => {
        loads++;
        if (loads > 1) global = makeFakeAdyenWeb().AdyenWeb;
      },
    });
    // Two mounts waiting on the same load both fail, and share that one load.
    const waiting = [adapter.loadSdk(), adapter.loadSdk()];
    for (const call of waiting) {
      await expect(call).rejects.toMatchObject({ code: "psp_unavailable", retryable: true });
    }
    expect(loads).toBe(1);
    await expect(adapter.loadSdk()).resolves.toBeUndefined();
    expect(loads).toBe(2);
  });
});

describe("AdyenClientAdapter configuration checks", () => {
  const sandbox = { clientKey: "test_CLIENTKEY", environment: "sandbox", countryCode: "NL" } as const;
  const live = { clientKey: "live_CLIENTKEY", environment: "live", countryCode: "NL" } as const;

  it("refuses a malformed cspNonce at construction, without echoing it", () => {
    for (const cspNonce of ["", "a b", "'nonce-abc'", "abc==="]) {
      const err = constructionError({ ...sandbox, cspNonce });
      expect(isPayFanoutError(err), JSON.stringify(cspNonce)).toBe(true);
      expect(err).toMatchObject({
        code: "invalid_request",
        retryable: false,
        message:
          "AdyenClientAdapter config.cspNonce must be the value of the policy's 'nonce-…' source: base64 or base64url characters",
      });
    }
    expect(constructionError({ ...sandbox, cspNonce: NONCE })).toBeUndefined();
  });

  it("refuses a client key whose prefix contradicts the environment, without echoing the key", () => {
    const cases: Array<[AdyenClientAdapterConfig, RegExp]> = [
      [{ ...sandbox, clientKey: "live_CLIENTKEY" }, /is a live_ key, but config\.environment "sandbox" takes a test_ key/],
      [{ ...live, clientKey: "test_CLIENTKEY" }, /is a test_ key, but config\.environment "live" takes a live_ key/],
      [{ ...sandbox, clientKey: "CLIENTKEY" }, /must start with test_ for config\.environment "sandbox"/],
      [{ ...live, clientKey: "LIVE_CLIENTKEY" }, /must start with live_ for config\.environment "live"/],
      // A legacy origin key, which Adyen Web still recognises by its pub. prefix.
      [{ ...live, clientKey: "pub.CLIENTKEY" }, /must start with live_ for config\.environment "live"/],
    ];
    for (const [config, message] of cases) {
      const err = constructionError(config);
      expect(err, config.clientKey).toMatchObject({ code: "invalid_request", retryable: false });
      expect((err as Error).message).toMatch(message);
      expect((err as Error).message).not.toContain("CLIENTKEY");
    }
  });

  it("refuses an adyenEnvironment Adyen Web does not support", () => {
    // Adyen Web would fall back to the European live hosts for any of these.
    for (const adyenEnvironment of ["live-eu", "LIVE-EU", "live-apac", "production", ""]) {
      const err = constructionError({ ...live, adyenEnvironment });
      expect(err, adyenEnvironment).toMatchObject({ code: "invalid_request", retryable: false });
      expect((err as Error).message).toBe(
        `AdyenClientAdapter config.adyenEnvironment ${JSON.stringify(adyenEnvironment)} is not an environment value ` +
          'Adyen Web supports: "test", "live", "live-us", "live-au", "live-nea", "live-in", "live-apse"',
      );
    }
    // A host without type checks can hand over something that is not a string at all.
    expect(constructionError({ ...live, adyenEnvironment: 5 as never })).toMatchObject({
      code: "invalid_request",
      message: "AdyenClientAdapter config.adyenEnvironment must be a string, not number",
    });
  });

  it("refuses an adyenEnvironment that contradicts the environment", () => {
    const cases: Array<[AdyenClientAdapterConfig, RegExp]> = [
      [{ ...sandbox, adyenEnvironment: "live" }, /"live" contradicts config\.environment "sandbox", which takes "test"/],
      [{ ...sandbox, adyenEnvironment: "live-us" }, /"live-us" contradicts config\.environment "sandbox"/],
      [{ ...sandbox, adyenEnvironment: "LIVE-APSE" }, /"LIVE-APSE" contradicts config\.environment "sandbox"/],
      [{ ...live, adyenEnvironment: "test" }, /"test" contradicts config\.environment "live", which takes "live" or a regional/],
      [{ ...live, adyenEnvironment: "Test" }, /"Test" contradicts config\.environment "live"/],
    ];
    for (const [config, message] of cases) {
      const err = constructionError(config);
      expect(err, config.adyenEnvironment).toMatchObject({ code: "invalid_request", retryable: false });
      expect((err as Error).message).toMatch(message);
    }
  });
});

describe("AdyenClientAdapter error names", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("classifies an Adyen Web error by its name before its message", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const reported: Array<{ code: string; retryable: boolean }> = [];
    await adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN, onError: (err) => reported.push(err) });
    const onError = fake.checkoutConfigs[0]!["onError"] as (err: unknown) => void;
    // In live, a NETWORK_ERROR carries the API's own message, which need not read as a network failure.
    onError(adyenError("NETWORK_ERROR", "Invalid Merchant Account"));
    onError(adyenError("SCRIPT_ERROR", "Unable to find script container node: #payment"));
    onError(adyenError("IMPLEMENTATION_ERROR", 'Resources module: "environmentsUrls.cdn" is not a valid URL'));
    // The generic ERROR says nothing by its name, so its message still decides.
    onError(adyenError("ERROR", "secured field iframes have failed to load"));
    onError(adyenError("ERROR", "secured fields have failed to configure"));
    expect(reported.map(({ code, retryable }) => ({ code, retryable }))).toEqual([
      { code: "psp_unavailable", retryable: true },
      { code: "psp_unavailable", retryable: true },
      { code: "invalid_request", retryable: false },
      { code: "psp_unavailable", retryable: true },
      { code: "invalid_card_data", retryable: false },
    ]);
  });

  it("rejects a mount Adyen Web refuses as an implementation error with invalid_request", async () => {
    stubBrowser();
    const fake = makeFakeAdyenWeb();
    fake.AdyenWeb = {
      AdyenCheckout: async () => {
        throw adyenError("IMPLEMENTATION_ERROR", "You must specify a countryCode when initializing checkout.");
      },
      Card: class {},
    };
    const { adapter } = makeAdapter(fake);
    let reported: unknown;
    await expect(
      adapter.mount(fakeContainer(), { clientSecret: SESSION_TOKEN, onError: (err) => (reported = err) }),
    ).rejects.toMatchObject({ code: "invalid_request", retryable: false });
    expect(reported).toMatchObject({ code: "invalid_request" });
  });
});
