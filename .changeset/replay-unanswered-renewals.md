---
"@payfanout/server": minor
---

Replay a subscription renewal whose charge ended without a definitive answer (an unreachable or rate-limiting provider, an unknown error, an error marked `outcomeUnknown`, or a first `processing_error`) under the same idempotency key and request, on the new `replayDelaysMinutes` schedule, instead of charging again under a new key; attempt numbers are never reused, so a new card no longer reuses an earlier key. Settle such a charge with `resolvePendingRenewal` and its `idempotencyKey`; `resumeSubscription` refuses while one is unsettled, and stores must persist the new `renewalAttempt` field. `PaymentService` and `PaymentRouter` keep `outcomeUnknown` on the errors they rebuild.
