# @payfanout/adapter-adyen

Client-side Adyen adapter for [PayFanout](https://donapulse.github.io/payfanout/): the
**Adyen Web Card component** (card data captured inside Adyen's hosted iframes, SAQ-A
eligible), tokenize-first.

> **No secrets.** This package ships to the browser and holds only the public `clientKey`,
> whose origins you allowlist in the Adyen Customer Area.

It implements the `ClientPaymentAdapter` contract from `@payfanout/core`, so
`@payfanout/react` renders it through the same `<PaymentFields>` / `<PayButton>` as every
other PSP.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [Set up Adyen](https://donapulse.github.io/payfanout/guide/adyen)
· [React usage](https://donapulse.github.io/payfanout/guide/react)

## Installation

```bash
pnpm add @payfanout/react @payfanout/adapter-adyen react react-dom
```

Adyen Web is **not** an npm dependency; the adapter injects the pinned build lazily from
Adyen's CDN on first mount.

## Usage

```tsx
import { PayFanoutProvider, PaymentFields, PayButton } from "@payfanout/react";
import { AdyenClientAdapter } from "@payfanout/adapter-adyen";

const adyen = new AdyenClientAdapter({
  clientKey: import.meta.env.VITE_ADYEN_CLIENT_KEY,
  environment: "sandbox",
  countryCode: "NL",
});

<PayFanoutProvider adapters={[adyen]} initialPsp="adyen" completionEndpoint="/api/complete">
  <PaymentFields clientSecret={session.clientSecret} />
  {/* completionEndpoint finishes the tokenize-first flow automatically — no onServerCompletion. */}
  <PayButton onResult={(result) => showOutcome(result)}>Pay</PayButton>
</PayFanoutProvider>
```

- `environment` selects both the CDN host and the value handed to Adyen Web
  (`sandbox → test`, `live → live`); `adyenEnvironment` overrides the latter for regional
  live values. Nothing is inferred.
- `countryCode` is required — Adyen Web takes it on the checkout instance.
- The session's `clientSecret` is the server adapter's signed session token; the adapter
  reads its payload half (amount and currency) so Adyen Web shows the right figures. It
  never needs the signing key.
- `confirm()` resolves `{ status: "requires_confirmation", clientToken }` where `clientToken`
  is the encrypted card blob, JSON-encoded. The host passes it to the server's
  `completePayment` — `<PayButton>` / `completionEndpoint` wire this automatically.

## Customization

`options.appearance` becomes Adyen's `styles` object (`base`, `error`, `placeholder`,
`validated`) and `options.fieldOptions` passes through to the Card component untouched — the
host wins on conflicts, except the two keys the adapter must own: `showPayButton` (forced to
`false`, since your `<PayButton>` drives submission) and `onChange` (where the encrypted blob
and the validity stream arrive). `options.locale` sets the SDK's locale for that mount.

## 3-D Secure

A challenge comes back from the *server* (`completePayment` reports `requires_action` with
Adyen's `action` object on `PaymentInfo.raw`). Hand it to `handleAction(handle, action)`:
the component resolves a `threeDS2` challenge **inline**, and the result is a fresh
`clientToken` carrying the additional details, which the host completes with exactly as it
did the first one. `handleAction` is Adyen-specific — the unified contract has no action
step, because most PSPs resolve challenges inside `confirm()`.

One challenge runs at a time per mounted field set: calling `handleAction` again while one
is outstanding resolves `{ status: "failed" }` with `invalid_request` rather than replacing
the pending resolver, which would strand the first caller's promise. The promise settles
when Adyen reports the shopper's details, so race it against your own timer if you need a
deadline on an abandoned challenge.

## Notes

- Card data is captured **only** inside Adyen's hosted iframes; there is no raw card input,
  and no PAN/CVV ever touches your DOM.
- `onChange` fires once with `{ complete: false }` on mount, then on every SDK validity
  change, so "disable Pay until complete" works out of the box.
- `sdkVersion` pins the Adyen Web build; `sdkUrl` / `stylesheetUrl` let you self-host. A
  stylesheet that fails to load never blocks the fields from mounting.

## Documentation

- [Set up Adyen](https://donapulse.github.io/payfanout/guide/adyen)
- [React usage](https://donapulse.github.io/payfanout/guide/react)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
