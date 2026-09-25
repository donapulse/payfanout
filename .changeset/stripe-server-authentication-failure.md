---
"@payfanout/adapter-stripe-server": patch
---

Map Stripe's `authentication_failure` (a payment method that failed authentication), and the intent-specific `payment_intent_authentication_failure` and `setup_intent_authentication_failure` that earlier API versions return, to `authentication_required` instead of `card_declined`, as the browser adapter maps them. A fraud decline code on the same error still yields `fraud_suspected`.
