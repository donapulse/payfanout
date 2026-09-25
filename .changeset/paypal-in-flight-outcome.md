---
"@payfanout/adapter-paypal-server": patch
---

Mark `outcomeUnknown` on the retryable `processing_error` of a 409, which PayPal's Payments API returns on an authorization's capture or void and on a capture's refund while a previous request on it is in progress: that request can be the call's own first one under the same `PayPal-Request-Id`, so retry only under the same idempotency key. The Orders API's 409 on an order's authorize or capture, which PayPal documents as a conflict with the order's state, is marked the same way through the shared error mapper.
