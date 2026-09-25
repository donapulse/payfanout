---
"@payfanout/adapter-paypal": patch
---

Report a failed PayPal button render to the `onError` option once. PayPal's SDK hands the failure to the buttons' `onError` and then rejects the render, which reached the host twice, with conflicting `retryable` flags. Every other error PayPal reports while the buttons render is passed on once too, and a host `onError` or `onReady` that throws after a successful render no longer removes the buttons: its exception is reported as uncaught instead.
