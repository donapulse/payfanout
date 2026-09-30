import { afterEach, describe, expect, it, vi } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import {
  StripeClientAdapter,
  type StripeClientAdapterConfig,
  type StripeJsFactory,
  type StripeJsLike,
} from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubBrowser(): void {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
}

const fakeStripe: StripeJsLike = {
  elements: () => ({ create: () => ({ mount: () => {}, unmount: () => {}, destroy: () => {}, on: () => {} }) }),
  confirmPayment: async () => ({ paymentIntent: { status: "succeeded" } }),
  confirmSetup: async () => ({ setupIntent: { status: "succeeded" } }),
  retrievePaymentIntent: async () => ({ paymentIntent: { status: "succeeded" } }),
  retrieveSetupIntent: async () => ({ setupIntent: { status: "succeeded" } }),
};

type Calls = Array<Record<string, unknown> | undefined>;

/**
 * A Stripe.js global as the served files define it: `version` names the build,
 * and a versioned build throws when `Stripe()` is given an apiVersion.
 */
function servedGlobal(version: unknown, calls: Calls = []): StripeJsFactory {
  const factory: StripeJsFactory = (_key, options) => {
    calls.push(options);
    if (version !== 3 && typeof version === "string" && options?.["apiVersion"] !== undefined) {
      throw new Error(`Unsupported on version [${version}]: Can not provide apiVersion to Stripe()`);
    }
    return fakeStripe;
  };
  (factory as { version?: unknown }).version = version;
  return factory;
}

/** An adapter whose loadScript seam records each URL and then defines `loaded`. */
function loadingAdapter(
  apiVersion: string,
  loaded: StripeJsFactory,
  extra: Partial<StripeClientAdapterConfig> = {},
): { adapter: StripeClientAdapter; urls: string[] } {
  const urls: string[] = [];
  let global: StripeJsFactory | undefined;
  const adapter = new StripeClientAdapter({
    publishableKey: "pk_test_unit",
    environment: "sandbox",
    apiVersion,
    getStripeGlobal: () => global,
    loadScript: async (url) => {
      urls.push(url);
      global = loaded;
    },
    ...extra,
  });
  return { adapter, urls };
}

/** An adapter over a global that is already there; `loads()` counts the loadScript calls. */
function adapterOver(
  apiVersion: string,
  global: StripeJsFactory | undefined,
  extra: Partial<StripeClientAdapterConfig> = {},
): { adapter: StripeClientAdapter; loads: () => number } {
  let loads = 0;
  const adapter = new StripeClientAdapter({
    publishableKey: "pk_test_unit",
    environment: "sandbox",
    apiVersion,
    getStripeGlobal: () => global,
    loadScript: async () => {
      loads++;
    },
    ...extra,
  });
  return { adapter, loads: () => loads };
}

function refusal(config: Record<string, unknown>): unknown {
  try {
    new StripeClientAdapter({ publishableKey: "pk_test_unit", environment: "sandbox", ...config } as never);
  } catch (err) {
    return err;
  }
  return undefined;
}

const mountAndReturn = async (adapter: StripeClientAdapter, locale?: string): Promise<void> => {
  await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret_x", ...(locale ? { locale } : {}) });
  await adapter.handleRedirectReturn({ search: "?payment_intent_client_secret=pi_1_secret_x" });
};

describe("StripeClientAdapter apiVersion", () => {
  it("loads the build of each release Stripe documents one for, and never gives Stripe() an apiVersion", async () => {
    stubBrowser();
    for (const [apiVersion, release] of [
      ["2024-09-30.acacia", "acacia"],
      ["2025-02-24.acacia", "acacia"],
      ["2025-08-27.basil", "basil"],
      ["2026-02-25.clover", "clover"],
      ["2026-03-25.dahlia", "dahlia"],
      ["2026-08-26.dahlia", "dahlia"],
    ] as const) {
      const calls: Calls = [];
      const { adapter, urls } = loadingAdapter(apiVersion, servedGlobal(release, calls));
      const handle = await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret_x" });
      expect(await adapter.confirm(handle), apiVersion).toEqual({ status: "succeeded" });
      await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret_x", locale: "fr" });
      await adapter.handleRedirectReturn({ search: "?payment_intent_client_secret=pi_1_secret_x" });
      expect(urls, apiVersion).toEqual([`https://js.stripe.com/${release}/stripe.js`]);
      expect(calls, apiVersion).toEqual([undefined, { locale: "fr" }, undefined]);
    }
  });

  it("loads v3 for a date alone and passes the version to Stripe(), which v3 takes", async () => {
    stubBrowser();
    const calls: Calls = [];
    const { adapter, urls } = loadingAdapter("2024-06-20", servedGlobal(3, calls), { locale: "de" });
    await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret_x" });
    await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret_x", locale: "fr" });
    await adapter.handleRedirectReturn({ search: "?setup_intent_client_secret=seti_1_secret_x" });
    expect(urls).toEqual(["https://js.stripe.com/v3"]);
    expect(calls).toEqual([
      { locale: "de", apiVersion: "2024-06-20" },
      { locale: "fr", apiVersion: "2024-06-20" },
      { locale: "de", apiVersion: "2024-06-20" },
    ]);

    const bare: Calls = [];
    const noLocale = loadingAdapter("2020-08-27", servedGlobal(3, bare)).adapter;
    await mountAndReturn(noLocale);
    expect(bare).toEqual([{ apiVersion: "2020-08-27" }, { apiVersion: "2020-08-27" }]);
  });

  it("refuses a missing apiVersion at construction", () => {
    for (const apiVersion of [undefined, null, ""]) {
      const err = refusal(apiVersion === undefined ? {} : { apiVersion });
      expect(isPayFanoutError(err), String(apiVersion)).toBe(true);
      expect(err).toMatchObject({
        code: "invalid_request",
        retryable: false,
        message: "StripeClientAdapter config.apiVersion is required: pass the apiVersion your StripeServerAdapter pins",
      });
    }
  });

  it("refuses a malformed apiVersion at construction", () => {
    for (const apiVersion of [
      "dahlia",
      "2026-08-26.Dahlia",
      "2026-8-26.dahlia",
      "2026-08-26.",
      "2026-08-26.dahlia.2",
      "2026-08-26dahlia",
      " 2026-08-26.dahlia",
      "2026-08-26.dahlia ",
      "2026-00-26.dahlia",
      "2026-13-26.dahlia",
      "2026-08-00.dahlia",
      "2026-08-32.dahlia",
      "26-08-26",
      "2024-06-20\n",
      20240620,
      {},
    ]) {
      const err = refusal({ apiVersion });
      expect(isPayFanoutError(err), JSON.stringify(apiVersion)).toBe(true);
      expect(err, JSON.stringify(apiVersion)).toMatchObject({
        code: "invalid_request",
        retryable: false,
        message:
          'StripeClientAdapter config.apiVersion must be a Stripe API version: a date, with or without a release name, such as "2026-08-26.dahlia" or "2024-06-20"',
      });
    }
  });

  it("refuses a date alone from 2024-09-30 on, when every version carries a release name", () => {
    for (const apiVersion of ["2024-09-30", "2024-12-18", "2026-08-26"]) {
      expect(refusal({ apiVersion }), apiVersion).toMatchObject({
        code: "invalid_request",
        retryable: false,
        message: `StripeClientAdapter config.apiVersion "${apiVersion}" has no release name, which every Stripe API version from 2024-09-30 on carries, as in "2024-09-30.acacia"`,
      });
    }
    for (const apiVersion of ["2024-09-29", "2024-06-20", "2011-01-01"]) {
      expect(refusal({ apiVersion }), apiVersion).toBeUndefined();
    }
  });

  it("refuses a release it knows no Stripe.js build for, naming the newest it knows", () => {
    for (const release of ["endive", "zinnia"]) {
      expect(refusal({ apiVersion: `2026-09-30.${release}` })).toMatchObject({
        code: "invalid_request",
        retryable: false,
        message:
          `StripeClientAdapter config.apiVersion names the release "${release}", for which this adapter knows no Stripe.js build ` +
          `(it knows acacia, basil, clover, dahlia): while the server is on "${release}", pass a version of dahlia, the newest release this adapter knows`,
      });
    }
  });

  it("refuses a preview version, which no Stripe.js build speaks", () => {
    expect(refusal({ apiVersion: "2026-08-26.preview" })).toMatchObject({
      code: "invalid_request",
      retryable: false,
      message:
        'StripeClientAdapter config.apiVersion "2026-08-26.preview" is a preview API version, which no Stripe.js build speaks: ' +
        "pass a generally available version, such as one of dahlia, the newest release this adapter knows",
    });
  });

  it("refuses beta headers, which Stripe.js no longer takes in an API version", () => {
    for (const apiVersion of ["2026-08-26.dahlia; custom_checkout_beta=v1", "2024-06-20;feature_beta=v3", "2026-08-26.preview; x=v1"]) {
      expect(refusal({ apiVersion }), apiVersion).toMatchObject({
        code: "invalid_request",
        retryable: false,
        message:
          'StripeClientAdapter config.apiVersion carries beta headers after ";", which Stripe.js no longer takes in an API version: pass the version before the ";"',
      });
    }
  });

  it("accepts the edges of a well-formed date", () => {
    for (const apiVersion of ["2011-01-01", "2019-12-31", "2026-01-31.dahlia", "2025-09-30.clover"]) {
      expect(() => new StripeClientAdapter({ publishableKey: "pk", environment: "sandbox", apiVersion }), apiVersion).not.toThrow();
    }
  });

  it("refuses the removed sdkUrl instead of ignoring it, before looking at apiVersion", () => {
    const message =
      "StripeClientAdapter config.sdkUrl is no longer supported: Stripe.js loads from https://js.stripe.com in the build config.apiVersion names";
    for (const sdkUrl of ["https://js.stripe.com/dahlia/stripe.js", "https://cdn.example/stripe.js", ""]) {
      expect(refusal({ apiVersion: "2026-08-26.dahlia", sdkUrl }), sdkUrl).toMatchObject({
        code: "invalid_request",
        retryable: false,
        message,
      });
    }
    // An upgrading config that still names sdkUrl learns that first.
    expect(refusal({ sdkUrl: "https://js.stripe.com/v3" })).toMatchObject({ message });
    expect(() => new StripeClientAdapter({ publishableKey: "pk", environment: "sandbox", apiVersion: "2024-06-20", sdkUrl: undefined } as never)).not.toThrow();
  });
});

describe("StripeClientAdapter hideTestingAssistant", () => {
  it("hides Stripe's testing assistant through Stripe(), whichever build runs", async () => {
    stubBrowser();
    const hidden = { developerTools: { assistant: { enabled: false } } };
    for (const [apiVersion, build, expected] of [
      ["2026-08-26.dahlia", "dahlia", [hidden, { locale: "fr", ...hidden }]],
      ["2024-06-20", 3, [{ apiVersion: "2024-06-20", ...hidden }, { locale: "fr", apiVersion: "2024-06-20", ...hidden }]],
    ] as const) {
      const calls: Calls = [];
      const { adapter } = loadingAdapter(apiVersion, servedGlobal(build, calls), { hideTestingAssistant: true });
      await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret_x" });
      await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret_x", locale: "fr" });
      expect(calls, apiVersion).toEqual(expected);
    }
  });

  it("leaves Stripe's default when unset or false", async () => {
    stubBrowser();
    for (const extra of [{}, { hideTestingAssistant: false }]) {
      const calls: Calls = [];
      const { adapter } = loadingAdapter("2026-08-26.dahlia", servedGlobal("dahlia", calls), extra);
      await mountAndReturn(adapter);
      expect(calls, JSON.stringify(extra)).toEqual([undefined, undefined]);
    }
  });

  it("refuses a value that is not a boolean", () => {
    expect(refusal({ apiVersion: "2026-08-26.dahlia", hideTestingAssistant: "yes" })).toMatchObject({
      code: "invalid_request",
      retryable: false,
      message: "StripeClientAdapter config.hideTestingAssistant must be a boolean",
    });
  });
});

describe("StripeClientAdapter and a Stripe.js already there", () => {
  it("uses the pinned build without loading anything", async () => {
    stubBrowser();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [apiVersion, version, expected] of [
      ["2026-08-26.dahlia", "dahlia", undefined],
      ["2025-03-31.basil", "basil", undefined],
      ["2024-06-20", 3, { apiVersion: "2024-06-20" }],
    ] as const) {
      const calls: Calls = [];
      const { adapter, loads } = adapterOver(apiVersion, servedGlobal(version, calls));
      await expect(adapter.loadSdk(), apiVersion).resolves.toBeUndefined();
      await mountAndReturn(adapter);
      expect(loads(), apiVersion).toBe(0);
      expect(calls, apiVersion).toEqual([expected, expected]);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("gives the page's v3 the pinned version, a release's included, so the browser speaks exactly it", async () => {
    stubBrowser();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const apiVersion of ["2026-08-26.dahlia", "2025-01-27.acacia"]) {
      const calls: Calls = [];
      const { adapter, loads } = adapterOver(apiVersion, servedGlobal(3, calls), { locale: "fr" });
      await mountAndReturn(adapter);
      expect(loads(), apiVersion).toBe(0);
      expect(calls, apiVersion).toEqual([
        { locale: "fr", apiVersion },
        { locale: "fr", apiVersion },
      ]);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses another versioned build as it is, warning once in a sandbox", async () => {
    stubBrowser();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [apiVersion, running, needed, url] of [
      ["2026-08-26.dahlia", "clover", "dahlia", "https://js.stripe.com/dahlia/stripe.js"],
      ["2026-08-26.dahlia", "endive", "dahlia", "https://js.stripe.com/dahlia/stripe.js"],
      ["2024-06-20", "dahlia", "v3", "https://js.stripe.com/v3"],
    ] as const) {
      warn.mockClear();
      const calls: Calls = [];
      const { adapter, loads } = adapterOver(apiVersion, servedGlobal(running, calls));
      await mountAndReturn(adapter);
      await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret_x", locale: "es" });
      expect(loads(), running).toBe(0);
      // A versioned build throws on an apiVersion, so it is never given one.
      expect(calls, running).toEqual([undefined, undefined, { locale: "es" }]);
      expect(warn, running).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        `[payfanout] This page runs Stripe.js ${running}, not ${needed} (${url}), the build config.apiVersion "${apiVersion}" names. ` +
          `The Stripe adapter uses the page's copy, so the browser speaks the API version Stripe pins ${running} to. ` +
          `Load ${url} on the page instead, or no Stripe.js at all and let the adapter load it.`,
      );
    }
  });

  it("does not warn in live mode, as Stripe's own loader warns only for test keys", async () => {
    stubBrowser();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: Calls = [];
    const { adapter } = adapterOver("2026-08-26.dahlia", servedGlobal("clover", calls), { environment: "live" });
    await mountAndReturn(adapter);
    expect(calls).toEqual([undefined, undefined]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("loads the build beside a Stripe.js v2 global and uses what attached itself as StripeV3", async () => {
    stubBrowser();
    const calls: Calls = [];
    const v2 = servedGlobal(2);
    const urls: string[] = [];
    const adapter = new StripeClientAdapter({
      publishableKey: "pk_test_unit",
      environment: "sandbox",
      apiVersion: "2026-08-26.dahlia",
      getStripeGlobal: () => v2,
      loadScript: async (url) => {
        urls.push(url);
        v2.StripeV3 = servedGlobal("dahlia", calls);
      },
    });
    await mountAndReturn(adapter);
    expect(urls).toEqual(["https://js.stripe.com/dahlia/stripe.js"]);
    expect(calls).toEqual([undefined, undefined]);

    // A StripeV3 already attached is used without loading, by the rules for the build it is.
    const v3Calls: Calls = [];
    const withV3 = servedGlobal(2);
    withV3.StripeV3 = servedGlobal(3, v3Calls);
    const { adapter: over, loads } = adapterOver("2026-08-26.dahlia", withV3);
    await mountAndReturn(over);
    expect(loads()).toBe(0);
    expect(v3Calls).toEqual([{ apiVersion: "2026-08-26.dahlia" }, { apiVersion: "2026-08-26.dahlia" }]);
  });

  it("uses a global whose version names no build as if it were the pinned build", async () => {
    stubBrowser();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const version of [undefined, "2026-03-25.dahlia", "Dahlia", "", 4, 3.5, {}]) {
      for (const [apiVersion, expected] of [
        ["2026-08-26.dahlia", undefined],
        ["2024-06-20", { apiVersion: "2024-06-20" }],
      ] as const) {
        const calls: Calls = [];
        const factory: StripeJsFactory = (_key, options) => {
          calls.push(options);
          return fakeStripe;
        };
        (factory as { version?: unknown }).version = version;
        const { adapter, loads } = adapterOver(apiVersion, factory);
        await mountAndReturn(adapter);
        expect(loads(), JSON.stringify(version)).toBe(0);
        expect(calls, `${JSON.stringify(version)} ${apiVersion}`).toEqual([expected, expected]);
      }
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses a build another script defined while its own was loading, by the same rules", async () => {
    stubBrowser();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: Calls = [];
    let global: StripeJsFactory | undefined;
    let loads = 0;
    const adapter = new StripeClientAdapter({
      publishableKey: "pk_test_unit",
      environment: "sandbox",
      apiVersion: "2026-08-26.dahlia",
      getStripeGlobal: () => global,
      loadScript: async () => {
        loads++;
        // The page's own v3 ran first; the adapter's copy left the global to it.
        global = servedGlobal(3, calls);
      },
    });
    await mountAndReturn(adapter);
    expect(loads).toBe(1);
    expect(calls).toEqual([{ apiVersion: "2026-08-26.dahlia" }, { apiVersion: "2026-08-26.dahlia" }]);
    expect(warn).not.toHaveBeenCalled();
  });
});
