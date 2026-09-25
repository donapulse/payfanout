---
"@payfanout/adapter-stripe-server": patch
"@payfanout/adapter-stripe": patch
---

Map Stripe's `authentication_failure` (a payment method that failed authentication) to `authentication_required`, as the intent-specific authentication failures already were, instead of `card_declined`. A fraud decline code on the same error still yields `fraud_suspected`.
