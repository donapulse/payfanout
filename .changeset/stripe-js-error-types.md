---
"@payfanout/adapter-stripe": patch
---

Classify Stripe.js errors by type as the server adapter does, where they read as `unknown` before: rate limits and lock timeouts are a retryable `rate_limited`, connection and API errors a retryable `psp_unavailable`, and invalid-request, authentication and idempotency errors `invalid_request` (an idempotency error marked `outcomeUnknown`). A Stripe.js field validation error is now `invalid_card_data` instead of `card_declined`, and errors whose Stripe.js message is not written for customers carry core's localized message.
