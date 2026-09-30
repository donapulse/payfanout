---
"@payfanout/adapter-stripe-server": patch
---

Declare UGX, which the adapter refuses, in `unsupportedCurrencies`, so `PaymentRouter` skips Stripe for a UGX session and tries the next candidate instead of stopping on the adapter's `invalid_request`. `PaymentService` now refuses a UGX session for Stripe before calling the adapter, with a non-retryable `unsupported_operation`, the message `"stripe" does not support currency UGX` and no `raw`, where the adapter's refusal was an `invalid_request` naming the currency's units on `raw`. That includes a zero-amount session, which the adapter still creates as a SetupIntent carrying no currency when called directly: create it in another currency.
