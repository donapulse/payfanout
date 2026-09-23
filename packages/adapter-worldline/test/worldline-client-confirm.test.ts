import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import { WorldlineClientAdapter, type WorldlineTokenizerResult } from "../src/index.js";

const URL_SECRET = "https://payment.preprod.direct.worldline-solutions.com/hostedtokenization/htp_9";

/** The exact clientToken confirm() produces for the default browser below. */
const WIRE_FORMAT =
  '{"hostedTokenizationId":"htp_123","device":{"locale":"fr-BE","timezoneOffsetUtcMinutes":"-120",' +
  '"userAgent":"Mozilla/5.0 (test)","browserData":{"colorDepth":24,"javaEnabled":false,' +
  '"javaScriptEnabled":true,"screenHeight":"1080","screenWidth":"1920"}}}';

interface FakeTokenizer {
  Tokenizer: unknown;
  submitOptions: unknown[];
}

function makeFakeTokenizer(
  submit: () => WorldlineTokenizerResult = () => ({ success: true, hostedTokenizationId: "htp_123" }),
): FakeTokenizer {
  const state: FakeTokenizer = { Tokenizer: undefined, submitOptions: [] };
  state.Tokenizer = function Tokenizer() {
    return {
      initialize: async () => {},
      submitTokenization: async (options?: unknown) => {
        state.submitOptions.push(options);
        return submit();
      },
    };
  };
  return state;
}

/** mount() needs a DOM; each test then installs the `window` confirm() reads from. */
async function mounted(fake = makeFakeTokenizer()) {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { createElement: () => ({ id: "", remove: () => {} }) });
  const adapter = new WorldlineClientAdapter({
    environment: "sandbox",
    getWorldlineGlobal: () => fake.Tokenizer as never,
    loadScript: async () => {},
  });
  const container = { appendChild: () => {} } as unknown as HTMLElement;
  const handle = await adapter.mount(container, { clientSecret: URL_SECRET });
  return { adapter, handle, fake };
}

function browser(overrides: { navigator?: unknown; screen?: unknown } = {}): void {
  vi.stubGlobal("window", {
    navigator: { language: "fr-BE", userAgent: "Mozilla/5.0 (test)", javaEnabled: () => false },
    screen: { colorDepth: 24, height: 1080, width: 1920 },
    ...overrides,
  });
}

function envelope(clientToken: string | undefined): { hostedTokenizationId?: string; device?: Record<string, unknown> } {
  expect(typeof clientToken).toBe("string");
  return JSON.parse(clientToken!) as { hostedTokenizationId?: string; device?: Record<string, unknown> };
}

describe("WorldlineClientAdapter.confirm() — 3-D Secure device data and card storage", () => {
  let timezoneOffset: MockInstance<() => number>;

  beforeEach(() => {
    timezoneOffset = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-120);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the hostedTokenizationId and the browser's device data as a JSON envelope", async () => {
    const { adapter, handle } = await mounted();
    browser();
    const result = await adapter.confirm(handle);
    expect(result).toEqual({ status: "requires_confirmation", clientToken: WIRE_FORMAT });
    expect(envelope(result.clientToken)).toEqual({
      hostedTokenizationId: "htp_123",
      device: {
        locale: "fr-BE",
        timezoneOffsetUtcMinutes: "-120",
        userAgent: "Mozilla/5.0 (test)",
        browserData: { colorDepth: 24, javaEnabled: false, javaScriptEnabled: true, screenHeight: "1080", screenWidth: "1920" },
      },
    });
  });

  it("tokenizes with storePermanently false, so Worldline keeps no token for later payments", async () => {
    const { adapter, handle, fake } = await mounted();
    browser();
    await adapter.confirm(handle);
    expect(fake.submitOptions).toEqual([{ storePermanently: false }]);
  });

  it("reports javaEnabled true only when navigator.javaEnabled() returns true", async () => {
    const cases: Array<[unknown, boolean]> = [
      [() => true, true],
      [() => false, false],
      [() => "yes", false],
      [undefined, false],
    ];
    for (const [javaEnabled, expected] of cases) {
      const { adapter, handle } = await mounted();
      browser({ navigator: { language: "fr-BE", userAgent: "Mozilla/5.0 (test)", javaEnabled } });
      const { device } = envelope((await adapter.confirm(handle)).clientToken);
      expect(device?.["browserData"]).toMatchObject({ javaEnabled: expected });
    }
  });

  it("calls navigator.javaEnabled on the navigator, as browsers require", async () => {
    const { adapter, handle } = await mounted();
    const navigatorLike = {
      language: "fr-BE",
      userAgent: "Mozilla/5.0 (test)",
      javaEnabled(this: unknown) {
        if (this !== navigatorLike) throw new TypeError("Illegal invocation");
        return true;
      },
    };
    browser({ navigator: navigatorLike });
    const { device } = envelope((await adapter.confirm(handle)).clientToken);
    expect(device?.["browserData"]).toMatchObject({ javaEnabled: true });
  });

  it("leaves javaEnabled out when navigator.javaEnabled throws, and still succeeds", async () => {
    const { adapter, handle } = await mounted();
    browser({
      navigator: {
        language: "fr-BE",
        userAgent: "Mozilla/5.0 (test)",
        javaEnabled: () => {
          throw new Error("blocked by the browser");
        },
      },
    });
    const result = await adapter.confirm(handle);
    expect(result.status).toBe("requires_confirmation");
    expect(envelope(result.clientToken).device).toEqual({
      locale: "fr-BE",
      timezoneOffsetUtcMinutes: "-120",
      userAgent: "Mozilla/5.0 (test)",
      browserData: { colorDepth: 24, javaScriptEnabled: true, screenHeight: "1080", screenWidth: "1920" },
    });
  });

  it("leaves the screen fields out when the browser exposes no screen", async () => {
    const { adapter, handle } = await mounted();
    browser({ screen: undefined });
    const result = await adapter.confirm(handle);
    expect(result.status).toBe("requires_confirmation");
    expect(envelope(result.clientToken).device).toEqual({
      locale: "fr-BE",
      timezoneOffsetUtcMinutes: "-120",
      userAgent: "Mozilla/5.0 (test)",
      browserData: { javaEnabled: false, javaScriptEnabled: true },
    });
  });

  it("leaves out every field whose read throws", async () => {
    const { adapter, handle } = await mounted();
    timezoneOffset.mockImplementation(() => {
      throw new RangeError("time zone unavailable");
    });
    browser({
      navigator: {
        get language(): string {
          throw new Error("blocked");
        },
        userAgent: "Mozilla/5.0 (test)",
        javaEnabled: () => false,
      },
      screen: {
        get colorDepth(): number {
          throw new Error("blocked");
        },
        height: 1080,
        get width(): number {
          throw new Error("blocked");
        },
      },
    });
    const result = await adapter.confirm(handle);
    expect(result.status).toBe("requires_confirmation");
    expect(envelope(result.clientToken).device).toEqual({
      userAgent: "Mozilla/5.0 (test)",
      browserData: { javaEnabled: false, javaScriptEnabled: true, screenHeight: "1080" },
    });
  });

  it("leaves out non-integer numbers and empty or non-string text", async () => {
    const { adapter, handle } = await mounted();
    timezoneOffset.mockReturnValue(Number.NaN);
    browser({
      navigator: { language: "", userAgent: 42, javaEnabled: () => false },
      screen: { colorDepth: Number.POSITIVE_INFINITY, height: 1080.5, width: "1920" },
    });
    const result = await adapter.confirm(handle);
    expect(result.status).toBe("requires_confirmation");
    expect(envelope(result.clientToken).device).toEqual({
      browserData: { javaEnabled: false, javaScriptEnabled: true },
    });
  });

  it("sends the hostedTokenizationId alone when there is no navigator to describe", async () => {
    const { adapter, handle } = await mounted();
    browser({ navigator: undefined });
    expect(await adapter.confirm(handle)).toEqual({
      status: "requires_confirmation",
      clientToken: '{"hostedTokenizationId":"htp_123"}',
    });

    vi.stubGlobal("window", {
      get navigator(): unknown {
        throw new Error("blocked");
      },
    });
    expect(envelope((await adapter.confirm(handle)).clientToken)).toEqual({ hostedTokenizationId: "htp_123" });

    vi.stubGlobal("window", undefined);
    expect(envelope((await adapter.confirm(handle)).clientToken)).toEqual({ hostedTokenizationId: "htp_123" });
  });

  it("keeps the failed-tokenization path unchanged", async () => {
    const failure = { success: false, error: { message: "Invalid card number" } };
    const declined = await mounted(makeFakeTokenizer(() => failure));
    browser();
    const result = await declined.adapter.confirm(declined.handle);
    expect(result.status).toBe("failed");
    expect(result.clientToken).toBeUndefined();
    expect(result.error?.code).toBe("invalid_card_data");
    expect(result.error?.raw).toBe(failure.error);
    expect(isPayFanoutError(result.error)).toBe(true);
    expect(declined.fake.submitOptions).toEqual([{ storePermanently: false }]);

    const empty = await mounted(makeFakeTokenizer(() => ({ success: true })));
    browser();
    const noId = await empty.adapter.confirm(empty.handle);
    expect(noId.status).toBe("failed");
    expect(noId.clientToken).toBeUndefined();

    const offline = await mounted(
      makeFakeTokenizer(() => {
        throw new Error("network unavailable");
      }),
    );
    browser();
    const unreachable = await offline.adapter.confirm(offline.handle);
    expect(unreachable.status).toBe("failed");
    expect(unreachable.error).toMatchObject({ code: "psp_unavailable", retryable: true });
  });
});
