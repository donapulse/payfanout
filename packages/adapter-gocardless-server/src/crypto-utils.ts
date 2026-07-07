/**
 * WebCrypto + pure-JS byte helpers. This adapter avoids `node:crypto` and
 * `Buffer` so it runs on edge runtimes (Cloudflare Workers, Next.js edge
 * routes) as well as Node ≥18 — everything here exists in both. Output is
 * bit-identical to node:crypto (HMAC-SHA256, lowercase hex); the equivalence
 * is locked in by tests that cross-check against node:crypto.
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
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)));
  let hex = "";
  for (const byte of mac) hex += byte.toString(16).padStart(2, "0");
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
