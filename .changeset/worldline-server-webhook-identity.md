---
"@payfanout/adapter-worldline-server": patch
---

Webhook event ids are now `worldline:<type>:<payment id>`, built from the pair Worldline documents as identical across duplicate deliveries (the refund id stands in when there is no payment, and the payment's operation id is appended when the payload carries one); payment-link events, `payment.test` messages and deliveries that lack the pair keep the envelope id, which stays available on `event.raw.id`. Worldline warns that a new payment id per maintenance operation "is not the case in some specific scenarios", so a second event of one type on one payment id is treated as a duplicate: on refund events, re-read the payment or refund instead of counting events. For about 35 hours after upgrading (Worldline's retry window), also check `event.raw.id` against the event ids you stored before the upgrade.
