---
"@payfanout/core": patch
---

Error-handling correctness. `PayFanoutError.wrap` no longer copies an arbitrary thrown error's text into the user-facing `message` — absent an explicit fallback it uses the built-in user-safe catalog message for the code, with the original error preserved on `raw`. `isPayFanoutError` (and therefore `wrap`) now recognizes errors structurally, so adapters resolving a duplicated copy of core keep their specific codes instead of being re-wrapped as `unknown`. `localizeError` resolves missing codes per key through the locale chain, matching `getUserMessage`, instead of falling back to English whenever a region catalog exists. `normalizeCurrency` accepts surrounding whitespace.
