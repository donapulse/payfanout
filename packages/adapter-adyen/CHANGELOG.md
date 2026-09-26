# @payfanout/adapter-adyen

## 1.1.0

### Minor Changes

- e856737: Add a `cspNonce` option for pages with a nonce-based Content-Security-Policy: the adapter sets it as the `nonce` attribute of both the Adyen Web `<script>` and the stylesheet `<link>` it injects, and the constructor rejects a malformed nonce with `invalid_request`. The stylesheet now loads through core's `injectStylesheet`: a second adapter instance waits for a stylesheet another is still loading, a `<link rel="preload">` for the same URL no longer stands in for it, a stylesheet that fails to load stays on the page rather than being fetched again, and an empty `stylesheetUrl` loads no stylesheet instead of leaving `loadSdk()` pending.

### Patch Changes

- Updated dependencies [e856737]
  - @payfanout/core@4.3.0

## 1.0.1

### Patch Changes

- Updated dependencies [1d66371]
  - @payfanout/core@4.2.0

## 1.0.0

### Major Changes

- 4adedb6: Breaking: `confirm()` now resolves a JSON `clientToken` that carries the browser data Adyen needs for 3-D Secure 2 — `browserInfo`, `origin`, and the billing address and risk data when the Card has them — along with the encrypted `paymentMethod`, instead of the bare `paymentMethod`. Only the matching major release of `@payfanout/adapter-adyen-server` decodes it, so upgrade the server adapter first: an earlier server adapter refuses the new token with `invalid_request`. The Card now shows a required cardholder-name field by default, and pressing Enter in the fields no longer triggers Adyen Web's submit; `hasHolderName`, `holderNameRequired` and `onEnterKeyPressed` in `fieldOptions` still take precedence, and `hasHolderName: false` alone hides the name field. `confirm()` shows the fields' validation errors when they are incomplete, and resolves `failed` with `invalid_request` once `handleAction` has replaced the fields, which must then be remounted to pay again. A pending `handleAction` now resolves `failed` when Adyen Web reports an error through `onError`, with `authentication_required` (or a retryable `psp_unavailable` for a load or network failure), and when the fields are unmounted. The new `adyenRedirectResultToken(redirectResult)` builds the `clientToken` that completes a payment on the return page of Adyen's 3-D Secure redirect flow.
- 28b3a91: Breaking: the constructor now throws `invalid_request` for a `clientKey` that does not start with `test_` on sandbox or `live_` on live (a legacy origin key included), and for an `adyenEnvironment` other than `test`, `live`, `live-us`, `live-au`, `live-nea`, `live-in` or `live-apse` (compared case-insensitively), or one that contradicts `environment`; that value now also picks the CDN host Adyen Web loads from (`checkoutshopper-{value}.cdn.adyen.com`), so a live account on location-based live endpoints sets it to their region, and a Content-Security-Policy that allows only the European host must allow the regional one. Adyen Web moves from 6.41.0 to 6.45.2 and loads with the Subresource Integrity hashes Adyen publishes, except for a file that `sdkVersion`, `sdkUrl` or `stylesheetUrl` overrides; the hashes are exported as `ADYEN_WEB_SCRIPT_INTEGRITY` and `ADYEN_WEB_STYLESHEET_INTEGRITY`, and a `<script>` your page adds for the default URL must carry the same `integrity` and a `crossorigin` attribute, or `loadSdk()` rejects with `invalid_request` while `window.AdyenWeb` is not defined yet. Adyen Web errors are now classified by type, network and script errors as a retryable `psp_unavailable` and implementation errors as `invalid_request` (`authentication_required` during a 3-D Secure challenge), and a script that failed to load is fetched again on the next mount, along with a stylesheet that failed.

### Patch Changes

- Updated dependencies [c0e5e1f]
- Updated dependencies [9eb0ce9]
- Updated dependencies [165bb56]
  - @payfanout/core@4.1.0

## 0.1.0

### Minor Changes

- c8aae95: Add the Adyen adapter pair. `@payfanout/adapter-adyen-server` drives the Checkout API v72 (payments, manual capture, cancels, refunds, standard webhooks) and is edge-runtime compatible; `@payfanout/adapter-adyen` renders Adyen Web's Card component in Adyen-hosted iframes and resolves 3-D Secure challenges inline. Adyen is push-only — it exposes no read for a payment or a refund and only acknowledges modifications — so the adapter declares `supportsPaymentRetrieval: false`, `supportsRefundRetrieval: false` and `modificationOutcome: "asynchronous"`, reports `"processing"` captures and cancels and `"pending"` refunds, and carries the payment's amount and currency in `pspPaymentId` so captures and refunds work without a read. `returnUrl` is required on every Adyen payment, so sessions carry their own or fall back to the adapter's `defaultReturnUrl`, and the `idempotency-key` sent to Adyen is scoped to the endpoint as well as the caller's key, because Adyen stores those keys per company account rather than per endpoint. Webhook verification checks Adyen's HMAC signature and the endpoint's basic-authentication credentials. Adyen signs eight values extracted from the payload rather than its bytes, so the adapter declares `webhookSignatureScope: "field-values"`; the credentials are what authenticate the channel carrying the fields the signature does not cover.

### Patch Changes

- Updated dependencies [d500d7d]
- Updated dependencies [8933b9f]
  - @payfanout/core@4.0.0
