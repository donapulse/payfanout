import { describe, expect, it } from "vitest";
import { screenSessionInput, type AdapterCapabilities, type CreatePaymentSessionInput } from "../src/index.js";

const caps = (overrides: Partial<AdapterCapabilities> = {}): AdapterCapabilities => ({
  pspName: "psp-x",
  supportsRefunds: true,
  supportsPartialRefunds: true,
  supportsManualCapture: false,
  supportsMultiCapture: false,
  supportsPaymentMethodVerification: false,
  supportsSavedPaymentMethods: false,
  supportsSessionUpdate: false,
  supportsEventPolling: false,
  supportsListing: false,
  requiresServerCompletion: false,
  paymentMethods: [{ type: "card", flow: "embedded", supported: true }],
  ...overrides,
});

const input = (overrides: Partial<CreatePaymentSessionInput> = {}): CreatePaymentSessionInput => ({
  amount: 1000,
  currency: "USD",
  idempotencyKey: "k",
  ...overrides,
});

describe("screenSessionInput", () => {
  it("accepts a plain card session", () => {
    expect(screenSessionInput(caps(), input())).toBeUndefined();
  });

  it("rejects manual capture without the capability, names the PSP", () => {
    expect(screenSessionInput(caps(), input({ captureMethod: "manual" }))).toMatch(/"psp-x".*manual capture/);
    expect(screenSessionInput(caps({ supportsManualCapture: true }), input({ captureMethod: "manual" }))).toBeUndefined();
  });

  it("zero-amount needs verification support — unless the session vaults the instrument", () => {
    expect(screenSessionInput(caps(), input({ amount: 0 }))).toMatch(/zero-amount/);
    expect(screenSessionInput(caps({ supportsPaymentMethodVerification: true }), input({ amount: 0 }))).toBeUndefined();
    // The save-card setup flow: no verification capability required.
    expect(
      screenSessionInput(
        caps({ supportsSavedPaymentMethods: true }),
        input({ amount: 0, savePaymentMethod: true, customer: "cus_1" }),
      ),
    ).toBeUndefined();
  });

  it("vault sessions need supportsSavedPaymentMethods", () => {
    expect(screenSessionInput(caps(), input({ savePaymentMethod: true, customer: "cus_1" }))).toMatch(
      /saved payment methods/,
    );
  });

  it("restricted method types must intersect the supported set", () => {
    expect(screenSessionInput(caps(), input({ paymentMethodTypes: ["ideal"] }))).toMatch(/none of the requested/);
    expect(screenSessionInput(caps(), input({ paymentMethodTypes: ["ideal", "card"] }))).toBeUndefined();
    expect(screenSessionInput(caps(), input({ paymentMethodTypes: [] }))).toBeUndefined();
    // Listed but not supported counts as unsupported.
    expect(
      screenSessionInput(
        caps({ paymentMethods: [{ type: "ideal", flow: "redirect", supported: false }] }),
        input({ paymentMethodTypes: ["ideal"] }),
      ),
    ).toMatch(/none of the requested/);
  });

  it("does not validate input-shape problems — missing customer is the service's job", () => {
    expect(
      screenSessionInput(caps({ supportsSavedPaymentMethods: true }), input({ savePaymentMethod: true })),
    ).toBeUndefined();
  });
});

describe("screenSessionInput — supportedCurrencies", () => {
  it("screens hard currency constraints case-insensitively; absent means unrestricted", () => {
    const constrained = caps({ supportedCurrencies: ["GBP", "EUR"] });
    expect(screenSessionInput(constrained, input({ currency: "USD" }))).toMatch(/does not support currency USD/);
    expect(screenSessionInput(constrained, input({ currency: "gbp" }))).toBeUndefined();
    expect(screenSessionInput(constrained, input({ currency: " EUR " }))).toBeUndefined();
    expect(screenSessionInput(caps(), input({ currency: "XCD" }))).toBeUndefined();
    expect(screenSessionInput(caps({ supportedCurrencies: [] }), input({ currency: "XCD" }))).toBeUndefined();
  });
});
