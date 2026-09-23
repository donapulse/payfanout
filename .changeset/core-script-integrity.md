---
"@payfanout/core": minor
---

`injectScript` accepts an optional `{ integrity, crossOrigin }` argument that puts Subresource Integrity on the SDK `<script>` it injects, defaulting `crossorigin` to `anonymous` when a hash is given, so the browser refuses a modified file; calls without it are unchanged. When a hash is given, a script already on the page for the same URL is reused only if every script for that URL carries the same `integrity` and a `crossorigin` attribute; a conflicting script, or an `integrity` holding no `sha256`, `sha384` or `sha512` hash, makes the call reject with a non-retryable `invalid_request` without injecting anything. This detects a conflicting script and does not vouch for the page: every shipped client adapter returns before calling `injectScript` once its SDK global exists, so a copy the host page already loaded is used without any check, and since a reused script may still be loading or may have failed, callers keep confirming the SDK global.
