---
"@payfanout/adapter-adyen-server": patch
---

The onboarding descriptor now follows Adyen's documentation: the HMAC key pattern accepts exactly the keys the adapter accepts (whole bytes of hex; surrounding whitespace is allowed because the adapter trims it), `liveUrlPrefix` has a pattern that rejects a pasted URL, and the credential hints say where to find the merchant account and live URL prefix, that the API credential needs the Checkout encrypted cardholder data role, and that client key origins must be `https` on live. `csp.frame` and `csp.connect` are now `"*"`, as in Adyen's recommended policy, because issuer 3-D Secure frames load from domains Adyen cannot list; a host that builds its policy from the descriptor gets that automatically. `style-src https://*.adyen.com`, `img-src *` and `form-action *` have no descriptor field and come from the Adyen setup guide.
