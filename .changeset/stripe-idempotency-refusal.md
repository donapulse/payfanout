---
"@payfanout/adapter-stripe-server": patch
---

Mark Stripe's refusal of a reused idempotency key (`idempotency_error`) `outcomeUnknown`: the key's first request ran and may have succeeded, so only the same key may follow.
