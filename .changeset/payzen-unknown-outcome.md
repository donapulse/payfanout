---
"@payfanout/adapter-payzen": patch
"@payfanout/adapter-payzen-server": patch
---

Mark `PSP_679` ("The transaction status is unknown.") `outcomeUnknown` on its non-retryable `processing_error`, from the server's API calls and from the browser's `KR.onError` and unpaid transactions alike: the operation may have taken effect, so read the payment back before trying again.
