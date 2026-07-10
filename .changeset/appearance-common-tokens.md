---
"@payfanout/adapter-stripe": minor
"@payfanout/adapter-paysafe": minor
"@payfanout/react": patch
---

Translate a small cross-PSP appearance token set (`colorPrimary`, `colorText`, `colorDanger`, `colorBackground`, `fontFamily`, `fontSize`) to each PSP's native format, so one `<PaymentFields appearance>` styles whichever PSP is active. Stripe maps the tokens into its Appearance API `variables`; Paysafe maps the ones its hosted inputs support onto the field `input` selector. PSP-native shapes still pass through for power users. The Paysafe adapter now warns about appearance entries it cannot apply — e.g. a Stripe `variables` object handed to Paysafe — instead of silently dropping all styling with a cryptic "Invalid css property" from Paysafe.js.
