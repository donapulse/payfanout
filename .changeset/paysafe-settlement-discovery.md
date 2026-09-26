---
"@payfanout/adapter-paysafe-server": minor
---

A full Paysafe capture (no amount, or the authorized amount) now settles under a reference derived from the payment, `payfanout-capture-<pspPaymentId>` (then `-a2` to `-a10` after one that moved no money), instead of its idempotency key, so `retrievePayment` and `refundPayment` find it and refund from it. A partial capture still settles under its idempotency key, where no read finds it: refund it, like any capture an earlier release made, in the Paysafe portal, using the settlement id every capture's answer now carries on `raw.captureSettlement` (typed by the newly exported `PaysafeSettlementLike`). Settlement lookups now start the day before the payment, so settlements older than Paysafe's default 30 days are found, and a lookup that fails now fails the call, retryable for an outage or a rate limit, instead of reading as no settlement.
