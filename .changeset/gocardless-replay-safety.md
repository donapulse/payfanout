---
"@payfanout/adapter-gocardless-server": patch
---

Replaying a GoCardless call with the same idempotency key now resolves to the original outcome, and a key reused for a different payment or refund (another amount, currency, session `id` or payment) rejects with `invalid_request` instead of returning the original. A replayed `createPaymentSession` reports its billing request's own status and gets a new authorisation URL only while the billing request is `pending`, so a session the payer has already authorised, or one that is fulfilled or cancelled, comes back as `processing` or `canceled` with no `clientSecret`; a replayed `refundPayment` returns the original refund even after that refund used up the payment, instead of rejecting with "nothing left to refund". `cancelPayment` re-reads the payment or billing request when GoCardless refuses the cancel and resolves `canceled` when it is already cancelled, so a repeated or retried cancel no longer fails.
