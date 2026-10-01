import { afterEach, describe, expect, it, vi } from "vitest";
import { getUserMessage } from "@payfanout/core";
import { StripeClientAdapter, type StripeJsErrorLike, type StripeJsFactory, type StripeJsLike } from "../src/index.js";

const API_VERSION = "2026-08-26.dahlia";

afterEach(() => vi.unstubAllGlobals());

function stubBrowser(): void {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
}

describe("StripeClientAdapter edge cases", () => {
  it("validates its config eagerly", () => {
    expect(
      () => new StripeClientAdapter({ publishableKey: "", environment: "sandbox", apiVersion: API_VERSION }),
    ).toThrowError(/publishableKey/);
    expect(
      () => new StripeClientAdapter({ publishableKey: "pk", environment: "test" as never, apiVersion: API_VERSION }),
    ).toThrowError(/sandbox.*live/);
  });

  it("loadSdk rejects during SSR and when the script loads but the global is missing", async () => {
    const noDom = new StripeClientAdapter({ publishableKey: "pk", environment: "sandbox", apiVersion: API_VERSION });
    await expect(noDom.loadSdk()).rejects.toThrowError(/browser-only/);

    stubBrowser();
    const adapter = new StripeClientAdapter({
      publishableKey: "pk",
      environment: "sandbox",
      apiVersion: API_VERSION,
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
      apiVersion: API_VERSION,
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
      apiVersion: API_VERSION,
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
      apiVersion: API_VERSION,
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
      apiVersion: API_VERSION,
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
        apiVersion: API_VERSION,
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

    const exotic = makeAdapter({ type: "future_error", message: "Something odd." });
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
        apiVersion: API_VERSION,
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
      [{ type: "card_error", code: "expired_card" }, "expired_card", false],
      [{ type: "card_error", code: "expired_payment_method" }, "expired_card", false],
      // 2026-08-26.dahlia's restriction code is a plain decline, unless a fraud decline code
      // comes with it, as on the server.
      [{ type: "card_error", code: "payment_method_restricted" }, "card_declined", false],
      [{ type: "card_error", code: "payment_method_restricted", decline_code: "lost_card" }, "fraud_suspected", false],
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
      // Any other field the customer has to correct, never a decline.
      [{ type: "validation_error" }, "invalid_card_data", false],
      // The types the server maps by the SDK's error class, the same way.
      [{ type: "rate_limit_error" }, "rate_limited", true],
      [{ type: "api_connection_error" }, "psp_unavailable", true],
      [{ type: "api_error" }, "psp_unavailable", true],
      [{ type: "authentication_error" }, "invalid_request", false],
      [{ type: "idempotency_error" }, "invalid_request", false],
      [{ type: "invalid_request_error" }, "invalid_request", false],
      // Both 429s by their codes, whatever the type, as the server reads every 429.
      [{ type: "invalid_request_error", code: "rate_limit" }, "rate_limited", true],
      [{ type: "invalid_request_error", code: "lock_timeout" }, "rate_limited", true],
      // Stripe.js may report a failed 3-D Secure as an invalid request: the codes come first.
      [{ type: "invalid_request_error", code: "payment_intent_authentication_failure" }, "authentication_required", false],
      [{ type: "invalid_request_error", code: "setup_intent_authentication_failure" }, "authentication_required", false],
      // An intent past the confirmable states, read before the type, with an open outcome.
      [{ type: "invalid_request_error", code: "payment_intent_unexpected_state" }, "invalid_request", false],
      [{ type: "invalid_request_error", code: "setup_intent_unexpected_state" }, "invalid_request", false],
      [{ type: "api_error", code: "payment_intent_unexpected_state" }, "invalid_request", false],
      // Only the lists' own entries count.
      [{ type: "card_error", code: "card_declined", decline_code: "constructor" }, "card_declined", false],
      [{ type: "constructor", code: "constructor" }, "unknown", false],
      [{ type: "toString" }, "unknown", false],
    ];
    for (const [error, code, retryable] of cases) {
      expect(await confirmWith(error), JSON.stringify(error)).toMatchObject({ code, retryable });
    }
    vi.stubGlobal("navigator", { language: "es-ES" });
    const fraud = await confirmWith({ type: "card_error", code: "card_declined", decline_code: "stolen_card", message: "Card reported stolen." });
    expect(fraud?.message).toBe(getUserMessage("fraud_suspected", "es"));
    // A card or validation error's message is Stripe.js's own, which it localizes.
    const funds = await confirmWith({ type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Fonds insuffisants." });
    expect(funds?.message).toBe("Fonds insuffisants.");
    const field = await confirmWith({ type: "validation_error", message: "Champ incomplet." });
    expect(field?.message).toBe("Champ incomplet.");
    // Stripe does not write the other types' messages for the customer, who reads core's.
    const catalogued = [
      ["rate_limit_error", "rate_limited"],
      ["api_connection_error", "psp_unavailable"],
      ["api_error", "psp_unavailable"],
      ["authentication_error", "invalid_request"],
      ["idempotency_error", "invalid_request"],
      ["invalid_request_error", "invalid_request"],
      ["future_error", "unknown"],
    ] as const;
    for (const [type, code] of catalogued) {
      expect((await confirmWith({ type, message: "Developer detail." }))?.message, type).toBe(getUserMessage(code, "es"));
    }
    expect((await confirmWith({ message: "Developer detail." }))?.message).toBe(getUserMessage("unknown", "es"));
    // The deliberate exception: a failed 3-D Secure keeps Stripe's text under any type, as
    // core's authentication_required message asks for the authentication that just failed.
    for (const code of ["authentication_failure", "payment_intent_authentication_failure", "setup_intent_authentication_failure"]) {
      const failed = await confirmWith({ type: "invalid_request_error", code, message: "Authentification refusée." });
      expect(failed, code).toMatchObject({ code: "authentication_required", message: "Authentification refusée." });
    }
    // A reused key's first request ran and may have gone through, as on the server, and an
    // intent may be past the confirmable states by the payment this call repeats.
    expect((await confirmWith({ type: "idempotency_error" }))?.outcomeUnknown).toBe(true);
    for (const code of ["payment_intent_unexpected_state", "setup_intent_unexpected_state"]) {
      expect((await confirmWith({ type: "invalid_request_error", code }))?.outcomeUnknown, code).toBe(true);
    }
    expect((await confirmWith({ type: "invalid_request_error" }))?.outcomeUnknown).toBeUndefined();
    expect((await confirmWith({ type: "authentication_error" }))?.outcomeUnknown).toBeUndefined();
  });

  it("reports the state of an intent a confirmation finds past the confirmable states", async () => {
    stubBrowser();
    const confirmWith = async (clientSecret: string, error: StripeJsErrorLike) => {
      const adapter = new StripeClientAdapter({
        publishableKey: "pk",
        environment: "sandbox",
        apiVersion: API_VERSION,
        getStripeGlobal: () => () => ({
          elements: () => ({ create: () => ({ mount: () => {}, unmount: () => {}, destroy: () => {}, on: () => {} }) }),
          confirmPayment: async () => ({ error }),
          confirmSetup: async () => ({ error }),
          retrievePaymentIntent: async () => ({ error }),
          retrieveSetupIntent: async () => ({ error }),
        }),
        loadScript: async () => {},
      });
      return adapter.confirm(await adapter.mount({} as HTMLElement, { clientSecret }));
    };
    const unexpected = { type: "invalid_request_error", code: "payment_intent_unexpected_state" };
    // A double submit, or a retry whose first attempt went through, reads as the intent stands.
    for (const status of ["succeeded", "processing", "requires_capture", "canceled"]) {
      expect(await confirmWith("pi_1_secret", { ...unexpected, payment_intent: { status } }), status).toEqual({ status });
    }
    const setupDone = { type: "invalid_request_error", code: "setup_intent_unexpected_state", setup_intent: { status: "succeeded" } };
    expect(await confirmWith("seti_1_secret", setupDone)).toEqual({ status: "succeeded" });
    // Without the status of the intent the code names, the outcome stays open.
    const withoutStatus = [
      unexpected,
      { ...unexpected, payment_intent: {} },
      { ...unexpected, setup_intent: { status: "succeeded" } },
      // States a confirmation accepts, and one Stripe may add later, are not settled.
      { ...unexpected, payment_intent: { status: "requires_payment_method" } },
      { ...unexpected, payment_intent: { status: "requires_action" } },
      { ...unexpected, payment_intent: { status: "some_future_state" } },
    ];
    for (const error of withoutStatus) {
      expect(await confirmWith("pi_1_secret", error), JSON.stringify(error)).toMatchObject({
        status: "failed",
        error: { code: "invalid_request", retryable: false, outcomeUnknown: true },
      });
    }
    // Only these codes: a decline carries its intent too, and stays a failure.
    const declined = { type: "card_error", code: "card_declined", payment_intent: { status: "requires_payment_method" } };
    expect(await confirmWith("pi_1_secret", declined)).toMatchObject({ status: "failed", error: { code: "card_declined" } });
  });

  it("maps a Payment Element loaderror the way it maps a confirmation's error", async () => {
    stubBrowser();
    let loadError: ((payload?: { error?: object }) => void) | undefined;
    const element = {
      mount: () => {},
      unmount: () => {},
      destroy: () => {},
      on: (event: string, handler: (payload?: { error?: object }) => void) => {
        if (event === "loaderror") loadError = handler;
      },
    };
    const adapter = new StripeClientAdapter({
      publishableKey: "pk",
      environment: "sandbox",
      apiVersion: API_VERSION,
      getStripeGlobal: () => () => ({
        elements: () => ({ create: () => element }),
        confirmPayment: async () => ({}),
        confirmSetup: async () => ({}),
        retrievePaymentIntent: async () => ({}),
        retrieveSetupIntent: async () => ({}),
      }),
      loadScript: async () => {},
    });
    const onError = vi.fn();
    await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret", locale: "fr", onError });
    loadError!({ error: { type: "api_connection_error", message: "Network failure." } });
    loadError!({ error: { type: "invalid_request_error", message: "Developer detail." } });
    // An error event cannot report the intent's state, so its outcome stays open.
    const paid = { type: "invalid_request_error", code: "payment_intent_unexpected_state", payment_intent: { status: "succeeded" } };
    loadError!({ error: paid });
    expect(onError.mock.calls.map(([error]) => [error.code, error.retryable, error.message, error.outcomeUnknown])).toEqual([
      ["psp_unavailable", true, getUserMessage("psp_unavailable", "fr"), undefined],
      ["invalid_request", false, getUserMessage("invalid_request", "fr"), undefined],
      ["invalid_request", false, getUserMessage("invalid_request", "fr"), true],
    ]);
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
        apiVersion: API_VERSION,
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
      apiVersion: API_VERSION,
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
      apiVersion: API_VERSION,
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
      apiVersion: API_VERSION,
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
      apiVersion: API_VERSION,
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
      apiVersion: API_VERSION,
      paymentMethods: [{ type: "card", flow: "embedded", supported: true }],
    });
    expect(adapter.listPaymentMethodCapabilities()).toEqual([
      { type: "card", flow: "embedded", supported: true },
    ]);
  });
});
