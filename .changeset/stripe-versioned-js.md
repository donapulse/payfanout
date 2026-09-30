---
"@payfanout/adapter-stripe": minor
---

Load the Stripe.js build of the API version you pin, so the browser speaks the version the server adapter sends instead of the account's default. A version with a release name, such as `2026-08-26.dahlia`, loads that release's build (`https://js.stripe.com/dahlia/stripe.js`; acacia, basil, clover and dahlia are known), which speaks the API version Stripe pins it to within that release. A date alone, such as `2024-06-20`, still loads `https://js.stripe.com/v3`, now with the version passed to `Stripe()`.

Breaking: `apiVersion` is required. Pass the same string as `StripeServerAdapter`'s `apiVersion`; a missing or malformed version, or a release this adapter knows no Stripe.js build for, is refused with `invalid_request`. The `sdkUrl` option is removed and refused, as Stripe.js must load from `https://js.stripe.com` and the version now picks the file. `loadSdk()` and `mount()` reject with a non-retryable `invalid_request` when the page already runs another Stripe.js build (a page runs one) instead of using it: if your pages load Stripe.js themselves, load the build the adapter loads. If your Content-Security-Policy names Stripe.js by path, list the host `https://js.stripe.com` instead, since the versioned builds load their frames and chunks from `https://js.stripe.com/v3/`.
