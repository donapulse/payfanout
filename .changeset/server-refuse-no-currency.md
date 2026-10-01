---
"@payfanout/server": patch
---

Refuse `XXX` (core's `NO_CURRENCY`) as the currency of a session, session update, saved-method charge or native subscription with a non-retryable `invalid_request` before calling the adapter: adapters report it for a record that states no currency, so it names no currency to charge in. `PaymentRouter` stops on it without calling any candidate.
