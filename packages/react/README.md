# @payfanout/react

React bindings for [PayFanout](https://donapulse.github.io/payfanout/):
`<PayFanoutProvider>`, `usePayFanout`, `<PaymentFields>`, and `<PayButton>`. No secrets,
no server logic.

The bindings render PSP-hosted card fields **embedded in your UI**, styled by your design
tokens; your code never touches card data. Everything is SSR-safe (adapters are never
touched during SSR) and works as client components under the Next.js App Router. Provider
browser SDKs load lazily: only the adapter actually mounted downloads its script. The same
component code drives both confirm-on-client and tokenize-first PSPs.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [React usage](https://donapulse.github.io/payfanout/guide/react)
· [Getting started](https://donapulse.github.io/payfanout/guide/getting-started)

## Installation

```bash
pnpm add @payfanout/react \
         @payfanout/adapter-stripe \
         @payfanout/adapter-paysafe \
         react react-dom
```

`react` (>= 18) is a peer dependency. Add only the client adapter(s) for the PSP(s) you use;
they have no npm dependency on the PSP browser SDKs (Stripe.js / Paysafe.js load lazily via
a `<script>` tag).

> **Not yet published to npm.** The packages are at `0.1.0`. Until a release is cut, consume
> them from source, see the [Installation guide](https://donapulse.github.io/payfanout/guide/installation).

## Quick start

```tsx
import { PayFanoutProvider, PaymentFields, PayButton } from "@payfanout/react";
import { StripeClientAdapter } from "@payfanout/adapter-stripe";
import { PaysafeClientAdapter } from "@payfanout/adapter-paysafe";

const adapters = [
  new StripeClientAdapter({ publishableKey: "pk_…", environment: "sandbox" }),
  new PaysafeClientAdapter({ apiKey: "base64-public-key", environment: "sandbox" }),
];

<PayFanoutProvider adapters={adapters} initialPsp="stripe">
  <PaymentFields
    clientSecret={session.clientSecret}
    appearance={designTokens}
    onChange={({ complete }) => setPayEnabled(complete)} // disable Pay until fields are valid
  />
  <PayButton
    onResult={(result) => …}
    onServerCompletion={(clientToken) =>
      // Only tokenize-first PSPs (Paysafe) invoke this: POST to YOUR route,
      // which calls payments.completePayment(psp, { pspSessionId, clientToken, idempotencyKey }).
      postToMyApi("/api/complete", { clientToken })
    }
  >
    Pay
  </PayButton>
</PayFanoutProvider>
```

## What's inside

- **`<PayFanoutProvider>`**, holds the adapter registry and the active PSP;
  `usePayFanout` / `usePayFanoutContext` expose status and the mounted entry.
- **`<PaymentFields>`**, mounts the PSP's embedded card fields. Four independent
  customization axes are PSP-vocabulary passthroughs: `appearance` (visual theme), `locale`
  (the PSP's own field texts), `fieldOptions` (the SDK's full UI option surface), and
  named slots (`data-payfanout-field=…`) for split-field PSPs so you own the layout.
- **`<PayButton>`** and **`usePay()`**, the same pay engine as a component or a hook. Both
  branch automatically between confirm-on-client (Stripe) and tokenize-first (Paysafe, via
  `onServerCompletion`), the UI code is identical either way.
- **`useRedirectReturn()` / `<RedirectReturn>`**, mount on your `returnUrl` page for
  genuinely redirect methods (iDEAL, bank redirects). It probes each registered client
  adapter and reports the same `PayResult` as `<PayButton>`.

## The two completion shapes

- **Confirm-on-client (Stripe):** server creates the PaymentIntent, the client confirms
  (inline 3DS). The server never touches confirmation.
- **Tokenize-first (Paysafe):** the client tokenizes first, then your server finalizes via
  `completePayment`. `<PayButton>` branches through `onServerCompletion` for you. Any future
  tokenize-first PSP reuses the same path.

## Where it fits

`@payfanout/react` is the browser half. The server half that creates the session it
consumes lives in [`@payfanout/server`](../server). Client adapters:
[`@payfanout/adapter-stripe`](../adapter-stripe),
[`@payfanout/adapter-paysafe`](../adapter-paysafe).

## Documentation

- [React usage](https://donapulse.github.io/payfanout/guide/react)
- [Server usage](https://donapulse.github.io/payfanout/guide/server)
- [Payment providers overview](https://donapulse.github.io/payfanout/guide/providers)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
