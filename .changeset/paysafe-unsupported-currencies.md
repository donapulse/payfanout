---
"@payfanout/adapter-paysafe-server": patch
---

Declare the currencies the adapter refuses (CLP, BYR and the currencies Paysafe's table lacks that are not priced in hundredths) in `unsupportedCurrencies`, derived from the same rule as the refusal, so `PaymentRouter` skips Paysafe for a session in one of them and tries the next candidate instead of stopping on the adapter's `invalid_request`. `PaymentService` now refuses such a session for Paysafe before calling the adapter, zero-amount sessions included, with a non-retryable `unsupported_operation`, the message `"paysafe" does not support currency CLP` and no `raw`, where the adapter's refusal was an `invalid_request` naming both exponents on `raw`. The adapter called directly refuses as before.
