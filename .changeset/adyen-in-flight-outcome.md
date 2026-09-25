---
"@payfanout/adapter-adyen-server": patch
---

Mark `outcomeUnknown` on the `processing_error` of an `errorCode` 704, of any other 409 and of a transient 4xx: each can answer a request sent while another under the same idempotency key is still in progress, which may yet go through, so retry only under that key. The `invalid_request` of a capture or refund whose acknowledgement echoes another amount, and of a completion answered with another request's payment that Adyen did not refuse, fail or cancel, carries `outcomeUnknown` too, since that capture, refund or payment may be the one the call was meant to make: use a new key only once it is known to be another.
