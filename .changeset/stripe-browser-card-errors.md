---
"@payfanout/adapter-stripe": patch
---

Classify Stripe.js errors as the server adapter does: `expired_payment_method` is `expired_card`, `incorrect_zip` and `incorrect_postal_code` are `invalid_card_data`, and the fraud decline codes (`fraudulent`, `stolen_card`, `lost_card`, `merchant_blacklist`) are `fraud_suspected` with a generic message, taking precedence over a failed authentication on the same error.
