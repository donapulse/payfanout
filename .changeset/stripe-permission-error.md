---
"@payfanout/adapter-stripe-server": patch
---

Map a 403 (`StripePermissionError`, an API key without the permission the request needs) to a non-retryable `invalid_request` "Payment configuration error.", as a 401 already is, instead of `unknown`, which hosts and `SubscriptionManager` read as an outcome that may have gone through.
