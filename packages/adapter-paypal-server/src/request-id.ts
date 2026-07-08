import { sha256Hex } from "@payfanout/core";

const encoder = new TextEncoder();

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
