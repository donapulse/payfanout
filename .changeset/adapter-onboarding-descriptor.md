---
"@payfanout/core": minor
"@payfanout/conformance": minor
"@payfanout/adapter-stripe-server": minor
"@payfanout/adapter-paysafe-server": minor
"@payfanout/adapter-paypal-server": minor
"@payfanout/adapter-payzen-server": minor
"@payfanout/adapter-gocardless-server": minor
---

Add a declarative adapter onboarding descriptor and an optional credential probe.
`@payfanout/core` exports `AdapterOnboardingDescriptor` — credential-field metadata (kind,
scope, format hints, per-currency), the webhook signature scheme and event list, and CSP
hosts — plus `validateOnboardingDescriptor`, and `ServerPaymentAdapter` gains an optional
`verifyCredentials()` that reports whether the configured credentials authenticate (auth vs
network vs internal). Every server adapter (Stripe, Paysafe, PayPal, PayZen, GoCardless) now
exports a descriptor and implements `verifyCredentials`, and the conformance suite validates
each descriptor against its adapter. Hosts can render provider-settings forms, validate
credential shapes, drive webhook-subscription copy, build CSP headers, and offer a "Test
connection" button as generic loops over the descriptor — identical for every adapter.
