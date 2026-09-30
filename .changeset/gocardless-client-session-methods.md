---
"@payfanout/adapter-gocardless": minor
---

List `sepa_debit` and `bacs_debit` as unsupported payment methods, as the server adapter now declares them: a GoCardless session is a one-off Open Banking payment (Pay by Bank), so `bank_redirect_generic` is the one method it offers.
