import { afterEach, describe, expect, it, vi } from "vitest";
import type { FieldsChangeState } from "@payfanout/core";
import { WorldlineClientAdapter } from "../src/index.js";

interface ConstructedTokenizer {
  url: string;
  containerId: string;
  config: Record<string, unknown>;
}

interface FakeTokenizer {
  Tokenizer: unknown;
  constructed: ConstructedTokenizer[];
  /**
   * What the served Tokenizer script does on every "form-status-updated"
   * message from the iframe: call `options.validationCallback` with the
   * reported status, the options object as `this`.
   */
  reportFormStatus(status: unknown): void;
}

function makeFakeTokenizer(events: string[] = []): FakeTokenizer {
  const fake: FakeTokenizer = {
    Tokenizer: undefined,
    constructed: [],
    reportFormStatus(status) {
      const config = fake.constructed[0]!.config;
      (config["validationCallback"] as ((status: unknown) => void) | undefined)?.call(config, status);
    },
  };
  fake.Tokenizer = function Tokenizer(url: string, containerId: string, config?: Record<string, unknown>) {
    events.push("construct");
    fake.constructed.push({ url, containerId, config: config ?? {} });
    return {
      initialize: async () => {},
      submitTokenization: async () => ({ success: true, hostedTokenizationId: "htp_123" }),
    };
  };
  return fake;
}

function makeAdapter(fake: FakeTokenizer): WorldlineClientAdapter {
  return new WorldlineClientAdapter({
    environment: "sandbox",
    getWorldlineGlobal: () => fake.Tokenizer as never,
    loadScript: async () => {},
  });
}

function stubBrowser(): void {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    createElement: () => ({ id: "", remove: vi.fn() }),
  });
}

function fakeContainer(): HTMLElement {
  return { appendChild: () => {} } as never;
}

const URL_SECRET = "https://payment.preprod.direct.worldline-solutions.com/hostedtokenization/htp_9";

describe("WorldlineClientAdapter Tokenizer options", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the cardholder-name field by default", async () => {
    stubBrowser();
    const fake = makeFakeTokenizer();
    await makeAdapter(fake).mount(fakeContainer(), { clientSecret: URL_SECRET });
    expect(fake.constructed[0]!.config["hideCardholderName"]).toBe(false);
  });

  it("keeps the name field visible when the host passes hideCardholderName: undefined", async () => {
    stubBrowser();
    const fake = makeFakeTokenizer();
    await makeAdapter(fake).mount(fakeContainer(), {
      clientSecret: URL_SECRET,
      fieldOptions: { hideCardholderName: undefined },
    });
    expect(fake.constructed[0]!.config["hideCardholderName"]).toBe(false);
  });

  it("lets the host's hideCardholderName override the default", async () => {
    stubBrowser();
    const fake = makeFakeTokenizer();
    await makeAdapter(fake).mount(fakeContainer(), {
      clientSecret: URL_SECRET,
      fieldOptions: { hideCardholderName: true },
    });
    expect(fake.constructed[0]!.config["hideCardholderName"]).toBe(true);
  });

  it("fires the initial state before the Tokenizer exists and keeps it until a report arrives", async () => {
    stubBrowser();
    const events: string[] = [];
    const fake = makeFakeTokenizer(events);
    const changes: FieldsChangeState[] = [];
    await makeAdapter(fake).mount(fakeContainer(), {
      clientSecret: URL_SECRET,
      onChange: (state) => {
        events.push("change");
        changes.push(state);
      },
    });
    expect(events).toEqual(["change", "construct"]);
    expect(changes).toEqual([{ complete: false, empty: true }]);
  });

  it("turns each validity report into onChange", async () => {
    stubBrowser();
    const fake = makeFakeTokenizer();
    const changes: FieldsChangeState[] = [];
    await makeAdapter(fake).mount(fakeContainer(), { clientSecret: URL_SECRET, onChange: (s) => changes.push(s) });
    fake.reportFormStatus({ valid: true });
    fake.reportFormStatus({ valid: false });
    expect(changes).toEqual([{ complete: false, empty: true }, { complete: true }, { complete: false }]);
  });

  it("reads a report without a boolean valid as incomplete", async () => {
    stubBrowser();
    const fake = makeFakeTokenizer();
    const changes: FieldsChangeState[] = [];
    await makeAdapter(fake).mount(fakeContainer(), { clientSecret: URL_SECRET, onChange: (s) => changes.push(s) });
    fake.reportFormStatus(undefined);
    fake.reportFormStatus({});
    fake.reportFormStatus({ valid: "true" });
    expect(changes.slice(1)).toEqual([{ complete: false }, { complete: false }, { complete: false }]);
  });

  it("keeps validationCallback adapter-owned and still calls the host's with the same result", async () => {
    stubBrowser();
    const fake = makeFakeTokenizer();
    const events: string[] = [];
    const hostCallback = vi.fn((_status: unknown) => {
      events.push("host");
    });
    await makeAdapter(fake).mount(fakeContainer(), {
      clientSecret: URL_SECRET,
      fieldOptions: { validationCallback: hostCallback },
      onChange: (state) => events.push(`change:${state.complete}`),
    });
    expect(fake.constructed[0]!.config["validationCallback"]).not.toBe(hostCallback);
    const status = { valid: true };
    fake.reportFormStatus(status);
    expect(hostCallback).toHaveBeenCalledTimes(1);
    expect(hostCallback.mock.calls[0]![0]).toBe(status);
    expect(events).toEqual(["change:false", "change:true", "host"]);
  });

  it("still calls the host's validationCallback when onChange throws", async () => {
    stubBrowser();
    const fake = makeFakeTokenizer();
    const hostCallback = vi.fn();
    let changes = 0;
    await makeAdapter(fake).mount(fakeContainer(), {
      clientSecret: URL_SECRET,
      fieldOptions: { validationCallback: hostCallback },
      onChange: () => {
        // The first call is the mount-time initial state; the report's call throws.
        if (++changes > 1) throw new Error("host onChange bug");
      },
    });
    expect(() => fake.reportFormStatus({ valid: true })).toThrowError(/host onChange bug/);
    expect(hostCallback).toHaveBeenCalledTimes(1);
    expect(hostCallback).toHaveBeenCalledWith({ valid: true });
  });

  it("ignores a validationCallback option that is not a function", async () => {
    stubBrowser();
    const fake = makeFakeTokenizer();
    const changes: FieldsChangeState[] = [];
    await makeAdapter(fake).mount(fakeContainer(), {
      clientSecret: URL_SECRET,
      fieldOptions: { validationCallback: "myValidationCallback" },
      onChange: (s) => changes.push(s),
    });
    expect(() => fake.reportFormStatus({ valid: true })).not.toThrow();
    expect(changes).toEqual([{ complete: false, empty: true }, { complete: true }]);
  });

  it("takes validity reports without an onChange", async () => {
    stubBrowser();
    const bare = makeFakeTokenizer();
    await makeAdapter(bare).mount(fakeContainer(), { clientSecret: URL_SECRET });
    expect(() => bare.reportFormStatus({ valid: true })).not.toThrow();

    const withHostCallback = makeFakeTokenizer();
    const hostCallback = vi.fn();
    await makeAdapter(withHostCallback).mount(fakeContainer(), {
      clientSecret: URL_SECRET,
      fieldOptions: { validationCallback: hostCallback },
    });
    expect(() => withHostCallback.reportFormStatus({ valid: false })).not.toThrow();
    expect(hostCallback).toHaveBeenCalledWith({ valid: false });
  });

  it("passes every other fieldOption through untouched and never mutates the host's object", async () => {
    stubBrowser();
    const fake = makeFakeTokenizer();
    const paymentProductUpdatedCallback = vi.fn();
    const validationCallback = vi.fn();
    const fieldOptions = { hideTokenFields: true, hideOptionalCvv: true, paymentProductUpdatedCallback, validationCallback };
    await makeAdapter(fake).mount(fakeContainer(), { clientSecret: URL_SECRET, fieldOptions });
    const config = fake.constructed[0]!.config;
    expect(Object.keys(config).sort()).toEqual([
      "hideCardholderName",
      "hideOptionalCvv",
      "hideTokenFields",
      "paymentProductUpdatedCallback",
      "validationCallback",
    ]);
    expect(config).toMatchObject({ hideCardholderName: false, hideTokenFields: true, hideOptionalCvv: true });
    expect(config["paymentProductUpdatedCallback"]).toBe(paymentProductUpdatedCallback);
    expect(fieldOptions).toEqual({ hideTokenFields: true, hideOptionalCvv: true, paymentProductUpdatedCallback, validationCallback });
  });
});
