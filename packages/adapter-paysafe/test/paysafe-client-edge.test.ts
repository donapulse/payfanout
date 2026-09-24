import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeSessionPayload, PaysafeClientAdapter, type PaysafeJsLike } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

function stubBrowser(): void {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    createElement: () => ({ id: "", remove: vi.fn() }),
  });
}

function fakeContainer(): HTMLElement {
  return { children: [], appendChild() {} } as never;
}

const TOKEN = `${Buffer.from(JSON.stringify({ v: 1, amount: 100, currency: "USD" })).toString("base64url")}.sig`;

function adapterWith(tokenize: () => Promise<{ token: string }>): PaysafeClientAdapter {
  const fake: PaysafeJsLike = {
    fields: { setup: async () => ({ tokenize }) },
  };
  return new PaysafeClientAdapter({
    apiKey: "a2V5",
    environment: "sandbox",
    getPaysafeGlobal: () => fake,
    loadScript: async () => {},
  });
}

describe("PaysafeClientAdapter edge cases", () => {
  it("validates its config eagerly", () => {
    expect(() => new PaysafeClientAdapter({ apiKey: "", environment: "sandbox" })).toThrowError(/apiKey/);
    expect(
      () => new PaysafeClientAdapter({ apiKey: "k", environment: "prod" as never }),
    ).toThrowError(/sandbox.*live/);
  });

  it("loadSdk rejects during SSR and when the global never appears", async () => {
    const noDom = new PaysafeClientAdapter({ apiKey: "k", environment: "sandbox" });
    await expect(noDom.loadSdk()).rejects.toThrowError(/browser-only/);

    stubBrowser();
    const adapter = new PaysafeClientAdapter({
      apiKey: "k",
      environment: "sandbox",
      loadScript: async () => {},
      getPaysafeGlobal: () => undefined,
    });
    await expect(adapter.loadSdk()).rejects.toMatchObject({ code: "psp_unavailable" });
  });

  it("retries the SDK injection after a failed script load instead of caching the rejection", async () => {
    stubBrowser();
    const failure = new Error("network hiccup");
    let paysafe: PaysafeJsLike | undefined;
    let loads = 0;
    const adapter = new PaysafeClientAdapter({
      apiKey: "k",
      environment: "sandbox",
      getPaysafeGlobal: () => paysafe,
      loadScript: async () => {
        loads++;
        if (loads === 1) throw failure;
        paysafe = {} as PaysafeJsLike;
      },
    });
    // Concurrent calls share the one load, and its rejection surfaces unchanged.
    const first = adapter.loadSdk();
    const second = adapter.loadSdk();
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(loads).toBe(1);
    await expect(adapter.loadSdk()).resolves.toBeUndefined();
    expect(loads).toBe(2);
  });

  it("loads the SDK again after a load that left the paysafe global missing", async () => {
    stubBrowser();
    let paysafe: PaysafeJsLike | undefined;
    let loads = 0;
    const adapter = new PaysafeClientAdapter({
      apiKey: "k",
      environment: "sandbox",
      getPaysafeGlobal: () => paysafe,
      loadScript: async () => {
        loads++;
        if (loads === 2) paysafe = {} as PaysafeJsLike;
      },
    });
    await expect(adapter.loadSdk()).rejects.toMatchObject({
      code: "psp_unavailable",
      message: "Paysafe.js loaded but the paysafe global is missing",
      retryable: true,
    });
    await expect(adapter.loadSdk()).resolves.toBeUndefined();
    expect(loads).toBe(2);
  });

  it("decodeSessionPayload rejects payloads missing amount/currency", () => {
    const bad = `${Buffer.from(JSON.stringify({ v: 1, note: "no money fields" })).toString("base64url")}.sig`;
    expect(() => decodeSessionPayload(bad)).toThrowError(/missing amount\/currency/);
  });

  it("treats a tokenize resolving without a token as a failure, not a success", async () => {
    stubBrowser();
    const adapter = adapterWith(async () => ({ token: "" }));
    const handle = await adapter.mount(fakeContainer(), { clientSecret: TOKEN });
    const result = await adapter.confirm(handle);
    expect(result.status).toBe("failed");
    expect(result.clientToken).toBeUndefined();
    expect(result.error?.code).toBe("processing_error");
  });

  it("maps 3DS-incomplete tokenize errors to authentication_required", async () => {
    stubBrowser();
    const adapter = adapterWith(async () => {
      throw { error: { code: 9201, message: "3DS not completed" } };
    });
    const handle = await adapter.mount(fakeContainer(), { clientSecret: TOKEN });
    const result = await adapter.confirm(handle);
    expect(result.error?.code).toBe("authentication_required");
  });

  it("cleans up its created field hosts when fields.setup itself fails", async () => {
    stubBrowser();
    const created: Array<{ remove: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const el = { id: "", remove: vi.fn() };
        created.push(el);
        return el;
      },
    });
    const failing = new PaysafeClientAdapter({
      apiKey: "k",
      environment: "sandbox",
      getPaysafeGlobal: () => ({
        fields: {
          setup: async () => {
            throw { error: { code: 9125, message: "SDK internal error" } };
          },
        },
      }),
      loadScript: async () => {},
    });
    const onError = vi.fn();
    await expect(
      failing.mount(fakeContainer(), { clientSecret: TOKEN, onError }),
    ).rejects.toMatchObject({ code: "psp_unavailable" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(3);
    for (const el of created) expect(el.remove).toHaveBeenCalled(); // no orphaned DOM
  });

  it("honors a per-account capability override", () => {
    const adapter = new PaysafeClientAdapter({
      apiKey: "k",
      environment: "sandbox",
      paymentMethods: [
        { type: "card", flow: "embedded", supported: true },
        { type: "paysafecard", flow: "voucher_code", supported: true },
      ],
    });
    expect(adapter.listPaymentMethodCapabilities()).toHaveLength(2);
  });
});
