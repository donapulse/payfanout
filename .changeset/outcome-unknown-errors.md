---
"@payfanout/core": minor
---

Add `PayFanoutError.outcomeUnknown`, set when a call may have taken effect at the provider although its code would otherwise read as definitive; `psp_unavailable`, `rate_limited` and `unknown` already leave the outcome open without it. Retry any such call only under the same idempotency key. `toJSON` includes the flag when it is set.
