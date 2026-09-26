---
"@payfanout/adapter-paysafe-server": patch
---

`refundPayment` and `retrievePayment` now find the settlement of a manually captured Paysafe payment, and of a payment settled more than 30 days ago: a capture of the whole authorization (no amount, or the authorized amount) settles under a reference derived from the payment instead of the capture's idempotency key, and settlement lookups start the day before the payment instead of covering Paysafe's default 30 days. A partial capture still settles under its idempotency key, which the adapter cannot find from the payment, so refund that money in the Paysafe portal. A retry of a full capture, under the same key or another one, now answers with the settlement the first capture made. A declined, cancelled or expired payment no longer reports, or refunds, the settlement of another payment under the same reference, such as the payment that went through after a declined card under the same completion key.
