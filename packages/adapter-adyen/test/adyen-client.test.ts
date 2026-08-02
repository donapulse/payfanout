import { afterEach, describe, expect, it, vi } from "vitest";
import { isPayFanoutError, type ClientPaymentAdapter } from "@payfanout/core";
import { runClientAdapterConformanceTests } from "@payfanout/conformance";
import { AdyenClientAdapter, ADYEN_WEB_VERSION, type AdyenCardState } from "../src/index.js";

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
      type: "scheme",
      encryptedCardNumber: "test_4111111111111111",
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

  it("resolves an action that throws inside the SDK as a unified failure", async () => {
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
    expect(result.error?.code).toBe("invalid_card_data");
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
        const element: Record<string, unknown> = { tag, id: "", remove: vi.fn() };
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

    // A second adapter finds the link already in the document and skips it.
    existing = links[0];
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
    expect(links).toHaveLength(1);
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
