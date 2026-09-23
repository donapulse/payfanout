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
  {/* onChange fires { complete: false } on mount, then { complete: true | false } each time
      the Tokenizer reports a validity change. */}
  <PaymentFields clientSecret={session.clientSecret} onChange={({ complete }) => setPayEnabled(complete)} />
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
  where `clientToken` is the `hostedTokenizationId`. The host passes it to the server's
  `completePayment` — `<PayButton>` / `completionEndpoint` wire this automatically.

## Notes

- Card data is captured **only** inside Worldline's Hosted Tokenization iframe; there is no
  raw card input, and no PAN/CVV ever touches your DOM.
- `onChange` is driven by the Tokenizer's `validationCallback`: it fires
  `{ complete: false, empty: true }` on mount, then `{ complete }` carrying each validity
  report's `valid` flag. The adapter owns that callback; one passed in `fieldOptions` still
  runs, after `onChange`, with the same result. Validity only means the form is correctly
  filled in: the decline outcome surfaces server-side at `completePayment`.
- The cardholder-name field is shown by default (`hideCardholderName: false`), because
  Worldline requires the cardholder name and hides that field unless told otherwise. A
  `hideCardholderName: true` in `fieldOptions` still wins, but then the name has to reach
  Worldline through its `useCardholderName` call, which the adapter neither makes nor
  exposes, so keep the field visible.

## Documentation

- [Set up Worldline](https://donapulse.github.io/payfanout/guide/worldline)
- [React usage](https://donapulse.github.io/payfanout/guide/react)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
