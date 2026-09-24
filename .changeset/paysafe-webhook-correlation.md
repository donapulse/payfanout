---
"@payfanout/adapter-paysafe-server": patch
---

Paysafe webhook events now reach the right payment: a bank return reports the returned payment as `pspPaymentId` instead of the return's own id, refund events carry `refundId` without a misleading `pspPaymentId`, and settlement and handle events no longer report their own ids as payment ids. `event.id` is now derived from the event name, resource id, status and status time, so every Paysafe redelivery of a notification shares one id; ids therefore differ from earlier releases, and a host deduping across the upgrade may process one duplicate of an event delivered around it. `REFUND_CANCELLED` and `REFUND_ERRORED` now map to `payment.refund_failed` and `PAYMENT_ERRORED` to `payment.failed`, the `variables`-nested envelope is read, the documented `Signature` header is matched in any casing, and the onboarding descriptor lists only the event names Paysafe documents.
