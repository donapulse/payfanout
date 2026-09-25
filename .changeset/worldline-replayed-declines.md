---
"@payfanout/adapter-worldline-server": patch
---

Let a customer pay with another card after a failed completion under the same idempotency key. Worldline answers a repeated key with its first outcome for at least 24 hours, so `completePayment` now sends a new attempt under a key derived from yours and the failed one, while a completion repeated after a success still returns that payment without charging again, and a 3-D Secure challenge is walked past only once it has failed or been cancelled. A key carries at most 20 attempts, and a completion whose key's first attempt Worldline could forget before the session expires is refused with a non-retryable `invalid_request` instead of sending anything.
