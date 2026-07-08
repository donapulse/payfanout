---
"@payfanout/adapter-stripe-server": patch
"@payfanout/adapter-paysafe-server": patch
"@payfanout/adapter-gocardless-server": patch
"@payfanout/adapter-paypal-server": patch
---

Per-adapter consistency: the Stripe server config gains a `paymentMethods` override (dashboard enablement varies per account — stop hardcoding iDEAL/SEPA/ACH/BACS as supported) and `requestTimeoutMs` (threaded to the SDK's timeout, default remains the SDK's 80s); `listSavedPaymentMethods` pages past 100 stored methods instead of silently truncating. Paysafe error 3004 (billing zip required) now maps to `invalid_request` instead of masquerading as a card decline. All REST adapters validate `maxNetworkRetries` as an integer ≥ 0 at construction, Stripe validates `webhookToleranceSeconds`, and GoCardless clamps list page sizes to its documented 1–500 bounds.
