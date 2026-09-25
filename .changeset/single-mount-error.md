---
"@payfanout/react": patch
---

Report a failed mount to the `<PaymentFields>` `onError` prop once, even when the adapter also passes the same error to its `onError` option before rejecting.
