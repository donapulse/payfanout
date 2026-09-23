---
"@payfanout/adapter-stripe-server": patch
---

`verifyCredentials()` now reports a Stripe response cut off mid-transfer as a `network` failure instead of `internal`, so a brief connection drop no longer reads as a credentials problem.
