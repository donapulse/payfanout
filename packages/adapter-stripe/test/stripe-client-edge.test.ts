import { afterEach, describe, expect, it, vi } from "vitest";
import { StripeClientAdapter, type StripeJsLike } from "../src/index.js";

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

  it("maps validation errors and unrecognized failures distinctly", async () => {
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

    const exotic = makeAdapter({ type: "api_error", message: "Something odd." });
    const eHandle = await exotic.mount({} as HTMLElement, { clientSecret: "pi_1_secret" });
    const eResult = await exotic.confirm(eHandle);
    expect(eResult.error?.code).toBe("unknown");
    expect(eResult.status).toBe("failed");
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
