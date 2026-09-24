---
"@payfanout/core": patch
---

`injectScript` now removes a script tag it injected when that tag's load fails, so a later `injectScript` call for the same URL fetches the file again instead of resolving at once from the failed tag, including after a failed integrity check.
