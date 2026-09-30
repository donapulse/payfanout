---
"@payfanout/conformance": minor
---

The server suite now checks that each `unsupportedCurrencies` code an adapter declares is written as its bare uppercase code, as it already checks `supportedCurrencies` and each payment method's `currencies`, and, through `validateAdapterCapabilities` from `@payfanout/core`, fails an entry that can never match (not a string, or not three letters once trimmed and uppercased), a currency declared in both `supportedCurrencies` and `unsupportedCurrencies`, or a supported payment method whose `currencies` are all declared unsupported. Every new check applies only to an adapter that declares `unsupportedCurrencies`, so no existing adapter's verdict changes.
