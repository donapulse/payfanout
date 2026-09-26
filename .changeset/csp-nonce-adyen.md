---
"@payfanout/adapter-adyen": minor
---

Add a `cspNonce` option for pages with a nonce-based Content-Security-Policy: the adapter sets it as the `nonce` attribute of both the Adyen Web `<script>` and the stylesheet `<link>` it injects, and the constructor rejects a malformed nonce with `invalid_request`. The stylesheet now loads through core's `injectStylesheet`, so a second adapter instance waits for a stylesheet another instance is still loading instead of resolving at once.
