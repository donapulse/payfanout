---
"@payfanout/conformance": major
---

The capability suites now assert that any `currencies` an adapter declares on a payment method are well-formed ISO 4217 codes, on both the server and client halves. An adapter whose method-level currency codes are malformed, or which offers a rail gated to currencies its `supportedCurrencies` excludes, will newly fail the suite — both cases silently disable the rail at routing time.
