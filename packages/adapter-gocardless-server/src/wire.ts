import { PayFanoutError, sha256Hex } from "@payfanout/core";

/**
 * Every metadata field: "Up to 3 keys are permitted, with key names up to 50
 * characters and values up to 500 characters."
 */
export const METADATA_MAX_KEYS = 3;
const METADATA_MAX_KEY_CHARACTERS = 50;
const METADATA_MAX_VALUE_CHARACTERS = 500;

/** Limits page: "Keys must be no longer than 128 characters". */
const IDEMPOTENCY_KEY_MAX_CHARACTERS = 128;

/**
 * GoCardless does not say what its characters are. Code points count every
 * character once, where UTF-16 units and UTF-8 bytes count some twice or
 * more, so what this refuses is over the limit under all three readings.
 */
function characters(text: string): number {
  return Array.from(text).length;
}

/**
 * Refuses metadata with a key name over 50 characters or a string value over
 * 500, naming the key; nothing is truncated. The key count is the caller's to
 * keep: the adapter withholds keys past the third instead.
 */
export function assertMetadataLimits(metadata: Record<string, string>): void {
  for (const [key, value] of Object.entries(metadata)) {
    const keyCharacters = characters(key);
    if (keyCharacters > METADATA_MAX_KEY_CHARACTERS) {
      throw PayFanoutError.invalidRequest(
        `GoCardless metadata key names are at most ${METADATA_MAX_KEY_CHARACTERS} characters; "${key}" has ${keyCharacters}`,
        { key, characters: keyCharacters, limit: METADATA_MAX_KEY_CHARACTERS },
      );
    }
    const valueCharacters = typeof value === "string" ? characters(value) : 0;
    if (valueCharacters > METADATA_MAX_VALUE_CHARACTERS) {
      throw PayFanoutError.invalidRequest(
        `GoCardless metadata values are at most ${METADATA_MAX_VALUE_CHARACTERS} characters; the value of "${key}" has ${valueCharacters}`,
        { key, characters: valueCharacters, limit: METADATA_MAX_VALUE_CHARACTERS },
      );
    }
  }
}

/** Whether fetch refuses the text as a header value: a NUL, CR or LF, or any character above U+00FF. */
function unsendableInHeader(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0 || code === 10 || code === 13 || code > 0xff) return true;
  }
  return false;
}

/**
 * The Idempotency-Key header for an idempotencyKey. A key GoCardless takes
 * and fetch can send goes as given. A key over 128 characters, which
 * GoCardless answers with `idempotency_key_too_long`, or one no header can
 * carry is sent as a digest of itself instead, as the PayPal and Worldline
 * adapters derive theirs: the same key always yields the same header, and
 * neither kind can have reached GoCardless before, so no earlier request is
 * keyed differently. The 128 counts JavaScript's `length`, which for a
 * header-safe key is also its count of code points and of bytes.
 */
export async function idempotencyKeyHeader(idempotencyKey: string): Promise<string> {
  if (idempotencyKey.length <= IDEMPOTENCY_KEY_MAX_CHARACTERS && !unsendableInHeader(idempotencyKey)) {
    return idempotencyKey;
  }
  return `payfanout-sha256-${await sha256Hex(idempotencyKey)}`;
}

/**
 * GoCardless types its amounts and counts `oneOf [string, integer]`: a safe
 * non-negative integer reads as itself, and a string of ASCII digits as the
 * integer it names when that is safe. Anything else reads as undefined. None
 * of the amounts the adapter reads is documented as negative.
 */
export function wireInteger(value: unknown): number | undefined {
  const integer = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof integer === "number" && Number.isSafeInteger(integer) && integer >= 0 ? integer : undefined;
}

export type AmountResource = "payment" | "refund" | "billing request" | "subscription";

/** Fails closed: no refund arithmetic, and no money field, rests on an amount that does not read. */
export function unreadableAmount(resource: AmountResource, raw: unknown): PayFanoutError {
  return new PayFanoutError({
    code: "unknown",
    message: `GoCardless returned a ${resource} whose amount is not a whole number of minor units.`,
    retryable: false,
    raw,
    pspName: "gocardless",
  });
}

/**
 * An amount a read reports. One GoCardless omits reads as 0, as it always has;
 * one it sends that does not read rejects the read rather than reach a
 * minor-unit field as a string, a fraction or NaN.
 */
export function readAmount(value: unknown, resource: AmountResource, raw: unknown): number {
  if (value === undefined || value === null) return 0;
  const amount = wireInteger(value);
  if (amount === undefined) throw unreadableAmount(resource, raw);
  return amount;
}
