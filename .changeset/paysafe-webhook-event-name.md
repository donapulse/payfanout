---
"@payfanout/adapter-paysafe-server": patch
---

Read the Paysafe webhook event name from `eventName`, the field real Payments-API deliveries use. Previously only `eventType`/`event` were consulted, so genuine deliveries mapped to the `unknown` event type and were acknowledged without effect; `PAYMENT_COMPLETED` and the other documented events now map to their unified types. The top-level `type` field (the resource category) is deliberately ignored.
