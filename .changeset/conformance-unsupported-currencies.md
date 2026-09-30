---
"@payfanout/conformance": minor
---

The server suite now fails an adapter that declares `unsupportedCurrencies` with an entry that can never match (not a string, or not three letters once trimmed and uppercased) or that is not written in uppercase, with a currency declared in both `supportedCurrencies` and `unsupportedCurrencies`, or with a supported payment method whose `currencies` are all refused. These checks reach the suite through `validateAdapterCapabilities` from `@payfanout/core`, and an adapter that does not declare `unsupportedCurrencies` gets the same verdict as before.
