---
"@payfanout/core": patch
"@payfanout/adapter-stripe": patch
"@payfanout/adapter-paysafe": patch
"@payfanout/adapter-paypal": patch
"@payfanout/adapter-payzen": patch
---

The Stripe, Paysafe, PayPal and PayZen client adapters no longer keep a failed SDK load: the next `loadSdk()` or `mount()` call loads the SDK again instead of failing until the page reloads, and PayZen also removes the krypton-client script tag that failed to load so the file is fetched again. `injectScript` now waits for a script tag it injected that is still loading, resolving when that tag loads and rejecting with a retryable `psp_unavailable` when it fails, instead of resolving at once; a script tag the page added itself is still reused at once.
