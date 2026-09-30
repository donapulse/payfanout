import { describe, expect, it } from "vitest";
import type { ServerPaymentAdapter } from "../src/adapters.js";
import { validateAdapterCapabilities } from "../src/capability-validation.js";
import type { AdapterCapabilities } from "../src/model.js";

const BASE_CAPS: AdapterCapabilities = {
  pspName: "fake",
  supportsPaymentRetrieval: true,
  supportsRefunds: false,
  supportsPartialRefunds: false,
  supportsRefundRetrieval: false,
  supportsManualCapture: false,
  supportsMultiCapture: false,
  modificationOutcome: "synchronous",
  supportsPaymentMethodVerification: false,
  supportsSavedPaymentMethods: false,
  supportsSessionUpdate: false,
  supportsEventPolling: false,
  supportsListing: false,
  nativeSubscriptions: { list: false, retrieve: false, create: false, cancel: false },
  webhookSignatureScope: "raw-bytes",
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
            supportsRefundRetrieval: true,
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

  const cases: Array<
    [string, Partial<AdapterCapabilities>, RegExp, Partial<Record<keyof ServerPaymentAdapter, unknown>>?]
  > = [
    ["pspName mismatch", { pspName: "other" }, /reports capabilities for "other"/],
    [
      "payment retrieval without retrievePayment",
      { supportsPaymentRetrieval: true },
      /claims payment retrieval but does not implement retrievePayment/,
      { retrievePayment: undefined },
    ],
    [
      "retrievePayment implemented while payment retrieval is denied",
      { supportsPaymentRetrieval: false },
      /implements retrievePayment but declares no payment retrieval/,
    ],
    ["server completion without completePayment", { requiresServerCompletion: true }, /completePayment/],
    ["manual capture without capturePayment", { supportsManualCapture: true }, /manual capture/],
    ["verification without verifyPaymentMethod", { supportsPaymentMethodVerification: true }, /verification/],
    ["partial refunds without refunds", { supportsPartialRefunds: true }, /partial refunds without refund support/],
    [
      "refund retrieval without refund support",
      { supportsRefundRetrieval: true },
      /claims refund retrieval without refund support/,
      { retrieveRefund: () => {} },
    ],
    [
      "refund retrieval without retrieveRefund",
      { supportsRefunds: true, supportsRefundRetrieval: true },
      /claims refund retrieval but does not implement retrieveRefund/,
    ],
    [
      "retrieveRefund implemented while refund retrieval is denied",
      { supportsRefunds: true, supportsRefundRetrieval: false },
      /implements retrieveRefund but declares no refund retrieval/,
      { retrieveRefund: () => {} },
    ],
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
  for (const [name, caps, expected, methods] of cases) {
    it(`flags ${name}`, () => {
      const issues = validateAdapterCapabilities(makeAdapter(caps, methods));
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

  it("accepts a push-only adapter that reads nothing back", () => {
    // The provider takes its payment reference as a write target only and
    // reports every outcome by webhook — coherent, not incomplete.
    expect(
      validateAdapterCapabilities(
        makeAdapter(
          {
            supportsPaymentRetrieval: false,
            supportsRefunds: true,
            supportsPartialRefunds: true,
            supportsRefundRetrieval: false,
            modificationOutcome: "asynchronous",
          },
          { retrievePayment: undefined },
        ),
      ),
    ).toEqual([]);
  });

  it("flags a missing nativeSubscriptions block instead of crashing on pre-upgrade shapes", () => {
    const issues = validateAdapterCapabilities(
      makeAdapter({ nativeSubscriptions: undefined as unknown as AdapterCapabilities["nativeSubscriptions"] }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/declares no nativeSubscriptions capability block/);
  });

  it("flags a missing webhookSignatureScope instead of silently dropping the assertion it gates", () => {
    const issues = validateAdapterCapabilities(
      makeAdapter({
        webhookSignatureScope: undefined as unknown as AdapterCapabilities["webhookSignatureScope"],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/declares no webhookSignatureScope/);
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

  const neverMatches = (entry: string) =>
    `Adapter "fake" declares ${entry} in unsupportedCurrencies, which can never match a session's currency: ` +
    "it is not a three-letter code";
  const both = (code: string) => `Adapter "fake" declares ${code} in both supportedCurrencies and unsupportedCurrencies`;

  it("flags an unsupportedCurrencies entry that can never match", () => {
    expect(
      validateAdapterCapabilities(
        makeAdapter({ unsupportedCurrencies: ["UGX", 123, null, "UG", "UGXX", ""] as unknown as string[] }),
      ),
    ).toEqual([
      neverMatches("123"),
      neverMatches("null"),
      neverMatches('"UG"'),
      neverMatches('"UGXX"'),
      neverMatches('""'),
    ]);
  });

  it("accepts an entry screening matches in another form; its bare uppercase form is the suite's check", () => {
    expect(
      validateAdapterCapabilities(makeAdapter({ unsupportedCurrencies: ["ugx", " CLP", "Isk", "JPY"] })),
    ).toEqual([]);
  });

  it("flags a currency declared in both supportedCurrencies and unsupportedCurrencies", () => {
    expect(
      validateAdapterCapabilities(
        makeAdapter({ supportedCurrencies: ["GBP", "ugx", "EUR"], unsupportedCurrencies: ["UGX", "eur", "USD"] }),
      ),
    ).toEqual([both("UGX"), both("EUR")]);
  });

  it("reads supportedCurrencies as screening does when comparing the two lists", () => {
    // Screening uppercases allowlist entries without trimming them, so " UGX"
    // admits no UGX session and contradicts nothing on the other list.
    expect(
      validateAdapterCapabilities(makeAdapter({ supportedCurrencies: [" UGX"], unsupportedCurrencies: ["UGX"] })),
    ).toEqual([]);
    // An allowlist entry that is not a string admits nothing and throws nothing.
    expect(
      validateAdapterCapabilities(
        makeAdapter({ supportedCurrencies: [123, "gbp"] as unknown as string[], unsupportedCurrencies: ["GBP", "UGX"] }),
      ),
    ).toEqual([both("GBP")]);
  });

  it("reads well-formed entries only in the rail rule, and never throws on another one", () => {
    expect(
      validateAdapterCapabilities(
        makeAdapter({
          unsupportedCurrencies: [123, null, "UG", "cad"] as unknown as string[],
          paymentMethods: [
            { type: "pad", flow: "redirect", supported: true, currencies: ["CAD"] },
            { type: "interac_etransfer", flow: "redirect", supported: true, currencies: ["UG"] },
          ],
        }),
      ),
    ).toEqual([
      neverMatches("123"),
      neverMatches("null"),
      neverMatches('"UG"'),
      'Adapter "fake" offers pad in CAD but declares each of those currencies in unsupportedCurrencies — ' +
        "the method can never be routed",
    ]);
  });

  it("a rail gated to currencies the adapter refuses can never be routed", () => {
    expect(
      validateAdapterCapabilities(
        makeAdapter({
          unsupportedCurrencies: ["CAD", "USD"],
          paymentMethods: [
            { type: "card", flow: "embedded", supported: true },
            { type: "pad", flow: "redirect", supported: true, currencies: ["cad", "USD"] },
          ],
        }),
      ),
    ).toEqual([
      'Adapter "fake" offers pad in cad/USD but declares each of those currencies in unsupportedCurrencies — ' +
        "the method can never be routed",
    ]);
  });

  it("reports the supportedCurrencies diagnosis alone for a rail both lists shut out", () => {
    expect(
      validateAdapterCapabilities(
        makeAdapter({
          supportedCurrencies: ["GBP"],
          unsupportedCurrencies: ["CAD"],
          paymentMethods: [{ type: "pad", flow: "redirect", supported: true, currencies: ["CAD"] }],
        }),
      ),
    ).toEqual([expect.stringMatching(/offers pad in CAD but declares supportedCurrencies GBP — /)]);
  });

  it("accepts coherent unsupportedCurrencies declarations", () => {
    const refusingCad = (caps: Partial<AdapterCapabilities> = {}) =>
      validateAdapterCapabilities(makeAdapter({ unsupportedCurrencies: ["CAD"], ...caps }));
    expect(refusingCad()).toEqual([]);
    expect(validateAdapterCapabilities(makeAdapter({ unsupportedCurrencies: [] }))).toEqual([]);
    // One currency left to a rail keeps it routable.
    expect(
      refusingCad({
        paymentMethods: [{ type: "pad", flow: "redirect", supported: true, currencies: ["CAD", "USD"] }],
      }),
    ).toEqual([]);
    // An unsupported rail's gate is inert, and an unrestricted rail is always reachable.
    expect(
      refusingCad({ paymentMethods: [{ type: "pad", flow: "redirect", supported: false, currencies: ["CAD"] }] }),
    ).toEqual([]);
    expect(
      refusingCad({ paymentMethods: [{ type: "card", flow: "embedded", supported: true, currencies: [] }] }),
    ).toEqual([]);
    // A refused currency the allowlist already leaves out is redundant, not contradictory.
    expect(refusingCad({ supportedCurrencies: ["GBP", "EUR"] })).toEqual([]);
  });
});
