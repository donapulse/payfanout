# @payfanout/adapter-worldline

Client-side Worldline Direct adapter for [PayFanout](https://donapulse.github.io/payfanout/):
the **Hosted Tokenization Page** iframe (card data captured inside Worldline's iframe, SAQ-A
eligible), tokenize-first.

> **No secrets.** This package ships to the browser and holds no API credentials. The
> tokenization iframe is addressed entirely by the `hostedTokenizationUrl` the server session
> hands it.

It implements the `ClientPaymentAdapter` contract from `@payfanout/core`, so
`@payfanout/react` renders it through the same `<PaymentFields>` / `<PayButton>` as every
other PSP.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [Set up Worldline](https://donapulse.github.io/payfanout/guide/worldline)
· [React usage](https://donapulse.github.io/payfanout/guide/react)

## Installation

```bash
pnpm add @payfanout/react @payfanout/adapter-worldline react react-dom
```

The Worldline `Tokenizer` script is **not** an npm dependency; the adapter injects it lazily
from Worldline's host on first mount.

## Usage

```tsx
import { PayFanoutProvider, PaymentFields, PayButton } from "@payfanout/react";
import { WorldlineClientAdapter } from "@payfanout/adapter-worldline";

const worldline = new WorldlineClientAdapter({ environment: "sandbox" });

<PayFanoutProvider adapters={[worldline]} initialPsp="worldline" completionEndpoint="/api/complete">
  {/* The Hosted Tokenization iframe emits no field-validity stream, so do not gate the Pay
      button on `complete` for Worldline — the default <PayButton> doesn't. */}
  <PaymentFields clientSecret={session.clientSecret} />
  {/* completionEndpoint finishes the tokenize-first flow automatically — no onServerCompletion. */}
  <PayButton onResult={(result) => showOutcome(result)}>Pay</PayButton>
</PayFanoutProvider>
```

- `environment` selects the Worldline host the Hosted Tokenization script loads from
  (`sandbox → payment.preprod.direct.worldline-solutions.com`,
  `live → payment.direct.worldline-solutions.com`). Nothing is inferred.
- The session's `clientSecret` is the **`hostedTokenizationUrl`** returned by
  `createPaymentSession`; the adapter builds the `Tokenizer` from it. No client key is needed.
- `confirm()` tokenizes the card and resolves `{ status: "requires_confirmation", clientToken }`
  where `clientToken` carries the `hostedTokenizationId` and the browser's 3-D Secure data
  (see below). The host passes it to the server's `completePayment` — `<PayButton>` /
  `completionEndpoint` wire this automatically.

## 3-D Secure and card storage

- Worldline lists browser device data among the mandatory 3-D Secure properties of every card
  payment, and only the browser can read it. `confirm()` collects it (language, time zone
  offset, user agent, screen height, width and color depth, the Java and JavaScript flags)
  and sends it with the `hostedTokenizationId` as a JSON `clientToken`:
  `{"hostedTokenizationId":"…","device":{…}}`. Browser characteristics only, never card data;
  a value the browser does not expose is left out rather than failing the payment.
- `@payfanout/adapter-worldline-server` decodes the envelope and forwards the device data as
  `order.customer.device`. Deploy the server adapter release that understands it **before**
  this package: an earlier server adapter would send the whole envelope as the
  `hostedTokenizationId`.
- The card is tokenized with `storePermanently: false`, so Worldline keeps no token for later
  payments. The adapter has no saved-card surface, so a stored token could never be used.

## Notes

- Card data is captured **only** inside Worldline's Hosted Tokenization iframe; there is no
  raw card input, and no PAN/CVV ever touches your DOM.
- The Hosted Tokenization `Tokenizer` does not expose a granular field-validity event stream,
  so the adapter emits `onChange({ complete: false })` once on mount and degrades gracefully;
  the true decline outcome surfaces server-side at `completePayment`.

## Documentation

- [Set up Worldline](https://donapulse.github.io/payfanout/guide/worldline)
- [React usage](https://donapulse.github.io/payfanout/guide/react)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
