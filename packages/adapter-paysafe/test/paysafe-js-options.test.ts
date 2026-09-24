import { afterEach, describe, expect, it, vi } from "vitest";
import type { FieldsChangeState } from "@payfanout/core";
import { PaysafeClientAdapter } from "../src/index.js";
import { createFakePaysafeJs, paysafeJsError, type FakePaysafeJs } from "./fake-paysafe-js.js";

afterEach(() => vi.unstubAllGlobals());

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

function sessionToken(payload: Record<string, unknown>): string {
  const json = JSON.stringify({ v: 1, amount: 2500, currency: "EUR", ...payload });
  return `${Buffer.from(json).toString("base64url")}.sig`;
}

function stubBrowser(): Array<{ id: string; remove: ReturnType<typeof vi.fn> }> {
  const created: Array<{ id: string; remove: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    createElement: () => {
      const el = { id: "", remove: vi.fn() };
      created.push(el);
      return el;
    },
  });
  return created;
}

function fakeContainer(): HTMLElement {
  return { appendChild() {} } as never;
}

function adapterFor(fake: FakePaysafeJs): PaysafeClientAdapter {
  return new PaysafeClientAdapter({
    apiKey: "cHVibGljOmtleQ==",
    environment: "sandbox",
    getPaysafeGlobal: () => fake,
    loadScript: async () => {},
  });
}

async function tokenizedRefNums(sessionId: string | undefined, attempts = 1): Promise<string[]> {
  stubBrowser();
  const fake = createFakePaysafeJs();
  const adapter = adapterFor(fake);
  const handle = await adapter.mount(fakeContainer(), {
    clientSecret: sessionToken(sessionId === undefined ? {} : { id: sessionId }),
  });
  for (let i = 0; i < attempts; i++) {
    expect(await adapter.confirm(handle)).toMatchObject({ status: "requires_confirmation" });
  }
  return fake.tokenizeCalls.map((call) => call["merchantRefNum"] as string);
}

describe("Paysafe.js tokenize merchantRefNum", () => {
  it("sends one even when the session has no id, since Paysafe.js rejects a tokenize without it", async () => {
    stubBrowser();
    const fake = createFakePaysafeJs();
    const instance = await fake.fields.setup("key", {});
    await expect(
      instance.tokenize({ amount: 2500, transactionType: "PAYMENT", paymentType: "CARD" }),
    ).rejects.toMatchObject({ code: "9003", fieldErrors: [{ field: "options.merchantRefNum" }] });

    const [refNum] = await tokenizedRefNums(undefined);
    expect(refNum).toMatch(new RegExp(`^${UUID.source}$`));
  });

  it("sends a fresh one on every attempt, so a card retried after a decline is a new transaction", async () => {
    const [first, second] = await tokenizedRefNums("order-1", 2);
    expect(first).toMatch(new RegExp(`^order-1-${UUID.source}$`));
    expect(second).toMatch(new RegExp(`^order-1-${UUID.source}$`));
    expect(second).not.toBe(first);
  });

  it("keeps the session id as a prefix, cut so the whole never exceeds 255 characters", async () => {
    const [long] = await tokenizedRefNums("x".repeat(300));
    expect(long).toHaveLength(255);
    expect(long).toMatch(new RegExp(`^x{218}-${UUID.source}$`));

    // The cut never leaves the first half of a surrogate pair behind.
    const [astral] = await tokenizedRefNums(`${"a".repeat(217)}\u{1F600}tail`);
    expect(astral).toMatch(new RegExp(`^a{217}-${UUID.source}$`));
  });

  it("drops the characters Paysafe rejects in any parameter from the prefix", async () => {
    const [cleaned] = await tokenizedRefNums('order["42"];');
    expect(cleaned).toMatch(new RegExp(`^order42-${UUID.source}$`));
    const [bare] = await tokenizedRefNums("[*]");
    expect(bare).toMatch(new RegExp(`^${UUID.source}$`));
    // The rest of the documented set: ^ < and the backslash.
    const [others] = await tokenizedRefNums(`a^b<c${String.fromCharCode(92)}d`);
    expect(others).toMatch(new RegExp(`^abcd-${UUID.source}$`));
  });

  it("draws the random part from getRandomValues where randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0xab),
    });
    const [refNum] = await tokenizedRefNums("order-1");
    expect(refNum).toBe(`order-1-${"ab".repeat(16)}`);
  });
});

describe("Paysafe.js setup accounts.default", () => {
  it("preselects the session's merchant account as a number, in place of the undocumented accountId", async () => {
    stubBrowser();
    const fake = createFakePaysafeJs();
    const adapter = adapterFor(fake);
    const handle = await adapter.mount(fakeContainer(), {
      clientSecret: sessionToken({ merchantAccountId: "1001234567" }),
    });
    const setup = fake.setupCalls[0]!.options;
    expect(setup["accounts"]).toEqual({ default: 1001234567 });
    expect(setup).not.toHaveProperty("accountId");
    // Tokenize keeps its own documented accountId.
    await adapter.confirm(handle);
    expect(fake.tokenizeCalls[0]!["accountId"]).toBe(1001234567);
  });

  it("sends none when the session names no merchant account", async () => {
    stubBrowser();
    const fake = createFakePaysafeJs();
    await adapterFor(fake).mount(fakeContainer(), { clientSecret: sessionToken({}) });
    expect(fake.setupCalls[0]!.options).not.toHaveProperty("accounts");
  });
});

describe("Paysafe.js show()", () => {
  it("calls it even after a single-method setup that ran it already, and the repeat is harmless", async () => {
    stubBrowser();
    const fake = createFakePaysafeJs();
    const adapter = adapterFor(fake);
    const handle = await adapter.mount(fakeContainer(), { clientSecret: sessionToken({ id: "order-1" }) });
    expect(fake.showCalls).toBe(2); // the SDK's own call inside setup, then the adapter's
    await expect(adapter.confirm(handle)).resolves.toEqual({
      status: "requires_confirmation",
      clientToken: "SPtok_handle_1",
    });
  });

  it("calls it when setup leaves the instance locked, so tokenize and the field events work", async () => {
    stubBrowser();
    const fake = createFakePaysafeJs({ autoShow: false });
    const adapter = adapterFor(fake);
    const changes: FieldsChangeState[] = [];
    const onReady = vi.fn();
    const handle = await adapter.mount(fakeContainer(), {
      clientSecret: sessionToken({ id: "order-1" }),
      onReady,
      onChange: (state) => changes.push(state),
    });
    expect(fake.showCalls).toBe(1);
    expect(onReady).toHaveBeenCalledOnce();

    for (const field of ["cardNumber", "expiryDate", "cvv"]) fake.fire(field, "valid");
    expect(changes.at(-1)).toEqual({ complete: true });

    await expect(adapter.confirm(handle)).resolves.toEqual({
      status: "requires_confirmation",
      clientToken: "SPtok_handle_1",
    });
  });

  it("fails the mount with the card method's error when show() reports one", async () => {
    const created = stubBrowser();
    const cardError = paysafeJsError("9028", "Failed to initialize Paysafe.js iframes.");
    const fake = createFakePaysafeJs({
      autoShow: false,
      paymentMethods: { card: { error: cardError }, googlePay: {} },
    });
    const onError = vi.fn();
    const onReady = vi.fn();
    const mounting = adapterFor(fake).mount(fakeContainer(), {
      clientSecret: sessionToken({}),
      onError,
      onReady,
    });
    await expect(mounting).rejects.toMatchObject({ pspName: "paysafe", raw: cardError });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBe(await mounting.catch((err: unknown) => err));
    expect(onReady).not.toHaveBeenCalled();
    expect(created).toHaveLength(3);
    for (const el of created) expect(el.remove).toHaveBeenCalled();
  });

  it("fails the mount when show() itself rejects because no method initialized", async () => {
    const created = stubBrowser();
    const cardError = paysafeJsError("9073", "Account not configured correctly.");
    const fake = createFakePaysafeJs({ autoShow: false, paymentMethods: { card: { error: cardError } } });
    await expect(adapterFor(fake).mount(fakeContainer(), { clientSecret: sessionToken({}) })).rejects.toMatchObject({
      pspName: "paysafe",
      raw: cardError,
    });
    for (const el of created) expect(el.remove).toHaveBeenCalled();
  });
});
