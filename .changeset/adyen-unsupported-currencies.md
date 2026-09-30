---
"@payfanout/adapter-adyen-server": patch
---

Declare CLP, CVE, IDR and ISK, which the adapter refuses, in `unsupportedCurrencies`, so `PaymentRouter` skips Adyen for a session in one of them and tries the next candidate instead of stopping on the adapter's `invalid_request`. `PaymentService` now refuses such a session for Adyen before calling the adapter, with a non-retryable `unsupported_operation`, the message `"adyen" does not support currency CLP` and no `raw`, where the adapter's refusal was an `invalid_request` naming Adyen's fractional digits on `raw`. The adapter called directly refuses as before.
