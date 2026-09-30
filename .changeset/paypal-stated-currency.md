---
"@payfanout/adapter-paypal-server": patch
---

Stop reporting USD for PayPal records that state no currency: sessions, payments and captures take the currency another record of the same order states, else `NO_CURRENCY`, and the subscription projection reports `NO_CURRENCY` instead of an empty string. An explicit capture amount, a partial refund and an amount-only `updatePaymentSession` are refused with `invalid_request` before any request when no record of the payment states its currency, instead of being sent in USD; a capture or refund in full still goes through. A `retrieveRefund` whose amount states no currency rejects with `processing_error` instead of being read as USD, and an update that only restates the order's own currency no longer sends a PATCH.
