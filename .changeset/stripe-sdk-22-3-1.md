---
"@payfanout/adapter-stripe-server": patch
---

Raise the Stripe SDK floor to 22.3.1, which restores public type exports missing since v22 (`Stripe.StripeConfig`, `Stripe.Webhooks`, the `HttpClient` interfaces, and others). No API or runtime behavior changes.
