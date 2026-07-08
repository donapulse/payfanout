# Webhooks

This page is the **code** side of webhooks, verifying, parsing, and handling events.
**Registering** the endpoint URL and obtaining its signing secret happens in each PSP's
dashboard, see [Set up Stripe](/guide/stripe) and [Set up Paysafe](/guide/paysafe).

Both ingress patterns are supported, the output is always one normalized
`UnifiedWebhookEvent`, whichever PSP sent it.

```ts
// 1. Recommended: one endpoint per adapter
const stripeHook = createAdapterWebhookHandler(stripe, { onEvent });

// 2. Single shared URL (tries each adapter's signature verification; logs which matched)
const unifiedHook = createUnifiedWebhookHandler([stripe, paysafe], { onEvent, log: console.log });
```

## ⚠ Raw body required

Signature verification hashes the **exact raw request bytes**. `express.json()`, Next.js
default body parsing, and most middlewares destroy them:

```ts
// Express, register BEFORE express.json():
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const result = await stripeHook({ rawBody: req.body.toString("utf8"), headers: req.headers });
  res.status(result.status).end();
});

// Next.js App Router:
export async function POST(req: Request) {
  const result = await stripeHook({
    rawBody: await req.text(),                       // BEFORE any json() call
    headers: Object.fromEntries(req.headers),
  });
  return new Response(null, { status: result.status });
}

// Fastify: addContentTypeParser("application/json", { parseAs: "string" }, (_r, body, done) => done(null, body))
// then pass request.body (the raw string) as rawBody.
```

::: warning The conformance suite enforces this
There is a test that **fails any adapter which re-serializes a parsed body before
verifying** (same JSON value, different bytes ⇒ must reject).
:::

## Ack fast, process async

The handler verifies, parses, hands the event to your `onEvent`, and expects a 2xx
immediately, `onEvent` must **enqueue, not process**. Paysafe retries effectively forever
until it sees success.

- **Dedupe is yours:** `event.id` is a stable key; keep the seen-set in your store.
- **Ordering is not guaranteed** by any PSP, treat events as unordered facts and reconcile
  with `retrievePayment` when sequence matters.
- **Batched deliveries (GoCardless):** the unified handlers process one event per
  delivery — a batched GoCardless webhook (up to 250 events under one signature) makes
  `parseWebhookEvent` throw instead of dropping events. Route GoCardless deliveries to
  `parseGoCardlessWebhookEvents` (verify once, fan out per event) as shown in the
  [GoCardless guide](/guide/gocardless).
- **Money facts ride the event** where the PSP payload carries them: `event.amount` /
  `event.currency` (integer minor units) and `event.refundId` on refund-shaped events —
  most handlers never need a `retrievePayment` round-trip just to learn how much a
  `payment.refunded` refunded.

## Operational concerns

**Secret rotation without cutover:** both adapters accept an *array* of signing
secrets/HMAC keys, register the new one, keep the old until the PSP switches, then drop it.

**Missed-webhook recovery:** `payments.fetchEvents("stripe", { since, cursor })` replays
recent events as the same normalized `UnifiedWebhookEvent`s (same ids, your dedupe makes
replays no-ops). Paysafe has no public events API (`supportsEventPolling: false`), so its
fallback stays `retrievePayment` per order.

## The events you'll see

- **Refund outcomes are first-class:** async refunds that later fail arrive as
  `payment.refund_failed`, never a misleading `payment.refunded`, and
  `retrieveRefund(refundId)` polls any `"pending"` refund to its terminal state.
- **Async rails signal progress:** SEPA/ACH-style methods emit `payment.processing`
  (underway, not final) before their terminal event days later.
- **Disputes resolve:** `payment.chargeback` on opening, then `payment.chargeback_won` /
  `payment.chargeback_lost` when closed.

## Next

- [Server usage](/guide/server), where `fetchEvents` and `retrievePayment` live.
- [Conformance](/guide/conformance), how the raw-body guarantee stays true for every adapter.
