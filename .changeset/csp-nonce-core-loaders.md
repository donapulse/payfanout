---
"@payfanout/core": minor
---

Add Content-Security-Policy nonce support to the SDK loaders. `injectScript` takes `nonce`, `attributes` (further attributes for the tag) and `async` (`true` unless set to `false`), all set on the `<script>` before its URL and before it is inserted; an invalid nonce, an attribute the loader manages itself (`src`, `async`, `defer`, `integrity`, `crossorigin`, `nonce`, `type`), an `on…` event handler or a name the browser refuses rejects with a non-retryable `invalid_request` and injects nothing. The new `injectStylesheet(url, pspName, { nonce, integrity, crossOrigin })` adds one `<link rel="stylesheet">` per URL, resolves when the sheet loads and also when it fails, removing a failed link so a later call fetches it again, and makes a call that finds a link an earlier call added, still loading, wait for it. `isValidCspNonce` checks a value against the CSP nonce grammar.
