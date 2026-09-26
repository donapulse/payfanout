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

/**
 * The merchantParameters sent for this metadata: its JSON, as JSON.stringify
 * writes it, when that is an object with at least one entry; else undefined,
 * and nothing is sent. An entry JSON cannot hold, such as an undefined value,
 * is left out.
 */
export function toMerchantParameters(metadata: unknown): string | undefined {
  const sent = serialize(metadata);
  const parsed: unknown = sent === undefined ? undefined : JSON.parse(sent);
  return isJsonObject(parsed) && Object.keys(parsed).length > 0 ? sent : undefined;
}

/** The metadata as a payment made with it reports it: the merchantParameters sent for it, read back. */
export function metadataAsSent(metadata: unknown): Record<string, string> | undefined {
  return parseMerchantParameters(toMerchantParameters(metadata));
}

/**
 * Refuses session metadata whose merchantParameters would not read back as
 * that metadata, judged on the JSON that is sent rather than on the object
 * (whose toJSON, say, decides what is sent): JSON that is not an object (a
 * string's, an array's, a Date's), none at all (a function, a BigInt, a
 * cycle), an entry whose value is not a string, or JSON longer than the
 * contract's 1000 characters. The contract's
 * maxLength counts characters, which JSON Schema defines as Unicode code
 * points, and Worldline may count UTF-16 code units or UTF-8 bytes instead.
 * This counts UTF-16 code units, one for every character of the Basic
 * Multilingual Plane and two for any other (an emoji, say), so nothing it
 * accepts is over 1000 code points or code units; it can be over 1000 UTF-8
 * bytes, which any character outside ASCII takes more than one of.
 */
export function assertMerchantParametersFit(metadata: unknown): void {
  if (metadata === undefined || metadata === null) return;
  const sent = serialize(metadata);
  const parsed: unknown = sent === undefined ? undefined : JSON.parse(sent);
  if (sent === undefined || !isJsonObject(parsed)) {
    throw PayFanoutError.invalidRequest(
      `Worldline session metadata must be an object of string values (it travels as ${PROPERTY_NAME}, JSON-encoded)`,
      { propertyName: PROPERTY_NAME },
    );
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw PayFanoutError.invalidRequest(
        `Worldline session metadata values must be strings, as only those are read back from ${PROPERTY_NAME}; "${key}" is not`,
        { propertyName: PROPERTY_NAME, key },
      );
    }
  }
  if (sent.length > MERCHANT_PARAMETERS_MAX_LENGTH) {
    throw PayFanoutError.invalidRequest(
      `Worldline merchant parameters are at most ${MERCHANT_PARAMETERS_MAX_LENGTH} characters (the session metadata ` +
        `travels as ${PROPERTY_NAME}, JSON-encoded), got ${sent.length}`,
      { propertyName: PROPERTY_NAME, length: sent.length },
    );
  }
}

/**
 * The metadata a payment's paymentOutput echoes: `references.merchantParameters`,
 * else, only when that is absent (missing or null), the deprecated
 * `merchantParameters` it replaces, read by parseMerchantParameters. When the
 * payment echoes neither, `fallback` stands in: the metadata the request that
 * made the payment carried, for an answer the echo is not documented on.
 */
export function readMerchantParameters(
  paymentOutput: unknown,
  fallback?: Record<string, string>,
): Record<string, string> | undefined {
  const references = isJsonObject(paymentOutput) ? paymentOutput["references"] : undefined;
  const echoed =
    (isJsonObject(references) ? references["merchantParameters"] : undefined) ??
    (isJsonObject(paymentOutput) ? paymentOutput["merchantParameters"] : undefined);
  return echoed === undefined || echoed === null ? fallback : parseMerchantParameters(echoed);
}

/**
 * The metadata a merchantParameters value holds: a JSON object with at least
 * one entry, every value a string, as the adapter writes it. Anything else, a
 * value in another format such as the contract's example query string,
 * `SessionID=126548354&ShopperID=73541312`, is no metadata rather than an error.
 */
export function parseMerchantParameters(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // Not JSON, so not metadata the adapter wrote.
    return undefined;
  }
  if (!isJsonObject(parsed)) return undefined;
  const values = Object.values(parsed);
  return values.length > 0 && values.every((entry) => typeof entry === "string")
    ? (parsed as Record<string, string>)
    : undefined;
}

/** JSON.stringify's JSON for the value, or undefined when there is none, for a function, a BigInt or a cycle. */
function serialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value) as string | undefined;
  } catch {
    // A BigInt or a cycle, which JSON cannot hold.
    return undefined;
  }
}

/** An object JSON.parse can make: neither null nor an array. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
