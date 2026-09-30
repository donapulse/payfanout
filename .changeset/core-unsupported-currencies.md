---
"@payfanout/core": minor
---

Add `AdapterCapabilities.unsupportedCurrencies`, the currencies an adapter refuses to send any amount in (uppercase ISO 4217), for providers that take too many currencies to declare `supportedCurrencies`; an adapter may declare either list or both. `screenSessionInput` refuses a session in one of them, zero-amount sessions included, with the message `"<psp>" declares currency <code> unsupported`, so the router can skip that adapter instead of stopping on its `invalid_request`. `validateAdapterCapabilities` now reports an entry that can never match (not a string, or not three letters once trimmed and uppercased), a currency declared in both lists, a supported payment method whose `currencies` are all refused, and, unless called with the new `{ registration: true }` option, an entry not written in uppercase.
