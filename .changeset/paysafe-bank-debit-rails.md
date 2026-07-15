---
"@payfanout/adapter-paysafe-server": minor
"@payfanout/adapter-paysafe": minor
---

Support Paysafe's direct-debit rails: SEPA (`sepa_debit`, EUR), ACH (`ach`), BACS (`bacs_debit`, GBP/UK), and EFT (`pad`, Canada). These are Payments-API rails Paysafe.js cannot tokenize, so the client adapter renders its own bank-details fields (account holder + IBAN, routing + account, sort code + account, or institution + transit + account), with a mandate-consent checkbox on SEPA and BACS, and the details travel to the server through the existing completion route. The server adapter mints the payment handle and charges it with `settleWithAuth: true` in one completion step, surfaces the SEPA/BACS mandate reference on `PaymentInfo.mandateReference`, and maps Paysafe's returned-payment webhook (both documented spellings) to `payment.failed` so late bank returns finalize the payment. All four rails are off by default — enablement is per-account; opt in via `config.paymentMethods`, keeping each rail's declared currency and country gates, and restrict each session to exactly one bank rail.
