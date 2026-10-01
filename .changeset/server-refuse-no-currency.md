---
"@payfanout/server": patch
---

Refuse `XXX` (core's `NO_CURRENCY`) as an input currency with a non-retryable `invalid_request` before any adapter call: in `PaymentService` sessions, session updates, saved-method charges and native subscriptions, in `PaymentRouter` before any candidate is screened, and in a `SubscriptionManager` plan, so a trial no longer fails only at its first renewal. Adapters report `XXX` for a record that states no currency, so it names no currency to charge in.
