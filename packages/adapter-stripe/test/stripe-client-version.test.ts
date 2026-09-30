import { afterEach, describe, expect, it, vi } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import {
  StripeClientAdapter,
  type StripeClientAdapterConfig,
  type StripeJsFactory,
  type StripeJsLike,
} from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

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

/**
 * A Stripe.js global as the served files define it: `version` names the build,
 * and a versioned build throws when `Stripe()` is given an apiVersion.
 */
function servedGlobal(version: number | string, calls: Array<Record<string, unknown> | undefined> = []): StripeJsFactory {
  const factory: StripeJsFactory = (_key, options) => {
    calls.push(options);
    if (version !== 3 && options?.["apiVersion"] !== undefined) {
      throw new Error(`Unsupported on version [${String(version)}]: Can not provide apiVersion to Stripe()`);
    }
    return fakeStripe;
  };
  factory.version = version;
  return factory;
}

/** An adapter whose loadScript seam records each URL and then defines `global`. */
function loadingAdapter(
  apiVersion: string,
  global: StripeJsFactory,
  extra: Partial<StripeClientAdapterConfig> = {},
): { adapter: StripeClientAdapter; urls: string[] } {
  const urls: string[] = [];
  let loaded: StripeJsFactory | undefined;
  const adapter = new StripeClientAdapter({
    publishableKey: "pk_test_unit",
    environment: "sandbox",
    apiVersion,
    getStripeGlobal: () => loaded,
    loadScript: async (url) => {
      urls.push(url);
      loaded = global;
    },
    ...extra,
  });
  return { adapter, urls };
}

function refusal(config: Record<string, unknown>): unknown {
  try {
    new StripeClientAdapter({ publishableKey: "pk_test_unit", environment: "sandbox", ...config } as never);
  } catch (err) {
    return err;
  }
  return undefined;
}

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
      const calls: Array<Record<string, unknown> | undefined> = [];
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
    const calls: Array<Record<string, unknown> | undefined> = [];
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

    const bare: Array<Record<string, unknown> | undefined> = [];
    const noLocale = loadingAdapter("2020-08-27", servedGlobal(3, bare)).adapter;
    await noLocale.mount({} as HTMLElement, { clientSecret: "pi_1_secret_x" });
    await noLocale.handleRedirectReturn({ search: "?payment_intent_client_secret=pi_1_secret_x" });
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
      "2026-08-26.dahlia; custom_checkout_beta=v1",
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

  it("refuses a release it knows no Stripe.js build for", () => {
    for (const release of ["endive", "preview", "zinnia"]) {
      expect(refusal({ apiVersion: `2026-09-30.${release}` })).toMatchObject({
        code: "invalid_request",
        retryable: false,
        message: `StripeClientAdapter config.apiVersion names the release "${release}", which has no Stripe.js build this adapter knows (acacia, basil, clover, dahlia)`,
      });
    }
  });

  it("accepts the edges of a well-formed date", () => {
    for (const apiVersion of ["2011-01-01", "2019-12-31", "2026-01-31.dahlia", "2025-09-30.clover"]) {
      expect(() => new StripeClientAdapter({ publishableKey: "pk", environment: "sandbox", apiVersion }), apiVersion).not.toThrow();
    }
  });

  it("refuses the removed sdkUrl instead of ignoring it", () => {
    for (const sdkUrl of ["https://js.stripe.com/dahlia/stripe.js", "https://cdn.example/stripe.js", ""]) {
      expect(refusal({ apiVersion: "2026-08-26.dahlia", sdkUrl }), sdkUrl).toMatchObject({
        code: "invalid_request",
        retryable: false,
        message:
          "StripeClientAdapter config.sdkUrl is no longer supported: Stripe.js loads from https://js.stripe.com in the build config.apiVersion names",
      });
    }
    expect(() => new StripeClientAdapter({ publishableKey: "pk", environment: "sandbox", apiVersion: "2024-06-20", sdkUrl: undefined } as never)).not.toThrow();
  });
});

describe("StripeClientAdapter and a Stripe.js global already there", () => {
  function adapterFor(apiVersion: string, global: StripeJsFactory | undefined): { adapter: StripeClientAdapter; loads: () => number } {
    let loads = 0;
    const adapter = new StripeClientAdapter({
      publishableKey: "pk_test_unit",
      environment: "sandbox",
      apiVersion,
      getStripeGlobal: () => global,
      loadScript: async () => {
        loads++;
      },
    });
    return { adapter, loads: () => loads };
  }

  it("uses a global of the pinned build without loading anything", async () => {
    stubBrowser();
    for (const [apiVersion, version] of [
      ["2026-08-26.dahlia", "dahlia"],
      ["2025-03-31.basil", "basil"],
      ["2024-06-20", 3],
    ] as const) {
      const { adapter, loads } = adapterFor(apiVersion, servedGlobal(version));
      await expect(adapter.loadSdk(), apiVersion).resolves.toBeUndefined();
      await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret_x" });
      expect(loads(), apiVersion).toBe(0);
    }
  });

  it("refuses a global of another build, loading nothing over it", async () => {
    stubBrowser();
    for (const [apiVersion, version, message] of [
      [
        "2026-08-26.dahlia",
        3,
        'This page already runs Stripe.js v3, but config.apiVersion "2026-08-26.dahlia" needs Stripe.js dahlia (https://js.stripe.com/dahlia/stripe.js)',
      ],
      [
        "2026-08-26.dahlia",
        "clover",
        'This page already runs Stripe.js clover, but config.apiVersion "2026-08-26.dahlia" needs Stripe.js dahlia (https://js.stripe.com/dahlia/stripe.js)',
      ],
      [
        "2026-08-26.dahlia",
        "endive",
        'This page already runs Stripe.js endive, but config.apiVersion "2026-08-26.dahlia" needs Stripe.js dahlia (https://js.stripe.com/dahlia/stripe.js)',
      ],
      [
        "2024-06-20",
        "dahlia",
        'This page already runs Stripe.js dahlia, but config.apiVersion "2024-06-20" needs Stripe.js v3 (https://js.stripe.com/v3)',
      ],
      [
        "2024-06-20",
        2,
        'This page already runs Stripe.js v2, but config.apiVersion "2024-06-20" needs Stripe.js v3 (https://js.stripe.com/v3)',
      ],
    ] as const) {
      const { adapter, loads } = adapterFor(apiVersion, servedGlobal(version));
      const expected = {
        code: "invalid_request",
        retryable: false,
        pspName: "stripe",
        message: `${message}: a page runs one Stripe.js build, so load that one or leave the loading to the adapter`,
        raw: { loadedVersion: version, neededVersion: apiVersion === "2024-06-20" ? 3 : "dahlia" },
      };
      await expect(adapter.loadSdk(), message).rejects.toMatchObject(expected);
      await expect(adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret_x" })).rejects.toMatchObject(expected);
      await expect(adapter.handleRedirectReturn({ search: "?payment_intent_client_secret=pi_1_secret_x" })).rejects.toMatchObject(expected);
      expect(loads(), message).toBe(0);
    }
  });

  it("uses a global whose version names no build as it is", async () => {
    stubBrowser();
    const bare: StripeJsFactory = () => fakeStripe;
    for (const global of [bare, servedGlobal("2026-03-25.dahlia"), servedGlobal("Dahlia"), servedGlobal(""), servedGlobal(3.5)]) {
      const { adapter, loads } = adapterFor("2026-08-26.dahlia", global);
      await expect(adapter.loadSdk(), String(global.version)).resolves.toBeUndefined();
      expect(loads()).toBe(0);
    }
  });

  it("refuses another build that another script defined while its own loaded, and does not load again", async () => {
    stubBrowser();
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
        global = servedGlobal(3);
      },
    });
    const refused = { code: "invalid_request", retryable: false, raw: { loadedVersion: 3, neededVersion: "dahlia" } };
    await expect(adapter.loadSdk()).rejects.toMatchObject(refused);
    await expect(adapter.loadSdk()).rejects.toMatchObject(refused);
    expect(loads).toBe(1);
  });
});
