import { firstCurrencyCode, NO_CURRENCY, PayFanoutError } from "@payfanout/core";

/**
 * Refuses core's NO_CURRENCY (`XXX`) as an input currency: adapters report it
 * for a record that states no currency, so it names no currency to charge in.
 */
export function refuseNoCurrency(currency: string | undefined, what: string, pspName?: string): void {
  if (firstCurrencyCode(currency) !== NO_CURRENCY) return;
  throw new PayFanoutError({
    code: "invalid_request",
    message: `${what} was given currency ${NO_CURRENCY}, which adapters report for a record that states no currency — pass the currency to charge in`,
    retryable: false,
    ...(pspName !== undefined ? { pspName } : {}),
  });
}
