---
"@payfanout/adapter-gocardless-server": major
---

Declare `sepa_debit` and `bacs_debit` unsupported for sessions, which GoCardless creates as one-off Open Banking payments (Pay by Bank), never as Direct Debit: `bank_redirect_generic` is the one method a session takes. Breaking: a session whose `paymentMethodTypes` names only types the adapter does not take, such as `["sepa_debit"]` or `["bacs_debit"]`, now rejects with `invalid_request` instead of creating a Pay by Bank payment, and the router no longer sends it to GoCardless; a list that also names `bank_redirect_generic` is served as a Pay by Bank session, as the router reads a list. A payment a payer completes by Direct Debit through `fallbackEnabled` is still reported as `bacs_debit` or `sepa_debit`.
