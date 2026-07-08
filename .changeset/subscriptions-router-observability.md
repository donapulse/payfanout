---
"@payfanout/server": minor
---

Subscription lifecycle and router observability. Subscriptions gain pause/resume (`pauseSubscription`/`resumeSubscription` — a lapsed resume re-charges with the caller's idempotency key and the same money-safety discipline as renewals, and resume refuses to charge over an unresolved pending renewal), a distinguishable `trialing` status with eager capability validation at creation, a `subscription.updated` event plus `occurredAt` on every event, month-end anchor preservation (`anchorDay` — a subscription created Jan 31 now bills Feb 28, Mar 31, Apr 30 instead of eroding to the 28th), and the optional `SubscriptionStore.listDue` seam so hosts can push due-ness into a database index instead of full-table scans. `PaymentRouter` exposes `getBreakerState()` and an exception-isolated `onBreakerStateChange` hook for circuit-breaker observability.
