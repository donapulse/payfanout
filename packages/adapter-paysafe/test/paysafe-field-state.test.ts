import { afterEach, describe, expect, it, vi } from "vitest";
import type { FieldsChangeState } from "@payfanout/core";
import { PaysafeClientAdapter, type PaysafeFieldsInstanceLike, type PaysafeJsLike } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

const TOKEN = `${Buffer.from(JSON.stringify({ v: 1, amount: 2500, currency: "EUR" })).toString("base64url")}.sig`;

function stubBrowser(): void {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    createElement: () => ({ id: "", remove: vi.fn() }),
  });
}

function fakeContainer(): HTMLElement {
  return { appendChild: () => {} } as never;
}

/** Instance with a controllable per-field event surface. */
function eventfulInstance(options: { withAreAllFieldsValid?: boolean } = {}): {
  instance: PaysafeFieldsInstanceLike;
  fire: (field: string, kind: "valid" | "invalid") => void;
  setAllValid: (value: boolean) => void;
} {
  const handlers = new Map<string, { valid?: () => void; invalid?: () => void }>();
  let allValid = false;
  const instance: PaysafeFieldsInstanceLike = {
    tokenize: async () => ({ token: "SPtok_1" }),
    ...(options.withAreAllFieldsValid !== false ? { areAllFieldsValid: () => allValid } : {}),
    fields: (selector: string) => ({
      valid: (handler: (...args: unknown[]) => void) => {
        handlers.set(selector, { ...handlers.get(selector), valid: handler as () => void });
      },
      invalid: (handler: (...args: unknown[]) => void) => {
        handlers.set(selector, { ...handlers.get(selector), invalid: handler as () => void });
      },
    }),
  };
  return {
    instance,
    fire: (field, kind) => handlers.get(field)?.[kind]?.(),
    setAllValid: (value) => {
      allValid = value;
    },
  };
}

function adapterFor(instance: PaysafeFieldsInstanceLike): PaysafeClientAdapter {
  const paysafe: PaysafeJsLike = { fields: { setup: async () => instance } };
  return new PaysafeClientAdapter({
    apiKey: "cHVibGljOmtleQ==",
    environment: "sandbox",
    getPaysafeGlobal: () => paysafe,
    loadScript: async () => {},
  });
}

describe("Paysafe field-state events", () => {
  it("initializes onChange with { complete: false } and follows the SDK's areAllFieldsValid verdict", async () => {
    stubBrowser();
    const { instance, fire, setAllValid } = eventfulInstance();
    const changes: FieldsChangeState[] = [];
    await adapterFor(instance).mount(fakeContainer(), {
      clientSecret: TOKEN,
      onChange: (state) => changes.push(state),
    });
    expect(changes).toEqual([{ complete: false, empty: true }]);

    setAllValid(true);
    fire("cvv", "valid");
    expect(changes.at(-1)).toEqual({ complete: true });

    setAllValid(false);
    fire("cardNumber", "invalid");
    expect(changes.at(-1)).toEqual({ complete: false });
  });

  it("tracks per-field validity itself when the SDK lacks areAllFieldsValid", async () => {
    stubBrowser();
    const { instance, fire } = eventfulInstance({ withAreAllFieldsValid: false });
    const changes: FieldsChangeState[] = [];
    await adapterFor(instance).mount(fakeContainer(), {
      clientSecret: TOKEN,
      onChange: (state) => changes.push(state),
    });

    fire("cardNumber", "valid");
    fire("expiryDate", "valid");
    expect(changes.at(-1)).toEqual({ complete: false }); // cvv still unknown
    fire("cvv", "valid");
    expect(changes.at(-1)).toEqual({ complete: true });
    fire("expiryDate", "invalid");
    expect(changes.at(-1)).toEqual({ complete: false });
  });

  it("degrades gracefully: no event surface, or a throwing one, never breaks mount", async () => {
    stubBrowser();
    const bare: PaysafeFieldsInstanceLike = { tokenize: async () => ({ token: "SPtok_1" }) };
    const changes: FieldsChangeState[] = [];
    await adapterFor(bare).mount(fakeContainer(), {
      clientSecret: TOKEN,
      onChange: (state) => changes.push(state),
    });
    expect(changes).toEqual([{ complete: false, empty: true }]); // initialized, then silent

    const hostile: PaysafeFieldsInstanceLike = {
      tokenize: async () => ({ token: "SPtok_1" }),
      fields: () => {
        throw new Error("SDK variation");
      },
    };
    await expect(
      adapterFor(hostile).mount(fakeContainer(), { clientSecret: TOKEN, onChange: () => {} }),
    ).resolves.toBeDefined();
  });

  it("skips event registration entirely when the host passes no onChange", async () => {
    stubBrowser();
    let registrations = 0;
    const instance: PaysafeFieldsInstanceLike = {
      tokenize: async () => ({ token: "SPtok_1" }),
      fields: () => {
        registrations += 1;
        return {};
      },
    };
    await adapterFor(instance).mount(fakeContainer(), { clientSecret: TOKEN });
    expect(registrations).toBe(0);
  });
});
