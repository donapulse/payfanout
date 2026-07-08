# @payfanout/adapter-payzen

Client-side PayZen (Lyra) adapter for [PayFanout](https://donapulse.github.io/payfanout/):
krypton-client embedded card fields, confirm-on-client, 3DS2 inline in a pop-in.

> **No secrets, no server code.** This package holds only the browser-safe public key.

It implements the `ClientPaymentAdapter` contract from `@payfanout/core` and plugs into
`@payfanout/react`, which renders the fields and drives the pay flow. krypton-client is
**loaded lazily via a `<script>` tag** (deliberately non-async, per PayZen's guidance)
only when this adapter is actually mounted — nothing extra to install and no SDK download
during SSR.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [React usage](https://donapulse.github.io/payfanout/guide/react)
· [Set up PayZen](https://donapulse.github.io/payfanout/guide/payzen)

## Installation

```bash
pnpm add @payfanout/react @payfanout/adapter-payzen react react-dom
```

> **Not yet published to npm.** The packages are at `0.1.0`. Until a release is cut, consume
> them from source, see the [Installation guide](https://donapulse.github.io/payfanout/guide/installation).

## Usage

```tsx
import { PayFanoutProvider, PaymentFields, PayButton } from "@payfanout/react";
import { PayZenClientAdapter } from "@payfanout/adapter-payzen";

const payzen = new PayZenClientAdapter({
  publicKey: "shopId:testpublickey_…",   // Back Office "Public key", browser-safe
  environment: "sandbox",                // never inferred
});

<PayFanoutProvider adapters={[payzen]} initialPsp="payzen">
  <PaymentFields clientSecret={session.clientSecret} appearance={designTokens} />
  <PayButton onResult={(result) => …}>Pay</PayButton>
</PayFanoutProvider>
```

This is a **confirm-on-client** PSP: `confirm()` submits the form, PayZen creates the
transaction in-browser (3DS2 runs inline in Lyra's pop-in — no navigation), and the
result resolves from the signed browser answer. The host's source of truth stays
server-side (IPN / `retrievePayment`) — the browser never holds the validation keys.

Card number, expiry, and CVV render as **Lyra-hosted iframes** (SAQ-A eligible). Styling
is plain CSS: krypton mirrors your page's styles into the iframes automatically, so
`appearance` has no JS hook to land on (documented no-op) — theme with CSS or swap the
`cssUrl` stylesheet.

## What's inside

- **`PayZenClientAdapter`** — SPA-mode script/stylesheet injection, `KR.setFormConfig`
  passthrough (`fieldOptions`, locale mapping) under the adapter-owned protected keys,
  programmatic submit, and defensive teardown (`KR.removeForms`).
- Structural **`KrLike`** types so the adapter is testable without the real SDK.

Pair it on the server with
[`@payfanout/adapter-payzen-server`](../adapter-payzen-server), which mints the
`formToken` this adapter mounts.

## Documentation

- [React usage](https://donapulse.github.io/payfanout/guide/react)
- [Set up PayZen](https://donapulse.github.io/payfanout/guide/payzen)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
