---
"@payfanout/adapter-stripe-server": patch
---

Update the Stripe Node SDK to 22.6.2. Payment operations now fail with a retryable `psp_unavailable` error, instead of hanging, when a Stripe response is cut off or stalls past the request timeout after its headers arrive.
