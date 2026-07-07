# @payfanout/adapter-gocardless

## 0.2.0

### Minor Changes

- 7444bb6: Add the GoCardless bank payments adapter pair. The server adapter creates billing requests with GoCardless-hosted bank authorisation flows and covers retrieval by session or payment id, cancellation, full/partial refunds, event polling, listing, and signature-verified webhooks — including batched deliveries via `parseGoCardlessWebhookEvents`. The client adapter drives the redirect flow (no card fields, no client-side key) and resolves the return trip through `handleRedirectReturn`.

### Patch Changes

- Updated dependencies [6e039c2]
  - @payfanout/core@0.2.0
