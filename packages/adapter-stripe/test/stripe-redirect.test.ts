import { afterEach, describe, expect, it, vi } from "vitest";
import { StripeClientAdapter, type StripeJsLike } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

function stubBrowser(): void {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
}

function makeAdapter(fake: Partial<StripeJsLike>): StripeClientAdapter {
  const full: StripeJsLike = {
    elements: () => ({ create: () => ({ mount: () => {}, unmount: () => {}, destroy: () => {}, on: () => {} }) }),
    confirmPayment: async () => ({ paymentIntent: { status: "succeeded" } }),
    confirmSetup: async () => ({ setupIntent: { status: "succeeded" } }),
    retrievePaymentIntent: async () => ({ paymentIntent: { status: "succeeded" } }),
    retrieveSetupIntent: async () => ({ setupIntent: { status: "succeeded" } }),
    ...fake,
  };
  return new StripeClientAdapter({
    publishableKey: "pk_test",
    environment: "sandbox",
    getStripeGlobal: () => () => full,
    loadScript: async () => {},
  });
}

describe("StripeClientAdapter.handleRedirectReturn", () => {
  it("returns null when the URL has no Stripe return params — even outside a browser", async () => {
    // No stubBrowser(): probing a paramless URL must be SSR-safe.
    const adapter = makeAdapter({});
    expect(await adapter.handleRedirectReturn({ search: "" })).toBeNull();
    expect(await adapter.handleRedirectReturn({ search: "?utm_source=mail&foo=1" })).toBeNull();
  });

  it("resolves a PaymentIntent return from the intent itself, not the redirect_status hint", async () => {
    stubBrowser();
    const retrieved: string[] = [];
    const adapter = makeAdapter({
      retrievePaymentIntent: async (secret) => {
        retrieved.push(secret);
        return { paymentIntent: { status: "processing" } };
      },
    });
    const result = await adapter.handleRedirectReturn({
      search: "?payment_intent=pi_1&payment_intent_client_secret=pi_1_secret_x&redirect_status=succeeded",
    });
    expect(result).toEqual({ status: "processing" });
    expect(retrieved).toEqual(["pi_1_secret_x"]);
  });

  it("tolerates a missing leading '?' and resolves SetupIntent returns", async () => {
    stubBrowser();
    const adapter = makeAdapter({
      retrieveSetupIntent: async () => ({ setupIntent: { status: "succeeded" } }),
    });
    const result = await adapter.handleRedirectReturn({
      search: "setup_intent=seti_1&setup_intent_client_secret=seti_1_secret_x",
    });
    expect(result).toEqual({ status: "succeeded" });
  });

  it("maps retrieval errors into the unified taxonomy", async () => {
    stubBrowser();
    const adapter = makeAdapter({
      retrievePaymentIntent: async () => ({
        error: { type: "card_error", code: "card_declined", message: "Declined." },
      }),
    });
    const result = await adapter.handleRedirectReturn({
      search: "?payment_intent_client_secret=pi_1_secret_x",
    });
    expect(result?.status).toBe("failed");
    expect(result?.error?.code).toBe("card_declined");
  });

  it("fails safe when the intent is missing from the response", async () => {
    stubBrowser();
    const adapter = makeAdapter({ retrievePaymentIntent: async () => ({}) });
    const result = await adapter.handleRedirectReturn({
      search: "?payment_intent_client_secret=pi_1_secret_x",
    });
    expect(result?.status).toBe("failed");
    expect(result?.error).toBeDefined();
  });

  it("refuses to resolve return params during SSR", async () => {
    const adapter = makeAdapter({});
    await expect(
      adapter.handleRedirectReturn({ search: "?payment_intent_client_secret=pi_1_secret_x" }),
    ).rejects.toThrowError(/browser-only/);
  });
});
