---
"@payfanout/core": major
---

Payment methods can now declare the currencies they settle in. `PaymentMethodCapability.currencies` (uppercase ISO 4217; absent or empty means unrestricted, and the PSP-wide `supportedCurrencies` still applies on top) is honored by session screening, so a rail requested outside its currencies — SEPA in GBP — is reported ineligible instead of attempted, and the router can fail over to a PSP that settles it.

Adds `pad` to `PAYMENT_METHOD_TYPES` for Pre-Authorized Debit, the Payments Canada scheme that Stripe calls `acss_debit`, GoCardless calls `pad`, and Paysafe calls EFT. This widens `UnifiedPaymentMethodType`: an exhaustive `switch` or a non-partial `Record` over it will need a `pad` arm.

`validateAdapterCapabilities` now reports a supported method gated to currencies that the adapter's own `supportedCurrencies` excludes — such a method can never be routed, so `PaymentService` rejects it at registration rather than offering a rail that always screens out.
