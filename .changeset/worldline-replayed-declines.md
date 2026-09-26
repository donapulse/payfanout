---
"@payfanout/adapter-worldline-server": patch
---

Let a customer pay with another card after a failed completion under the same idempotency key. Worldline answers a repeated key with its first outcome for at least 24 hours, so `completePayment` now makes a new attempt under a key derived from yours, and only once every earlier attempt under it has failed. A key carries at most 20 attempts, and a completion whose first attempt Worldline could forget before the session expires is refused with a non-retryable `invalid_request` instead of sending anything.
