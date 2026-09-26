---
"@payfanout/adapter-stripe": minor
---

Add a `cspNonce` option for pages with a nonce-based Content-Security-Policy: the adapter sets it as the `nonce` attribute of the Stripe.js `<script>` it injects, and the constructor rejects a malformed nonce with `invalid_request`. The Stripe guide lists what Stripe.js still loads without a nonce.
