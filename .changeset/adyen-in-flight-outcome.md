---
"@payfanout/adapter-adyen-server": patch
---

Mark `outcomeUnknown` on the `processing_error` of an `errorCode` 704, of any other 409 and of a transient 4xx: each can answer a request sent while another under the same idempotency key is still in progress, which may yet go through, so retry only under that key.
