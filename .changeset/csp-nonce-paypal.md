---
"@payfanout/adapter-paypal": minor
---

Add a `cspNonce` option for pages with a nonce-based Content-Security-Policy: the adapter sets it as both the `nonce` and the `data-csp-nonce` attribute of the PayPal JS SDK `<script>` it injects, as PayPal's nonce-based policy requires, and the SDK applies it to the inline scripts and styles it creates. The constructor rejects a malformed nonce with `invalid_request`.
