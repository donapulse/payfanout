---
"@payfanout/core": minor
---

Add Content-Security-Policy nonce support to the SDK loaders: `injectScript` takes `nonce`, `attributes` and `async`, all set on the `<script>` before its URL and before it is inserted, and rejects an invalid nonce, an `on…` handler, or an attribute it manages or that can stop the script from running (such as `nomodule`) with a non-retryable `invalid_request`, injecting nothing. The new `injectStylesheet(url, pspName, { nonce, integrity, crossOrigin })` adds one `<link rel="stylesheet">` per URL, never mistaking a preload link for it, resolves when the sheet loads and also when it fails, and keeps a failed link on the page, since a browser can report a sheet as failed when one of its `@import`s fails; an empty URL injects nothing. `isValidCspNonce` checks a value against the CSP nonce grammar.
