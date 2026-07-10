# @payfanout/adapter-paysafe

Client-side Paysafe adapter for [PayFanout](https://donapulse.github.io/payfanout/):
Paysafe.js hosted iframe fields, tokenize-first, rendered embedded in your UI.

> **No secrets, no server code.** This package holds only a browser-safe public key.

It implements the `ClientPaymentAdapter` contract from `@payfanout/core` and plugs into
`@payfanout/react`, which renders the fields and drives the pay flow. Paysafe.js is **loaded
lazily via a `<script>` tag** only when this adapter is actually mounted, there is nothing
extra to install and no SDK download during SSR.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [React usage](https://donapulse.github.io/payfanout/guide/react)
· [Set up Paysafe](https://donapulse.github.io/payfanout/guide/paysafe)

## Installation

```bash
pnpm add @payfanout/react @payfanout/adapter-paysafe react react-dom
```

## Usage

```tsx
import { PayFanoutProvider, PaymentFields, PayButton } from "@payfanout/react";
import { PaysafeClientAdapter } from "@payfanout/adapter-paysafe";

const paysafe = new PaysafeClientAdapter({
  apiKey: "base64-public-key",   // public single-use-token key
  environment: "sandbox",        // never inferred
});

<PayFanoutProvider adapters={[paysafe]} initialPsp="paysafe">
  <PaymentFields clientSecret={session.clientSecret} appearance={designTokens} />
  <PayButton
    onResult={(result) => …}
    onServerCompletion={(clientToken) => postToMyApi("/api/complete", { clientToken })}
  >
    Pay
  </PayButton>
</PayFanoutProvider>
```

This is a **tokenize-first** PSP: the client tokenizes first, then your server finalizes via
`completePayment` (called through the `onServerCompletion` route). `<PayButton>` branches
into that path automatically, so the UI code is identical to a confirm-on-client PSP.

## Split-field layouts are yours

Paysafe uses separate iframe fields (card number, expiry, CVV). Own the layout with named
slots, any grid, rows, and labels:

```tsx
<PaymentFields clientSecret={secret} fieldOptions={{ fields: { cardNumber: { placeholder: "Card number" } } }}>
  <div className="my-grid">
    <div data-payfanout-field="cardNumber" />
    <div className="row">
      <div data-payfanout-field="expiryDate" />
      <div data-payfanout-field="cvv" />
    </div>
  </div>
</PaymentFields>
```

## Content-Security-Policy

On CSP-enforcing pages, allow every host Paysafe.js touches, or the hosted fields
fail quietly: the script (`hosted.paysafe.com`), the card-field iframes
(`hosted.paysafe.com` in live, `hosted.test.paysafe.com` in sandbox), and its
parent-page XHRs (`api.paysafe.com` / `api.test.paysafe.com`):

```
script-src  https://hosted.paysafe.com
frame-src   https://hosted.paysafe.com https://hosted.test.paysafe.com
connect-src https://hosted.paysafe.com https://hosted.test.paysafe.com
            https://api.paysafe.com https://api.test.paysafe.com
```

The `.test` hosts are used only by `environment: "sandbox"`. See
[Set up Paysafe](https://donapulse.github.io/payfanout/guide/paysafe) for the
per-directive failure modes.

## What's inside

- **`PaysafeClientAdapter`**, mounts the hosted fields, tokenizes, and resolves the
  tokenize-first completion.
- **`decodeSessionPayload`** and the structural `PaysafeJsLike` / `PaysafeFieldsInstanceLike`
  types so the adapter is testable without the real SDK.

Pair it on the server with [`@payfanout/adapter-paysafe-server`](../adapter-paysafe-server),
which issues the signed session context this adapter consumes.

## Documentation

- [React usage](https://donapulse.github.io/payfanout/guide/react)
- [Set up Paysafe](https://donapulse.github.io/payfanout/guide/paysafe)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
