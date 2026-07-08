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
  if (caps.supportedCurrencies && caps.supportedCurrencies.length > 0) {
    const currency = input.currency?.trim().toUpperCase();
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
  if (input.paymentMethodTypes && input.paymentMethodTypes.length > 0) {
    const supported = new Set(caps.paymentMethods.filter((m) => m.supported).map((m) => m.type as string));
    if (!input.paymentMethodTypes.some((t) => supported.has(t))) {
      return `"${psp}" supports none of the requested payment method types: ${input.paymentMethodTypes.join(", ")}`;
    }
  }
  return undefined;
}
