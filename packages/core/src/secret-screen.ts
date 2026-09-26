/**
 * How many consecutive characters of a secret count as repeating it: long
 * enough that an unrelated code rarely holds them, short enough that a stretch
 * of a credential cannot slip through inside a longer value.
 */
const SPAN = 8;

/**
 * Whether `text` repeats a secret: holds one of `secrets` whole, or eight
 * consecutive characters of one, in any letter case. Both sides are compared
 * as UTF-16 code units after `toUpperCase`. A secret of eight units or fewer
 * counts only whole, and an empty secret always counts, so a blank credential
 * withholds the text instead of letting it through.
 *
 * For a value a server wrote that a message would otherwise quote, such as
 * the error code a connection check names: a request sent to the wrong host
 * (a mistyped `baseUrl`) carried the credentials there, and that host wrote
 * the value. Quote only a value that matches the provider's documented code
 * shape, a strict pattern with a length cap, and only when this returns
 * false. It compares every stretch of each secret with the text, so it is
 * meant for short values like those.
 */
export function repeatsSecret(text: string, secrets: readonly string[]): boolean {
  const haystack = text.toUpperCase();
  return secrets.some((secret) => {
    const needle = secret.toUpperCase();
    if (needle.length === 0) return true;
    if (needle.length <= SPAN) return haystack.includes(needle);
    for (let start = 0; start + SPAN <= needle.length; start++) {
      if (haystack.includes(needle.slice(start, start + SPAN))) return true;
    }
    return false;
  });
}
