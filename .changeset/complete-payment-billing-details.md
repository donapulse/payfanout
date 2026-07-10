---
"@payfanout/core": minor
"@payfanout/adapter-paysafe-server": minor
---

Accept `billingDetails` on `CompletePaymentInput`. Hosts can now attach AVS billing — typically a postal code collected on the payment step — at completion instead of only at session creation. The Paysafe server adapter merges it over the session's billing before charging, so AVS-enforcing accounts complete without recreating the session (previously they failed with error 3004). Confirm-on-client adapters (Stripe) never call `completePayment` and are unaffected.
