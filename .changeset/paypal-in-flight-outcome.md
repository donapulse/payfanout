---
"@payfanout/adapter-paypal-server": patch
---

Mark `outcomeUnknown` on the retryable `processing_error` of a 409, which PayPal returns while a previous request on the order, authorization or capture is in progress: that request can be the call's own first one under the same `PayPal-Request-Id`, so retry only under the same idempotency key.
