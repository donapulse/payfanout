import { bytesToBase64, hmacSha256, sha256Hex } from "@payfanout/core";

/**
 * Worldline Direct "v1HMAC" request authentication, built on WebCrypto so the
 * server adapter runs on edge runtimes (no `node:crypto`, no `Buffer`).
 *
 * The signature covers a canonical string assembled from the request, each line
 * terminated by `\n`, in this exact order:
 *
 *   1. HTTP method (upper-case)
 *   2. Content-Type — the empty string when the request has no body (e.g. GET)
 *   3. the `Date` header value (RFC-1123 GMT)
 *   4. every signed `x-gcs-*` header, canonicalized as `lowercased-key:value`
 *      (value trimmed, internal whitespace collapsed to single spaces), sorted
 *      alphabetically by key, each terminated with `\n`
 *   5. the resource path (e.g. `/v2/{merchantId}/payments`)
 *
 * There is a trailing `\n` after the path. The digest is HMAC-SHA256 over the
 * UTF-8 bytes, base64-encoded, and carried as
 * `Authorization: GCS v1HMAC:{apiKeyId}:{signature}`.
 *
 * Worldline also accepts an `X-GCS-Date` signed header in place of the `Date`
 * HTTP header (line 3 stays empty and `x-gcs-date` joins the canonical block) —
 * useful on edge runtimes that forbid setting the `Date` request header. The
 * documented `Date`-header form is implemented here as the default.
 */
export interface V1HmacSigningInput {
  apiKeyId: string;
  secretApiKey: string;
  /** Upper-case HTTP method. */
  method: string;
  /** Absolute resource path, e.g. `/v2/{merchantId}/payments` (no query string). */
  path: string;
  /** The `Date` header value being sent (RFC-1123 GMT). */
  date: string;
  /** Sent Content-Type; omit/empty when the request has no body. */
  contentType?: string;
  /** Signed `x-gcs-*` headers (e.g. the idempotence key), keyed by header name. */
  gcsHeaders?: Record<string, string>;
}

/** Builds the `Authorization` header value for a Worldline Direct request. */
export async function buildV1HmacAuthorization(input: V1HmacSigningInput): Promise<string> {
  const canonicalHeaders = Object.entries(input.gcsHeaders ?? {})
    .map(([key, value]) => [key.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, value]) => `${key}:${value}\n`)
    .join("");
  const dataToSign = `${input.method}\n${input.contentType ?? ""}\n${input.date}\n${canonicalHeaders}${input.path}\n`;
  const signature = bytesToBase64(await hmacSha256(input.secretApiKey, dataToSign));
  return `GCS v1HMAC:${input.apiKeyId}:${signature}`;
}

/**
 * Worldline's `X-GCS-Idempotence-Key` is capped at 40 ASCII characters, while a
 * caller's `idempotencyKey` is arbitrary. Hashing it to 40 hex characters keeps
 * the header within bounds while staying deterministic — the same key always
 * derives the same idempotence key, so a replay dedupes at Worldline.
 */
export async function deriveIdempotenceKey(idempotencyKey: string): Promise<string> {
  return (await sha256Hex(idempotencyKey)).slice(0, 40);
}
