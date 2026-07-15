---
"@payfanout/adapter-stripe-server": patch
---

Explicit `paymentMethodTypes` are now narrowed to the rails that can settle the session currency before the PaymentIntent is created, using the same declared per-method `currencies` gates that `getCapabilities()` exposes. Stripe rejects a PaymentIntent whose explicit `payment_method_types` carries a currency-incompatible entry, so a mixed request like `["sepa_debit", "card"]` in GBP previously failed outright; it now creates a card-only session. When no requested rail can settle the currency the adapter rejects with `invalid_request` naming the rails and the currency, without calling Stripe. Zero-amount verification sessions (SetupIntents, which carry no currency) are never narrowed, and an overridden `config.paymentMethods` rail declared without `currencies` is forwarded unnarrowed.
