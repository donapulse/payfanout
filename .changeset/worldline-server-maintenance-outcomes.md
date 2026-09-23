---
"@payfanout/adapter-worldline-server": patch
---

A capture or cancellation the acquirer refuses now leaves the payment `requires_capture` with its authorisation intact: an automatic-capture completion answered with a refused capture resolves `requires_capture` instead of throwing `card_declined`, and the `payment.rejected_capture` webhook parses as `unknown` instead of `payment.failed`. A payment with a refund in flight or refused now reads `succeeded` instead of `processing` or `failed`, a refused refund reads `failed` and its `payment.rejected` webhook arrives as `payment.refund_failed`, and a cancellation still awaiting the acquirer reads `processing` instead of `canceled`. Cancelling a payment Worldline reports as closed now rejects with a non-retryable `invalid_request`, and a partial capture in a currency without two decimals is refused with `invalid_request` rather than risk capturing the wrong amount.
