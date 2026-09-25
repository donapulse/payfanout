---
"@payfanout/adapter-stripe": patch
---

Map Stripe.js's `authentication_failure` (a payment method that failed authentication) to `authentication_required`, like the intent-specific authentication failures, instead of `card_declined`.
