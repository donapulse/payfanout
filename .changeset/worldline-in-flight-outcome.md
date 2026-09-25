---
"@payfanout/adapter-worldline-server": patch
---

Mark `outcomeUnknown` on the retryable `processing_error` of a 409, which Worldline returns while the original request under the same idempotency key is still being processed: that request may yet go through, so retry only under that key.
