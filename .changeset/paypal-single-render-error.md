---
"@payfanout/adapter-paypal": patch
---

Report a failed PayPal button render to the `onError` option once. PayPal's SDK hands the failure to the buttons' `onError` and then rejects the render, which reached the host twice, with conflicting `retryable` flags.
