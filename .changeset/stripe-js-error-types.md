---
"@payfanout/adapter-stripe": patch
---

Classify Stripe.js errors by type as the server adapter does, where they read as `unknown` before: rate limits and lock timeouts are a retryable `rate_limited`, connection and API errors a retryable `psp_unavailable`, and invalid-request, authentication and idempotency errors `invalid_request`. A confirmation that finds its intent no longer confirmable, such as one already paid, now reports the intent's status instead of failing, and otherwise leaves the outcome open (`outcomeUnknown`), as an idempotency error does. A field validation error is `invalid_card_data` instead of `card_declined`, and only card and validation errors, plus a failed 3-D Secure, show Stripe.js's own message; other errors carry core's localized one.
