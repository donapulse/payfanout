import { PAYMENT_METHOD_FLOWS, PAYMENT_METHOD_TYPES, type AdapterCapabilities } from "@payfanout/core";

/** The capability lists the server suite holds to a shape. */
export type DeclaredShapes = Pick<AdapterCapabilities, "paymentMethods" | "supportedCurrencies" | "unsupportedCurrencies">;

const CURRENCY_CODE = { pattern: /^[A-Z]{3}$/, form: "three uppercase letters" };
const COUNTRY_CODE = { pattern: /^[A-Z]{2}$/, form: "two uppercase letters" };

/**
 * The server suite's own shape checks on an adapter's declaration, on top of
 * core's coherence rules (validateAdapterCapabilities). Returns one message
 * per violation, in declaration order, empty when well-formed. Kept pure so
 * every rule is pinned by a failing input of its own: the suite's self-tests
 * only run adapters that pass, so a loosened check would go unnoticed there.
 */
export function validateDeclarationShapes(pspName: string, declared: DeclaredShapes): string[] {
  const problems: string[] = [];
  if (!(pspName.length > 0)) problems.push("pspName is empty");
  if (!(declared.paymentMethods.length > 0)) problems.push("paymentMethods is empty");
  let index = 0;
  for (const method of declared.paymentMethods) {
    const at = `paymentMethods[${index}]`;
    if (!PAYMENT_METHOD_TYPES.includes(method.type)) {
      problems.push(`${at}.type ${shown(method.type)} is not in PAYMENT_METHOD_TYPES`);
    }
    if (!PAYMENT_METHOD_FLOWS.includes(method.flow)) {
      problems.push(`${at}.flow ${shown(method.flow)} is not in PAYMENT_METHOD_FLOWS`);
    }
    if (typeof method.supported !== "boolean") {
      problems.push(`${at}.supported ${shown(method.supported)} is not a boolean`);
    }
    // Per-method currencies is the same pre-screen input at rail scope: a
    // malformed code never matches, silently disabling the rail instead of
    // gating it. A single-currency rail (SEPA/EUR) that omits it routes
    // dishonestly — but only the adapter knows, so shape is what's checkable.
    checkCodes(problems, `${at}.currencies`, method.currencies, CURRENCY_CODE);
    // Countries mirror currencies (ISO 3166-1 alpha-2, customer side): a
    // malformed code never matches a session's customerCountry, so the rail
    // silently screens out for every session that states one.
    checkCodes(problems, `${at}.countries`, method.countries, COUNTRY_CODE);
    index += 1;
  }
  // supportedCurrencies is a router pre-screen input — malformed codes would
  // silently disable a PSP for every payment.
  checkCodes(problems, "supportedCurrencies", declared.supportedCurrencies, CURRENCY_CODE);
  // unsupportedCurrencies is the same input, inverted. Core already fails an
  // entry that can never match; a working one is held here to the bare
  // uppercase form of the lists above.
  checkCodes(problems, "unsupportedCurrencies", declared.unsupportedCurrencies, CURRENCY_CODE);
  return problems;
}

function checkCodes(
  problems: string[],
  field: string,
  codes: Iterable<unknown> | undefined,
  code: { pattern: RegExp; form: string },
): void {
  let index = 0;
  for (const entry of codes ?? []) {
    // Checked before the pattern: RegExp#test coerces, so ["EUR"] would pass it.
    if (typeof entry !== "string") problems.push(`${field}[${index}] is not a string`);
    else if (!code.pattern.test(entry)) problems.push(`${field}[${index}] ${shown(entry)} is not ${code.form}`);
    index += 1;
  }
}

/** A declared value as a message shows it: a string quoted with its whitespace visible, anything else as it prints. */
function shown(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
