---
"@payfanout/server": minor
---

`PaymentRouter` now skips, without a PSP call, a candidate whose adapter declares the session's currency in `unsupportedCurrencies`, and `PaymentService` refuses such a session before calling the adapter with a non-retryable `unsupported_operation` and no `raw`, where the adapter's own refusal is an `invalid_request` with `raw`. Only `createPaymentSession` is screened: session updates, `chargeSavedPaymentMethod`, `createNativeSubscription` and `SubscriptionManager` renewals still meet the adapter's own refusal, and registration rejects only an `unsupportedCurrencies` entry that can never match. Hosts need this release for the router to read the field.
