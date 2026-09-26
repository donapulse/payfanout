import { PayFanoutError } from "@payfanout/core";

/**
 * Session metadata travels to Worldline as `order.references.merchantParameters`,
 * a string Worldline stores "in the format you prefer" and echoes "back to you in
 * API GET calls and Webhook notifications" (API contract). The adapter writes it
 * as JSON. The same description adds: "This field must not contain any personal
 * data." Nothing here can tell personal data apart, so keeping it out is the
 * host's part.
 */
const MERCHANT_PARAMETERS_MAX_LENGTH = 1000;

const PROPERTY_NAME = "order.references.merchantParameters";

/** The metadata as merchantParameters, or undefined when it has no entries to send. */
export function toMerchantParameters(metadata: unknown): string | undefined {
  return isPlainObject(metadata) && Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : undefined;
}

/**
 * Refuses session metadata that would not come back as sent: a value that is
 * not a string, which readMerchantParameters would not read back, or JSON
 * longer than the contract's 1000 characters. The contract's maxLength counts
 * characters, which JSON Schema defines as Unicode code points; this counts
 * UTF-16 code units, one for every character of the Basic Multilingual Plane
 * and two for any other (an emoji, say), so nothing it accepts is over the
 * limit whether Worldline counts code points or code units.
 */
export function assertMerchantParametersFit(metadata: unknown): void {
  if (metadata === undefined || metadata === null) return;
  if (!isPlainObject(metadata)) {
    throw PayFanoutError.invalidRequest(
      `Worldline session metadata must be an object of string values (it travels as ${PROPERTY_NAME})`,
      { propertyName: PROPERTY_NAME },
    );
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== "string") {
      throw PayFanoutError.invalidRequest(
        `Worldline session metadata values must be strings, as only those are read back from ${PROPERTY_NAME}; "${key}" is not`,
        { propertyName: PROPERTY_NAME, key },
      );
    }
  }
  const length = toMerchantParameters(metadata)?.length ?? 0;
  if (length > MERCHANT_PARAMETERS_MAX_LENGTH) {
    throw PayFanoutError.invalidRequest(
      `Worldline merchant parameters are at most ${MERCHANT_PARAMETERS_MAX_LENGTH} characters (the session metadata ` +
        `travels as ${PROPERTY_NAME}, JSON-encoded), got ${length}`,
      { propertyName: PROPERTY_NAME, length },
    );
  }
}

/**
 * The metadata a payment's paymentOutput echoes: `references.merchantParameters`,
 * else, only when that is absent, the deprecated `merchantParameters` it
 * replaces. Read only when it parses to a JSON object with at least one entry,
 * every value a string, as the adapter writes it; anything else, a query string
 * another integration stored for one, reads as no metadata instead of throwing.
 */
export function readMerchantParameters(paymentOutput: unknown): Record<string, string> | undefined {
  if (!isPlainObject(paymentOutput)) return undefined;
  const references = paymentOutput["references"];
  const echoed =
    (isPlainObject(references) ? references["merchantParameters"] : undefined) ?? paymentOutput["merchantParameters"];
  if (typeof echoed !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(echoed);
  } catch {
    // Not JSON, so not metadata the adapter wrote.
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  const values = Object.values(parsed);
  return values.length > 0 && values.every((value) => typeof value === "string")
    ? (parsed as Record<string, string>)
    : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
