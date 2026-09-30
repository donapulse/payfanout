---
"@payfanout/adapter-stripe-server": patch
---

Report `NO_CURRENCY` instead of USD as the currency of a `verifyPaymentMethod` answer: the SetupIntent it reads moves no money and states no currency.
