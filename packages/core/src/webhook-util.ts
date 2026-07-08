/** Webhook plumbing every adapter shares — normalization only, no crypto. */

/** Header lookup is case-insensitive per RFC 9110; adapters match lowercase names. */
export function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) out[key.toLowerCase()] = value;
  return out;
}

/** PSP timestamp → ISO string for `UnifiedWebhookEvent.occurredAt`. */
export function normalizeTime(value: string | undefined): string {
  const parsed = value ? Date.parse(value) : Number.NaN;
  // Deterministic fallback: a missing timestamp is the PSP's omission, not ours.
  return Number.isNaN(parsed) ? "1970-01-01T00:00:00.000Z" : new Date(parsed).toISOString();
}

/**
 * Normalizes a `secret | secret[]` config value (adapters accept several
 * secrets at once so a rotation needs no cutover) into the non-empty list to
 * verify against. Empty/undefined entries are dropped — an empty-string HMAC
 * key must never take part in signature verification.
 */
export function normalizeSecrets(raw: string | string[] | undefined): string[] {
  return (Array.isArray(raw) ? raw : [raw]).filter(
    (secret): secret is string => typeof secret === "string" && secret.length > 0,
  );
}
