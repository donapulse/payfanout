/**
 * WebCrypto + pure-JS byte helpers shared by the server adapters. Everything
 * here avoids `node:crypto` and `Buffer` so adapters built on it run on edge
 * runtimes (Cloudflare Workers, Next.js edge routes) as well as Node ≥18 —
 * every API used exists in both. Output is bit-identical to node:crypto
 * (HMAC-SHA256, lowercase hex, unpadded base64url), so signed tokens issued
 * by earlier node:crypto implementations stay valid; the equivalence is
 * locked in by tests that cross-check against node:crypto.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** HMAC-SHA-256 over UTF-8 `data`, keyed with UTF-8 `key`, as raw bytes. */
export async function hmacSha256(key: string, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)));
}

/** HMAC-SHA-256 as lowercase hex — what GoCardless and PayZen signatures use. */
export async function hmacSha256Hex(key: string, data: string): Promise<string> {
  return bytesToHex(await hmacSha256(key, data));
}

/** SHA-256 of UTF-8 `data` as lowercase hex. */
export async function sha256Hex(data: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(data))));
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Constant-time string comparison (XOR-accumulate over UTF-8 bytes). Length
 * mismatches return false immediately — same observable behavior as
 * timingSafeEqual guarded by a length check.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bytesA = encoder.encode(a);
  const bytesB = encoder.encode(b);
  if (bytesA.length !== bytesB.length) return false;
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i]! ^ bytesB[i]!;
  return diff === 0;
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding (what Paysafe webhook signatures use). */
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

/** Unpadded URL-safe base64 — matches Node's "base64url" encoding exactly. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Basic-auth credential encoding without Buffer (UTF-8 safe). */
export function utf8ToBase64(value: string): string {
  return bytesToBase64(encoder.encode(value));
}

export function utf8ToBase64Url(value: string): string {
  return bytesToBase64Url(encoder.encode(value));
}

export function base64UrlToUtf8(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return decoder.decode(bytes);
}
