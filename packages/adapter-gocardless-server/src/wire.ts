import { NO_CURRENCY, PayFanoutError, sha256Hex } from "@payfanout/core";

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

/** HTTP whitespace (tab, LF, CR, space), which fetch trims from both ends of a header value before it is sent. */
function isHeaderWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 13 || code === 32;
}

/** The value fetch sends for a header: `value` with its edge HTTP whitespace trimmed, in one linear pass. */
function trimHeaderWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isHeaderWhitespace(value.charCodeAt(start))) start += 1;
  while (end > start && isHeaderWhitespace(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

/**
 * Whether GoCardless can have taken a key, with fetch's edge whitespace
 * trimmed, as given: no NUL, CR or LF inside it, which no runtime sends in a
 * header, and at most 128 characters as GoCardless may have read them.
 * Cloudflare Workers sends every character as UTF-8, and code points are the
 * smallest count of those, so a longer key was answered
 * `idempotency_key_too_long` however GoCardless counts. Node's fetch refuses
 * characters above U+00FF and ASCII control characters other than tab before
 * sending, and sends U+0080 to U+00FF as one byte each, which GoCardless may
 * decode as UTF-8 into fewer characters: such a key counts as that decoding.
 */
function takenAsGiven(trimmed: string): boolean {
  let codePoints = 0;
  let oneBytePerCharacter = true;
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    if (code === 0 || code === 10 || code === 13) return false;
    if (code > 0xff) oneBytePerCharacter = false;
    codePoints += 1;
  }
  if (codePoints <= IDEMPOTENCY_KEY_MAX_CHARACTERS) return true;
  return oneBytePerCharacter && characters(decodedAsUtf8(trimmed)) <= IDEMPOTENCY_KEY_MAX_CHARACTERS;
}

/** The text a value of characters up to U+00FF reads as when its one byte per character is decoded as UTF-8. */
function decodedAsUtf8(latin1: string): string {
  const bytes = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i++) bytes[i] = latin1.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function sentAsGiven(idempotencyKey: string): boolean {
  return takenAsGiven(trimHeaderWhitespace(idempotencyKey));
}

/**
 * The Idempotency-Key header for an idempotencyKey. A key GoCardless can have
 * taken (see takenAsGiven) goes as given, exactly as earlier releases sent it,
 * so a replay of an earlier request keeps its key on every runtime. Any other
 * key never created anything, and is sent as `payfanout-sha256-` and the
 * SHA-256 digest of itself: the same key always yields the same header.
 */
export async function idempotencyKeyHeader(idempotencyKey: string): Promise<string> {
  if (sentAsGiven(idempotencyKey)) return idempotencyKey;
  return `payfanout-sha256-${await sha256Hex(idempotencyKey)}`;
}

/** A lone surrogate: text that is not well-formed Unicode. */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Refuses an idempotencyKey that is sent as its digest while holding a lone
 * surrogate. UTF-8 encoding replaces each lone surrogate with U+FFFD before
 * hashing, so every key that differs from it only by another lone surrogate
 * would share its digest, and two different requests one key. A key sent as
 * given keeps its lone surrogates as the runtime sends them, as it always did.
 */
export function assertDigestibleIdempotencyKey(idempotencyKey: string): void {
  if (!LONE_SURROGATE.test(idempotencyKey) || sentAsGiven(idempotencyKey)) return;
  throw PayFanoutError.invalidRequest(
    "The idempotencyKey is sent as its digest, being over GoCardless's 128 characters or holding a NUL, CR or LF, " +
      "and it holds a lone surrogate, which would give it the digest of other keys",
  );
}

/**
 * Refuses a refund idempotencyKey holding a lone surrogate: a refund's stamp
 * is the SHA-256 of its key, which such a key would share with every key that
 * differs from it only by another lone surrogate. Earlier releases stamped
 * such keys, and a runtime that sends them may have created the refund, so
 * the refusal leaves the outcome open.
 */
export function assertStampableRefundKey(idempotencyKey: string): void {
  if (!LONE_SURROGATE.test(idempotencyKey)) return;
  throw new PayFanoutError({
    code: "invalid_request",
    message:
      "The refund idempotencyKey holds a lone surrogate, so its refund stamp would match other keys' stamps; " +
      "an earlier release may already have refunded under it: check the payment's refunds before refunding again",
    retryable: false,
    pspName: "gocardless",
    outcomeUnknown: true,
  });
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

/**
 * The currency a read reports: the first of `codes` that is an ISO 4217 code,
 * uppercased, else NO_CURRENCY rather than a guess such as GBP.
 */
export function readCurrency(...codes: Array<string | undefined>): string {
  for (const code of codes) {
    const upper = code?.trim().toUpperCase();
    if (upper && /^[A-Z]{3}$/.test(upper)) return upper;
  }
  return NO_CURRENCY;
}
