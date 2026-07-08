# @payfanout/adapter-payzen-server

Server-side PayZen (Lyra) adapter for [PayFanout](https://donapulse.github.io/payfanout/):
payments, validation capture, refunds, and IPN verification over the PayZen REST API V4.

> **Holds secrets.** This package uses your PayZen REST password. Never bundle it
> client-side.

It implements the `ServerPaymentAdapter` contract from `@payfanout/core`, so
`@payfanout/server` drives it through the same unified API as every other PSP. It talks to
the REST API directly and is **edge-runtime compatible** (WebCrypto only, no Node builtins),
so it runs on Cloudflare Workers and Next.js edge routes.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [Set up PayZen](https://donapulse.github.io/payfanout/guide/payzen)
· [Server usage](https://donapulse.github.io/payfanout/guide/server)

## Installation

```bash
pnpm add @payfanout/server @payfanout/adapter-payzen-server
```

`@payfanout/core` comes in transitively.

## Usage

```ts
import { PaymentService } from "@payfanout/server";
import { PayZenServerAdapter } from "@payfanout/adapter-payzen-server";

const payzen = new PayZenServerAdapter({
  shopId: process.env.PAYZEN_SHOP_ID!,       // Back Office "User"
  password: process.env.PAYZEN_PASSWORD!,    // testpassword_… / prodpassword_…
  environment: "sandbox",                    // validated against the key family
  hmacKey: process.env.PAYZEN_HMAC_KEY,      // browser-return kr-answer validation
});

const payments = new PaymentService({ adapters: [payzen] });
```

This is a **confirm-on-client** PSP: `createPaymentSession` returns a short-lived
`formToken` as `clientSecret`, the krypton-client form in the browser creates the
transaction (3DS2 inline), and the server reads outcomes via `retrievePayment` and the
IPN. There is no `completePayment` step.

## What's inside

- **`PayZenServerAdapter`** — sessions (`Charge/CreatePayment`), reads
  (`Transaction/Get`, `Order/Get`), manual capture via `Transaction/Validate`,
  cancel/refund (`Transaction/Cancel`, `Transaction/Refund`,
  `Transaction/CancelOrRefund`), and IPN signature verification (HMAC-SHA-256 over the
  raw `kr-answer`, both key families, rotation arrays).
- **Synthesized idempotency** — PayZen has no idempotency mechanism, so the adapter
  derives a deterministic `orderId` from your `idempotencyKey`, stamps it into
  transaction metadata, and never auto-retries refund-class calls. See the
  [PayZen guide](https://donapulse.github.io/payfanout/guide/payzen) for the residual
  caveats (never blind-retry refunds).
- Errors normalize into PayFanout's taxonomy — PayZen answers HTTP 200 even for
  failures, so the envelope (`INT_`/`PSP_`/`ACQ_`/`AUTH_` codes) drives the mapping and
  the untouched envelope always rides `raw`.

Pair it in the browser with [`@payfanout/adapter-payzen`](../adapter-payzen), which mounts
the embedded card form the `formToken` feeds.

## Documentation

- [Set up PayZen](https://donapulse.github.io/payfanout/guide/payzen)
- [Server usage](https://donapulse.github.io/payfanout/guide/server)
- [Webhooks](https://donapulse.github.io/payfanout/guide/webhooks)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
