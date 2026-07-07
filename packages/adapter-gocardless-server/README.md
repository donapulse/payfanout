# @payfanout/adapter-gocardless-server

Server-side GoCardless adapter for [PayFanout](https://donapulse.github.io/payfanout/):
Billing Requests, hosted bank authorisation flows, payments, refunds, events, and
webhooks, over the GoCardless REST API.

> **Holds secrets.** This package uses your GoCardless access token. Never bundle it
> client-side.

It implements the `ServerPaymentAdapter` contract from `@payfanout/core`, so
`@payfanout/server` drives it through the same unified API as every other PSP. It talks to
the REST API directly and is **edge-runtime compatible** (WebCrypto only, no Node
builtins), so it runs on Cloudflare Workers and Next.js edge routes.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [Set up GoCardless](https://donapulse.github.io/payfanout/guide/gocardless)
· [Server usage](https://donapulse.github.io/payfanout/guide/server)

## Installation

```bash
pnpm add @payfanout/server @payfanout/adapter-gocardless-server
```

`@payfanout/core` comes in transitively.

> **Not yet published to npm.** The packages are at `0.1.0`. Until a release is cut, consume
> them from source, see the [Installation guide](https://donapulse.github.io/payfanout/guide/installation).

## Usage

```ts
import { PaymentService } from "@payfanout/server";
import { GoCardlessServerAdapter } from "@payfanout/adapter-gocardless-server";

const gocardless = new GoCardlessServerAdapter({
  accessToken: process.env.GOCARDLESS_ACCESS_TOKEN!,   // read-write dashboard token
  environment: "sandbox",                              // never inferred from credentials
  webhookSecret: process.env.GOCARDLESS_WEBHOOK_SECRET!, // string or array for rotation
});

const payments = new PaymentService({ adapters: [gocardless] });
```

Pair it on the browser with [`@payfanout/adapter-gocardless`](../adapter-gocardless). This
is a **confirm-on-client** PSP with a **redirect flow**: `createPaymentSession` creates a
billing request plus its GoCardless-hosted authorisation flow, the client redirects the
payer to `clientSecret` (the `authorisation_url`), and GoCardless fulfils the billing
request itself — there is no `completePayment` step. Outcomes are asynchronous: confirm
them via webhooks or `retrievePayment` (which accepts both the `BRQ...` session id and the
`PM...` payment id), never via the redirect.

## Webhooks are BATCHED — read this before wiring the endpoint

One GoCardless delivery carries **up to 250 events** in a single signed body. Verify the
signature once over the exact raw bytes, then fan out per event:

```ts
import { parseGoCardlessWebhookEvents } from "@payfanout/adapter-gocardless-server";

app.post("/webhooks/gocardless", express.raw({ type: "application/json" }), async (req, res) => {
  const rawBody = req.body.toString("utf8");
  if (!(await gocardless.verifyWebhookSignature(rawBody, req.headers as Record<string, string>))) {
    res.status(498).end(); // GoCardless's "Invalid Token" convention
    return;
  }
  for (const event of parseGoCardlessWebhookEvents(rawBody)) {
    enqueue(event); // ack fast, dedupe by event.id, process async
  }
  res.status(200).end();
});
```

The single-event contract method `parseWebhookEvent` **throws on multi-event deliveries**
rather than silently dropping events — use the recipe above for GoCardless ingress.

## What's inside

- **`GoCardlessServerAdapter`**, the server contract (sessions via billing requests +
  hosted flows, retrieve by billing request or payment id, cancel, full/partial refunds
  with `total_amount_confirmation`, refund polling, event polling, payment/refund listing).
- **Webhook helpers**, `verifyGoCardlessWebhookSignature` (hex HMAC-SHA256 over the raw
  bytes, constant-time, secret-rotation aware) and `parseGoCardlessWebhookEvents` (the
  batch fan-out).
- **`mapGoCardlessError`**, unifies GoCardless errors into `PayFanoutError` (only
  429/5xx/network trouble is retryable), and **`GOCARDLESS_PSP_NAME`**.

## Notes

- Billing-request and refund creates carry an `Idempotency-Key`; a consumed key's 409
  `idempotent_creation_conflict` is resolved by fetching the original resource.
  GoCardless does not dedupe flow creates, so a replayed session returns the same
  billing request with a fresh authorisation URL — replays stay side-effect free.
- One-off billing request payments support **GBP and EUR** only; bank payments confirm
  **asynchronously** (seconds for instant rails, days for debit fallback) and late
  failures exist — webhooks are the source of truth.
- **Refunds are disabled by default** on GoCardless accounts; until support enables them,
  `refundPayment` surfaces the 403 with an actionable message.
- Saved payment methods are declared `false` in v1: GoCardless mandates are reusable
  charging handles, but bank debits cannot meet the vault contract's instantly-succeeded
  off-session charge. Mandates-as-vault is documented future work.

## Documentation

- [Set up GoCardless](https://donapulse.github.io/payfanout/guide/gocardless)
- [Server usage](https://donapulse.github.io/payfanout/guide/server)
- [Webhooks](https://donapulse.github.io/payfanout/guide/webhooks)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
