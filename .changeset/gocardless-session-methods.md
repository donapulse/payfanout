---
"@payfanout/adapter-gocardless-server": major
"@payfanout/adapter-gocardless": minor
---

Declare `sepa_debit` and `bacs_debit` unsupported for sessions, which GoCardless creates as one-off Open Banking payments (Pay by Bank), never as Direct Debit: `bank_redirect_generic` is the one method a session takes. Breaking: a session whose `paymentMethodTypes` names `sepa_debit` or `bacs_debit` now rejects with `invalid_request` instead of creating a Pay by Bank payment, and the router no longer sends a session asking for either to GoCardless; ask for `bank_redirect_generic`, or name no method. A payment GoCardless settles over Bacs or SEPA Core through `fallbackEnabled` is still reported as `bacs_debit` or `sepa_debit`.
