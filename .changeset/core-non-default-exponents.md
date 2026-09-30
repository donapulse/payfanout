---
"@payfanout/core": minor
---

Add `listNonDefaultCurrencyExponents()`, the currencies whose exponent is not the default 2, each with its exponent and in code order, so an adapter can compare its provider's currency table with PayFanout's minor units without enumerating every code; any currency it does not list reads as 2.
