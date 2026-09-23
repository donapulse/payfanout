---
"@payfanout/adapter-stripe-server": patch
---

Recognise two of the payment-method error codes Stripe added in API version 2026-08-26.dahlia: `expired_payment_method` now maps to `expired_card` and `incorrect_postal_code` to `invalid_card_data`, like their card-specific counterparts. The other two new codes, `authentication_failure` and `payment_method_restricted`, keep mapping to `card_declined`.
