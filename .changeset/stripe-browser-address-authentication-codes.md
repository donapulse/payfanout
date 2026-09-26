---
"@payfanout/adapter-stripe": patch
---

Map Stripe.js's `incorrect_address`, as an error code or the issuer's decline code, to `invalid_card_data` as `incorrect_zip` is, and the decline code `authentication_not_handled`, which the issuer returns when a payment went ahead without its required authentication, to `authentication_required`, instead of reporting both as `card_declined`.
