# Integration tests (real PSP sandboxes)

These suites are **skipped and green** until credentials are present, then they run the
adapters against the real sandbox APIs. They exist to validate every assumption the
in-memory fakes encode — REST paths, auth formats, idempotency semantics, status
transitions, payload shapes.

## Environment variables

| Variable | Used for | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Stripe suite | **Must** start with `sk_test_` — the suite refuses live keys |
| `STRIPE_WEBHOOK_SECRET` | optional | Only needed for future webhook-delivery tests |
| `PAYSAFE_USERNAME` / `PAYSAFE_PASSWORD` | Paysafe suite | Sandbox API key credentials |
| `PAYSAFE_ACCOUNT_ID` | optional | Merchant account id — omit for single-account API keys (Paysafe routes by key + currency) |
| `PAYSAFE_CURRENCY` | optional | Defaults to `USD`; sandbox accounts are often provisioned for one currency (the current test account: **CAD only**) |
| `PAYSAFE_WEBHOOK_HMAC_KEY` | optional | Only needed for future webhook-delivery tests |
| `PAYSAFE_BASE_URL` | optional | Defaults to `https://api.test.paysafe.com`; live URL is refused |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | PayPal suite | Sandbox REST app credentials |
| `PAYPAL_WEBHOOK_ID` | optional | Only needed for future webhook-delivery tests |
| `PAYPAL_ENVIRONMENT` | optional | Anything but `live`; setting `live` makes the suite refuse to run |
| `PAYPAL_NEGATIVE_TESTING` | optional | Set to `1` to run the `INSTRUMENT_DECLINED` mock-response case (requires Negative Testing enabled on the business sandbox account) |

## Run

```powershell
$env:STRIPE_SECRET_KEY = "sk_test_..."
$env:PAYSAFE_USERNAME = "..."; $env:PAYSAFE_PASSWORD = "..."; $env:PAYSAFE_CURRENCY = "CAD"
pnpm run test:integration
```

Keys are read from the environment only — never commit them.

## Webhook delivery (manual step, needs a public URL)

Real webhook deliveries can't run in a plain test process. Two options:

- **Stripe CLI:** `stripe listen --forward-to localhost:4242/webhooks/stripe`, run the demo
  server (`pnpm --filter payfanout-demo dev:server` with `STRIPE_WEBHOOK_SECRET` set to the
  CLI's printed `whsec_…`), then `stripe trigger payment_intent.succeeded` and watch the
  `[webhook]` log line.
- **Paysafe:** point the sandbox webhook configuration (or the per-session `webhookUrl`)
  at a tunnel (e.g. `cloudflared`/`ngrok`) to the demo server and make a sandbox payment.
  This is also how the real signature header name gets confirmed.
