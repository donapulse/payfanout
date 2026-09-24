---
"@payfanout/core": patch
---

`injectScript` now removes a script tag it injected when that tag's load fails, so a later call fetches the file again instead of resolving at once from the failed tag, and a retried SDK load after a network error or a failed integrity check can succeed.
