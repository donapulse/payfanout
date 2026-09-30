---
"@payfanout/core": minor
---

Export `NO_CURRENCY` (`"XXX"`, ISO 4217's code for "no currency involved") and `firstCurrencyCode(...codes)`, which returns the first candidate that is three letters once trimmed and uppercased. Adapters report `NO_CURRENCY` as a session's, payment's or subscription's currency when the provider states none and they have no other source they trust, instead of guessing one. It reads with the default exponent 2, so reconcile such a record with the provider before relying on its amounts.
