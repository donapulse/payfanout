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
  nativeSubscriptions: { list: false, retrieve: false, create: false, cancel: false },
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
            nativeSubscriptions: { list: true, retrieve: true, create: true, cancel: true },
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
            listNativeSubscriptions: () => {},
            retrieveNativeSubscription: () => {},
            createNativeSubscription: () => {},
            cancelNativeSubscription: () => {},
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
    [
      "native-subscription list without listNativeSubscriptions",
      { nativeSubscriptions: { list: true, retrieve: false, create: false, cancel: false } },
      /native-subscription list .* listNativeSubscriptions/,
    ],
    [
      "native-subscription retrieve without retrieveNativeSubscription",
      { nativeSubscriptions: { list: false, retrieve: true, create: false, cancel: false } },
      /native-subscription retrieve .* retrieveNativeSubscription/,
    ],
    [
      "native-subscription create without createNativeSubscription",
      { nativeSubscriptions: { list: false, retrieve: false, create: true, cancel: false } },
      /native-subscription create .* createNativeSubscription/,
    ],
    [
      "native-subscription cancel without cancelNativeSubscription",
      { nativeSubscriptions: { list: false, retrieve: false, create: false, cancel: true } },
      /native-subscription cancel .* cancelNativeSubscription/,
    ],
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

  it("flags a missing nativeSubscriptions block instead of crashing on pre-upgrade shapes", () => {
    const issues = validateAdapterCapabilities(
      makeAdapter({ nativeSubscriptions: undefined as unknown as AdapterCapabilities["nativeSubscriptions"] }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/declares no nativeSubscriptions capability block/);
  });

  it("accepts per-operation native-subscription surfaces (uneven provider support)", () => {
    // PayZen-shaped: no list API at the provider — three operations, honestly declared.
    expect(
      validateAdapterCapabilities(
        makeAdapter(
          { nativeSubscriptions: { list: false, retrieve: true, create: true, cancel: true } },
          {
            retrieveNativeSubscription: () => {},
            createNativeSubscription: () => {},
            cancelNativeSubscription: () => {},
          },
        ),
      ),
    ).toEqual([]);
    // Each missing operation is its own violation, not one lump.
    const issues = validateAdapterCapabilities(
      makeAdapter({ nativeSubscriptions: { list: true, retrieve: true, create: false, cancel: true } }),
    );
    expect(issues).toEqual([
      expect.stringMatching(/native-subscription list/),
      expect.stringMatching(/native-subscription retrieve/),
      expect.stringMatching(/native-subscription cancel/),
    ]);
  });

  it("reports every violation, in rule order", () => {
    expect(
      validateAdapterCapabilities(makeAdapter({ supportsManualCapture: true, supportsSessionUpdate: true })),
    ).toEqual([expect.stringMatching(/manual capture/), expect.stringMatching(/session update/)]);
  });

  it("a rail gated to currencies the adapter does not declare can never be routed", () => {
    const issues = validateAdapterCapabilities(
      makeAdapter({
        supportedCurrencies: ["GBP", "EUR"],
        paymentMethods: [
          { type: "card", flow: "embedded", supported: true },
          { type: "pad", flow: "redirect", supported: true, currencies: ["CAD"] },
        ],
      }),
    );
    expect(issues).toHaveLength(1);
    // Scoped to the adapter's own declaration, not the provider's real reach.
    expect(issues[0]).toMatch(/offers pad in CAD but declares supportedCurrencies GBP\/EUR/);
    expect(issues[0]).toMatch(/never be routed/);
  });

  it("accepts coherent, unconstrained, and unsupported-rail currency declarations", () => {
    const methods = (paymentMethods: AdapterCapabilities["paymentMethods"]) =>
      validateAdapterCapabilities(makeAdapter({ supportedCurrencies: ["GBP", "EUR"], paymentMethods }));
    // Overlaps the declared list (case-insensitively).
    expect(methods([{ type: "sepa_debit", flow: "embedded", supported: true, currencies: ["eur"] }])).toEqual([]);
    // Unrestricted rails are always reachable.
    expect(methods([{ type: "card", flow: "embedded", supported: true }])).toEqual([]);
    expect(methods([{ type: "card", flow: "embedded", supported: true, currencies: [] }])).toEqual([]);
    // An unsupported rail's gate is inert — nothing to misroute.
    expect(methods([{ type: "pad", flow: "redirect", supported: false, currencies: ["CAD"] }])).toEqual([]);
    // An adapter that declares no currency list constrains nothing.
    expect(
      validateAdapterCapabilities(
        makeAdapter({ paymentMethods: [{ type: "pad", flow: "redirect", supported: true, currencies: ["CAD"] }] }),
      ),
    ).toEqual([]);
  });
});
