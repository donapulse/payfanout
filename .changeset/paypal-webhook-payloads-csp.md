---
"@payfanout/adapter-paypal-server": patch
---

`CHECKOUT.PAYMENT-APPROVAL.REVERSED` webhook events now carry the order id as `pspPaymentId`, read from `resource.order_id` where PayPal sends it, and `verifyWebhookSignature` answers `false` without calling PayPal for a body that is not exactly one JSON object. The onboarding descriptor's CSP lists `*.paypalobjects.com` and `*.venmo.com` for scripts, frames and connections, as PayPal recommends.
