---
"@payfanout/adapter-stripe-server": patch
---

`verifyCredentials()` now reports any `StripeAPIError`, including a response cut off mid-transfer or a body that is not valid JSON, as a `network` failure instead of `internal`, matching how the adapter's other calls already treat it as retryable. A brief connection drop no longer reads as a credentials problem.
