import { bytesToBase64, PayFanoutError, sha256Hex } from "@payfanout/core";

/**
 * Adyen request/webhook crypto, built on WebCrypto so the server adapter runs on
 * edge runtimes (no `node:crypto`, no `Buffer`).
 */

const encoder = new TextEncoder();

/** Adyen caps the `idempotency-key` header at 64 characters. */
export const ADYEN_IDEMPOTENCY_KEY_MAX_LENGTH = 64;

/**
 * A caller's `idempotencyKey` is arbitrary; Adyen's header takes at most 64
 * characters. A SHA-256 hex digest is exactly 64 and deterministic, so the same
 * caller key on the same endpoint always derives the same header value and a
 * replay dedupes at Adyen.
 *
 * The request path is part of the digest because Adyen stores idempotency keys
 * **at company account level**, not per endpoint: a key already consumed by
 * `/payments` would make Adyen replay that stored response for the very next
 * call, whatever endpoint it targets. One caller key legitimately drives two
 * endpoints — `/payments` then `/payments/details` when a 3-D Secure challenge
 * comes back, or a capture and then a refund — and without the path those calls
 * collide: the payment would never leave `requires_action`, and the refund would
 * answer with the capture's acknowledgement.
 */
export async function deriveAdyenIdempotencyKey(path: string, idempotencyKey: string): Promise<string> {
  // The newline cannot appear in a path, so no pair of (path, key) inputs can
  // produce the same digest input as another.
  return sha256Hex(`${path}\n${idempotencyKey}`);
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
