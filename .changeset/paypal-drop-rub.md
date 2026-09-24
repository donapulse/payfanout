---
"@payfanout/adapter-paypal-server": patch
---

The PayPal server adapter no longer offers RUB, which PayPal's currency codes reference no longer lists: `supportedCurrencies` leaves it out, so routing picks another provider for a RUB payment, and a new session in RUB, or a move of an order to RUB, is refused with `invalid_request` before calling PayPal. Payments made in RUB earlier still read, capture and refund.
