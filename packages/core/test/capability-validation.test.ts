import { describe, expect, it } from "vitest";
import type { ServerPaymentAdapter } from "../src/adapters.js";
import { validateAdapterCapabilities } from "../src/capability-validation.js";
import type { AdapterCapabilities } from "../src/model.js";

const BASE_CAPS: AdapterCapabilities = {
  pspName: "fake",
  supportsRefunds: false,
  supportsPartialRefunds: false,
  supportsManualCapture: false,
  supportsMultiCapture: false,
  supportsPaymentMethodVerification: false,
  supportsSavedPaymentMethods: false,
  supportsSessionUpdate: false,
  supportsEventPolling: false,
  supportsListing: false,
  requiresServerCompletion: false,
  paymentMethods: [{ type: "card", flow: "embedded", supported: true }],
};

function makeAdapter(
  caps: Partial<AdapterCapabilities>,
  methods: Partial<Record<keyof ServerPaymentAdapter, unknown>> = {},
): ServerPaymentAdapter {
  const never = () => Promise.reject(new Error("not under test"));
  return {
    pspName: "fake",
    getCapabilities: () => ({ ...BASE_CAPS, ...caps }),
    createPaymentSession: never,
    retrievePayment: never,
    cancelPayment: never,
    refundPayment: never,
    verifyWebhookSignature: never,
    parseWebhookEvent: never,
    ...methods,
  } as ServerPaymentAdapter;
}

describe("validateAdapterCapabilities", () => {
  it("answers no issues for a coherent adapter", () => {
    expect(validateAdapterCapabilities(makeAdapter({}))).toEqual([]);
    expect(
      validateAdapterCapabilities(
        makeAdapter(
          {
            supportsRefunds: true,
            supportsPartialRefunds: true,
            supportsManualCapture: true,
            supportsMultiCapture: true,
            supportsPaymentMethodVerification: true,
            supportsSessionUpdate: true,
            supportsEventPolling: true,
            supportsListing: true,
            requiresServerCompletion: true,
            supportsSavedPaymentMethods: true,
          },
          {
            completePayment: () => {},
            capturePayment: () => {},
            verifyPaymentMethod: () => {},
            retrieveRefund: () => {},
            updatePaymentSession: () => {},
            fetchEvents: () => {},
            listPayments: () => {},
            listRefunds: () => {},
            createCustomer: () => {},
            savePaymentMethod: () => {},
            listSavedPaymentMethods: () => {},
            deleteSavedPaymentMethod: () => {},
            chargeSavedPaymentMethod: () => {},
          },
        ),
      ),
    ).toEqual([]);
  });

  const cases: Array<[string, Partial<AdapterCapabilities>, RegExp]> = [
    ["pspName mismatch", { pspName: "other" }, /reports capabilities for "other"/],
    ["server completion without completePayment", { requiresServerCompletion: true }, /completePayment/],
    ["manual capture without capturePayment", { supportsManualCapture: true }, /manual capture/],
    ["verification without verifyPaymentMethod", { supportsPaymentMethodVerification: true }, /verification/],
    ["partial refunds without refunds", { supportsPartialRefunds: true }, /partial refunds without refund support/],
    ["refunds without retrieveRefund", { supportsRefunds: true }, /retrieveRefund/],
    ["multi-capture without manual capture", { supportsMultiCapture: true }, /multi-capture without manual capture/],
    ["session update without updatePaymentSession", { supportsSessionUpdate: true }, /session update/],
    ["event polling without fetchEvents", { supportsEventPolling: true }, /event polling/],
    ["listing without listPayments/listRefunds", { supportsListing: true }, /listPayments\/listRefunds/],
  ];
  for (const [name, caps, expected] of cases) {
    it(`flags ${name}`, () => {
      const issues = validateAdapterCapabilities(makeAdapter(caps));
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(expected);
    });
  }

  it("demands the full vault surface, savePaymentMethod only when tokenize-first", () => {
    const missingAll = validateAdapterCapabilities(makeAdapter({ supportsSavedPaymentMethods: true }));
    expect(missingAll).toHaveLength(4);
    for (const issue of missingAll) expect(issue).toMatch(/saved payment methods/);

    const vaultMethods = {
      createCustomer: () => {},
      listSavedPaymentMethods: () => {},
      deleteSavedPaymentMethod: () => {},
      chargeSavedPaymentMethod: () => {},
    };
    expect(
      validateAdapterCapabilities(makeAdapter({ supportsSavedPaymentMethods: true }, vaultMethods)),
    ).toEqual([]);
    // Tokenize-first vaulting additionally needs savePaymentMethod.
    const tokenizeFirst = validateAdapterCapabilities(
      makeAdapter(
        { supportsSavedPaymentMethods: true, requiresServerCompletion: true },
        { ...vaultMethods, completePayment: () => {} },
      ),
    );
    expect(tokenizeFirst).toHaveLength(1);
    expect(tokenizeFirst[0]).toMatch(/tokenize-first .* savePaymentMethod/);
  });

  it("reports every violation, in rule order", () => {
    expect(
      validateAdapterCapabilities(makeAdapter({ supportsManualCapture: true, supportsSessionUpdate: true })),
    ).toEqual([expect.stringMatching(/manual capture/), expect.stringMatching(/session update/)]);
  });
});
