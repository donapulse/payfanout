---
"@payfanout/adapter-adyen-server": patch
---

The onboarding descriptor now follows Adyen's documentation: the HMAC key pattern accepts only whole bytes of hex, exactly the keys the adapter accepts, and the credential hints say where to find the merchant account and live URL prefix, that the API credential needs the Checkout encrypted cardholder data role, and that client key origins must be `https` on live. `csp.frame` and `csp.connect` are now empty, the descriptor's convention for a documented wildcard: Adyen recommends `frame-src *` and `connect-src *` because 3-D Secure 2 challenges load from issuer domains it cannot list, so a host that builds its policy from the descriptor should take those two directives, and `style-src`, `img-src` and `form-action`, from the Adyen setup guide.
