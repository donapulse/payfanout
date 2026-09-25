---
"@payfanout/adapter-paysafe": patch
---

Stop sending `colorBackground` as `background-color` and `locale` as a setup option to Paysafe.js: its hosted inputs accept no background property and setup has no locale option, so both were silently ignored. `colorBackground` is now recognized and not applied, like `colorPrimary`.
