---
"@payfanout/adapter-stripe-server": patch
---

List `https://*.js.stripe.com` under `script` and `frame` in the onboarding descriptor's CSP, as Stripe's security guide does, and Link's `https://link.com` and `https://*.link.com` under `frame` and `connect`, since the Payment Element offers Link whenever the account enables it.
