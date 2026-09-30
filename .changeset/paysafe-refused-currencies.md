---
"@payfanout/adapter-paysafe-server": patch
---

Refuse the currencies Paysafe may price with another exponent than PayFanout instead of sending their amounts unchanged: CLP and BYR, which Paysafe's currency table prices differently (per that table, CLP 10,000 would be charged as CLP 100.00), and, as a precaution, BIF, CLF, DJF, GNF, IQD, ISK, KMF, UGX, UYI, UYW, VUV, XAF, XOF and XPF, which the table does not list and which are not priced in hundredths. Calls that would send an amount in them reject with a non-retryable `invalid_request`, marked `outcomeUnknown` when a retried charge, subscription create or completion finds that Paysafe already holds something under its key; calls that would report an amount in them reject with `unsupported_operation`, a subscription list page holding one fails whole, and webhook events in them carry no `amount` (see the setup guide for each case).

Before upgrading, route these currencies to another provider and move `SubscriptionManager` subscriptions that renew on Paysafe in them, as their renewals would fail with `invalid_request` into dunning. Native Paysafe subscriptions created in them keep billing at Paysafe's exponent and can no longer be read, listed or cancelled through the adapter: cancel them in the Paysafe portal. `cancelNativeSubscription` now reads the subscription before cancelling it, one more request on every cancel.
