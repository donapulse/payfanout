---
"@payfanout/adapter-paysafe": minor
---

Add a `cspNonce` option for pages with a nonce-based Content-Security-Policy: the adapter sets it as the `nonce` attribute of the Paysafe.js `<script>` it injects, and the constructor rejects a malformed nonce with `invalid_request`. The Paysafe guide lists what Paysafe.js still loads or adds without a nonce.
