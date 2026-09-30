---
"@payfanout/core": minor
---

Add `AdapterCapabilities.unsupportedCurrencies`, the currencies an adapter refuses outright (uppercase ISO 4217), for providers that take too many currencies to declare `supportedCurrencies`. `screenSessionInput` refuses a session in one of them, zero-amount sessions included, so `PaymentRouter` skips that adapter for the next candidate instead of stopping on its `invalid_request`, and `PaymentService` refuses the session with `unsupported_operation` before calling the adapter. `validateAdapterCapabilities` now reports an entry that is not an uppercase ISO 4217 code, a currency declared in both lists, and a supported payment method whose `currencies` are all refused.
