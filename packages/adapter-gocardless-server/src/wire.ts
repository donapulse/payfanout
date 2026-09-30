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
    // A value that is not a string goes out as its JSON, so that is what is counted.
    const valueCharacters = characters(typeof value === "string" ? value : (JSON.stringify(value) ?? ""));
    if (valueCharacters > METADATA_MAX_VALUE_CHARACTERS) {
      throw PayFanoutError.invalidRequest(
        `GoCardless metadata values are at most ${METADATA_MAX_VALUE_CHARACTERS} characters; the value of "${key}" has ${valueCharacters}`,
        { key, characters: valueCharacters, limit: METADATA_MAX_VALUE_CHARACTERS },
      );
    }
  }
}

/** HTTP whitespace, which fetch trims from both ends of a header value before it is sent. */
const HEADER_EDGE_WHITESPACE = /^[\t\n\r ]+|[\t\n\r ]+$/g;

/**
 * Whether the Fetch standard lets a header carry the value: no character
 * above U+00FF anywhere, and no NUL, CR or LF once fetch has trimmed it. Any
 * fetch refuses a value that fails this, so no such key ever reached
 * GoCardless. Other control characters pass the standard, and a runtime may
 * send them, although Node's fetch refuses them.
 */
function fetchCanCarry(value: string, trimmed: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0xff) return false;
  }
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code === 0 || code === 10 || code === 13) return false;
  }
  return true;
}

/**
 * The Idempotency-Key header for an idempotencyKey. A key fetch can carry,
 * and whose trimmed value GoCardless takes (at most 128 characters), goes as
 * given, exactly as earlier releases sent it, so a replay of an earlier
 * request keeps its key. Any other key, one over 128 characters once trimmed
 * (GoCardless answers `idempotency_key_too_long`) or one no fetch can carry,
 * never reached GoCardless, and is sent as `payfanout-sha256-` and the
 * SHA-256 digest of itself: the same key always yields the same header. The
 * 128 counts JavaScript's `length`, which for a value fetch can carry is
 * also its count of code points and of bytes.
 */
export async function idempotencyKeyHeader(idempotencyKey: string): Promise<string> {
  const trimmed = idempotencyKey.replace(HEADER_EDGE_WHITESPACE, "");
  if (trimmed.length <= IDEMPOTENCY_KEY_MAX_CHARACTERS && fetchCanCarry(idempotencyKey, trimmed)) {
    return idempotencyKey;
  }
  return `payfanout-sha256-${await sha256Hex(idempotencyKey)}`;
}

/** A lone surrogate: text that is not well-formed Unicode. */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Refuses an idempotencyKey holding a lone surrogate. No fetch can carry it,
 * and its digest, like its refund stamp, would be the digest of every key
 * that differs from it only by another lone surrogate, as UTF-8 encoding
 * replaces each with U+FFFD: two different requests would share one key.
 */
export function assertWellFormedIdempotencyKey(idempotencyKey: string): void {
  if (typeof idempotencyKey === "string" && LONE_SURROGATE.test(idempotencyKey)) {
    throw PayFanoutError.invalidRequest(
      "The idempotencyKey holds a lone surrogate, so it is not well-formed Unicode and no request can carry it",
    );
  }
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
