---
"@payfanout/adapter-payzen": minor
---

Add a `cspNonce` option for pages with a nonce-based Content-Security-Policy: the adapter sets it as the `nonce` attribute of the krypton-client `<script>` and of the theme stylesheet `<link>` it injects, and the constructor rejects a malformed nonce with `invalid_request`. The theme stylesheet is now added once the script has loaded, as PayZen requires theme files to load after the library, without `loadSdk()` waiting for it, and an empty `cssUrl` loads none. A second adapter instance on the page now waits for a krypton-client script another instance is still loading, and fails with it, instead of failing at once with `psp_unavailable` while that load could still succeed.
