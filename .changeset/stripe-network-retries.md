---
"@payfanout/adapter-stripe-server": patch
---

Reject a `maxNetworkRetries` that is not an integer >= 0 at construction, as the other server adapters do, instead of letting the Stripe SDK silently fall back to its default of 2 retries.
