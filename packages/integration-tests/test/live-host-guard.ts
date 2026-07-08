/**
 * True if baseUrl's parsed hostname is exactly liveHostname. Never substring
 * matching (CodeQL js/incomplete-url-substring-sanitization) — a lookalike
 * host embedded in a path, query string, or URL userinfo must not fool the
 * guard. Trailing dots are stripped before comparing: "host." is
 * DNS-equivalent to "host" and must not bypass it either.
 */
export function isLiveHost(baseUrl: string, liveHostname: string): boolean {
  return new URL(baseUrl).hostname.replace(/\.$/, "") === liveHostname;
}
