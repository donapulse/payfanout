---
"@payfanout/adapter-stripe-server": patch
---

Map Stripe's `authentication_failure` (a payment method that failed authentication) to `authentication_required`, as the browser adapter maps the intent-specific authentication failures, instead of `card_declined`. A fraud decline code on the same error still yields `fraud_suspected`.
