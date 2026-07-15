---
"@payfanout/adapter-paysafe-server": minor
"@payfanout/adapter-paysafe": minor
---

Support Interac e-Transfer on Paysafe (Canada, CAD). Paysafe.js cannot tokenize this rail, so `createPaymentSession` mints the payment handle server-side and the customer authenticates at their bank; the return trip resolves through `handleRedirectReturn` and the existing server-completion route, with the terminal outcome arriving by webhook. Request a session with `paymentMethodTypes: ["interac_etransfer"]`, a `returnUrl`, and the customer's email.
