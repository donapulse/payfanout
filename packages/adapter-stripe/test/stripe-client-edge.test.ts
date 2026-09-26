import { afterEach, describe, expect, it, vi } from "vitest";
import { getUserMessage } from "@payfanout/core";
import { StripeClientAdapter, type StripeJsFactory, type StripeJsLike } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

function stubBrowser(): void {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
}

describe("StripeClientAdapter edge cases", () => {
  it("validates its config eagerly", () => {
    expect(
      () => new StripeClientAdapter({ publishableKey: "", environment: "sandbox" }),
    ).toThrowError(/publishableKey/);
    expect(
      () => new StripeClientAdapter({ publishableKey: "pk", environment: "test" as never }),
    ).toThrowError(/sandbox.*live/);
  });

  it("loadSdk rejects during SSR and when the script loads but the global is missing", async () => {
    const noDom = new StripeClientAdapter({ publishableKey: "pk", environment: "sandbox" });
    await expect(noDom.loadSdk()).rejects.toThrowError(/browser-only/);

    stubBrowser();
    const adapter = new StripeClientAdapter({
      publishableKey: "pk",
      environment: "sandbox",
      loadScript: async () => {}, // "loads" but never defines window.Stripe
      getStripeGlobal: () => undefined,
    });
    await expect(adapter.loadSdk()).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
    });
  });

  it("keeps a newer load cached when a stale call's catch runs after it started", async () => {
    stubBrowser();
    const failure = new Error("network hiccup");
    let rejectFirst!: (err: unknown) => void;
    const firstLoad = new Promise<void>((_, reject) => (rejectFirst = reject));
    let loads = 0;
    const adapter = new StripeClientAdapter({
      publishableKey: "pk",
      environment: "sandbox",
      getStripeGlobal: () => undefined,
      loadScript: () => (++loads === 1 ? firstLoad : new Promise<void>(() => {})),
    });
    const a = adapter.loadSdk();
    // Starts a second load between the two stale calls' catch blocks.
    void firstLoad.catch(() => void adapter.loadSdk());
    const b = adapter.loadSdk();
    rejectFirst(failure);
    await expect(a).rejects.toBe(failure);
    await expect(b).rejects.toBe(failure);
    void adapter.loadSdk();
    expect(loads).toBe(2);
  });

  it("retries the SDK injection after a failed script load instead of caching the rejection", async () => {
    stubBrowser();
    const failure = new Error("network hiccup");
    let stripe: StripeJsFactory | undefined;
    let loads = 0;
    const adapter = new StripeClientAdapter({
      publishableKey: "pk",
      environment: "sandbox",
      getStripeGlobal: () => stripe,
      loadScript: async () => {
        loads++;
        if (loads === 1) throw failure;
        stripe = () => ({}) as StripeJsLike;
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

  it("loads the SDK again after a load that left window.Stripe missing", async () => {
    stubBrowser();
    let stripe: StripeJsFactory | undefined;
    let loads = 0;
    const adapter = new StripeClientAdapter({
      publishableKey: "pk",
      environment: "sandbox",
      getStripeGlobal: () => stripe,
      loadScript: async () => {
        loads++;
        if (loads === 2) stripe = () => ({}) as StripeJsLike;
      },
    });
    await expect(adapter.loadSdk()).rejects.toMatchObject({
      code: "psp_unavailable",
      message: "Stripe.js loaded but window.Stripe is missing",
      retryable: true,
    });
    await expect(adapter.loadSdk()).resolves.toBeUndefined();
    expect(loads).toBe(2);
  });

  it("forwards returnUrl into confirmParams and maps unknown PSP statuses to processing", async () => {
    stubBrowser();
    const confirmCalls: Record<string, unknown>[] = [];
    const element = { mount: () => {}, unmount: () => {}, destroy: () => {}, on: () => {} };
    const fake: StripeJsLike = {
      elements: () => ({ create: () => element }),
      confirmPayment: async (options) => {
        confirmCalls.push(options);
        return { paymentIntent: { status: "brand_new_stripe_status" } };
      },
      confirmSetup: async () => ({ setupIntent: { status: "succeeded" } }),
      retrievePaymentIntent: async () => ({ paymentIntent: { status: "succeeded" } }),
      retrieveSetupIntent: async () => ({ setupIntent: { status: "succeeded" } }),
    };
    const adapter = new StripeClientAdapter({
      publishableKey: "pk",
      environment: "sandbox",
      returnUrl: "https://host.example/return",
      getStripeGlobal: () => () => fake,
      loadScript: async () => {},
    });
    const handle = await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret" });
    const result = await adapter.confirm(handle);
    expect(result.status).toBe("processing"); // unknown statuses degrade safely, stay in the enum
    expect(confirmCalls[0]!["confirmParams"]).toEqual({ return_url: "https://host.example/return" });
  });

  it("maps validation, authentication and unrecognized failures distinctly", async () => {
    stubBrowser();
    const element = { mount: () => {}, unmount: () => {}, destroy: () => {}, on: () => {} };
    const makeAdapter = (error: object): StripeClientAdapter =>
      new StripeClientAdapter({
        publishableKey: "pk",
        environment: "sandbox",
        getStripeGlobal: () => () => ({
          elements: () => ({ create: () => element }),
          confirmPayment: async () => ({ error }),
          confirmSetup: async () => ({ error }),
          retrievePaymentIntent: async () => ({ error }),
          retrieveSetupIntent: async () => ({ error }),
        }),
        loadScript: async () => {},
      });

    const validation = makeAdapter({ type: "validation_error", code: "incomplete_number", message: "Incomplete." });
    const vHandle = await validation.mount({} as HTMLElement, { clientSecret: "pi_1_secret" });
    const vResult = await validation.confirm(vHandle);
    expect(vResult.error?.code).toBe("invalid_card_data");

    // authentication_required is resolved on-session (3DS challenge), never by replay.
    const auth = makeAdapter({ type: "card_error", code: "authentication_required", message: "3DS needed." });
    const aHandle = await auth.mount({} as HTMLElement, { clientSecret: "pi_1_secret" });
    const aResult = await auth.confirm(aHandle);
    expect(aResult.error?.code).toBe("authentication_required");
    expect(aResult.error?.retryable).toBe(false);

    // The general form of the intent-specific authentication failures maps the same way.
    const failed = makeAdapter({ type: "card_error", code: "authentication_failure", message: "Authentication failed." });
    const fResult = await failed.confirm(await failed.mount({} as HTMLElement, { clientSecret: "pi_1_secret" }));
    expect(fResult.error?.code).toBe("authentication_required");
    expect(fResult.error?.retryable).toBe(false);

    const exotic = makeAdapter({ type: "api_error", message: "Something odd." });
    const eHandle = await exotic.mount({} as HTMLElement, { clientSecret: "pi_1_secret" });
    const eResult = await exotic.confirm(eHandle);
    expect(eResult.error?.code).toBe("unknown");
    expect(eResult.status).toBe("failed");
  });

  it("classifies Stripe.js errors in the server adapter's order", async () => {
    stubBrowser();
    const confirmWith = async (error: Record<string, string>) => {
      const adapter = new StripeClientAdapter({
        publishableKey: "pk",
        environment: "sandbox",
        getStripeGlobal: () => () => ({
          elements: () => ({ create: () => ({ mount: () => {}, unmount: () => {}, destroy: () => {}, on: () => {} }) }),
          confirmPayment: async () => ({ error }),
          confirmSetup: async () => ({ error }),
          retrievePaymentIntent: async () => ({ error }),
          retrieveSetupIntent: async () => ({ error }),
        }),
        loadScript: async () => {},
      });
      return (await adapter.confirm(await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret" }))).error;
    };
    const cases: Array<[Record<string, string>, string, boolean]> = [
      // 2026-08-26.dahlia's payment-method spellings, and the region-specific incorrect_zip.
      [{ type: "card_error", code: "expired_payment_method" }, "expired_card", false],
      [{ type: "card_error", code: "incorrect_postal_code" }, "invalid_card_data", false],
      [{ type: "card_error", code: "incorrect_zip" }, "invalid_card_data", false],
      // A wrong address, as an error code or the issuer's decline code, like incorrect_zip.
      [{ type: "card_error", code: "incorrect_address" }, "invalid_card_data", false],
      [{ type: "card_error", code: "card_declined", decline_code: "incorrect_address" }, "invalid_card_data", false],
      // In the card-data step, so it comes before a fraud decline code on the same error.
      [{ type: "card_error", code: "incorrect_address", decline_code: "fraudulent" }, "invalid_card_data", false],
      // Fraud decline codes, over a failed authentication on the same error as on the server.
      [{ type: "card_error", code: "card_declined", decline_code: "fraudulent" }, "fraud_suspected", false],
      [{ type: "card_error", code: "card_declined", decline_code: "stolen_card" }, "fraud_suspected", false],
      [{ type: "card_error", code: "card_declined", decline_code: "lost_card" }, "fraud_suspected", false],
      [{ type: "card_error", code: "card_declined", decline_code: "merchant_blacklist" }, "fraud_suspected", false],
      [{ type: "card_error", code: "authentication_failure", decline_code: "stolen_card" }, "fraud_suspected", false],
      // Card details the customer can correct come first, as on the server.
      [{ type: "card_error", code: "incorrect_cvc", decline_code: "fraudulent" }, "invalid_card_data", false],
      [{ type: "card_error", code: "card_declined", decline_code: "incorrect_cvc" }, "invalid_card_data", false],
      [{ type: "card_error", code: "card_declined", decline_code: "expired_card" }, "expired_card", false],
      [{ type: "card_error", code: "card_declined", decline_code: "processing_error" }, "processing_error", true],
      [{ type: "card_error", code: "card_declined", decline_code: "insufficient_funds" }, "insufficient_funds", false],
      [{ type: "card_error", code: "card_declined", decline_code: "lost_or_stolen_card" }, "fraud_suspected", false],
      // A required authentication, read from either code, comes before a fraud decline code.
      [{ type: "card_error", code: "authentication_required", decline_code: "fraudulent" }, "authentication_required", false],
      [{ type: "card_error", code: "card_declined", decline_code: "authentication_required" }, "authentication_required", false],
      // The issuer's decline after a skipped authentication, in the same step, so a processing
      // error cannot make it retryable; Stripe lists it as a decline code only.
      [{ type: "card_error", code: "card_declined", decline_code: "authentication_not_handled" }, "authentication_required", false],
      [{ type: "card_error", code: "processing_error", decline_code: "authentication_not_handled" }, "authentication_required", false],
      [{ type: "card_error", code: "authentication_not_handled" }, "card_declined", false],
      // Card data the customer can correct comes before the skipped authentication.
      [{ type: "card_error", code: "incorrect_cvc", decline_code: "authentication_not_handled" }, "invalid_card_data", false],
      [{ type: "card_error", code: "incorrect_address", decline_code: "authentication_not_handled" }, "invalid_card_data", false],
      // The intent-specific failed authentications that accounts before dahlia still receive.
      [{ type: "card_error", code: "payment_intent_authentication_failure" }, "authentication_required", false],
      [{ type: "card_error", code: "setup_intent_authentication_failure" }, "authentication_required", false],
      [{ type: "card_error", code: "processing_error" }, "processing_error", true],
      // The card-detail codes, whether Stripe returns them as error codes or decline codes.
      [{ type: "card_error", code: "incorrect_number" }, "invalid_card_data", false],
      [{ type: "card_error", code: "invalid_number" }, "invalid_card_data", false],
      [{ type: "card_error", code: "invalid_cvc" }, "invalid_card_data", false],
      [{ type: "card_error", code: "invalid_expiry_month" }, "invalid_card_data", false],
      [{ type: "card_error", code: "invalid_expiry_year" }, "invalid_card_data", false],
      // Every Stripe.js field code, as the other card-detail codes.
      [{ type: "validation_error", code: "incomplete_number" }, "invalid_card_data", false],
      [{ type: "validation_error", code: "incomplete_cvc" }, "invalid_card_data", false],
      [{ type: "validation_error", code: "incomplete_expiry" }, "invalid_card_data", false],
      // Only the lists' own entries count.
      [{ type: "card_error", code: "card_declined", decline_code: "constructor" }, "card_declined", false],
      [{ type: "api_error", code: "constructor" }, "unknown", false],
    ];
    for (const [error, code, retryable] of cases) {
      expect(await confirmWith(error), JSON.stringify(error)).toMatchObject({ code, retryable });
    }
    vi.stubGlobal("navigator", { language: "es-ES" });
    const fraud = await confirmWith({ type: "card_error", code: "card_declined", decline_code: "stolen_card", message: "Card reported stolen." });
    expect(fraud?.message).toBe(getUserMessage("fraud_suspected", "es"));
    // Every other message is Stripe.js's own, which it localizes.
    const funds = await confirmWith({ type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Fonds insuffisants." });
    expect(funds?.message).toBe("Fonds insuffisants.");
  });

  it("writes the generic fraud message in the browser's locale under \"auto\", without one, or with an empty one", async () => {
    stubBrowser();
    vi.stubGlobal("navigator", { language: "es-ES" });
    const stolen = { type: "card_error", code: "card_declined", decline_code: "stolen_card", message: "Card reported stolen." };
    const factory = () => ({
      elements: () => ({ create: () => ({ mount: () => {}, unmount: () => {}, destroy: () => {}, on: () => {} }) }),
      confirmPayment: async () => ({ error: stolen }),
      confirmSetup: async () => ({ error: stolen }),
      retrievePaymentIntent: async () => ({ error: stolen }),
      retrieveSetupIntent: async () => ({ error: stolen }),
    });
    const spanish = getUserMessage("fraud_suspected", "es");
    expect(spanish).not.toBe(getUserMessage("fraud_suspected", "en"));
    for (const locale of ["auto", undefined, ""]) {
      const adapter = new StripeClientAdapter({
        publishableKey: "pk",
        environment: "sandbox",
        ...(locale === undefined ? {} : { locale }),
        getStripeGlobal: () => factory,
        loadScript: async () => {},
      });
      const confirmed = await adapter.confirm(await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret" }));
      expect(confirmed.error?.message, String(locale)).toBe(spanish);
      const returned = await adapter.handleRedirectReturn({ search: "?payment_intent_client_secret=pi_1_secret" });
      expect(returned?.error?.message, String(locale)).toBe(spanish);
    }
    vi.stubGlobal("navigator", undefined);
    const noBrowserLocale = new StripeClientAdapter({
      publishableKey: "pk",
      environment: "sandbox",
      getStripeGlobal: () => factory,
      loadScript: async () => {},
    });
    const english = await noBrowserLocale.confirm(await noBrowserLocale.mount({} as HTMLElement, { clientSecret: "pi_1_secret" }));
    expect(english.error?.message).toBe(getUserMessage("fraud_suspected", "en"));
  });

  it("writes the generic fraud message in the locale Stripe.js was given", async () => {
    stubBrowser();
    vi.stubGlobal("navigator", { language: "es-ES" });
    const stolen = { type: "card_error", code: "card_declined", decline_code: "stolen_card", message: "Card reported stolen." };
    const factory = () => ({
      elements: () => ({ create: () => ({ mount: () => {}, unmount: () => {}, destroy: () => {}, on: () => {} }) }),
      confirmPayment: async () => ({ error: stolen }),
      confirmSetup: async () => ({ error: stolen }),
      retrievePaymentIntent: async () => ({ error: stolen }),
      retrieveSetupIntent: async () => ({ error: stolen }),
    });
    const adapter = new StripeClientAdapter({
      publishableKey: "pk",
      environment: "sandbox",
      locale: "de",
      getStripeGlobal: () => factory,
      loadScript: async () => {},
    });
    const configured = await adapter.confirm(await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret" }));
    expect(configured.error?.message).toBe(getUserMessage("fraud_suspected", "de"));
    expect(configured.error?.message).not.toBe(getUserMessage("fraud_suspected", "en"));
    const perMount = await adapter.confirm(await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret", locale: "fr" }));
    expect(perMount.error?.message).toBe(getUserMessage("fraud_suspected", "fr"));
    const returned = await adapter.handleRedirectReturn({ search: "?payment_intent_client_secret=pi_1_secret" });
    expect(returned?.error?.message).toBe(getUserMessage("fraud_suspected", "de"));
  });

  it("streams field-state changes through onChange, initialized to incomplete", async () => {
    stubBrowser();
    const handlers = new Map<string, (payload?: { complete?: boolean; empty?: boolean }) => void>();
    const element = {
      mount: () => {},
      unmount: () => {},
      destroy: () => {},
      on: (event: string, handler: (payload?: { complete?: boolean; empty?: boolean }) => void) => {
        handlers.set(event, handler);
      },
    };
    const adapter = new StripeClientAdapter({
      publishableKey: "pk",
      environment: "sandbox",
      getStripeGlobal: () => () => ({
        elements: () => ({ create: () => element }),
        confirmPayment: async () => ({ paymentIntent: { status: "succeeded" } }),
        confirmSetup: async () => ({ setupIntent: { status: "succeeded" } }),
        retrievePaymentIntent: async () => ({ paymentIntent: { status: "succeeded" } }),
        retrieveSetupIntent: async () => ({ setupIntent: { status: "succeeded" } }),
      }),
      loadScript: async () => {},
    });
    const changes: Array<{ complete: boolean; empty?: boolean }> = [];
    await adapter.mount({} as HTMLElement, {
      clientSecret: "pi_1_secret",
      onChange: (state) => changes.push(state),
    });
    expect(changes).toEqual([{ complete: false }]); // deterministic initial state

    handlers.get("change")?.({ complete: true, empty: false });
    expect(changes.at(-1)).toEqual({ complete: true, empty: false });
    handlers.get("change")?.(undefined); // SDK quirk: payload-less event degrades safely
    expect(changes.at(-1)).toEqual({ complete: false });
  });

  it("forwards fieldOptions to the Payment Element and lets mount-level locale win", async () => {
    stubBrowser();
    const createCalls: Array<Record<string, unknown> | undefined> = [];
    const factoryCalls: Array<Record<string, unknown> | undefined> = [];
    const element = { mount: () => {}, unmount: () => {}, destroy: () => {}, on: () => {} };
    const adapter = new StripeClientAdapter({
      publishableKey: "pk",
      environment: "sandbox",
      locale: "en", // config default…
      getStripeGlobal: () => (_key, factoryOptions) => {
        factoryCalls.push(factoryOptions);
        return {
          elements: () => ({
            create: (_type, options) => {
              createCalls.push(options);
              return element;
            },
          }),
          confirmPayment: async () => ({ paymentIntent: { status: "succeeded" } }),
          confirmSetup: async () => ({ setupIntent: { status: "succeeded" } }),
          retrievePaymentIntent: async () => ({ paymentIntent: { status: "succeeded" } }),
          retrieveSetupIntent: async () => ({ setupIntent: { status: "succeeded" } }),
        };
      },
      loadScript: async () => {},
    });
    const fieldOptions = {
      layout: { type: "accordion", defaultCollapsed: false },
      paymentMethodOrder: ["card", "sepa_debit"],
      terms: { card: "never" },
    };
    await adapter.mount({} as HTMLElement, {
      clientSecret: "pi_1_secret",
      locale: "fr-FR", // …overridden per mount
      fieldOptions,
    });
    expect(createCalls[0]).toEqual(fieldOptions); // passed through untouched
    expect(factoryCalls[0]).toEqual({ locale: "fr-FR" });
  });

  it("honors a per-account capability override", () => {
    const adapter = new StripeClientAdapter({
      publishableKey: "pk",
      environment: "sandbox",
      paymentMethods: [{ type: "card", flow: "embedded", supported: true }],
    });
    expect(adapter.listPaymentMethodCapabilities()).toEqual([
      { type: "card", flow: "embedded", supported: true },
    ]);
  });
});
