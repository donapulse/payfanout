---
"@payfanout/adapter-paypal-server": patch
---

Stop reporting or sending USD for PayPal records that state no currency: a read takes the currency another record of the same order states (for a capture or refund read on its own, the capture's order), else reports `NO_CURRENCY`, and the subscription projection reports `NO_CURRENCY` instead of an empty string. When no record states the currency, a capture amount other than all of an untouched authorization, a partial refund and an amount-only `updatePaymentSession` are refused with `invalid_request` before any request, and `retrieveRefund` rejects with `processing_error` instead of reading the amount as USD. An update that only restates the order's own currency no longer sends a PATCH.
