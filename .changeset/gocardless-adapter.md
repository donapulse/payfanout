---
"@payfanout/adapter-gocardless": minor
"@payfanout/adapter-gocardless-server": minor
---

Add the GoCardless bank payments adapter pair. The server adapter creates billing requests with GoCardless-hosted bank authorisation flows and covers retrieval by session or payment id, cancellation, full/partial refunds, event polling, listing, and signature-verified webhooks — including batched deliveries via `parseGoCardlessWebhookEvents`. The client adapter drives the redirect flow (no card fields, no client-side key) and resolves the return trip through `handleRedirectReturn`.
