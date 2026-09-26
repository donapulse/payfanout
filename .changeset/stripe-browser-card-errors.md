---
"@payfanout/adapter-stripe": patch
---

Classify Stripe.js errors as the server adapter does: `expired_payment_method` is `expired_card`, `incorrect_zip` and `incorrect_postal_code` are `invalid_card_data`, and the fraud decline codes (`fraudulent`, `stolen_card`, `lost_card`, `merchant_blacklist`, `lost_or_stolen_card`) are `fraud_suspected`, taking precedence over a failed authentication on the same error. A fraud decline shows core's generic message in the locale Stripe.js was given (the browser's under `"auto"`), falling back to English; every other error keeps Stripe.js's localized message.
