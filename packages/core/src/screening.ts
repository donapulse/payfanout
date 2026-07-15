import type { AdapterCapabilities } from "./model.js";
import type { CreatePaymentSessionInput } from "./adapters.js";

/**
 * Static capability screening for a session input — the single source of
 * truth consumed by BOTH PaymentService (which throws) and PaymentRouter
 * (which skips the candidate). These rules used to live in two hand-mirrored
 * copies that drifted, producing different answers for the same input.
 * Returns the human-readable reason the capabilities cannot serve the input,
 * or undefined when they can.
 *
 * Deliberately capability-only: input validation that no PSP could fix (a
 * savePaymentMethod session missing `customer`) stays in PaymentService —
 * skipping to another candidate cannot repair the input.
 */
export function screenSessionInput(
  caps: AdapterCapabilities,
  input: CreatePaymentSessionInput,
): string | undefined {
  const psp = caps.pspName;
  const currency = input.currency?.trim().toUpperCase();
  if (caps.supportedCurrencies && caps.supportedCurrencies.length > 0) {
    if (!caps.supportedCurrencies.some((c) => c.toUpperCase() === currency)) {
      return `"${psp}" does not support currency ${String(input.currency)}`;
    }
  }
  if (input.captureMethod === "manual" && !caps.supportsManualCapture) {
    return `"${psp}" does not support manual capture`;
  }
  // A zero-amount session is a verification — unless it exists to vault the
  // instrument, which the saved-payment-methods rule below covers instead.
  if (input.amount === 0 && !caps.supportsPaymentMethodVerification && !input.savePaymentMethod) {
    return `"${psp}" does not support zero-amount payment method verification`;
  }
  if (input.savePaymentMethod && !caps.supportsSavedPaymentMethods) {
    return `"${psp}" does not support saved payment methods`;
  }
  const customerCountry = input.customerCountry?.trim().toUpperCase();
  const requested = input.paymentMethodTypes;
  if (requested && requested.length > 0) {
    // A supported-but-ineligible rail (SEPA asked for in GBP, Bacs asked for
    // a US customer) and an outright unsupported one are different diagnoses:
    // all skip the candidate, but the router surfaces these strings when
    // every candidate was skipped, and "we don't do SEPA" would be a lie
    // about the first two.
    let ineligibleByCurrency = false;
    let ineligibleByCountry = false;
    let eligible = false;
    for (const method of caps.paymentMethods) {
      if (!method.supported || !requested.includes(method.type)) continue;
      // Absent OR empty means unrestricted, exactly as supportedCurrencies reads.
      const currencyOk =
        !method.currencies?.length || method.currencies.some((c) => c.toUpperCase() === currency);
      // Country additionally screens nothing when the session does not state
      // customerCountry — the constraint is real but unknowable here, so the
      // rail must stay routable rather than be guessed away.
      const countryOk =
        !customerCountry ||
        !method.countries?.length ||
        method.countries.some((c) => c.toUpperCase() === customerCountry);
      if (currencyOk && countryOk) {
        eligible = true;
        break;
      }
      if (!currencyOk) ineligibleByCurrency = true;
      else ineligibleByCountry = true;
    }
    if (!eligible) {
      if (ineligibleByCurrency) {
        return `"${psp}" supports none of the requested payment method types in ${String(input.currency)}: ${requested.join(", ")}`;
      }
      if (ineligibleByCountry) {
        return `"${psp}" supports none of the requested payment method types for customer country ${String(input.customerCountry)}: ${requested.join(", ")}`;
      }
      return `"${psp}" supports none of the requested payment method types: ${requested.join(", ")}`;
    }
  }
  return undefined;
}
