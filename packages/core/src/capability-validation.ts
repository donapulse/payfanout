import type { ServerPaymentAdapter } from "./adapters.js";
import { listedCurrencyCode } from "./screening.js";

/** Options for validateAdapterCapabilities. */
export interface ValidateAdapterCapabilitiesOptions {
  /**
   * Report only what stops the adapter from working, as PaymentService does
   * at registration. A declaration that works but is not written in its
   * canonical form (an `unsupportedCurrencies` code in lowercase) is then left
   * out; without this option it is reported too, and the conformance suite,
   * which passes no options, fails the adapter on it.
   */
  registration?: boolean;
}

/**
 * The capability coherence rule table: every flag an adapter claims must be
 * backed by the matching implemented surface. The two retrieval flags are
 * checked BOTH ways — they gate conformance assertions rather than only
 * describing the provider, so denying an implemented read would buy silence.
 * Returns one message per violation, in rule order, empty when coherent.
 * `@payfanout/server`'s PaymentService rejects registration on the first
 * violation (in `registration` mode) and the conformance suite asserts an
 * empty result — both consume this single implementation so the two can never
 * drift.
 */
export function validateAdapterCapabilities(
  adapter: ServerPaymentAdapter,
  options: ValidateAdapterCapabilitiesOptions = {},
): string[] {
  const caps = adapter.getCapabilities();
  const issues: string[] = [];
  if (caps.pspName !== adapter.pspName) {
    issues.push(`Adapter "${adapter.pspName}" reports capabilities for "${caps.pspName}"`);
  }
  if (caps.supportsPaymentRetrieval && typeof adapter.retrievePayment !== "function") {
    issues.push(
      `Adapter "${adapter.pspName}" claims payment retrieval but does not implement retrievePayment`,
    );
  }
  if (!caps.supportsPaymentRetrieval && typeof adapter.retrievePayment === "function") {
    issues.push(
      `Adapter "${adapter.pspName}" implements retrievePayment but declares no payment retrieval — ` +
        "the flag switches off the conformance readback assertions, so denying an implemented read buys silence",
    );
  }
  if (caps.requiresServerCompletion && typeof adapter.completePayment !== "function") {
    issues.push(
      `Adapter "${adapter.pspName}" requires server completion but does not implement completePayment`,
    );
  }
  if (caps.supportsManualCapture && typeof adapter.capturePayment !== "function") {
    issues.push(`Adapter "${adapter.pspName}" claims manual capture but does not implement capturePayment`);
  }
  if (caps.supportsPaymentMethodVerification && typeof adapter.verifyPaymentMethod !== "function") {
    issues.push(`Adapter "${adapter.pspName}" claims verification but does not implement verifyPaymentMethod`);
  }
  if (caps.supportsPartialRefunds && !caps.supportsRefunds) {
    issues.push(`Adapter "${adapter.pspName}" claims partial refunds without refund support`);
  }
  if (caps.supportsRefundRetrieval && !caps.supportsRefunds) {
    issues.push(`Adapter "${adapter.pspName}" claims refund retrieval without refund support`);
  }
  if (caps.supportsRefundRetrieval && typeof adapter.retrieveRefund !== "function") {
    issues.push(
      `Adapter "${adapter.pspName}" claims refund retrieval but does not implement retrieveRefund — ` +
        "pending refunds would be unpollable",
    );
  }
  if (!caps.supportsRefundRetrieval && typeof adapter.retrieveRefund === "function") {
    issues.push(
      `Adapter "${adapter.pspName}" implements retrieveRefund but declares no refund retrieval — ` +
        "the flag switches off the conformance refund polling, so denying an implemented read buys silence",
    );
  }
  if (caps.supportsMultiCapture && !caps.supportsManualCapture) {
    issues.push(`Adapter "${adapter.pspName}" claims multi-capture without manual capture support`);
  }
  // unsupportedCurrencies is a router pre-screen input, read here as
  // screening reads it (listedCurrencyCode). An entry that can never match
  // fails everywhere: the adapter's own refusal of the currency it meant would
  // end the cascade. One that matches in another form ("ugx") works, so only
  // the conformance suite, which passes no options, asks for the uppercase form
  // it asks of the other currency lists. The rules below it read well-formed
  // entries only.
  const declared = caps.supportedCurrencies ?? [];
  const refused: string[] = [];
  for (const entry of caps.unsupportedCurrencies ?? []) {
    const code = listedCurrencyCode(entry);
    if (code === undefined) {
      issues.push(
        `Adapter "${adapter.pspName}" declares ${describeEntry(entry)} in unsupportedCurrencies, which can ` +
          "never match a session's currency: it is not a three-letter code",
      );
      continue;
    }
    refused.push(code);
    if (!options.registration && entry !== code) {
      issues.push(
        `Adapter "${adapter.pspName}" declares "${entry}" in unsupportedCurrencies; write it "${code}", the ` +
          "uppercase ISO 4217 form",
      );
    }
    // Compared as screening reads the allowlist: each entry uppercased.
    if (declared.some((listed) => typeof listed === "string" && listed.toUpperCase() === code)) {
      issues.push(`Adapter "${adapter.pspName}" declares ${code} in both supportedCurrencies and unsupportedCurrencies`);
    }
  }
  // A rail gated to currencies the adapter itself does not accept can never be
  // routed: screening rejects the session on supportedCurrencies or
  // unsupportedCurrencies before the method rule is ever consulted. Offering
  // it is dead capability, not a gate. Scoped to the ADAPTER, not the provider
  // — supportedCurrencies is often the narrower thing an adapter's flow reaches
  // (GoCardless declares its one-off currencies, while the platform collects
  // more over flows it cannot reach).
  for (const method of caps.paymentMethods) {
    if (!method.supported || !method.currencies?.length) continue;
    if (declared.length > 0 && !method.currencies.some((c) => listsCode(declared, c))) {
      issues.push(
        `Adapter "${adapter.pspName}" offers ${method.type} in ${method.currencies.join("/")} but declares ` +
          `supportedCurrencies ${declared.join("/")} — the method can never be routed`,
      );
    } else if (method.currencies.every((c) => listsCode(refused, c))) {
      issues.push(
        `Adapter "${adapter.pspName}" offers ${method.type} in ${method.currencies.join("/")} but declares ` +
          "each of those currencies in unsupportedCurrencies — the method can never be routed",
      );
    }
  }
  if (caps.supportsSessionUpdate && typeof adapter.updatePaymentSession !== "function") {
    issues.push(
      `Adapter "${adapter.pspName}" claims session update but does not implement updatePaymentSession`,
    );
  }
  if (caps.supportsEventPolling && typeof adapter.fetchEvents !== "function") {
    issues.push(`Adapter "${adapter.pspName}" claims event polling but does not implement fetchEvents`);
  }
  if (
    caps.supportsListing &&
    (typeof adapter.listPayments !== "function" || typeof adapter.listRefunds !== "function")
  ) {
    issues.push(`Adapter "${adapter.pspName}" claims listing but does not implement listPayments/listRefunds`);
  }
  // Native subscriptions are per-operation honest: each declared operation
  // must be implemented on its own — provider support is uneven (no list on
  // some PSPs, no server-only create on others), so there is no all-or-nothing
  // surface rule like the vault's. The whole block is required (all-false for
  // PSPs without a native product); a pre-upgrade adapter shape gets a
  // violation here instead of a TypeError downstream.
  if (!caps.nativeSubscriptions) {
    issues.push(
      `Adapter "${adapter.pspName}" declares no nativeSubscriptions capability block (all-false is the explicit "no native product" declaration)`,
    );
  } else {
    for (const [flag, method] of [
      ["list", "listNativeSubscriptions"],
      ["retrieve", "retrieveNativeSubscription"],
      ["create", "createNativeSubscription"],
      ["cancel", "cancelNativeSubscription"],
    ] as const) {
      if (caps.nativeSubscriptions[flag] && typeof adapter[method] !== "function") {
        issues.push(
          `Adapter "${adapter.pspName}" claims native-subscription ${flag} but does not implement ${method}`,
        );
      }
    }
  }
  // Presence rule, like nativeSubscriptions above: the scope GATES conformance
  // assertions instead of only describing the provider, so an absent one is an
  // opt-out nobody declared rather than a shape to fail downstream.
  if (caps.webhookSignatureScope !== "raw-bytes" && caps.webhookSignatureScope !== "field-values") {
    issues.push(
      `Adapter "${adapter.pspName}" declares no webhookSignatureScope — the flag gates the ` +
        "conformance re-serialization assertion, so an absent scope would switch it off silently",
    );
  }
  // The saved-payment-methods flag demands the full method surface. Cards
  // still live at the PSP only — the coherence rule is about implemented
  // methods, not about storing card data (never).
  if (caps.supportsSavedPaymentMethods) {
    for (const method of [
      "createCustomer",
      "listSavedPaymentMethods",
      "deleteSavedPaymentMethod",
      "chargeSavedPaymentMethod",
    ] as const) {
      if (typeof adapter[method] !== "function") {
        issues.push(`Adapter "${adapter.pspName}" claims saved payment methods but does not implement ${method}`);
      }
    }
    if (caps.requiresServerCompletion && typeof adapter.savePaymentMethod !== "function") {
      issues.push(
        `Adapter "${adapter.pspName}" is tokenize-first with saved payment methods but does not implement savePaymentMethod`,
      );
    }
  }
  return issues;
}

/** Whether `codes` lists `code`, compared case-insensitively as screening compares. */
function listsCode(codes: readonly string[], code: string): boolean {
  return codes.some((listed) => listed.toUpperCase() === code.toUpperCase());
}

/** A declared entry as a message quotes it: a string in quotes, anything else as it prints. */
function describeEntry(entry: unknown): string {
  return typeof entry === "string" ? `"${entry}"` : String(entry);
}
