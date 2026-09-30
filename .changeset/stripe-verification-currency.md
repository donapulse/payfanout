---
"@payfanout/adapter-stripe-server": patch
---

Report `NO_CURRENCY` instead of USD as the currency of a `verifyPaymentMethod` answer, whose SetupIntent moves no money and states no currency, and instead of an empty string for a subscription that states no currency code. A subscription whose own currency is empty now takes its first price's currency for both the reported currency and the conversion of its amount from Stripe's units.
