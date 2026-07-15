---
"@payfanout/conformance": major
---

The capability suites now assert that any `countries` an adapter declares on a payment method are well-formed ISO 3166-1 alpha-2 codes, on both the server and client halves. An adapter declaring malformed country codes will newly fail the suite — a malformed code never matches a session's `customerCountry`, silently screening the rail out instead of gating it.
