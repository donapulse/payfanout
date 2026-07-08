/**
 * PII-aware logging helper. `PaymentInfo.raw` / `UnifiedWebhookEvent.raw`
 * preserve the full PSP payload — which may contain names,
 * emails, addresses, and tokens. Pass anything through scrubForLogging()
 * before writing it to logs; the original object is never mutated.
 *
 * This is a log-hygiene tool, not a compliance guarantee: it redacts by key
 * name and masks card-number-shaped strings, so novel PSP fields with
 * unrecognized names pass through.
 */

export const SCRUBBED = "[scrubbed]";

/** Key names (case/format-insensitive) whose values are always redacted. */
const SENSITIVE_KEYS = new Set(
  [
    // identity
    "name", "firstname", "lastname", "fullname", "holdername", "cardholdername",
    "email", "receiptemail", "phone", "phonenumber",
    // address
    "street", "street1", "street2", "line1", "line2", "address1", "address2",
    "city", "state", "zip", "postalcode", "postcode",
    // card / bank data (defense in depth — PayFanout itself never holds these)
    "cardnum", "cardnumber", "pan", "cvv", "cvc", "cardexpiry", "expirydate",
    "iban", "accountnumber", "routingnumber", "dob", "dateofbirth", "ssn", "nationalid",
    // secrets & bearer material
    "password", "secret", "secretkey", "apikey", "token", "paymenthandletoken",
    "clienttoken", "clientsecret", "authorization", "sessionsigningkey", "webhookhmackey",
  ].map((k) => k.toLowerCase()),
);

/** Objects under these keys are wholly redacted (every leaf is PII by definition). */
const SENSITIVE_SUBTREES = new Set(["card", "billingdetails", "shippingdetails", "profile", "shipping"]);

/** 13–19 digits (spaces/dashes tolerated) that pass Luhn — mask all but the last 4. */
const PAN_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

export interface ScrubOptions {
  /** Extra key names to redact (case/format-insensitive). */
  extraKeys?: string[];
  /** Recursion guard; deeper structures are replaced with SCRUBBED. Default 12. */
  maxDepth?: number;
}

/**
 * Deep-copies `value` with PII redacted: sensitive keys replaced by
 * "[scrubbed]", card-number-shaped strings masked to their last 4 digits,
 * circular references and over-deep nesting cut off safely.
 *
 * Caveat: PAN masking applies to strings only. A card number carried as a JS
 * NUMBER under a key that isn't in the sensitive list passes through
 * unmasked — numbers are returned verbatim, so key-based redaction is the
 * only guard for numeric fields.
 */
export function scrubForLogging<T>(value: T, options: ScrubOptions = {}): unknown {
  const extra = new Set((options.extraKeys ?? []).map(normalizeKey));
  return scrub(value, options.maxDepth ?? 12, extra, new WeakSet());
}

function scrub(value: unknown, depth: number, extra: Set<string>, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return maskPanLike(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value;
  if (typeof value === "function" || typeof value === "symbol") return SCRUBBED;
  if (depth <= 0) return SCRUBBED;
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) {
      return {
        name: value.name,
        message: maskPanLike(value.message),
        ...scrubEntries({ ...value }, depth - 1, extra, seen),
      };
    }
    if (Array.isArray(value)) return value.map((item) => scrub(item, depth - 1, extra, seen));
    if (value instanceof Map || value instanceof Set) {
      return scrub([...value], depth - 1, extra, seen);
    }
    return scrubEntries(value as Record<string, unknown>, depth - 1, extra, seen);
  }
  return SCRUBBED;
}

function scrubEntries(
  obj: Record<string, unknown>,
  depth: number,
  extra: Set<string>,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(obj)) {
    const normalized = normalizeKey(key);
    if (SENSITIVE_KEYS.has(normalized) || extra.has(normalized)) {
      out[key] = SCRUBBED;
    } else if (SENSITIVE_SUBTREES.has(normalized) && entry !== null && typeof entry === "object") {
      out[key] = SCRUBBED;
    } else {
      out[key] = scrub(entry, depth, extra, seen);
    }
  }
  return out;
}

/** "receipt_email" / "receipt-email" / "receiptEmail" all normalize to "receiptemail". */
function normalizeKey(key: string): string {
  return key.replace(/[_\-\s]/g, "").toLowerCase();
}

function maskPanLike(text: string): string {
  return text.replace(PAN_CANDIDATE, (candidate) => {
    const digits = candidate.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !passesLuhn(digits)) return candidate;
    return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
  });
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
