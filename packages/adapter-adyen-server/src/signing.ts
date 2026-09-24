import { bytesToBase64, PayFanoutError, sha256Hex } from "@payfanout/core";

/**
 * Adyen request/webhook crypto, built on WebCrypto so the server adapter runs on
 * edge runtimes (no `node:crypto`, no `Buffer`).
 */

const encoder = new TextEncoder();

/** Adyen caps the `idempotency-key` header at 64 characters. */
export const ADYEN_IDEMPOTENCY_KEY_MAX_LENGTH = 64;

/**
 * The `idempotency-key` header the adapter sends on every capture, cancel and
 * refund. A caller's `idempotencyKey` is arbitrary; Adyen's header takes at
 * most 64 characters. A SHA-256 hex digest is exactly 64 and deterministic, so
 * the same caller key on the same endpoint always derives the same header value
 * and a replay dedupes at Adyen.
 *
 * The request path is part of the digest because Adyen stores idempotency keys
 * **at company account level**, not per endpoint: without it, a capture and a
 * refund under one caller key would receive each other's stored answers. A
 * modification's path also carries the payment's pspReference, which Adyen
 * makes globally unique, so two merchant accounts of one company never derive
 * the same value; and it is the value 0.1.0 sent on every call, so a
 * modification retried across the upgrade still dedupes. `/payments` and
 * `/payments/details` carry no pspReference in their path, so the adapter
 * derives their header differently, covering the merchant account as well.
 */
export async function deriveAdyenIdempotencyKey(path: string, idempotencyKey: string): Promise<string> {
  // The newline cannot appear in a path, so no pair of (path, key) inputs can
  // produce the same digest input as another.
  return sha256Hex(`${path}\n${idempotencyKey}`);
}

/** Leads every encoding, so a later derivation cannot reproduce a value this one sends. */
const PAYMENT_IDEMPOTENCY_KEY_DERIVATION = "adyen-idempotency-key/2";

/**
 * The `idempotency-key` header of a `/payments` or `/payments/details` request:
 * the SHA-256 hex digest of the JSON array
 * `["adyen-idempotency-key/2", merchantAccount, path, idempotencyKey, submission]`.
 * Internal to the adapter; the package does not export it.
 *
 * Neither path carries a pspReference, and Adyen checks idempotency keys across
 * the whole company account, so the merchant account is part of the digest: two
 * merchant accounts of one company sharing a caller key never receive each
 * other's stored answers. `submission` is `null` on `/payments`, whose body
 * stays out of the digest, so a completion retried under the same key dedupes
 * whatever payment-method blob it carries. On `/payments/details` it is the
 * SHA-256 of the canonical JSON of the submitted `details` and `paymentData`:
 * each step of a multi-step action flow submits different data and is a request
 * of its own, while a replayed step submits the same data and dedupes. The
 * fields travel as a JSON array, so no two distinct inputs share an encoding.
 */
export async function derivePaymentIdempotencyKey(request: {
  /** The merchant account the request is booked against. */
  merchantAccount: string;
  path: "/payments" | "/payments/details";
  /** The caller's `idempotencyKey`. */
  idempotencyKey: string;
  /** `/payments/details` only: the request's `details`, as sent. */
  details?: unknown;
  /** `/payments/details` only: the request's `paymentData`, when it carries one. */
  paymentData?: string;
}): Promise<string> {
  const { merchantAccount, path, idempotencyKey, details, paymentData } = request;
  const submission = path === "/payments/details" ? await sha256Hex(canonicalJson({ details, paymentData })) : null;
  return sha256Hex(
    JSON.stringify([PAYMENT_IDEMPOTENCY_KEY_DERIVATION, merchantAccount, path, idempotencyKey, submission]),
  );
}

/**
 * Canonical JSON of JSON data — what `JSON.parse` returns, which is all a
 * `/payments/details` submission is: object keys sorted at every depth, so
 * equal values always encode alike and distinct values never share an
 * encoding. A member whose value is `undefined`, a function or a symbol is left
 * out, and such an array item written as `null`, as `JSON.stringify` does, so
 * the encoding covers what the request body carries and nothing it drops.
 */
function canonicalJson(value: unknown): string {
  if (isDroppedByJson(value)) return "null";
  if (Array.isArray(value)) return `[${Array.from(value, (item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => !isDroppedByJson(record[key]))
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The values `JSON.stringify` leaves out of an object and writes as `null` in an array. */
function isDroppedByJson(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/**
 * Adyen's Customer Area issues the webhook HMAC key as a HEX string; the bytes
 * it encodes are the key, so it must be decoded before signing. Hashing the hex
 * text itself would produce a signature that never matches.
 */
export function hexToBytes(hex: string): Uint8Array {
  const value = hex.trim();
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    throw PayFanoutError.invalidRequest("Adyen HMAC keys are hex strings from the Customer Area", {
      length: value.length,
    });
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** HMAC-SHA-256 over UTF-8 `data` with a RAW BYTE key, base64-encoded (Adyen's signature form). */
export async function hmacSha256Base64(keyBytes: Uint8Array, data: string): Promise<string> {
  // WebCrypto takes an ArrayBuffer-backed view; copying accepts a caller's key
  // whatever buffer it sits on.
  const key = new Uint8Array(keyBytes.length);
  key.set(keyBytes);
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data))));
}
