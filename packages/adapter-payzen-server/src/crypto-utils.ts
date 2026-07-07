/**
 * WebCrypto + pure-JS byte helpers. This adapter avoids `node:crypto` and
 * `Buffer` so it runs on edge runtimes (Cloudflare Workers, Next.js edge
 * routes) as well as Node ≥18 — everything here exists in both. PayZen signs
 * kr-answer payloads with hex-encoded HMAC-SHA-256, so the hex path is primary
 * here (Paysafe's adapter is base64-primary); a guard test keeps Node builtins
 * from sneaking back in.
 */

const encoder = new TextEncoder();

export async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data))));
}

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

/** Basic-auth credential encoding without Buffer (UTF-8 safe). */
export function utf8ToBase64(value: string): string {
  const bytes = encoder.encode(value);
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
