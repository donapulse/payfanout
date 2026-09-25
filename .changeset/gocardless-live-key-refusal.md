---
"@payfanout/adapter-gocardless-server": patch
---

Mark `outcomeUnknown` on the `invalid_request` of a session or refund whose idempotency key already holds a different billing request or refund, unless that billing request was cancelled, its payment failed or was cancelled, or that refund was cancelled, bounced or had its funds returned: it may be the payment or refund the call was meant to make, so use a fresh key only once it is known to be another.
