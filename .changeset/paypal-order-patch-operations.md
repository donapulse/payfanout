---
"@payfanout/adapter-paypal-server": patch
---

`updatePaymentSession` patches shipping through the name and address attributes PayPal documents, so updating the shipping of an order that already has one no longer fails, along with any amount change sent with it. Adding a statement descriptor to an order created without one is now refused with `invalid_request` before any update, since PayPal can only replace or remove one, and a statement descriptor longer than 22 characters is cut to 22, as PayPal does, instead of being left out.
