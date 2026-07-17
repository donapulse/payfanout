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
  nativeSubscriptions: { list: false, retrieve: false, create: false, cancel: false },
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

describe("screenSessionInput — per-method currencies", () => {
  const rails = caps({
    paymentMethods: [
      { type: "card", flow: "embedded", supported: true },
      { type: "sepa_debit", flow: "embedded", supported: true, currencies: ["EUR"] },
      { type: "pad", flow: "redirect", supported: true, currencies: ["CAD", "USD"] },
    ],
  });

  it("skips a rail requested outside its currency, and says so", () => {
    expect(screenSessionInput(rails, input({ currency: "GBP", paymentMethodTypes: ["sepa_debit"] }))).toMatch(
      /none of the requested payment method types in GBP: sepa_debit/,
    );
    expect(screenSessionInput(rails, input({ currency: "EUR", paymentMethodTypes: ["sepa_debit"] }))).toBeUndefined();
  });

  it("distinguishes an unsupported rail from a currency-ineligible one", () => {
    // Both skip the candidate, but the router surfaces these strings when every
    // candidate was skipped — "we don't do SEPA" would be a lie about the first.
    expect(screenSessionInput(rails, input({ currency: "GBP", paymentMethodTypes: ["sepa_debit"] }))).toMatch(
      /in GBP/,
    );
    expect(screenSessionInput(rails, input({ currency: "GBP", paymentMethodTypes: ["ideal"] }))).not.toMatch(/in GBP/);
  });

  it("a rail listing several currencies matches any of them, case-insensitively", () => {
    expect(screenSessionInput(rails, input({ currency: "CAD", paymentMethodTypes: ["pad"] }))).toBeUndefined();
    expect(screenSessionInput(rails, input({ currency: "usd", paymentMethodTypes: ["pad"] }))).toBeUndefined();
    expect(screenSessionInput(rails, input({ currency: "EUR", paymentMethodTypes: ["pad"] }))).toMatch(/in EUR/);
  });

  it("absent or empty means unrestricted, exactly as supportedCurrencies reads", () => {
    expect(screenSessionInput(rails, input({ currency: "JPY", paymentMethodTypes: ["card"] }))).toBeUndefined();
    const empty = caps({ paymentMethods: [{ type: "card", flow: "embedded", supported: true, currencies: [] }] });
    expect(screenSessionInput(empty, input({ currency: "JPY", paymentMethodTypes: ["card"] }))).toBeUndefined();
  });

  it("one eligible rail carries a multi-method request", () => {
    // Screening answers "can this candidate serve the payment at all" — via
    // card, it can, so the router must not skip it. Narrowing what the adapter
    // then offers the PSP is the adapter's own concern, not this predicate's
    // (see #89 — Stripe still forwards the ineligible rail today).
    expect(
      screenSessionInput(rails, input({ currency: "GBP", paymentMethodTypes: ["sepa_debit", "card"] })),
    ).toBeUndefined();
  });

  it("ignores the constraint on a rail the PSP does not support", () => {
    const off = caps({
      paymentMethods: [
        { type: "card", flow: "embedded", supported: true },
        { type: "sepa_debit", flow: "embedded", supported: false, currencies: ["EUR"] },
      ],
    });
    expect(screenSessionInput(off, input({ currency: "EUR", paymentMethodTypes: ["sepa_debit"] }))).toMatch(
      /none of the requested payment method types: sepa_debit/,
    );
  });
});

describe("screenSessionInput — per-method countries", () => {
  const rails = caps({
    paymentMethods: [
      { type: "card", flow: "embedded", supported: true },
      { type: "bacs_debit", flow: "embedded", supported: true, currencies: ["GBP"], countries: ["GB"] },
      { type: "interac_etransfer", flow: "redirect", supported: true, currencies: ["CAD"], countries: ["CA"] },
    ],
  });

  it("skips a rail requested for a customer outside its countries, and says so", () => {
    expect(
      screenSessionInput(
        rails,
        input({ currency: "GBP", customerCountry: "US", paymentMethodTypes: ["bacs_debit"] }),
      ),
    ).toMatch(/none of the requested payment method types for customer country US: bacs_debit/);
    expect(
      screenSessionInput(
        rails,
        input({ currency: "GBP", customerCountry: "GB", paymentMethodTypes: ["bacs_debit"] }),
      ),
    ).toBeUndefined();
  });

  it("screens nothing when the session does not state customerCountry", () => {
    // The constraint is real but unknowable without the field — the rail must
    // stay routable rather than be guessed away. This is the decided answer to
    // "what does an absent country mean": absent screens nothing.
    expect(
      screenSessionInput(rails, input({ currency: "GBP", paymentMethodTypes: ["bacs_debit"] })),
    ).toBeUndefined();
  });

  it("matches case-insensitively and trims; absent or empty countries means unrestricted", () => {
    expect(
      screenSessionInput(
        rails,
        input({ currency: "CAD", customerCountry: " ca ", paymentMethodTypes: ["interac_etransfer"] }),
      ),
    ).toBeUndefined();
    expect(
      screenSessionInput(rails, input({ currency: "USD", customerCountry: "JP", paymentMethodTypes: ["card"] })),
    ).toBeUndefined();
    const empty = caps({
      paymentMethods: [{ type: "card", flow: "embedded", supported: true, countries: [] }],
    });
    expect(
      screenSessionInput(empty, input({ currency: "USD", customerCountry: "JP", paymentMethodTypes: ["card"] })),
    ).toBeUndefined();
  });

  it("prefers the currency diagnosis when a rail fails both gates", () => {
    expect(
      screenSessionInput(
        rails,
        input({ currency: "EUR", customerCountry: "US", paymentMethodTypes: ["bacs_debit"] }),
      ),
    ).toMatch(/in EUR/);
  });

  it("one country-eligible rail carries a multi-method request", () => {
    // Same predicate contract as currencies: screening answers "can this
    // candidate serve the payment at all" — via card, it can.
    expect(
      screenSessionInput(
        rails,
        input({ currency: "GBP", customerCountry: "US", paymentMethodTypes: ["bacs_debit", "card"] }),
      ),
    ).toBeUndefined();
  });

  it("distinguishes a country-ineligible rail from an unsupported one", () => {
    expect(
      screenSessionInput(rails, input({ currency: "GBP", customerCountry: "US", paymentMethodTypes: ["ideal"] })),
    ).not.toMatch(/customer country/);
  });
});
