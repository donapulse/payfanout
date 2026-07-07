/**
 * WebCrypto + pure-JS byte helpers. This adapter avoids `node:crypto` and
 * `Buffer` so it runs on edge runtimes (Cloudflare Workers, Next.js edge
 * routes) as well as Node ≥18 — everything here exists in both.
 */

const encoder = new TextEncoder();

export async function sha256Hex(data: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(data)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_CHARS[b0 >> 2]!;
    out += BASE64_CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    out += b1 === undefined ? "=" : BASE64_CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    out += b2 === undefined ? "=" : BASE64_CHARS[b2 & 0x3f]!;
  }
  return out;
}

/** Basic-auth credential encoding without Buffer (UTF-8 safe). */
export function utf8ToBase64(value: string): string {
  return bytesToBase64(encoder.encode(value));
}

/**
 * PayPal-Request-Id caps at 38 single-byte characters. Short keys pass
 * through untouched; longer ones collapse to a SHA-256 prefix — the same
 * PayFanout idempotencyKey must always yield the same header value, so the
 * derivation is deterministic, never random.
 */
export async function derivePayPalRequestId(idempotencyKey: string): Promise<string> {
  if (encoder.encode(idempotencyKey).length <= 38) return idempotencyKey;
  return (await sha256Hex(idempotencyKey)).slice(0, 36);
}
