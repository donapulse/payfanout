import { afterEach, describe, expect, it, vi } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import { runClientAdapterConformanceTests } from "@payfanout/conformance";
import { decodeSessionPayload, PaysafeClientAdapter } from "../src/index.js";
import { createFakePaysafeJs, type FakePaysafeJsOptions } from "./fake-paysafe-js.js";

function sessionToken(payload: object): string {
  return `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fake-signature`;
}

const TOKEN = sessionToken({ v: 1, amount: 2500, currency: "EUR", merchantAccountId: "acct-EUR", id: "order-1" });

function makeFakePaysafe(tokenize?: FakePaysafeJsOptions["tokenize"]) {
  return createFakePaysafeJs({ tokenize });
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
  expectedMethodTypes: ["card", "paysafecard", "skrill", "sepa_debit", "ach", "bacs_debit", "pad"],
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
    // Not a setup option (accounts.default is), and "acct-EUR" cannot be the
    // number that one takes.
    expect(setup.options).not.toHaveProperty("accountId");
    expect(setup.options).not.toHaveProperty("accounts");
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
      merchantRefNum: expect.stringMatching(/^order-1-/),
    });
  });

  it("coerces a digit-only merchantAccountId to the number Paysafe.js requires, but never rounds an oversized id", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    // A real per-currency account id is numeric — Paysafe.js rejects the string
    // form (setup 9061, tokenize 9003), so both must receive a number.
    const numericToken = sessionToken({ v: 1, amount: 2500, currency: "CAD", merchantAccountId: "1003178470", id: "o1" });
    const handle = await adapter.mount(fakeContainer(), { clientSecret: numericToken });
    expect(fake.setupCalls[0]!.options["accounts"]).toEqual({ default: 1003178470 });
    await adapter.confirm(handle);
    expect(fake.tokenizeCalls[0]!["accountId"]).toBe(1003178470);

    // An id too large to represent exactly stays a string — silently rounding it
    // could route the tokenize to a different merchant account. Setup takes no
    // string, so it goes without; tokenize still carries it, and Paysafe.js
    // rejects it there as the configuration error mapped further down.
    const huge = "9".repeat(20);
    const hugeHandle = await adapter.mount(fakeContainer(), {
      clientSecret: sessionToken({ v: 1, amount: 2500, currency: "CAD", merchantAccountId: huge }),
    });
    expect(fake.setupCalls[1]!.options).not.toHaveProperty("accounts");
    await adapter.confirm(hugeHandle);
    expect(fake.tokenizeCalls[1]!["accountId"]).toBe(huge);
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

  it("maps a 9003 options.* configuration failure to invalid_request, not invalid_card_data", async () => {
    stubBrowser();
    // Paysafe.js reuses 9003 for bad setup/tokenize options (e.g. accountId). The
    // cardholder must not be told a valid card is invalid.
    const configError = {
      code: "9003",
      detailedMessage: "Invalid fields: options.accountId.",
      fieldErrors: [{ message: "Invalid accountId parameter." }],
    };
    const fake = makeFakePaysafe(async () => {
      throw configError;
    });
    const { adapter } = makeAdapter(fake);
    const handle = await adapter.mount(fakeContainer(), { clientSecret: TOKEN });
    const result = await adapter.confirm(handle);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invalid_request");
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.message).toBe("The payment request was invalid.");
    expect(result.error?.raw).toBe(configError);
  });

  it("keeps a genuine 9003 card-field failure as invalid_card_data", async () => {
    stubBrowser();
    const cardError = { code: "9003", detailedMessage: "Invalid fields: card number." };
    const fake = makeFakePaysafe(async () => {
      throw cardError;
    });
    const { adapter } = makeAdapter(fake);
    const handle = await adapter.mount(fakeContainer(), { clientSecret: TOKEN });
    const result = await adapter.confirm(handle);
    expect(result.error?.code).toBe("invalid_card_data");
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
