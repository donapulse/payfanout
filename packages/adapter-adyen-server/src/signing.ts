import { bytesToBase64, PayFanoutError, sha256Hex } from "@payfanout/core";

/**
 * Adyen request/webhook crypto, built on WebCrypto so the server adapter runs on
 * edge runtimes (no `node:crypto`, no `Buffer`).
 */

const encoder = new TextEncoder();

/** Adyen caps the `idempotency-key` header at 64 characters. */
export const ADYEN_IDEMPOTENCY_KEY_MAX_LENGTH = 64;

/** Leads every encoding, so a later derivation cannot reproduce a value this one sends. */
const IDEMPOTENCY_KEY_DERIVATION = "adyen-idempotency-key/2";

/**
 * The `idempotency-key` header of one Adyen request. A caller's
 * `idempotencyKey` is arbitrary and the header takes at most 64 characters, so
 * it travels as a SHA-256 hex digest: exactly 64 characters, deterministic, and
 * identical on every retry of the same request, which Adyen then answers from
 * its store instead of performing it again.
 *
 * Adyen stores idempotency keys **at company account level** and checks their
 * uniqueness there, not per endpoint or merchant account: a value one request
 * consumed replays that request's stored response to any other request that
 * sends it. The digest therefore covers everything that tells two requests
 * apart under one caller key: the merchant account (two merchant accounts of
 * one company), the path (`/payments` then `/payments/details`, a capture then a
 * refund) and, for `/payments/details`, the submitted `details` and
 * `paymentData`, since each step of a multi-step action flow submits different
 * data while a replayed step submits the same. The fields are encoded as a JSON
 * array and the submission as canonical JSON (object keys sorted), so no two
 * distinct inputs share an encoding.
 */
export async function deriveAdyenIdempotencyKey(request: {
  /** The merchant account the request is booked against. */
  merchantAccount: string;
  /** The Checkout API path without host or version, e.g. `/payments/{pspReference}/refunds`. */
  path: string;
  /** The caller's `idempotencyKey`. */
  idempotencyKey: string;
  /** `/payments/details` only: the request's `details`, as sent. */
  details?: unknown;
  /** `/payments/details` only: the request's `paymentData`, when it carries one. */
  paymentData?: string;
}): Promise<string> {
  const { merchantAccount, path, idempotencyKey, details, paymentData } = request;
  const submission =
    details === undefined && paymentData === undefined
      ? null
      : await sha256Hex(canonicalJson({ details, paymentData }));
  return sha256Hex(JSON.stringify([IDEMPOTENCY_KEY_DERIVATION, merchantAccount, path, idempotencyKey, submission]));
}

/** JSON with object keys sorted at every depth, so equal values always encode alike. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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
