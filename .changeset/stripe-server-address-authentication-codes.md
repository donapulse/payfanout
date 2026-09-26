---
"@payfanout/adapter-stripe-server": patch
---

Map `incorrect_address`, as an error code or the issuer's decline code, to `invalid_card_data` as `incorrect_zip` is, and the decline code `authentication_not_handled`, which the issuer returns when a payment went ahead without its required authentication, to the non-retryable `authentication_required`, instead of `card_declined`, as the browser adapter maps them.
