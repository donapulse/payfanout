---
"@payfanout/adapter-stripe-server": patch
---

List `https://*.js.stripe.com` under `script` and `frame` in the onboarding descriptor's CSP, as Stripe's security guide does: Stripe.js can start its frames on those origins.
