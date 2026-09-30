---
"@payfanout/adapter-payzen-server": patch
---

Map `PSP_707` (the issuer refused the authentication) to `card_declined`, `PSP_708` (the issuer could not authenticate) to `processing_error`, and `PSP_052` to `PSP_055` as `AUTH_100` to `AUTH_103` read, instead of the default `processing_error`.
