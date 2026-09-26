import { PayFanoutError } from "./errors.js";

/**
 * Whether `text` repeats a secret: holds one of `secrets` whole, or `span`
 * consecutive characters of one (8 by default), in any letter case. Both
 * sides are compared upper-cased (`toUpperCase`). A secret shorter than
 * `span` counts only whole, and an empty secret always counts, so a blank
 * credential withholds the text instead of letting it through.
 *
 * For text a server wrote that a message would otherwise quote, such as the
 * error code a connection check names: a request sent to the wrong host (a
 * mistyped `baseUrl`) carried the credentials there, and that host wrote the
 * text. Quote it only when this returns false. A `span` that is not a
 * positive integer throws `invalid_request`.
 */
export function repeatsSecret(text: string, secrets: readonly string[], span = 8): boolean {
  if (!Number.isInteger(span) || span < 1) {
    throw PayFanoutError.invalidRequest("repeatsSecret span must be a positive integer");
  }
  const haystack = text.toUpperCase();
  return secrets.some((secret) => {
    const needle = secret.toUpperCase();
    if (needle.length === 0) return true;
    if (needle.length <= span) return haystack.includes(needle);
    for (let start = 0; start + span <= needle.length; start++) {
      if (haystack.includes(needle.slice(start, start + span))) return true;
    }
    return false;
  });
}
