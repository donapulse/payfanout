# Decision log

Running record of choices that shape the library. Items marked **(default, unconfirmed)**
were taken autonomously from the brief's own recommended defaults (§10/§11) during the
2026-07-04 build sessions and await explicit team sign-off — they are seams, not cement.

## Tooling & packaging

- **pnpm workspaces + changesets** for the monorepo and releases. *(default, unconfirmed)*
- **Build = plain `tsc` emit** (`tsconfig.build.json` per package → `dist/` with `.d.ts`,
  source maps, preserved `"use client"` directives). In-repo consumption stays on TS
  source via `exports: "./src/index.ts"`; **published** artifacts point at `dist/` via
  `publishConfig` (pnpm rewrites on publish). `pnpm run build` builds everything;
  `pnpm run release` = check + build + `changeset publish`.
- Coverage thresholds ratchet up, never down: 92% lines/functions/statements, 82% branches.

## API shape

- **React peer `>=18`**, SSR-safe throughout, no RSC-specific work. *(default, unconfirmed)*
- **Manual capture in v1** on both adapters, plus **multi-capture** modeled as a
  capability: Paysafe `true` (partial settlements are native), Stripe `false` (one
  capture per PaymentIntent). *(manual capture was §7-required; multi-capture flag added 2026-07-04)*
- **Stripe verification = SetupIntent + guaranteed detach** (§8 option a);
  `verifyPaymentMethodStrategy: "disabled"` flips to option b. *(default, unconfirmed)*
- **Currencies with real test coverage:** USD/EUR (2-dec), JPY (0-dec), BHD (3-dec);
  Paysafe sandbox account is CAD-only, so its integration suite runs CAD. *(default, unconfirmed)*
- **Session TTL:** every Paysafe signed session context embeds `expiresAt`
  (default 3600s, `sessionTtlSeconds` to change). Tokens without an expiry are
  rejected — pre-TTL tokens die at deploy time, deliberately.
- **`statementDescriptor` maps to Stripe's `statement_descriptor_suffix`** (the
  standalone param is rejected for card charges on modern API versions) and to
  Paysafe's `merchantDescriptor.dynamicDescriptor`.
- **`payment.refund_failed`** is a first-class unified webhook type; refund-object
  events map by the refund's own status (`succeeded` → `payment.refunded`,
  `failed`/`canceled` → `payment.refund_failed`, non-terminal → `unknown`).
- **Routing lives in a separate `PaymentRouter`**, not inside `PaymentService`:
  session creation only, capability pre-screening, cascade on transient errors only
  (`retryable`, `psp_unavailable`, `rate_limited`, `processing_error`). Post-session
  operations stay pinned to the winning PSP.

## Gap build-out (2026-07-04 evening session)

- **`paymentMethodDetails`** ({brand, last4, wallet}) and **`mandateReference`** on
  PaymentInfo — receipt/compliance facts, normalized (never enough data to charge with).
- **`FieldsChangeState` / `MountOptions.onChange`** — the "disable Pay until complete"
  stream; Stripe via element `change` events, Paysafe via per-field valid/invalid +
  `areAllFieldsValid()` with defensive degradation (SDK variations must never break mount).
- **Event vocabulary grew:** `payment.processing` (async rails underway) and
  `payment.chargeback_won` / `payment.chargeback_lost` (dispute outcomes; Stripe
  `warning_closed` counts as won — the inquiry died without a chargeback).
- **Retries:** `withRetry` in core (backoff+jitter over `retryable`); Stripe SDK
  `maxNetworkRetries` default 2; Paysafe transport retries timeouts/5xx/429 (default 2,
  never business errors — 3406 is retryable hours later, not milliseconds).
- **Circuit breaker in PaymentRouter** (default on: threshold 5, cooldown 30s,
  half-open probe; business rejections close the circuit — they prove liveness;
  desperation mode attempts all-open chains rather than self-inflicting downtime).
- **Paysafe adapter is edge-runtime compatible:** WebCrypto + pure base64 replaced
  node:crypto/Buffer (encode/decode/parse became async). Output is bit-identical —
  outstanding signed tokens stay valid; equivalence is cross-checked against
  node:crypto in tests, plus a static no-node-builtins guard. The Stripe server
  adapter stays Node-only (SDK dependency).
- **Sandbox-verified 2026-07-04:** voiding the remainder AFTER a partial settlement
  works (void 2000 of a 3000 auth with 1000 settled → 200 COMPLETED, settled funds
  stand, payment stays COMPLETED, availableToSettle 0). `cancelPayment` on a
  partially-settled payment = "release remainder", reported as `succeeded` with the
  settled amount — with custom capture keys the settled amount is not statelessly
  rediscoverable (known limitation; default capture keys are).
- **Ops:** typedoc API reference (`pnpm run docs:api` → docs/api, gitignored; note —
  typedoc's glob handling breaks on paths containing parentheses, so run it from a
  paren-free checkout/CI), changesets release workflow (.github/workflows/release.yml,
  needs NPM_TOKEN), demo showcases auto-routing (psp="auto" → PaymentRouter), the
  telemetry hook, and disabled-until-complete via onChange.

## Recurring payments build-out (2026-07-04, explicit user decision)

The "no saved payment methods" scope constraint was **deliberately repealed by user
order** and the full recurring system shipped. What the constraint actually protected —
*card data never touches us* — is untouched: vaulting is PSP-side only (Stripe
Customers + PaymentMethods; Paysafe Customer Vault), and hosts store nothing but opaque
tokens. Shipped surface:

- **Vault contract:** `createCustomer`, `savePaymentMethod` (tokenize-first conversion),
  `listSavedPaymentMethods`, `deleteSavedPaymentMethod` (by token — PSP-internal handle
  ids stay inside the adapter), `chargeSavedPaymentMethod` (off-session, honest
  credential-on-file `occurrence` flags). Save-during-checkout via session
  `customer` + `savePaymentMethod`; the stored token surfaces on
  `PaymentInfo.savedPaymentMethodToken`. Capability `supportsSavedPaymentMethods` now
  demands the full surface (coherence-checked); the conformance suite runs a
  customer→save→list→charge×2→delete round-trip on every adapter.
- **Stripe realities:** save-mode SetupIntents (customer present) do NOT detach —
  verification-mode (customer-less) keeps the detach guarantee; stored-token charges
  need `automatic_payment_methods.allow_redirects: "never"` or Stripe demands a
  return_url (sandbox-verified failure); `off_session: true` except for `initial`.
- **Paysafe realities (probe-verified 2026-07-04):** `POST /customers` (unique
  `merchantCustomerId`); single-use → MULTI_USE via
  `POST /customers/{id}/paymenthandles { paymentHandleTokenFrom }` — works for BOTH
  server-created `/paymenthandles` tokens and browser `/singleusepaymenthandles`
  tokens (Paysafe.js); listing ONLY via `GET /customers/{id}?fields=paymenthandles`
  (the collection GET 405s); delete by handle id; charges carry
  `storedCredential { type: RECURRING, occurrence: INITIAL|SUBSEQUENT }` (ADHOC used
  for "unscheduled", not sandbox-verified); a deleted token dies at /payments with
  5068. **createCustomer is idempotent per host user id:** duplicate
  `merchantCustomerId` → 409 error 7505; the adapter recovers the existing profile via
  `GET /customers?merchantCustomerId=` — a restarted host that lost its cache gets the
  same profile back (found by E2E, sandbox-verified). **Re-saving an already-vaulted
  card** → 409 error 7503 naming the existing handle; the adapter returns that stored
  method when it belongs to the same customer (idempotent save). **AVS on stored-token
  charges:** browser-tokenized (Paysafe.js) handles carry no billing data — charges of
  such tokens can 3004 ("zip required") regardless of INITIAL/SUBSEQUENT, varying by
  card; `ChargeSavedPaymentMethodInput.billingDetails` forwards it, and
  SubscriptionRecord persists it so renewals have it too (server-created handles kept
  their AVS data and charged fine without — the E2E caught the browser-origin case).
  One sandbox oddity: a stale card-uniqueness record for 4111… (pointing at a deleted
  ghost profile) permanently 7503s public-key-origin conversions of that card — test
  flows use distinct cards per suite.
- **SubscriptionManager (@payfanout/server):** full lifecycle
  (create/retrieve/list/update/cancel[atPeriodEnd]) + `chargeDueSubscriptions` cron
  entry point. PayFanout still persists NOTHING — the host implements
  `SubscriptionStore` over its database (InMemory impl ships for dev/tests). Design
  points: periods anchor on period END (no drift); renewal idempotency keys are
  `payfanout-sub-{id}-{periodEnd}-a{attempt}` (crash-safe, and retries never replay a
  PSP-cached failure); dunning default 24h/72h then cancel; `catchUpLimit` default 1
  (a dead cron never surprise-multi-charges); plan changes apply next period, no
  proration; a failed FIRST charge persists nothing. PSP-native billing (Stripe
  Billing) deliberately not wrapped — one-PSP concepts are not abstractions.

- Settlements/voidauths require an explicit `amount`; settlements are query-only
  (`GET /settlements?merchantRefNum=`); `availableToSettle`/`availableToRefund` are the
  state sources; refunds of unbatched settlements → error 3406 (retryable
  `processing_error`); verification refNums must be unique per attempt.
- `POST /payments` strict-rejects handle-level fields with error 5023: `webhook`,
  `returnLinks`, and — verified 2026-07-04 — **`shippingDetails`**. Accepted on
  `/payments`: `merchantDescriptor`, `profile`, `billingDetails`. Shipping therefore
  rides the signed session context only (available to handle-level flows).
- `GET /paymenthub/v1/refunds/{id}` is the refund-polling route (probe-verified:
  proper 5269 "Entity not found" on unknown ids). Full round-trip with a live refund id
  needs a batched settlement (sandbox batches overnight).
- Paysafe sandbox account pmle-1152420: CARD + CAD only, single-account key (no
  `accountId` needed). Paysafe.js apiKey = base64("OT-1152420:<public key>").

## Design-system customization (2026-07-04, explicit user decision)

The front-end field surface became fully host-customizable, via passthroughs rather
than enumerated options (future SDK options need no library release):

- **`MountOptions.fieldOptions`** — PSP-vocabulary UI options forwarded untouched to
  the SDK's field creation. Stripe: the entire Payment Element option surface
  (`layout` tabs/accordion, `paymentMethodOrder`, `fields`, `defaultValues`, `terms`,
  `wallets`, …). Paysafe: per-field options under `fields` (placeholders, …) plus any
  top-level setup option. Adapters protect ONLY their functional keys (Stripe:
  clientSecret; Paysafe: environment/currencyCode/accountId/mount selectors) — the
  host wins everywhere else.
- **`MountOptions.locale`** — BCP-47, mapped per PSP (Paysafe underscore form).
- **Slot convention for split-field PSPs:** `data-payfanout-field="cardNumber|
  expiryDate|cvv"` elements inside the container become the mount points — the host
  owns the layout (grids, rows, labels); adapter-created stacked divs remain the
  fallback; host slots are never removed on unmount. `<PaymentFields>` renders its
  children inside the mount container to carry the slots.
- **`usePay()`** — `<PayButton>`'s engine as a hook (`{ pay, paying }`), so any
  design-system button gets confirm + §4a branching + normalized failures in three
  lines; `<PayButton>` is now a thin skin over it.
- Proven live in the demo/E2E: Stripe accordion + method order, Paysafe French
  placeholders + host-owned two-column grid, fully custom gradient button.

## PayZen adapter (2026-07-07)

Confirm-on-client pair (`adapter-payzen` / `adapter-payzen-server`, REST API V4 +
krypton-client embedded form, server edge-runtime compatible). Platform gaps and the
choices they forced:

- **PayZen has no idempotency mechanism** (live-verified: identical
  `Charge/CreatePayment` bodies mint distinct formTokens). Session creation synthesizes
  traceability: `orderId` derives deterministically from the caller's `idempotencyKey`
  (`pf-` prefix, sanitized, ≤ 64 chars, hash-fragment disambiguation) and the key/id are
  stamped into `metadata` — replays converge on one order, reconcilable via `Order/Get`.
- **Refunds have NO honest idempotency**: `Transaction/Refund` carries no
  metadata/reference field a replayed key could be matched against, so replays stack a
  second credit. Consequently refund/cancel/validate are never transport-retried, and
  their transport failures (network/timeout/5xx/429) surface `retryable: false` with
  guidance to re-read the payment (`amountRefunded`) before retrying — the outcome of a
  lost response is unknown. ERROR envelopes keep their mapped flags (the gateway
  provably rejected the call).
- **IPN event id is synthesized** as `uuid:detailedStatus` — PayZen has no event id,
  `kr-hash` regenerates per delivery, and a redelivery can carry a *changed*
  `detailedStatus` that must not dedupe away.
- **Manual capture = `Transaction/Validate`** (`Transaction/Capture` is a Brazil-only
  batch WS — a regional trap, never used). `AUTHORISED` maps to `succeeded`
  (auto-capture is scheduled); `AUTHORISED_TO_VALIDATE` maps to `requires_capture`.
- **CNY and KHR are excluded by the adapter**: PayZen prices them with 1 and 0
  fractional digits while ISO 4217 (core's minor-unit contract) uses 2 — pass-through
  would shift decimal points. **BHD is unsupported by PayZen** (absent from its currency
  table); KWD/TND prove the 3-decimal path.
- **The kr-answer string is the signed webhook unit**: `verifyWebhookSignature` hashes
  the raw `kr-answer` (rawBody), the `kr-hash*` fields ride headers, and handing over
  the whole urlencoded IPN body is tolerated (the adapter extracts the fields itself).

## GoCardless adapter (2026-07-07)

- One-off bank payments ("Pay by Bank" / Instant Bank Pay) via **Billing Requests**:
  the billing request id is `pspSessionId` and the hosted flow's `authorisation_url`
  is `clientSecret`. Confirm-on-client shaped (`requiresServerCompletion: false`),
  every method `flow: "redirect"` — bank authorisation is only permitted on
  GoCardless-hosted UIs, so an embedded flow cannot honestly be claimed.
- One-off payment requests are **GBP/EUR only**; the other GoCardless currencies need
  mandate-based flows the adapter does not create in v1.
- `payment_request.description` is **mandatory** (422 "can't be blank",
  sandbox-verified 2026-07-07). `statementDescriptor` rides it — the
  authorisation-screen text, not the bank statement line (`reference` is restricted
  to PayTo/direct-settlement accounts) — falling back to `metadata.description`,
  then a derived `Payment <id>` default.
- **Flow creates are not idempotent at GoCardless** (sandbox-verified 2026-07-07: two
  POST /billing_request_flows with the same Idempotency-Key returned two different
  flow ids). Idempotency therefore lives at the billing-request level: a replayed
  session returns the same billing request with a fresh authorisation URL (every flow
  authorises that one billing request — no duplicate-payment risk), and the
  conformance idempotency proof moved to refunds (same key twice → the original
  refund, exactly one create).
- Webhook deliveries are **batched** (up to 250 events, one HMAC over the raw body):
  `parseWebhookEvent` throws on batched deliveries instead of dropping events;
  `parseGoCardlessWebhookEvents` (verify once, fan out per event) is the documented
  ingress. `billing_requests`/`fulfilled` maps to `payment.processing`, payment id
  from `links.payment_request_payment`.
- `supportsSavedPaymentMethods: false` in v1: mandates are genuinely reusable
  charging handles, but async bank rails cannot meet the vault contract's
  instantly-succeeded off-session charge; mandates-as-vault is future work.
- `listRefunds` scopes with the server-side `?payment=` filter on GET /refunds
  (sandbox-verified: 200 + empty list for a refund-less payment).

## PayPal adapter (2026-07-07)

- **`paypal` added as a first-class unified payment method type** in
  `PAYMENT_METHOD_TYPES`. Additive vocabulary growth only — no contract semantics
  changed, so this deliberately did not go through the "adapter contract change"
  process (core + conformance + all adapters); conformance validates against the
  const array and no exhaustive switches over the type exist outside adapters.
- **Post-capture canonical id = the CAPTURE id.** PayPal order GETs stop answering a
  few days after completion, while the capture is the durable money object refunds
  and webhooks key on. `completePayment` therefore returns
  `PaymentInfo.pspPaymentId` = capture id (order id pre-capture / for AUTHORIZE
  intent), `retrievePayment` accepts either and falls back order → capture, and
  `refundPayment` resolves order ids to their capture. Hosts are documented to
  store the capture id.
- **Webhook verification via PayPal's postback API**
  (`POST /v1/notifications/verify-webhook-signature`), not local X.509 crypto:
  stateless, edge-clean, and PayPal does the certificate work. The raw body is
  spliced into the postback by string concatenation (parse + re-stringify breaks
  PayPal's verification); a missing `webhookId`, missing transmission headers, or
  transport trouble all answer `false` (fail closed, no network call where
  detectable locally). Local crypto (CRC32 + SHA256withRSA over the cert from
  `paypal-cert-url`) stays a documented optimization path, rejected for v1 because
  WebCrypto cannot import X.509 certs without hand-rolled ASN.1.
- **Sandbox-verified 2026-07-07:** orders created with `payment_source.paypal`
  (always, for the experience_context) answer `PAYER_ACTION_REQUIRED` immediately —
  not `CREATED` — so a fresh session reports `requires_action`; PATCH still works in
  that state, and capture/authorize still 422 `ORDER_NOT_APPROVED`. The in-memory
  fake mirrors this (bare orders without a payment_source keep `CREATED`).

## Versioning policy (2026-07-07, explicit user decision)

- **Independent package versioning.** The repo-wide `linked: [["@payfanout/*"]]`
  group (a tooling default from the 2026-07-04 build, until now unconfirmed) is
  removed: lock-step minors on untouched packages misrepresent what changed.
  Only packages with a changeset take that bump; packages that merely depend on
  a bumped package receive the `updateInternalDependencies: "patch"` bump that
  published artifacts need for coherent internal dependency ranges.
- The private workspaces `@payfanout/integration-tests` and `@payfanout/e2e`
  join `payfanout-demo` in changesets `ignore` — never published, no version
  churn.

## Open items requiring humans or infrastructure

- Webhook delivery verification (both PSPs) needs a public URL/tunnel + real webhook
  secrets; deferred by user request. Paysafe's signature **header name** is still
  unconfirmed (adapter accepts `signature` / `x-signature` / `x-paysafe-signature`).
- Team sign-off on every *(default, unconfirmed)* item above.

## Contract hardening (2026-07-08, explicit user-approved review follow-up)

One atomic core+conformance+all-adapters change (major changesets across the board):

- **idempotencyKey is now REQUIRED on `capturePayment`, `cancelPayment`, and
  `verifyPaymentMethod`** (`VerifyPaymentMethodInput.idempotencyKey`). The library's own
  invariant said "required on every mutating call" while the contract left it optional on
  capture — the canonical double-charge operation. Under `supportsMultiCapture` every
  partial capture carries its own key.
- **`authentication_required` is retryable: false, everywhere.** Stripe's adapter said
  true, PayPal's said false; `withRetry` and the router cascade act on the flag, so the
  same situation behaved differently per PSP. Resolving SCA means bringing the customer
  back on-session — never replaying the call. The conformance error suite now asserts
  this, plus retryable: true for `rate_limited`/`psp_unavailable`.
- **`AdapterCapabilities.supportedCurrencies`** (absent = unrestricted): hard PSP currency
  constraints (PayPal's whitelist, GoCardless GBP/EUR) are now declared and pre-screened
  by `screenSessionInput`, so a currency mismatch skips the candidate instead of aborting
  the failover cascade with the PSP-local `invalid_request`.
- **New error codes**: `session_expired` (expired stateless session tokens — recover by
  creating a fresh session; Paysafe's session-context adopts it) and
  `unsupported_operation` (capability guards, previously indistinguishable from input
  errors under `invalid_request`). Compiler-enforced entries in every locale catalog.
- **`PaymentInfo` grew `amountCaptured`/`amountCapturable`** (partial/multi-capture is
  first-class but the model couldn't show captured totals) **and `metadata`** (echo of the
  PSP-stored host metadata). PSPs that cannot honestly provide id round-trip or metadata
  echo declare it via conformance `money.expectations` (Paysafe: both false — the id and
  metadata ride the signed session token only; PayPal: metadata false, custom_id carries
  the id). `PaymentMethodDetails` grew `expMonth`/`expYear` (display/renewal warnings).
- **`UnifiedWebhookEvent` grew `amount`/`currency`/`refundId`** — a stateless host should
  not need a retrieve round-trip to know how much a `payment.refunded` refunded.
- **Conformance now proves the money paths** instead of trusting per-adapter discipline:
  mandatory `money` fixtures drive retrievePayment truth (amount/ids/metadata), full
  refund, accumulating partial refunds, over-refund rejection, pending-refund polling,
  capture (`amountCaptured` === captured amount), multi-capture accumulation, and
  cancel → `"canceled"`; webhooks additionally prove unknown-but-valid types map to
  `"unknown"` on a SIGNED body, and client adapters that report redirect-flow methods
  must implement `handleRedirectReturn`.
- Smaller core additions: `allocate()` (largest-remainder integer splits — the sanctioned
  way to compute fee/tax shares), `RetryPolicy.signal` (AbortSignal stops between
  attempts) and `maxDelayMs` is now a hard ceiling jitter included, `REFUND_STATUSES`/
  `RefundStatus`, `RefundRequest.reason` typed to Stripe's vocabulary (best-effort
  elsewhere), `isUnifiedWebhookEventType`/`isUnifiedPaymentMethodType` guards, and the
  `DATA_PAYFANOUT_FIELD` slot-attribute constant.

## Dependency security remediation (2026-07-09)

- **`vite`/`esbuild` forced past 4 disclosed CVEs via `pnpm.overrides`**, not a plain
  version bump: `vitepress@1.6.4` pins its own `vite: ^5.4.14`, and 5.x never received a
  patched release for any of them (fixes start at 6.4.2/6.4.3). `vite@<6.4.3` /
  `esbuild@<0.25.0` overrides force every resolution in the tree upward regardless of
  what a dependency declares; pnpm dedupes this onto the `vite@8.1.3`/`esbuild@0.28.1`
  versions `examples/demo` already depends on directly.
- **Known, accepted cost: `pnpm run docs:dev` serves pages with empty `<title>`/meta
  tags** under vite 8 — vitepress 1.x's dev-server SSR head-injection isn't compatible
  with vite 8's Rolldown-based bundler (vitepress itself logs "not compatible with
  rolldown-vite, use VitePress v2" on startup). Tried capping the override at `<7.0.0`
  to stay on a more conservative vite major instead; that broke `vitest@4.1.9`'s own
  peer expectations (it wants the same vite 8 line `examples/demo` uses), which is worse
  since every CI check depends on vitest. `pnpm run docs:build` — what actually ships to
  GitHub Pages — is unaffected; verified the built output's titles/meta are correct. No
  clean fix exists short of a VitePress v2 migration (alpha-only as of this writing);
  revisit once VitePress ships a stable v2.

## Completion-time billing (2026-07-10)

- **`CompletePaymentInput.billingDetails`** (optional) lets a host attach AVS billing —
  typically a postal code collected on the payment step — at completion, not only at
  `createPaymentSession`. The Paysafe server adapter merges it over the signed session
  context's billing (completion's defined fields win, field by field) before `POST /payments`, so
  AVS-enforcing accounts clear error 3004 without recreating the session. Additive and
  backward-compatible: existing callers/adapters are unaffected, confirm-on-client PSPs
  (Stripe) never call `completePayment`, and the conformance suite is unchanged — so, like
  the PayPal payment-method-type addition, this deliberately did NOT go through the
  breaking adapter-contract-change process (core + conformance + all adapters).
