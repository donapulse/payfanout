---
"@payfanout/adapter-stripe-server": patch
---

Classify the payment-method error codes Stripe added in API version 2026-08-26.dahlia: `expired_payment_method` now maps to `expired_card` and `incorrect_postal_code` to `invalid_card_data`, matching their card-specific counterparts.
