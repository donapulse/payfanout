---
"@payfanout/adapter-worldline-server": patch
---

Report capture, cancellation and refund outcomes the way Worldline defines them. A capture or cancellation the acquirer refuses now leaves the payment `requires_capture` (still authorised) instead of `failed`, and the `payment.rejected_capture` webhook parses as `unknown` rather than `payment.failed`; a refused refund leaves the payment `succeeded`, reads back as a `failed` refund and arrives as `payment.refund_failed`; cancellations and refunds still awaiting the acquirer are no longer reported as final. Cancelling a payment Worldline reports as closed now rejects with a non-retryable `invalid_request` instead of a retryable conflict, and repeating a cancellation that already took effect answers `canceled`. Partial captures in currencies without two decimals are refused with `invalid_request` rather than risk capturing the wrong amount.
