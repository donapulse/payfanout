import type { ServerPaymentAdapter } from "./adapters.js";

/**
 * The capability coherence rule table: every flag an adapter claims must be
 * backed by the matching implemented surface. Returns one message per
 * violation, in rule order, empty when coherent. `@payfanout/server`'s
 * PaymentService rejects registration on the first violation and the
 * conformance suite asserts an empty result — both consume this single
 * implementation so the two can never drift.
 */
export function validateAdapterCapabilities(adapter: ServerPaymentAdapter): string[] {
  const caps = adapter.getCapabilities();
  const issues: string[] = [];
  if (caps.pspName !== adapter.pspName) {
    issues.push(`Adapter "${adapter.pspName}" reports capabilities for "${caps.pspName}"`);
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
  if (caps.supportsRefunds && typeof adapter.retrieveRefund !== "function") {
    issues.push(
      `Adapter "${adapter.pspName}" supports refunds but does not implement retrieveRefund — ` +
        "pending refunds would be unpollable",
    );
  }
  if (caps.supportsMultiCapture && !caps.supportsManualCapture) {
    issues.push(`Adapter "${adapter.pspName}" claims multi-capture without manual capture support`);
  }
  // A rail gated to currencies the PSP itself does not accept can never be
  // routed: screening rejects the session on supportedCurrencies before the
  // method rule is ever consulted. Offering it is dead capability, not a gate.
  const pspCurrencies = caps.supportedCurrencies ?? [];
  if (pspCurrencies.length > 0) {
    for (const method of caps.paymentMethods) {
      if (!method.supported || !method.currencies?.length) continue;
      const reachable = method.currencies.some((c) =>
        pspCurrencies.some((s) => s.toUpperCase() === c.toUpperCase()),
      );
      if (!reachable) {
        issues.push(
          `Adapter "${adapter.pspName}" offers ${method.type} in ${method.currencies.join("/")} but the PSP ` +
            `supports none of those currencies — the method can never be routed`,
        );
      }
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
