import { afterEach, describe, expect, it, vi } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import { runClientAdapterConformanceTests } from "@payfanout/conformance";
import {
  decodeSessionPayload,
  PaysafeClientAdapter,
  type PaysafeFieldsInstanceLike,
  type PaysafeJsLike,
} from "../src/index.js";

function sessionToken(payload: object): string {
  return `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fake-signature`;
}

const TOKEN = sessionToken({ v: 1, amount: 2500, currency: "EUR", merchantAccountId: "acct-EUR", id: "order-1" });

function makeFakePaysafe(tokenizeImpl?: PaysafeFieldsInstanceLike["tokenize"]): PaysafeJsLike & {
  setupCalls: Array<{ apiKey: string; options: Record<string, unknown> }>;
  tokenizeCalls: Record<string, unknown>[];
} {
  const fake = {
    setupCalls: [] as Array<{ apiKey: string; options: Record<string, unknown> }>,
    tokenizeCalls: [] as Record<string, unknown>[],
    fields: {
      setup: async (apiKey: string, options: Record<string, unknown>) => {
        fake.setupCalls.push({ apiKey, options });
        return {
          tokenize: async (opts: Record<string, unknown>) => {
            fake.tokenizeCalls.push(opts);
            return tokenizeImpl ? tokenizeImpl(opts) : { token: "SPtok_handle_1" };
          },
        };
      },
    },
  };
  return fake as never;
}

function makeAdapter(fake = makeFakePaysafe()): { adapter: PaysafeClientAdapter; fake: typeof fake } {
  const adapter = new PaysafeClientAdapter({
    apiKey: "cHVibGljOmtleQ==",
    environment: "sandbox",
    getPaysafeGlobal: () => fake,
    loadScript: async () => {},
  });
  return { adapter, fake };
}

function stubBrowser(): { appended: Array<{ id: string }> } {
  const appended: Array<{ id: string }> = [];
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    createElement: () => {
      const el = { id: "", remove: vi.fn() };
      return el;
    },
  });
  return { appended };
}

interface FakeChild {
  id: string;
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

runClientAdapterConformanceTests("paysafe", () => makeAdapter().adapter, {
  expectedMethodTypes: ["card", "paysafecard", "skrill"],
});

describe("PaysafeClientAdapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("decodes the session payload half without needing the signing key", () => {
    const payload = decodeSessionPayload(TOKEN);
    expect(payload).toMatchObject({ amount: 2500, currency: "EUR", merchantAccountId: "acct-EUR" });
    expect(() => decodeSessionPayload("garbage")).toThrowError(/not a Paysafe session context/);
  });

  it("mounts hosted fields into generated child containers", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const container = fakeContainer();
    let ready = false;
    await adapter.mount(container, { clientSecret: TOKEN, onReady: () => (ready = true) });
    expect(container.children).toHaveLength(3); // number / expiry / cvv hosts
    expect(ready).toBe(true);
    const setup = fake.setupCalls[0]!;
    expect(setup.options["environment"]).toBe("TEST");
    expect(setup.options["currencyCode"]).toBe("EUR"); // Paysafe.js 9055s without it
    expect(setup.options["accountId"]).toBe("acct-EUR");
    expect(Object.keys(setup.options["fields"] as object)).toEqual(["cardNumber", "expiryDate", "cvv"]);
  });

  it("confirm() tokenizes with the session's amount/currency and returns the tokenize-first shape (§4a)", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const handle = await adapter.mount(fakeContainer(), { clientSecret: TOKEN });
    const result = await adapter.confirm(handle);
    expect(result).toEqual({ status: "requires_confirmation", clientToken: "SPtok_handle_1" });
    expect(fake.tokenizeCalls[0]).toMatchObject({
      transactionType: "PAYMENT",
      paymentType: "CARD",
      amount: 2500,
      currencyCode: "EUR",
      accountId: "acct-EUR",
      merchantRefNum: "order-1",
    });
  });

  it("maps tokenize failures to unified errors with raw preserved", async () => {
    stubBrowser();
    const declined = { error: { code: "9003", message: "Invalid card number" } };
    const fake = makeFakePaysafe(async () => {
      throw declined;
    });
    const { adapter } = makeAdapter(fake);
    const handle = await adapter.mount(fakeContainer(), { clientSecret: TOKEN });
    const result = await adapter.confirm(handle);
    expect(result.status).toBe("failed");
    expect(result.clientToken).toBeUndefined();
    expect(result.error?.code).toBe("invalid_card_data");
    expect(result.error?.raw).toBe(declined);
    expect(isPayFanoutError(result.error)).toBe(true);
  });

  it("cleans up its generated containers on unmount", async () => {
    stubBrowser();
    const { adapter } = makeAdapter();
    const container = fakeContainer();
    const handle = await adapter.mount(container, { clientSecret: TOKEN });
    adapter.unmount(handle);
    for (const child of container.children) {
      expect(child.remove).toHaveBeenCalled();
    }
  });

  it("rejects mount during SSR and foreign handles", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.mount({} as HTMLElement, { clientSecret: TOKEN })).rejects.toThrowError(/browser-only/);
    await expect(adapter.confirm({} as never)).rejects.toThrowError(/not produced by PaysafeClientAdapter/);
  });
});
