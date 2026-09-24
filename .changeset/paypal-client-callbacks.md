---
"@payfanout/adapter-paypal": patch
---

The PayPal client adapter now returns the order id from `createOrder` as a Promise, the form PayPal's JS SDK reference documents. Errors the SDK delivers through the buttons' `onError` are now reported as non-retryable `processing_error`, since PayPal documents that callback as a catch-all with nothing to handle beyond a generic error message; a failed button render stays retryable.
