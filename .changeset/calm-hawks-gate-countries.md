---
"@payfanout/core": minor
---

Payment methods can now declare the customer countries they serve. `PaymentMethodCapability.countries` (uppercase ISO 3166-1 alpha-2; absent or empty means unrestricted) is the customer-side sibling of `currencies`: Bacs pays from UK bank accounts, Interac from Canadian ones. Session screening honors it through a new `CreatePaymentSessionInput.customerCountry` field — when the host states the customer's country, a rail that cannot serve it is reported ineligible and the router can fail over; when the host omits it, country-restricted rails are not screened at all, so existing callers see no change. `customerCountry` is distinct from `country`, which resolves the merchant account and is never read for rail eligibility.
