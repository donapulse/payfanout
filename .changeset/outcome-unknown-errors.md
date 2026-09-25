---
"@payfanout/core": minor
---

Add `PayFanoutError.outcomeUnknown`, set when a call may have taken effect at the provider although it failed, for example because the answer was lost. Retry such a call only under the same idempotency key. `toJSON` includes the flag when it is set.
