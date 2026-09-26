---
"@payfanout/adapter-adyen": minor
---

Add a `cspNonce` option for pages with a nonce-based Content-Security-Policy: the adapter sets it as the `nonce` attribute of both the Adyen Web `<script>` and the stylesheet `<link>` it injects, and the constructor rejects a malformed nonce with `invalid_request`. The stylesheet now loads through core's `injectStylesheet`: a second adapter instance waits for a stylesheet another is still loading, a `<link rel="preload">` for the same URL no longer stands in for it, a stylesheet that fails to load stays on the page rather than being fetched again, and an empty `stylesheetUrl` loads no stylesheet instead of leaving `loadSdk()` pending.
