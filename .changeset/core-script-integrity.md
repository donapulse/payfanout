---
"@payfanout/core": minor
---

`injectScript` accepts an optional `{ integrity, crossOrigin }` argument that puts Subresource Integrity on the SDK `<script>` it injects, defaulting `crossorigin` to `anonymous` when a hash is given, so the browser refuses a modified file; calls without it are unchanged. When a hash is given, a script for the same URL already on the page is reused only if it carries the same `integrity`, and the call otherwise rejects with a non-retryable `invalid_request`.
