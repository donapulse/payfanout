---
"@payfanout/adapter-gocardless-server": patch
---

`retrievePayment` now reports a billing request that is `ready_to_fulfil` or `fulfilling` as `processing` instead of `requires_action`, because nothing is left for the payer to do, and payments on GoCardless's `pad` scheme report `paymentMethodType: "pad"` instead of `"other"`. Webhooks and `fetchEvents` now map `billing_requests.cancelled` to `payment.canceled`, a `billing_requests.fulfilled` event that names no payment (a mandate-only billing request) to `unknown`, and give billing request events that name no payment the billing request id as `pspPaymentId`. `late_failure_settled` now maps to `unknown`, so a late failure reaches hosts once, as the `payment.failed` of its `payments.failed` event, instead of twice.
