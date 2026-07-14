import { afterEach, describe, expect, it, vi } from "vitest";
import { isPayFanoutError, type ClientPaymentAdapter } from "@payfanout/core";
import { runClientAdapterConformanceTests } from "@payfanout/conformance";
import {
  WorldlineClientAdapter,
  type WorldlineTokenizerResult,
} from "../src/index.js";

interface FakeTokenizer {
  Tokenizer: unknown;
  constructed: Array<{ url: string; containerId: string; config: Record<string, unknown> | undefined }>;
  initialized: number;
  submitted: number;
  destroyed: number;
}

function makeFakeTokenizer(submitImpl?: () => WorldlineTokenizerResult): FakeTokenizer {
  const state: FakeTokenizer = { Tokenizer: undefined, constructed: [], initialized: 0, submitted: 0, destroyed: 0 };
  state.Tokenizer = function Tokenizer(url: string, containerId: string, config?: Record<string, unknown>) {
    state.constructed.push({ url, containerId, config });
    return {
      initialize: async () => {
        state.initialized++;
      },
      submitTokenization: async () => {
        state.submitted++;
        return submitImpl ? submitImpl() : { success: true, hostedTokenizationId: "htp_123" };
      },
      destroy: () => {
        state.destroyed++;
      },
    };
  };
  return state;
}

function makeAdapter(fake = makeFakeTokenizer()): { adapter: WorldlineClientAdapter; fake: FakeTokenizer } {
  const adapter = new WorldlineClientAdapter({
    environment: "sandbox",
    getWorldlineGlobal: () => fake.Tokenizer as never,
    loadScript: async () => {},
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
    appendChild(el: { id: string; remove: ReturnType<typeof vi.fn> }) {
      container.children.push(el);
    },
  };
  return container as never;
}

const URL_SECRET = "https://payment.preprod.direct.worldline-solutions.com/hostedtokenization/htp_9";

runClientAdapterConformanceTests("worldline", () => makeAdapter().adapter, { expectedMethodTypes: ["card"] });

describe("WorldlineClientAdapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mounts the hosted tokenization iframe from the session's clientSecret", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const container = fakeContainer();
    let ready = false;
    let firstChange: { complete: boolean } | undefined;
    await adapter.mount(container, {
      clientSecret: URL_SECRET,
      onReady: () => (ready = true),
      onChange: (state) => (firstChange ??= state),
    });
    expect(container.children).toHaveLength(1);
    expect(ready).toBe(true);
    expect(firstChange).toEqual({ complete: false, empty: true }); // initialize button state, degrade gracefully
    expect(fake.initialized).toBe(1);
    const constructed = fake.constructed[0]!;
    expect(constructed.url).toBe(URL_SECRET);
    expect(constructed.containerId).toMatch(/^payfanout-wl-\d+$/);
  });

  it("forwards fieldOptions to the Tokenizer config untouched", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    await adapter.mount(fakeContainer(), { clientSecret: URL_SECRET, fieldOptions: { hideCardholderName: true } });
    expect(fake.constructed[0]!.config).toMatchObject({ hideCardholderName: true });
  });

  it("confirm() tokenizes and returns the tokenize-first shape with the hostedTokenizationId", async () => {
    stubBrowser();
    const { adapter } = makeAdapter();
    const handle = await adapter.mount(fakeContainer(), { clientSecret: URL_SECRET });
    const result = await adapter.confirm(handle);
    expect(result).toEqual({ status: "requires_confirmation", clientToken: "htp_123" });
  });

  it("maps a failed/empty tokenization to a unified failure with raw preserved", async () => {
    stubBrowser();
    const failure = { success: false, error: { message: "Invalid card number" } };
    const { adapter } = makeAdapter(makeFakeTokenizer(() => failure));
    const handle = await adapter.mount(fakeContainer(), { clientSecret: URL_SECRET });
    const result = await adapter.confirm(handle);
    expect(result.status).toBe("failed");
    expect(result.clientToken).toBeUndefined();
    expect(result.error?.code).toBe("invalid_card_data");
    expect(result.error?.raw).toBe(failure.error);
    expect(isPayFanoutError(result.error)).toBe(true);
  });

  it("cleans up its generated container and destroys the tokenizer on unmount", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const container = fakeContainer();
    const handle = await adapter.mount(container, { clientSecret: URL_SECRET });
    adapter.unmount(handle);
    expect(fake.destroyed).toBe(1);
    expect(container.children[0]!.remove).toHaveBeenCalled();
  });

  it("rejects mount during SSR and rejects foreign handles", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.mount({} as HTMLElement, { clientSecret: URL_SECRET })).rejects.toThrowError(/browser-only/);
    await expect(adapter.confirm({} as never)).rejects.toThrowError(/not produced by WorldlineClientAdapter/);
  });

  it("requires an explicit environment", () => {
    expect(() => new WorldlineClientAdapter({ environment: "prod" as never })).toThrowError(/sandbox.*live/);
  });

  it("retries the SDK injection after a failed script load instead of caching the rejection", async () => {
    stubBrowser();
    let tokenizer: unknown;
    let loads = 0;
    const adapter = new WorldlineClientAdapter({
      environment: "sandbox",
      getWorldlineGlobal: () => tokenizer as never,
      loadScript: async () => {
        loads++;
        if (loads === 1) throw new Error("network hiccup");
        tokenizer = makeFakeTokenizer().Tokenizer;
      },
    });
    await expect(adapter.loadSdk()).rejects.toThrowError(/hiccup/);
    await expect(adapter.loadSdk()).resolves.toBeUndefined();
    expect(loads).toBe(2);
  });

  it("lists only the embedded card method (no redirect flow, so no handleRedirectReturn needed)", () => {
    const { adapter } = makeAdapter();
    const methods = adapter.listPaymentMethodCapabilities();
    expect(methods).toEqual([{ type: "card", flow: "embedded", supported: true }]);
    // No supported redirect-flow method, so no return-trip handler is needed.
    expect((adapter as ClientPaymentAdapter).handleRedirectReturn).toBeUndefined();
  });
});
