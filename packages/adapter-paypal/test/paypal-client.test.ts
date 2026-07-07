import { afterEach, describe, expect, it, vi } from "vitest";
import { isPayFanoutError, type ConfirmResult, type FieldsChangeState } from "@payfanout/core";
import { runClientAdapterConformanceTests } from "@payfanout/conformance";
import {
  PayPalClientAdapter,
  type PayPalButtonsInstanceLike,
  type PayPalClientAdapterConfig,
  type PayPalJsLike,
} from "../src/index.js";

const ORDER_ID = "5O190127TN364715T";

interface ButtonsRecord {
  options: Record<string, unknown>;
  rendered: unknown[];
  closed: number;
}

interface FakePayPal extends PayPalJsLike {
  created: ButtonsRecord[];
  /** The wired-up callbacks of the most recent Buttons instance. */
  drive(): {
    createOrder: () => string;
    onApprove: (data?: { orderID?: string }) => void;
    onCancel: () => void;
    onError: (err: unknown) => void;
  };
}

function makeFakePayPal(overrides: { eligible?: boolean; renderError?: unknown; close?: () => Promise<void> } = {}): FakePayPal {
  const created: ButtonsRecord[] = [];
  const fake: FakePayPal = {
    created,
    drive() {
      const options = created.at(-1)!.options;
      return {
        createOrder: options["createOrder"] as () => string,
        onApprove: options["onApprove"] as (data?: { orderID?: string }) => void,
        onCancel: options["onCancel"] as () => void,
        onError: options["onError"] as (err: unknown) => void,
      };
    },
    Buttons(options: Record<string, unknown>): PayPalButtonsInstanceLike {
      const record: ButtonsRecord = { options, rendered: [], closed: 0 };
      created.push(record);
      return {
        isEligible: () => overrides.eligible ?? true,
        render: async (el) => {
          if (overrides.renderError !== undefined) throw overrides.renderError;
          record.rendered.push(el);
        },
        close:
          overrides.close ??
          (async () => {
            record.closed += 1;
          }),
      };
    },
  };
  return fake;
}

function makeAdapter(
  fake: FakePayPal = makeFakePayPal(),
  config: Partial<PayPalClientAdapterConfig> = {},
): { adapter: PayPalClientAdapter; fake: FakePayPal; loadedUrls: string[] } {
  const loadedUrls: string[] = [];
  const adapter = new PayPalClientAdapter({
    clientId: "test-client-id",
    environment: "sandbox",
    getPayPalGlobal: () => fake,
    loadScript: async (url) => {
      loadedUrls.push(url);
    },
    ...config,
  });
  return { adapter, fake, loadedUrls };
}

function stubBrowser(): void {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    createElement: () => ({ id: "", remove: vi.fn() }),
  });
}

interface FakeChild {
  remove: ReturnType<typeof vi.fn>;
}

function fakeContainer(): HTMLElement & { children: FakeChild[] } {
  const container = {
    children: [] as FakeChild[],
    appendChild(el: FakeChild) {
      container.children.push(el);
    },
  };
  return container as never;
}

runClientAdapterConformanceTests("paypal", () => makeAdapter().adapter, {
  expectedMethodTypes: ["paypal"],
});

describe("PayPalClientAdapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders Buttons into an adapter-owned wrapper and reports the initial field state", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const container = fakeContainer();
    const changes: FieldsChangeState[] = [];
    let ready = false;
    await adapter.mount(container, {
      clientSecret: ORDER_ID,
      onChange: (state) => changes.push(state),
      onReady: () => (ready = true),
    });
    expect(container.children).toHaveLength(1); // our wrapper, never host nodes
    expect(fake.created[0]!.rendered).toHaveLength(1);
    expect(ready).toBe(true);
    // Approval hasn't happened — the host's Pay button starts disabled.
    expect(changes).toEqual([{ complete: false, empty: true }]);
    expect(fake.drive().createOrder()).toBe(ORDER_ID); // the server-created order id
  });

  it("approve-then-confirm resolves immediately with the approved order id", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const changes: FieldsChangeState[] = [];
    const handle = await adapter.mount(fakeContainer(), {
      clientSecret: ORDER_ID,
      onChange: (state) => changes.push(state),
    });
    fake.drive().onApprove({ orderID: ORDER_ID });
    expect(changes.at(-1)).toEqual({ complete: true }); // gates the host's Pay button
    await expect(adapter.confirm(handle)).resolves.toEqual({
      status: "requires_confirmation",
      clientToken: ORDER_ID,
    });
  });

  it("confirm-before-approve waits for the popup outcome", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const handle = await adapter.mount(fakeContainer(), { clientSecret: ORDER_ID });
    let resolved: ConfirmResult | undefined;
    const pending = adapter.confirm(handle).then((r) => (resolved = r));
    await Promise.resolve();
    expect(resolved).toBeUndefined(); // still waiting on the buyer
    fake.drive().onApprove({ orderID: ORDER_ID });
    await pending;
    expect(resolved).toEqual({ status: "requires_confirmation", clientToken: ORDER_ID });
  });

  it("cancel resolves requires_payment_method and a fresh approval still works", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const changes: FieldsChangeState[] = [];
    const handle = await adapter.mount(fakeContainer(), {
      clientSecret: ORDER_ID,
      onChange: (state) => changes.push(state),
    });
    const first = adapter.confirm(handle);
    fake.drive().onCancel();
    await expect(first).resolves.toEqual({ status: "requires_payment_method" });
    expect(changes.at(-1)).toEqual({ complete: false });

    // The buyer clicks the PayPal button again and approves this time.
    fake.drive().onApprove({ orderID: ORDER_ID });
    await expect(adapter.confirm(handle)).resolves.toEqual({
      status: "requires_confirmation",
      clientToken: ORDER_ID,
    });
  });

  it("SDK errors resolve a waiting confirm as failed with raw preserved, else surface via onError", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const surfaced: unknown[] = [];
    const handle = await adapter.mount(fakeContainer(), {
      clientSecret: ORDER_ID,
      onError: (err) => surfaced.push(err),
    });
    const sdkError = new Error("popup blew up");

    const waiting = adapter.confirm(handle);
    fake.drive().onError(sdkError);
    const result = await waiting;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("processing_error");
    expect(result.error?.raw).toBe(sdkError);
    expect(isPayFanoutError(result.error)).toBe(true);
    expect(surfaced).toHaveLength(0); // consumed by the waiter

    fake.drive().onError(sdkError); // nobody waiting now
    expect(surfaced).toHaveLength(1);
  });

  it("an error clears a previous approval — confirm waits again", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const handle = await adapter.mount(fakeContainer(), { clientSecret: ORDER_ID });
    fake.drive().onApprove({ orderID: ORDER_ID });
    fake.drive().onError(new Error("approval invalidated"));
    let resolved: ConfirmResult | undefined;
    void adapter.confirm(handle).then((r) => (resolved = r));
    await Promise.resolve();
    expect(resolved).toBeUndefined(); // approval was cleared, back to waiting
  });

  it("unmount closes the buttons, removes only our wrapper, and resolves waiters as failed", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const container = fakeContainer();
    const handle = await adapter.mount(container, { clientSecret: ORDER_ID });
    const waiting = adapter.confirm(handle);
    adapter.unmount(handle);

    const result = await waiting; // no dangling promise
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invalid_request");
    expect(result.error?.message).toMatch(/unmounted/);
    expect(fake.created[0]!.closed).toBe(1);
    expect(container.children[0]!.remove).toHaveBeenCalled();

    // confirm() after unmount fails immediately instead of hanging.
    await expect(adapter.confirm(handle)).resolves.toMatchObject({ status: "failed" });
  });

  it("unmount tolerates a close() that rejects or throws", async () => {
    stubBrowser();
    const rejecting = makeFakePayPal({ close: () => Promise.reject(new Error("iframe gone")) });
    const { adapter } = makeAdapter(rejecting);
    const handle = await adapter.mount(fakeContainer(), { clientSecret: ORDER_ID });
    expect(() => adapter.unmount(handle)).not.toThrow();
  });

  it("forwards host style via fieldOptions and protects the lifecycle keys", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const hostCreateOrder = vi.fn(() => "EVIL-ORDER");
    await adapter.mount(fakeContainer(), {
      clientSecret: ORDER_ID,
      fieldOptions: {
        style: { layout: "horizontal", color: "blue" },
        fundingSource: "paypal",
        createOrder: hostCreateOrder, // protected — the adapter must own it
      },
    });
    const options = fake.created[0]!.options;
    expect(options["style"]).toEqual({ layout: "horizontal", color: "blue" });
    expect(options["fundingSource"]).toBe("paypal");
    expect((options["createOrder"] as () => string)()).toBe(ORDER_ID);
    expect(hostCreateOrder).not.toHaveBeenCalled();
  });

  it("falls back to options.appearance for the button style", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    await adapter.mount(fakeContainer(), { clientSecret: ORDER_ID, appearance: { layout: "vertical" } });
    expect(fake.created[0]!.options["style"]).toEqual({ layout: "vertical" });
  });

  it("rejects mount when Buttons report no eligible funding source", async () => {
    stubBrowser();
    const ineligible = makeFakePayPal({ eligible: false });
    const { adapter } = makeAdapter(ineligible);
    const container = fakeContainer();
    const surfaced: unknown[] = [];
    await expect(
      adapter.mount(container, { clientSecret: ORDER_ID, onError: (err) => surfaced.push(err) }),
    ).rejects.toThrowError(/funding/);
    expect(container.children[0]!.remove).toHaveBeenCalled(); // no orphaned wrapper
    expect(surfaced).toHaveLength(1);
  });

  it("maps render failures and cleans up the wrapper", async () => {
    stubBrowser();
    const broken = makeFakePayPal({ renderError: new Error("render exploded") });
    const { adapter } = makeAdapter(broken);
    const container = fakeContainer();
    await expect(adapter.mount(container, { clientSecret: ORDER_ID })).rejects.toMatchObject({
      code: "processing_error",
    });
    expect(container.children[0]!.remove).toHaveBeenCalled();
  });

  it("requires a clientSecret and validates foreign handles", async () => {
    stubBrowser();
    const { adapter } = makeAdapter();
    await expect(adapter.mount(fakeContainer(), { clientSecret: "" })).rejects.toThrowError(/clientSecret/);
    await expect(adapter.confirm({} as never)).rejects.toThrowError(/not produced by PayPalClientAdapter/);
  });

  it("assembles the SDK URL from load-time params and loads it once per instance", async () => {
    stubBrowser();
    const fake = makeFakePayPal();
    let loaded = 0;
    const urls: string[] = [];
    let available = false;
    const adapter = new PayPalClientAdapter({
      clientId: "test-client-id",
      environment: "sandbox",
      currency: "cad",
      locale: "fr-CA",
      intent: "authorize",
      userAction: "pay_now",
      getPayPalGlobal: () => (available ? fake : undefined),
      loadScript: async (url) => {
        loaded += 1;
        urls.push(url);
        available = true;
      },
    });
    await adapter.mount(fakeContainer(), { clientSecret: ORDER_ID });
    await adapter.mount(fakeContainer(), { clientSecret: ORDER_ID });
    expect(loaded).toBe(1); // idempotent per instance
    const url = new URL(urls[0]!);
    expect(url.origin + url.pathname).toBe("https://www.paypal.com/sdk/js");
    expect(url.searchParams.get("client-id")).toBe("test-client-id");
    expect(url.searchParams.get("currency")).toBe("CAD");
    expect(url.searchParams.get("intent")).toBe("authorize");
    expect(url.searchParams.get("commit")).toBe("true"); // pay_now captures on approval
    expect(url.searchParams.get("components")).toBe("buttons");
    expect(url.searchParams.get("locale")).toBe("fr_CA"); // SDK wants underscores
  });

  it("defaults the SDK to USD + intent=capture and honors sdkBaseUrl", async () => {
    stubBrowser();
    const fake = makeFakePayPal();
    let available = false;
    const urls: string[] = [];
    const adapter = new PayPalClientAdapter({
      clientId: "test-client-id",
      environment: "sandbox",
      sdkBaseUrl: "https://sdk.example/js",
      getPayPalGlobal: () => (available ? fake : undefined),
      loadScript: async (url) => {
        urls.push(url);
        available = true;
      },
    });
    await adapter.loadSdk();
    const url = new URL(urls[0]!);
    expect(url.origin + url.pathname).toBe("https://sdk.example/js");
    expect(url.searchParams.get("currency")).toBe("USD");
    expect(url.searchParams.get("intent")).toBe("capture");
    // Default userAction "continue": the popup's button says "Continue" and
    // PayFanout's Pay button does the capture — matching the server default.
    expect(url.searchParams.get("commit")).toBe("false");
    expect(url.searchParams.get("locale")).toBeNull();
  });

  it("fails loadSdk clearly when the script loads but the global never appears", async () => {
    stubBrowser();
    const adapter = new PayPalClientAdapter({
      clientId: "test-client-id",
      environment: "sandbox",
      getPayPalGlobal: () => undefined,
      loadScript: async () => {},
    });
    await expect(adapter.loadSdk()).rejects.toMatchObject({ code: "psp_unavailable" });
  });

  it("guards SSR on loadSdk and mount", async () => {
    const { adapter } = makeAdapter(); // no stubbed browser globals
    await expect(adapter.loadSdk()).rejects.toThrowError(/browser-only/);
    await expect(adapter.mount({} as HTMLElement, { clientSecret: ORDER_ID })).rejects.toThrowError(/browser-only/);
  });

  it("reads window.paypal when no getPayPalGlobal seam is injected", async () => {
    const fake = makeFakePayPal();
    vi.stubGlobal("window", { paypal: fake });
    vi.stubGlobal("document", { createElement: () => ({ id: "", remove: vi.fn() }) });
    const adapter = new PayPalClientAdapter({ clientId: "test-client-id", environment: "sandbox" });
    await adapter.loadSdk(); // global already present — nothing to inject
    await adapter.mount(fakeContainer(), { clientSecret: ORDER_ID });
    expect(fake.created).toHaveLength(1);
  });

  describe("built-in script injection", () => {
    interface FakeScript {
      src?: string;
      async?: boolean;
      onload?: () => void;
      onerror?: () => void;
      remove: ReturnType<typeof vi.fn>;
      id: string;
    }

    function stubDom(options: { existingScript?: boolean } = {}): { appended: FakeScript[] } {
      const appended: FakeScript[] = [];
      vi.stubGlobal("window", {});
      vi.stubGlobal("document", {
        querySelector: () => (options.existingScript ? {} : null),
        createElement: () => ({ id: "", remove: vi.fn() }) as FakeScript,
        head: {
          appendChild: (el: FakeScript) => {
            appended.push(el);
          },
        },
      });
      return { appended };
    }

    it("injects the SDK script once and resolves on load", async () => {
      const { appended } = stubDom();
      const fake = makeFakePayPal();
      let loaded = false;
      const adapter = new PayPalClientAdapter({
        clientId: "test-client-id",
        environment: "sandbox",
        getPayPalGlobal: () => (loaded ? fake : undefined),
      });
      const loading = adapter.loadSdk();
      expect(appended).toHaveLength(1);
      expect(appended[0]!.src).toContain("https://www.paypal.com/sdk/js?client-id=test-client-id");
      expect(appended[0]!.async).toBe(true);
      loaded = true;
      appended[0]!.onload!();
      await expect(loading).resolves.toBeUndefined();
    });

    it("resolves immediately when the script tag already exists", async () => {
      stubDom({ existingScript: true });
      const fake = makeFakePayPal();
      let probes = 0;
      const adapter = new PayPalClientAdapter({
        clientId: "test-client-id",
        environment: "sandbox",
        getPayPalGlobal: () => (++probes > 1 ? fake : undefined),
      });
      await expect(adapter.loadSdk()).resolves.toBeUndefined();
    });

    it("rejects with psp_unavailable when the script fails to load", async () => {
      const { appended } = stubDom();
      const adapter = new PayPalClientAdapter({
        clientId: "test-client-id",
        environment: "sandbox",
        getPayPalGlobal: () => undefined,
      });
      const loading = adapter.loadSdk();
      appended[0]!.onerror!();
      await expect(loading).rejects.toMatchObject({ code: "psp_unavailable", retryable: true });
    });
  });

  it("unmount tolerates a close() that throws synchronously", async () => {
    stubBrowser();
    const throwing = makeFakePayPal({
      close: () => {
        throw new Error("sync teardown failure");
      },
    });
    const { adapter } = makeAdapter(throwing);
    const handle = await adapter.mount(fakeContainer(), { clientSecret: ORDER_ID });
    expect(() => adapter.unmount(handle)).not.toThrow();
  });

  it("validates its config eagerly", () => {
    expect(() => new PayPalClientAdapter({ clientId: "", environment: "sandbox" })).toThrowError(/clientId/);
    expect(() => new PayPalClientAdapter({ clientId: "x", environment: "prod" as never })).toThrowError(
      /sandbox.*live/,
    );
    expect(() => new PayPalClientAdapter({ clientId: "x", environment: "sandbox", intent: "sale" as never })).toThrowError(
      /intent/,
    );
    expect(() => new PayPalClientAdapter({ clientId: "x", environment: "sandbox", currency: "US" })).toThrowError(
      /currency/i,
    );
    expect(
      () => new PayPalClientAdapter({ clientId: "x", environment: "sandbox", userAction: "PAY_NOW" as never }),
    ).toThrowError(/userAction/);
  });
});
