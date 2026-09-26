---
"@payfanout/adapter-worldline": minor
---

Add a `cspNonce` option for pages with a nonce-based Content-Security-Policy: the adapter sets it as the `nonce` attribute of the Tokenizer `<script>` it injects, and the constructor rejects a malformed nonce with `invalid_request`.
