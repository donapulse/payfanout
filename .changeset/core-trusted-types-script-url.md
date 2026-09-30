---
"@payfanout/core": patch
---

Reject with a non-retryable `invalid_request` from `injectScript` when a page that enforces Trusted Types refuses the script URL, instead of with the browser's bare `TypeError`, which now rides on `raw`; nothing is injected. Such a page needs a default policy that accepts the SDK's URL.
