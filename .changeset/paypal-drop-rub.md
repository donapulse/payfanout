---
"@payfanout/adapter-paypal-server": patch
---

The PayPal server adapter no longer offers RUB, which PayPal's currency codes reference no longer lists. `supportedCurrencies` leaves it out, so `PaymentRouter` skips PayPal for a RUB payment and `PaymentService` refuses a RUB session for PayPal with `unsupported_operation`; the adapter itself refuses a new RUB session, or moving an order to RUB, with `invalid_request` before creating or changing the order. Payments made in RUB earlier can still be retrieved, captured and refunded.
