---
"@payfanout/adapter-stripe-server": patch
---

Update the Stripe Node SDK to 22.6.2. A Stripe response that is cut off, or that stalls past the request timeout after its headers arrive, now fails with a retryable `psp_unavailable` error instead of leaving the call hanging.
