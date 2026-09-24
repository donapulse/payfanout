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

## Common appearance tokens (2026-07-10)

- **`PaymentFields.appearance` gained a small cross-PSP common token set** —
  `colorPrimary`, `colorText`, `colorDanger`, `colorBackground`, `fontFamily`, `fontSize` —
  that the hosted-card-field adapters — today Stripe and Paysafe — translate to their
  native format, making the long-documented "style regardless of PSP" promise real for the
  common case (rather than the false blanket claim it was). Stripe maps
  them into the Appearance API `variables` (`fontSize`→`fontSizeBase`); Paysafe maps the
  ones its hosted inputs can honestly surface onto the `input` selector (`colorText`→
  `color`, `colorBackground`→`background-color`, `fontFamily`, `fontSize`) and leaves
  `colorPrimary`/`colorDanger` unapplied — no honest hosted-card-input surface, so they are
  recognized but never faked. Only these two hosted-card-field adapters translate the
  tokens; PayPal (button `style`), GoCardless (`panel`), and PayZen style different surfaces
  and keep their own native `appearance` shape — the common tokens do not apply to them.
  PSP-native shapes still pass through for power users, and the
  Paysafe adapter now `console.warn`s about entries it cannot apply (notably a Stripe
  `variables`/`theme`/`rules`/`labels` object misrouted to Paysafe, which previously made
  Paysafe.js log a cryptic "Invalid css property" and silently drop ALL styling). The common
  vocabulary is shared by convention (documented in the `appearance` JSDoc), not a core
  export — core stays UI-free. Not a contract change: `appearance` is
  `Record<string, unknown>` and each adapter handles it independently; conformance is unchanged.

## Built-in server-completion transport (2026-07-10)

- **`createCompletionHandler` (@payfanout/server) + `completionEndpoint` (@payfanout/react)**
  make `requiresServerCompletion` a mounted transport instead of per-host, per-surface
  plumbing. The flag *described* the tokenize-first flow, but every host re-implemented the
  same bridge: return a completion reference from each session endpoint, thread it through
  every checkout surface, hand-write a `completePayment` route, wire `onServerCompletion` per
  surface, and CSRF-exempt the route. Now the provider derives `onServerCompletion` from
  `completionEndpoint` (POST `{ sessionRef, clientToken, billingDetails? }` → `PaymentInfo`)
  and the server mounts one handler.
- **The session's `clientSecret` is the completion reference.** The browser already holds it
  (it mounted `<PaymentFields>` with it), so `<PaymentFields>` publishes it on the mounted
  entry (`MountedEntry.sessionRef`) and `usePay` posts it — no host-minted id travels through
  session-creation responses or checkout components. `resolveSession(sessionRef)` maps it to
  `{ service, pspName, pspSessionId, idempotencyKey }`; for tokenize-first PSPs the session
  token IS the `pspSessionId`.
- **Web-standard `Request`/`Response`, deliberately diverging from the webhook handler's
  neutral `{ rawBody, headers }` objects.** Those globals are native in
  Next.js/Hono/workers/Node 18+, so the handler mounts as one route with no framework
  dependency; Express bridges via `new Request(...)`. The error taxonomy maps to HTTP status
  (`completionErrorStatus`: declines + `authentication_required` → 402, `invalid_request` →
  400, `session_expired` → 410, `unsupported_operation` → 422, `rate_limited` → 429,
  `psp_unavailable` → 503, `processing_error` → 502, `unknown` → 500) and the client rebuilds
  the `PayFanoutError` from the `{ error }` body so `code`/`message`/`retryable` survive.
- **Additive and backward-compatible**: the explicit `onServerCompletion` callback stays the
  escape hatch (and always wins over the endpoint), `createCompletionHandler`/
  `createEndpointCompletion` are new exports, `completionEndpoint` is a new optional prop, and
  no adapter contract or conformance test changed — so, like the completion-time
  `billingDetails` and the appearance tokens, this did NOT go through the breaking
  core+conformance+all-adapters process. @payfanout/server and @payfanout/react bump minor.

## Adapter onboarding descriptor + verifyCredentials (2026-07-10)

- **`AdapterOnboardingDescriptor` (@payfanout/core) + a descriptor per server adapter** turn
  the operator-facing onboarding path into generic loops. An adapter strictly typed its
  config but exposed nothing a host could use to onboard a merchant: settings forms, key-shape
  validation, "which events to subscribe", and CSP hosts were all rebuilt per PSP by reading
  adapter source. Each `-server` adapter now exports a declarative descriptor
  (`credentialFields` with kind/scope/format/perCurrency, `webhook.signature` +
  `webhook.events`, `csp` hosts), so a host renders forms, validates inputs, drives
  subscribe-copy, and builds CSP headers identically for every current and future adapter.
- **The descriptor lives in the SERVER package** (it carries the webhook event list and pairs
  with the server-only probe), even though it also describes client credential fields
  (`scope: "client"`). Client adapter packages are unchanged.
- **`webhook.events` is optional**: PayZen omits it (its IPNs are order-state snapshots, not
  discrete subscribable event types); the other four list exactly their parser's recognized
  provider event strings. `signature` is `hmac-sha256-hex` (Stripe/PayZen/GoCardless),
  `hmac-sha256-base64` (Paysafe), or `provider-postback` (PayPal). GoCardless CSP is empty
  (redirect-only, no browser SDK); PayPal CSP uses documented wildcards.
- **`verifyCredentials?()` (optional on ServerPaymentAdapter)** is the runtime companion — a
  "Test connection" probe that makes ONE side-effect-free call and classifies `auth` /
  `network` / `internal`. Each adapter reuses an existing read-only path: Stripe `events.list`,
  PayPal the OAuth client-credentials mint, Paysafe a customer-vault lookup, PayZen
  `Charge/SDKTest`, GoCardless `GET /payments`.
- **Additive, so NOT the breaking contract process.** `verifyCredentials` and the descriptor
  are new optional/additive surface; `validateOnboardingDescriptor` + a new conformance
  assertion validate the descriptor when a fixture provides it (existing external adapters
  without one still pass — the fixture is optional). core, conformance, and the five `-server`
  adapters bump minor; the client adapters are untouched.

## Worldline Direct adapter (2026-07-14)

Tokenize-first pair (`adapter-worldline` / `adapter-worldline-server`, Online Payments REST
v2 + Hosted Tokenization Page). New adapter packages only — no core/server/react/conformance
changes. Platform facts and the choices they forced (all doc-verified against
docs.direct.worldline-solutions.com unless noted):

- **v1HMAC request signing on WebCrypto** (edge-compatible): `Authorization: GCS
  v1HMAC:{apiKeyId}:{base64(HMAC-SHA256(secret, dataToSign))}`, where `dataToSign` is
  method / Content-Type (empty for GET) / `Date` / sorted canonical `x-gcs-*` header lines /
  resource path, each `\n`-terminated (trailing `\n` after the path). The `Date` header is
  sent and signed (RFC-1123 GMT); the clock is an injectable `now()` so tests are
  deterministic and hosts stay inside the platform's 5-minute skew. (Corrected 2026-09-23
  against the manual-authentication guide: `x-gcs-date` is not documented as a replacement
  for the `Date` header — the guide's examples send it alongside `Date`, signed as a
  canonical `x-gcs-*` header — so the code no longer presents it as an edge-runtime
  alternative.)
- **Idempotency** rides `X-GCS-Idempotence-Key` (max 40 ASCII). Arbitrary caller keys are
  hashed to fit: `sha256Hex(idempotencyKey).slice(0,40)` — deterministic, so replays dedupe
  at Worldline. The header is BOTH signed (in the canonical block) and sent on every mutating
  call (create payment, capture, cancel, refund, and the amountless hostedtokenizations
  create). Doc-verified 2026-07-15: the documented idempotent operations are CreatePayment /
  CapturePayment / CancelPayment / RefundPayment / CompletePayment / CreatePayout /
  SubsequentPayment — CreateHostedTokenization is NOT on the list, so the header on the
  tokenization create is harmless but never relied on for dedupe (the fake mirrors this;
  money-side safety comes from CreatePayment idempotency). A 409 means the request with
  this idempotence key is still being processed, so it maps to a retryable
  `processing_error` and the transport loop replays it instead of surfacing a hard error.
- **Stateless session = signed context** (same pattern as Paysafe): createPaymentSession
  calls `POST /hostedtokenizations` (no amount) and encodes amount/currency/captureMethod/
  returnUrl/billing/hostedTokenizationId + enforced `expiresAt` into `pspSessionId`;
  `clientSecret` is the `hostedTokenizationUrl` the browser iframe mounts from (no client
  key). The host id round-trips via `order.references.merchantReference` only — Worldline has
  no arbitrary metadata map — so conformance `money.expectations` is
  `{ idRoundTrip: true, metadataEcho: false }`. Doc-verified 2026-09-23 (Hosted Tokenization
  Page guide and the served `tokenizer.min.js`): the browser `Tokenizer` hides the
  cardholder-name field unless constructed with `hideCardholderName: false`, although the name
  is mandatory, and calls `validationCallback` with `{ valid }` whenever the form's validity
  changes, so the client adapter defaults `hideCardholderName` to `false` (a host
  `fieldOptions` value still wins) and owns `validationCallback` to drive `onChange`, passing
  each result on to a host-supplied one. The same guide also asks for `integrity` (the
  CreateHostedTokenization response's `sri`) and `crossorigin="anonymous"` on the Tokenizer
  script tag; not applied yet, because the browser receives only the hostedTokenizationUrl and
  core's script injection sets neither attribute.
- **CreatePayment wiring (corrected in review, 2026-07-15):** `hostedTokenizationId` rides
  at the ROOT of the CreatePayment request — the platform's current domain model declares it
  there and `CardPaymentMethodSpecificInput` has no such field (the guide's "replace the
  card property" wording is about replacing card DATA, not a nesting instruction). The 3-D
  Secure return URL is sent BOTH as `cardPaymentMethodSpecificInput.returnUrl` (the field
  the Hosted Tokenization guide names) and in its `threeDSecure.redirectionData.returnUrl`
  form — both are current in the models; sandbox-verify one challenge flow.
  Extended 2026-09-23, doc-verified against the 3-D Secure implementation guide, the Hosted
  Tokenization Page guide, the API contract (v2.507.0) and the Tokenizer script Worldline
  serves: the 3-D Secure guide lists `threeDSecure.redirectionData.returnUrl`,
  `threeDSecure.skipAuthentication` and the browser's `order.customer.device` data as
  mandatory on every card CreatePayment, and the Hosted Tokenization guide requires at least
  those. The list opens with `cardPaymentMethodSpecificInput.card.cardholderName`, which the
  Hosted Tokenization Page collects in the iframe's name field; Worldline hides that field
  unless the `Tokenizer` is constructed with `hideCardholderName: false` (Hosted Tokenization
  guide, "Manage cardholder name"), so it has to stay visible. `confirm()` now returns a JSON
  `clientToken`, `{"hostedTokenizationId","device"}`, whose `device` carries `locale`,
  `timezoneOffsetUtcMinutes`, `userAgent` and `browserData` under the contract's names and
  types (offset and screen size are strings; the guide's `ScreenWidth` is the contract's
  `screenWidth`), each read guarded and left out when unavailable. Open question: `confirm()`
  sends `javaScriptEnabled: true` even when a privacy-hardened browser withholds some of the
  fields JavaScript reads, and whether Worldline then still requires them is undocumented
  (the contract waives `colorDepth`, `javaEnabled`, `screenHeight`, `screenWidth` and
  `timezoneOffsetUtcMinutes` only when `javaScriptEnabled` is `false`) — sandbox-check it. The
  server decodes the envelope with `decodeWorldlineClientToken`, keeps only the fields a
  browser can read, drops any off the contract's types and limits, and still accepts a bare
  `hostedTokenizationId`: the contract also defines `acceptHeader` and `ipAddress` (taken
  "from the HTTP Headers", so observed by the server) and `deviceFingerprint` (a session id
  that "must match the one sent in the device fingerprint script"), and all three are refused
  from the browser, as is any key the contract does not define. CreatePayment always sends
  `threeDSecure.skipAuthentication: false` (the flat field is deprecated) and the return URL in
  both forms, plus `challengeIndicator: "challenge-required"` for `sca.challenge: "force"`.
  Worldline models MOTO as `cardPaymentMethodSpecificInput.transactionChannel` (`ECOMMERCE` by
  default, or `MOTO`), not as an `exemptionRequest` value; the adapter does not map
  `sca.exemption: "moto"` yet, so such a payment goes out as an e-commerce payment with
  3-D Secure. The return URL became mandatory — the session's `returnUrl` or the new
  `defaultReturnUrl`, refused before any call otherwise (a breaking change), as is a URL over
  the contract's 200 characters or without a protocol (`https://`, or a custom `protocol://`
  for mobile apps). `merchantReference` (max 40) and the statement descriptor (max 256) are
  length-checked at session creation. The descriptor is now sent as `softDescriptor`:
  `descriptor` is deprecated with `x-deprecated-by: merchantReconciliationReference`, and its
  description recommends `merchantReconciliationReference` "for the same usage, and the new
  softDescriptor on top only in case you start needing another specific value to be pushed to
  the cardholder statement". `merchantReconciliationReference` is reconciliation data, passed
  to the acquirer where it accepts it, while `statementDescriptor` is cardholder-statement
  text, so `softDescriptor` stays its target (the contract advises 22 characters and
  currently allows per-call overrides only for AIB and Barclays). The Tokenizer stores a
  token permanently unless `submitTokenization` receives `storePermanently: false`, which
  `confirm()` always passes (the adapter never vaults). The fake enforces the documented
  limits the adapter relies on: it rejects a CreatePayment without the redirection return
  URL, with either return URL over 200 characters or without a protocol, with a
  `merchantReference` over 40 or a `softDescriptor` over 256 characters, or with an
  `order.customer.device` field off the contract's types and limits; as a regression guard it
  also rejects a `hostedTokenizationId` that starts with `{`, the envelope an earlier server
  adapter would forward whole. Known gaps: `acceptHeader`, and
  `ipAddress` (mandatory for Visa and Cartes Bancaires), are observed on the customer's HTTP
  request, which neither `CompletePaymentInput` nor `createCompletionHandler` carries to the
  adapter, so neither is sent; Cartes Bancaires also requires
  `cardPaymentMethodSpecificInput.paymentProduct130SpecificInput.threeDSecure.useCase`, which
  the contract's `paymentProduct130SpecificThreeDSecure` spells `usecase`, so it is not sent
  until a sandbox run settles the name. Sandbox-verify one challenge flow with device data
  before production.
- **Refund reads (corrected in review, 2026-07-15):** Direct has NO refund-by-id endpoint —
  `GET /{merchantId}/refunds/{refundId}` is Connect-era; the only read surface is
  `GET /v2/{merchantId}/payments/{paymentId}/refunds`. `refundPayment` therefore returns a
  composite `refundId` (`{paymentId}:{refundId}`, the suffix being Worldline's raw refund
  id, the one webhooks report) and `retrieveRefund` resolves it through the per-payment
  list. With no dedicated refund-failure webhook (below; since 2026-09-23 a `payment.rejected`
  carrying 73/83 is read as one), this polling path is the refund-failure signal a host can
  always drive itself.
- **paymentProductId → brand** map holds only ids confirmed on the current payment-method
  pages (1 Visa, 2 Amex, 3 Mastercard, 117 Maestro, 125 JCB, 132 Diners); 114/118/128 were
  unverified and dropped 2026-07-15 — an unknown id degrades to brandless details.
- **Status mapping** leads with `statusOutput.statusCategory` (the forward-compatible band —
  new statuses join an existing category), then `statusCode`, then the status string, with
  `CANCELLED` checked first (it sits in the UNSUCCESSFUL band but must map to `canceled`,
  not `failed`). Verified against the Statuses reference
  (docs.direct.worldline-solutions.com/.../statuses): COMPLETED → `succeeded`,
  PENDING_MERCHANT (PENDING_CAPTURE) → `requires_capture`, UNSUCCESSFUL
  (REJECTED/REJECTED_CAPTURE/CANCELLED) → `failed`/`canceled`, PENDING_PAYMENT/CREATED →
  `processing`. The **PENDING_CONNECT_OR_3RD_PARTY** band holds BOTH a genuine customer
  action (REDIRECTED → `requires_action`) and async downstream states
  (AUTHORIZATION_REQUESTED / CAPTURE_REQUESTED / REFUND_REQUESTED → `processing`), so the
  adapter disambiguates on the status string rather than mapping the whole band to
  `requires_action`. statusCode fallbacks: 9 (CAPTURED/settled) → `succeeded`,
  5 → `requires_capture`, 2 → `failed`, 46 → `requires_action`. Refunds: REFUNDED →
  `succeeded`, REJECTED/CANCELLED → `failed`, REFUND_REQUESTED/pending → `pending`.
  Refined 2026-09-23, superseding the REJECTED_CAPTURE → `failed` and REFUND_REQUESTED →
  `processing` readings above, from the Statuses reference's per-operation outcome tables and
  numeric-code list. The codes naming a refused operation are decided first, by code alone,
  whatever status string or category carries them (the contract's status enum, v2.507.0,
  has no CANCELLATION_REJECTED, so a refused cancellation can arrive under another string):
  63 ("The payment remains authorised") and 93 (the transaction "will remain in
  statusOutput.statusCode=5") → `requires_capture`; 73/83 (a refused deletion or refund, the
  payment staying at 9) → `succeeded`. Then, still before the category band: CANCELLED 61/62
  (a cancellation still awaiting the acquirer) → `processing`, any other CANCELLED →
  `canceled`; without a status string (the contract does not require one) 1/6 → `canceled`
  and 61/62 → `processing`; the CANCELLATION_REJECTED and REJECTED_CAPTURE strings → `requires_capture`;
  REFUND_REQUESTED and the REVERSED band → `succeeded`. A capture carrying 93 or a refund
  carrying 73/83 stays out of `amountCaptured` / `amountRefunded`, and a refund maps by its
  statusCode when that is its only signal.
- **Manual capture (not multi-capture):** `PRE_AUTHORIZATION` authorizes, `POST /capture
  { amount?, isFinal: true }` settles — a partial capture settles that amount and RELEASES
  the uncaptured remainder (Worldline finalizes the capture, and referenced refunds are only
  accepted once the capture is finalized). `supportsMultiCapture` is **false**: the core
  `capturePayment(id, amount, key)` contract carries no `isFinal` signal, so an authorization
  cannot be held open across several captures. `retrievePayment` sums `GET /captures` and
  `GET /refunds` (separate sub-resources) for `amountCaptured` / `amountCapturable` (0 once
  the payment is a completed sale/capture) / `amountRefunded`.
  Since 2026-09-23 a capture that names an amount reads the payment first: the full
  authorised amount goes out without `amount` (a full capture), and a partial amount is sent
  only in a two-decimal currency, any other being refused with `invalid_request` before the
  capture call, because the API contract (v2.507.0) documents CapturePayment's bare `amount`
  "in cents, where single digit currencies are presumed to have 2 digits" (see the
  minor-unit item below). CancelPayment answers 409 both for a request "currently being
  processed" under the same idempotence key (idempotent-requests guide) and, per the
  contract, for "Cancellation is not allowed because payment is closed"; after the transport
  retries, a 409 is read against the payment. A payment reading `canceled` answers as is, and
  one reading `processing` does when its status is CANCELLED or, without a status string, its
  code is 61/62; a payment still cancellable
  (`statusOutput.isCancellable`, or when that flag is absent, one reading `requires_capture`)
  keeps the retryable `processing_error`, because the original may still land and a replay
  under the same key answers the original's outcome; anything else rejects with a
  non-retryable `invalid_request`. A `processing` read-back alone is never taken for a
  pending cancellation, since CAPTURE_REQUESTED (4/91/92/99), AUTHORIZATION_REQUESTED and
  CREATED read `processing` too. Refusals are reported where Worldline reports them:
  `capturePayment` answers `requires_capture` only when the refusal comes back synchronously,
  while the Statuses reference and the test-cases page document `statusCode=91` as the
  immediate CapturePayment answer with 93 set "after a few minutes", so the refusal usually
  surfaces through `retrievePayment` or `payment.rejected_capture`; `cancelPayment` can
  resolve `processing` (61/62), settled by `payment.cancelled` (documented for statusCode 6)
  or a re-read; and a refused capture can leave an automatic-capture payment at
  `requires_capture`, a status `usePaymentStatus` does not treat as final.
- **Webhooks:** `X-GCS-Signature` = base64(HMAC-SHA256(webhookSecret, rawBody)) over the
  EXACT raw bytes, key selected by `X-GCS-KeyId` (array of `{keyId, secretKey}` for
  rotation, any active key verifying wins). One event per delivery. The documented event
  list (2026-07-15, unchanged on 2026-09-23) is `payment.created / redirected /
  authorization_requested / pending_approval / pending_completion / pending_capture /
  capture_requested / captured / rejected / rejected_capture / cancelled / refunded`,
  `refund.refund_requested` and `paymentlink.*` (`payment.test` is only the type the
  SendTestWebhooks test message carries, and it parses as `unknown`); the documented
  terminal refund signal is `payment.refunded`. There is no dedicated refund-failure event,
  but (corrected 2026-09-23) the Statuses reference defines REJECTED as "The
  authorisation/refund request has been rejected by the acquirer" and lists refused
  deletions/refunds as REJECTED 73/83, so a `payment.rejected` whose payment (or refund)
  resource carries statusCode 73 or 83 reports a refused deletion or refund (docs-derived,
  not yet seen in the sandbox). A refund-failure event takes its amount and currency from a
  `refundOutput` only and omits them otherwise, since a payment's `amountOfMoney` is what was
  paid, not what the refused refund asked back; polling `retrieveRefund` remains the other
  refund-failure signal. Mapping: `payment.captured` → `payment.succeeded`,
  `payment.rejected` → `payment.failed`, or `payment.refund_failed` when it carries
  statusCode 73/83, and `payment.rejected_capture` → `unknown` (corrected 2026-09-23: it
  reports a failed capture on a payment that stays authorised until the merchant captures
  again or cancels, so neither `payment.failed`, which would tell hosts the money is gone, nor
  a success type is honest; `retrievePayment` reports `requires_capture`), `payment.cancelled`
  → `payment.canceled`, a `payment.rejected` or `payment.cancelled` carrying 63/93 →
  `unknown` for the same reason, `payment.refunded` → `payment.refunded`, pending payment states →
  `payment.processing`. `refund.refund_requested` maps to `unknown` deliberately — it is
  recognized but non-terminal, and the unified vocabulary has no in-flight refund state;
  fabricating a terminal type would misreport it. The parser additionally TOLERATES
  `payment.paid`, `payment.pending_fraud_approval`, `refund.refunded`, `refund.rejected`
  and `refund.cancelled` — none are on the documented list, and the onboarding descriptor
  advertises only the documented set so hosts never subscribe to undocumented types.

  Event identity, doc-verified 2026-09-23 against the webhooks guide: Worldline calls
  duplicate deliveries "a feature of our reliable delivery architecture" and states
  "Duplicate webhooks will have identical values for both properties payment.id and type".
  Those are the only fields it documents as identical: any other one, the envelope `id` and
  `operationOutput` included, may differ on a redelivery, so putting it in the key could let
  a duplicate through. The Adyen adapter keys on its documented pair alone for the same
  reason (Adyen's webhook-handling guide: duplicates "have the same values in the
  `eventCode` and `pspReference` fields, while the `eventDate` and other fields can be
  different"). The event id is therefore `worldline:{type}:{payment.id}` (type lower-cased
  as received; `refund.id` when the delivery carries no payment), falling back to the
  envelope `id` when either half of the pair is missing and to `worldline_{sha256(rawBody)}`
  after that. `payment.test` always takes the fallback: the SendTestWebhook example's
  `payment.id` is the fixed `9999_9`. A suffix from the payment's `operationOutput.id` (a
  contract field none of the page's webhook examples shows) was considered and rejected on
  the same ground: nothing says a redelivery repeats it. Keeping distinct events apart rests
  on a premise the same page hedges: "The payment.id can change after each maintenance
  operation following an incremental logic. However, as this is not the case in some
  specific scenarios, we strongly recommend not building your business operations around
  it." Its Status Changes table lists `payment.id2` for both `payment.capture_requested` and
  `payment.captured`, and `payment.id3` for both `refund.refund_requested` and
  `payment.refunded`, while the prose of the two offline rows names an earlier id: "Our
  platform updates the original capture request payment.id1 to statusOutput.status=9 and
  sends a webhook for offline event payment.captured" and "Our platform updates the original
  capture request payment.id2 to statusOutput.status=8 and sends a webhook for offline event
  payment.refunded". Two events of one type on one `payment.id` therefore share an id, and a
  host's dedupe store drops the second, so the fallback must not depend on that delivery
  being processed. Hosts are told to run the refund re-read (`retrievePayment` for
  `amountRefunded`, `retrieveRefund` for the refunds they created that are still `pending`)
  on every verified refund-type delivery (`payment.refunded`, `payment.refund_failed`, and
  `unknown` events whose lower-cased `raw.type` starts with `refund.`) whether or not its
  `event.id` was seen, both reads being idempotent; to poll `retrieveRefund` on a schedule
  until those refunds leave `pending`; to reconcile captured payments periodically with
  `retrievePayment`, which also covers operations made outside PayFanout (the page itself
  recommends "a back-up mechanism in your business logic. This could be sending proactively
  a GetHostedCheckout/GetPaymentDetails request"); and never to sum `event.amount` across
  refund events. The premise that every operation reports an id of its own stays
  (default, unconfirmed) until a sandbox run makes two partial refunds on one payment and
  compares the two `payment.refunded` events (`payment.id`, `merchantReference`).
  Correlation: the page says a maintenance operation changes the `payment.id`, and the
  maintenance operations guide lists capture, cancellation and refund among them, so those
  events' `pspPaymentId` can be the operation's id (possibly on `payment.cancelled` too,
  documented for statusCode 6 but shown in no example), while CapturePayment /
  CancelPayment / RefundPayment take "The payment.Id of the initial transaction". Each
  route covers part of that: `merchantReference` is sent only when the session has an `id`,
  and the page shows it echoed only on the events of a sale (`payment.created`,
  `payment.authorization_requested`, `payment.captured`), none of its examples being a
  maintenance event; the refund id inside the composite `refundId` exists only for refunds
  made through `refundPayment`; a re-read takes the original `pspPaymentId`.
  `capturePayment` and `cancelPayment` return no id of the operation's own, so their events
  and operations made in the Merchant Portal rely on the echo or a scheduled re-read of the
  orders still awaiting confirmation. The page names GetPaymentDetails `operations[].id` as
  the way "to retrace the changes of the payment.id"; the adapter does not wrap it. The same
  sandbox run checks the echo on maintenance events. Payment-link events keep the envelope
  id: the platform's Node SDK types that resource as `PaymentLinkResponse`, which has no
  `id`, and its `paymentLinkId` repeats across distinct events of one type (each payment on
  a reusable link). Same page: a 2xx is expected right away; five retries follow at 10 min /
  1 h / 2 h / 8 h / 24 h, its table heading them "Retry time relative to last delivery
  attempt", so the last lands 35 h 10 min after the first attempt, each with a `retry-count`
  header (0 on the first attempt); "Generate webhooks keys" revokes an existing pair
  immediately, without saying whether at the click or at "Confirm" when you enter your own
  pair, and the Back Office manages the same pair, so a rotation deploys a self-chosen
  random pair to `webhookKeys` before entering it in the portal. That shrinks the
  verification gap to the moment between the click and "Confirm" rather than closing it, and
  a delivery rejected in that moment is retried, the first retry 10 minutes later.
  `ValidateWebhookCredentials` takes as `secret` the base64 HMAC-SHA256 of an empty body
  under the webhook secret, not the secret itself (contract: "use an empty string as body
  while hashing it"). The id format changes once on upgrade, so an event delivered on both
  sides of it can be processed twice; the envelope id stays on `event.raw.id` for hosts
  bridging the retry window, told to do so for at least 36 hours.

Items initially flagged AMBIGUOUS/undocumented, resolved conservatively — each notes its
current status (remaining sandbox checks run via the dispatch-only integration workflow):

- **Decline HTTP shape.** The API Troubleshooting reference documents declines as **HTTP 402**
  with `{ errorId, errors, status, paymentResult }`; a separate Create-payment reference
  summary suggested some declines arrive as `201` with `payment.status = "REJECTED"`. The
  adapter handles both: non-2xx maps through `mapWorldlineError` (the primary decline path,
  modeled in the fake), and a 2xx whose payment maps to `failed` is defensively surfaced as
  `card_declined` rather than a "failed" PaymentInfo. Confirm the real sandbox shape.
- **Decline sub-codes.** Only five reject codes are enumerated on the troubleshooting page
  (30511001 insufficient funds, 30591001 fraud, 40001134 3-D Secure, 30171001 customer
  cancelled, 30041001 issuer rejected); everything else on a 402 maps to the generic
  `card_declined`. Enumerate expired-card / invalid-card-data codes from the sandbox.
- **Sandbox triggers.** Doc-verified 2026-07-15: amount `1302` (EUR, `authorizationMode=SALE`)
  is the test-cases page's documented unsuccessful-transaction trigger (statusCode 2), as the
  fake models; the page also documents `1303`/`1309` (unsuccessful refund/capture) and
  `1203`/`1209` (uncertain refund/capture) for future integration tests. The `htp_3ds` →
  3-D Secure REDIRECT trigger remains fake-only — verify the real challenge flow in the
  sandbox.
- **`verifyCredentials` probe** uses `GET /v2/{merchantId}/services/testconnection` —
  endpoint confirmed 2026-07-15 (verbatim in the platform's current services surface). The
  status-based classification (401/403 = auth, 5xx/429 = network, else authenticated) stays,
  so the probe remains robust across API evolutions; a live sandbox call is the remaining
  check.
- **Webhook envelope: array vs object.** The webhooks page's example body renders as a JSON
  ARRAY, while the platform's own webhooks helper JSON-parses a single object. The parser
  accepts both single-event shapes (a one-element array is unwrapped) and rejects
  multi-event arrays rather than partially processing them. Confirm with the portal's
  test-webhook feature once credentials exist.
- **Minor-unit semantics for 0/3-decimal currencies.** CONFIRMED 2026-09-23 for every
  `amountOfMoney` field (CreatePayment, RefundPayment and CancelPayment all use it): the API
  contract (payment.preprod.direct.worldline-solutions.com/v1/public-contract-definition.yaml,
  v2.507.0) defines its `amount` as "Amount in the smallest currency unit" (EUR 1234 is
  12.34, KWD 1234 is 1.234, JPY 1234 is 1234), so ISO 4217 minor units are forwarded
  unchanged. Still AMBIGUOUS for CapturePayment, whose bare `amount` is documented "in
  cents, where single digit currencies are presumed to have 2 digits" without saying how a
  zero- or three-decimal currency is expressed. The adapter sidesteps it: a capture of the
  full authorised amount is sent without `amount`, and a partial capture in a currency whose
  exponent is not 2 is refused with `invalid_request` before any capture call. One sandbox
  partial capture in JPY (for example 2000 of a 5000 authorisation, then reading the
  captured amount back from `GET /captures`) would settle the unit and let the refusal be
  lifted or replaced by a conversion.
- **`card.expiryDate` format** is parsed as `MMYY` when building masked instrument details —
  consistent with the platform's examples but worth one sandbox observation.
- **`PaymentInfo.createdAt`** falls back to epoch — the Worldline payment object exposes no
  stable creation timestamp in a documented field; hosts read the timestamp from the webhook
  `created` or their own record. Revisit if the sandbox payment object carries one.

## Paysafe Interac e-Transfer (2026-07-15)

- **The sandbox account cannot exercise Interac.** Sandbox-verified 2026-07-15: creating an
  `INTERAC_ETRANSFER` payment handle in CAD is refused with `PAYMENTHUB-1`, "The submitted
  payment type and currency code combination is not supported for your account". That is an
  account-provisioning fact, not a code defect — the rail must be enabled on the Paysafe
  account before it can be verified end to end, and before any live enablement. The
  integration suite tolerates this specific error the way it tolerates unbatched
  settlements, and starts asserting for real once the capability exists.
- **`interacEtransfer` vs `interacETransfer`.** Doc-verified 2026-07-15: the payment-handle
  request field is spelled `interacEtransfer` (lowercase `t`). Paysafe's own OpenAPI spec
  contradicts itself — the `interacObject` schema declares `interacETransfer`, but that
  schema is flagged `x-internal: true`, while all seven request/response examples in the
  same spec and the Interac integration guide's worked request use `interacEtransfer`. Two
  independent public sources outweigh one internal-flagged schema, and the failure mode is
  loud rather than silent (error `5023`, unrecognized field), so a wrong choice surfaces on
  the first sandbox call. Partially corroborated 2026-07-15: the sandbox rejected the handle
  with `PAYMENTHUB-1` (account capability) rather than `5023`, so the body — this field
  included — parsed. That is evidence, not proof: the capability check may precede
  instrument validation. Settle it on an account that has the rail enabled before going live.
- **Handle lifetime vs session TTL.** Redirect payment handles report
  `timeToLiveSeconds: 899` (~15 min) and the field is response-only, so it cannot be aligned
  from our side. The adapter's default `sessionTtlSeconds` is 3600, meaning a signed session
  can outlive the handle it references: a slow customer returns to a session that still
  verifies but whose handle is `EXPIRED`. Hosts running this rail should lower
  `sessionTtlSeconds` toward the handle window. Once that window closes Paysafe resolves the
  handle itself (see the next entry), so a stale session's completion rejecting is a
  reconcile-by-webhook situation, not a lost payment.
- **The return trip is a fallback signal; `PAYMENT_HANDLE_PAYABLE` is the documented cue.**
  Doc-verified 2026-07-15 (Interac guide, integration notes): the handle flips to `PAYABLE`
  when the customer is *redirected* — before any bank approval — and the guide instructs
  merchants to make the `POST /payments` call on receiving that webhook. Interac does not
  redirect the customer back after a *completed* payment (the return links fire on the
  failed/cancelled paths), so the client marker mostly resolves failure trips and manual
  returns. If the merchant never completes, Paysafe completes on the merchant's behalf once
  the handle TTL closes (customer-paid path: `PAYMENT_PROCESSING` → `PAYMENT_COMPLETED`) or
  fails the handle (`PAYMENT_HANDLE_FAILED`, then `PAYMENT_FAILED` ~2 days later). A
  completion attempt against a handle that already left `PAYABLE` rejects with error `5283`
  — terminal for that call, reconciled by webhook. `PAYMENT_HANDLE_PAYABLE` stays mapped
  `unknown` (its payload id is a handle id, not a payment id); hosts correlate via the
  payload `merchantRefNum`, which is the session `idempotencyKey`.
- **Return-trip completion carries a placeholder `clientToken`.** The standard completion
  route requires a non-empty `clientToken` and the react transport only fires when one is
  present, while the real handle token rides the signed session context. The client adapter
  therefore resolves the marked return as `requires_confirmation` with
  `clientToken: "paysafe-redirect-return"`, and the server adapter ignores the wire value
  whenever the context already carries a minted handle — the signed context is the only
  authority on which handle gets charged.
- **`availableToRefund: 0` on an in-flight settlement means "not refundable yet".** Bank
  rails attach a `PROCESSING` settlement to the payment immediately, sharing its
  `merchantRefNum`; refunds are therefore only inferred from `availableToRefund` once the
  settlement has left an in-flight status, and never from `refundedAmount`'s absence alone.

## Per-method currency gating + the `pad` rail (2026-07-15)

- **`PaymentMethodCapability` gained `currencies?: string[]`** (absent OR empty =
  unrestricted, mirroring `supportedCurrencies` one level up; the PSP-wide list still
  applies on top). `screenSessionInput` honors it, so a currency-ineligible rail is
  skipped and the router fails over to a PSP that can settle it, instead of the rail
  looking available and dying on a PSP-local rejection. Chosen over a per-method
  `countries` field, or a nested `constraints` object, deliberately: country is a
  genuinely different problem — GoCardless collects SEPA in EUR from *non*-Eurozone
  countries, so country does not imply currency, and `CreatePaymentSessionInput.country`
  is optional, leaving an absent country with no good screening answer. Both remain
  addable later without a break, so neither was worth guessing at now.
- **The declaration does not replace the adapter-local guard — it derives from it.**
  Paysafe's Interac CAD check stays in `createInteracSession`; screening is bypassed
  entirely when a host drives an adapter without `PaymentService`, and a host overriding
  `config.paymentMethods` can drop the declared gate. One constant
  (`INTERAC_CURRENCIES`), two readers, so they cannot drift.
- **A rail gated to currencies the PSP does not accept is now a capability-coherence
  violation** (`validateAdapterCapabilities`), not a silent dead method: screening would
  reject such a session on `supportedCurrencies` before the method rule was ever
  consulted. Enforced at PaymentService registration and by the conformance suite, which
  both consume the same rule table.
- **The new Canadian rail is `pad`, not `eft`.** The rail is Pre-Authorized Debit,
  administered by Payments Canada. Its PSP names disagree — Stripe `acss_debit`
  ("pre-authorized debit (PAD)"), GoCardless `pad`, Paysafe "Electronic Fund Transfer
  (EFT)" — and the unified vocabulary is provider-agnostic, so it takes the scheme's own
  name and each adapter maps to it. #87 proposed `eft`; that is Paysafe's word, and
  naming core after one provider would have forced a future Stripe/GoCardless rail to
  report under it. Doc-verified 2026-07-15.
- **Not a single-currency rail: Stripe's PAD takes CAD *and* USD.** Doc-verified
  2026-07-15 (docs.stripe.com/payments/acss-debit): "It's possible to accept PAD payments
  in either CAD or USD" — the currency must match the customer's account denomination and
  a mismatch fails up to 5 business days later. This is why the field is an array; a
  scalar would have been wrong on the first rail that used it.
- **Paysafe's EFT and ACH currencies are undocumented.** Doc-verified 2026-07-15: the
  Paysafe EFT page states Canada as a country and no currency at all, and its ACH page
  states neither; only SEPA (EUR), BACS (GBP) and Interac (CAD) are stated outright.
  Both rails are `supported: false` today, so nothing is declared for them — encoding
  EFT→CAD would assert something the provider does not document. Needs a sandbox check
  or Paysafe's confirmation before #83 gates them.

## Paysafe bank-debit rails — SEPA, ACH, BACS, EFT (2026-07-15)

- **Bank details ride the completion `clientToken` as a versioned envelope**
  (`"paysafe-bank." + base64url(JSON)`, `v: 1`, paymentType + per-rail fields +
  `mandateConsent`), produced by the client adapter's own plain inputs and parsed by the
  server adapter. Chosen over a core contract change (`CompletePaymentInput` gaining a
  details payload): the golden rule is new rails = adapter packages only, the token is
  "produced by the client adapter's confirm()" by contract, and the signed-session-context
  precedent already encodes structured adapter state in opaque strings. The prefix and
  shape are duplicated across the pair by convention, like the redirect marker — the
  packages share no code across the client/server boundary.
- **The rail is stamped into the signed session context at creation** (`paymentType`
  SEPA/ACH/BACS/EFT) with no PSP call; the handle is minted and charged inside
  `completePayment` (handle then payment, both with `merchantRefNum = idempotencyKey` —
  Paysafe dedupes per endpoint, so one key is replay-safe across both calls).
  `settleWithAuth: true` unconditionally (doc-required for ACH/EFT; shown true in every
  SEPA/BACS payload example) and manual capture is rejected at session creation. One rail
  per session, mixed requests rejected — the Interac rule, for the same reason (the
  client mounts exactly one collection UI per session).
- **Customer profile data is embedded in the handle request** rather than sent as
  separate `/customers` + Mandate API calls: the SEPA/BACS pages prescribe a
  profile→handle→mandate-link→payment sequence but publish no request bodies or mandate
  endpoint (the API reference is a SPA that flattens for fetchers), while the payload
  examples show `mandateReference` inside the handle/payment `sepa`/`bacs` objects.
  Sandbox probes are the validation instrument for this and for the per-rail request
  field names; `mandateReference` is surfaced on `PaymentInfo` from the payment response,
  falling back to the handle's.
- **Sandbox verdict (run 2026-07-15, CAD sandbox account): EFT completed end-to-end** —
  envelope → PAYABLE handle → charge → retrieve, from the documented simulation values —
  which validates the shared request builder (lowercase rail object, profile-on-handle,
  no returnLinks, settleWithAuth, merchantRefNum reuse across both calls) on the one
  rail the account is provisioned for. ACH defers with PAYMENTHUB-1 (rail/currency not
  provisioned), the known Interac shape. SEPA and BACS are refused with error 5005
  "Creation of sepa/bacs single use payment handle is not supported": the request
  parses (not 5023/5068), the operation is refused — on an account with no EUR/GBP
  provisioning this is indistinguishable from a provisioning gap, but the wording
  leaves open that the mandate rails may require a different handle vehicle. Both
  readings are safe here: the rails ship `supported: false`, an opt-in merchant gets a
  clean diagnostic `invalid_request` carrying Paysafe's own message on first use, and
  the guide instructs validating one sandbox payment against a provisioned account
  before enabling either rail in production. Re-run the rail probes when an EUR/GBP
  sandbox account exists.
- **ACH and EFT stay currency-ungated** — resolves the open note from the per-method
  currency gating entry: the provider pages still document no currency for either
  (re-verified 2026-07-15), so nothing is declared and the merchant account decides.
  Gates shipped: SEPA `currencies: ["EUR"]` (no countries — zone), BACS
  `currencies: ["GBP"]`, `countries: ["GB"]`, EFT→`pad` `countries: ["CA"]`, ACH bare.
  All four default `supported: false` (per-account enablement, the Interac precedent).
- **Both returned-payment spellings map to `payment.failed`.** Paysafe's own pages are
  internally inconsistent: the event-description tables say `PAYMENT_RETURNED_COMPLETED`,
  the payload examples say `PAYMENT_RETURN_COMPLETED`. The map matches wire values
  exactly and missing the real one would downgrade a bank-reported failure to `unknown`,
  so both are mapped and mirrored in the onboarding descriptor. `SETTLEMENT_*` events
  stay unmapped (delivered `unknown`): their payload ids are settlement ids, not payment
  ids — the `PAYMENT_HANDLE_PAYABLE` reasoning; hosts correlate via `merchantRefNum`.
  Paysafe documents refunds as not applicable for BACS; refund eligibility elsewhere
  already rides the in-flight-settlement guard (`availableToRefund: 0` = not yet).
- **A session whose context carries an unknown `paymentType` fails closed on the client**
  (`invalid_request`) instead of falling back to card fields: on version skew, card
  fields would tokenize a CARD charge against a session the server minted for another
  rail — a mischarge risk. The client performs presence-only validation (no IBAN/sort
  checksums — substance is Paysafe's to judge; a local checksum would drift).

## Stripe: explicit payment_method_types vs intent currency (2026-07-15)

- **Sandbox-verified 2026-07-15**: `POST /v1/payment_intents` REJECTS an explicit
  `payment_method_types` entry that cannot settle the intent currency —
  `StripeInvalidRequestError` at creation — and a mixed list is rejected whole
  (`["sepa_debit", "card"]` on a GBP intent fails; nothing is silently filtered).
  The API reference does not state this either way, so the integration suite pins
  both cases against the real sandbox; if a pin flips, Stripe changed the contract
  the adapter's narrowing rests on.
- **The adapter narrows explicit `paymentMethodTypes` to currency-eligible rails
  before creation**, reading the same declared per-method gates screening consults
  (config overrides included). Chosen over rejecting the whole mixed request —
  which would make `["sepa_debit", "card"]` behave worse than `["card"]`, inverting
  what the host meant by offering more rails — and over forwarding untouched, which
  the observed rejection rules out. The dropped rail stays visible in
  `getCapabilities()`, so the narrowing is declared, inspectable behavior rather
  than a silent loss.
- **Narrowing to empty rejects with `invalid_request`** naming the rails and the
  currency, before any Stripe call — the same code the Paysafe Interac currency
  guard uses for the identical situation; `unsupported_operation` (floated in the
  issue) would have been a third vocabulary for one condition.
- **SetupIntents are never narrowed**: zero-amount verification sessions carry no
  currency, so the session's nominal one must not disqualify the instrument being
  verified. An override rail declared without `currencies` forwards unnarrowed.
- **Conformance generalization examined and deferred**: GoCardless's billing-request
  flow selects the scheme from the currency (doc-verified 2026-07-15,
  developer.gocardless.com billing-requests guide: "You can pass currency rather than
  a scheme and GoCardless automatically selects the optimal scheme for that
  currency"), so it cannot express the mismatch; Paysafe already guards Interac
  adapter-locally. A suite-level rule would need a shared narrowing/rejection
  contract across differently-shaped adapters — a contract change, not part of
  this fix.

## Per-method country gating (2026-07-15)

- **`countries` means the CUSTOMER's country, and the screening signal is a new
  `CreatePaymentSessionInput.customerCountry`.** Rail eligibility follows the customer
  (Stripe's support matrix keeps "business location" and "customer country" as separate
  columns; Bacs pays from UK bank accounts wherever the merchant is), while the existing
  `input.country` exists for merchant-account resolution — so reusing it would have had
  every adapter declaring one thing and screening reading another. `country` keeps its
  merchant meaning, now stated explicitly in its JSDoc; the two cannot be conflated
  again. `billingDetails.address.country` is deliberately NOT read as a fallback: a
  billing address is not a bank-account country (a French billing address pays a German
  IBAN over SEPA), and a silent fallback would screen PSPs out on a false signal.
- **An absent `customerCountry` screens nothing.** The alternative — screening the
  candidate out — breaks every existing caller, and the constraint it would enforce is
  unknowable at session creation for most checkouts anyway (the binding fact is the bank
  account the customer eventually brings). The field is documented as a best-effort
  router pre-filter, not an eligibility guarantee: it only does work for hosts that know
  the customer's country, which is exactly the population offering country-bound rails.
  This resolves the question #88 deferred.
- **When a rail fails both gates the currency diagnosis wins** — currency is the harder
  constraint (the PSP cannot settle it at all) and preserving the existing message keeps
  #88's router-surface strings stable for hosts that match on them.
- **Declared only where the provider states a country outright** (all doc-verified
  2026-07-15): Stripe iDEAL → NL (docs.stripe.com/payments/ideal, customer location
  "Netherlands"), Stripe ACH → US (payments/ach-direct-debit, "customers who have a US
  bank account"; support matrix customer country "US"), Stripe Bacs → GB
  (payments/payment-methods/bacs-debit, "customers who hold a British bank account"),
  GoCardless Bacs → GB (support.gocardless.com Schemes-and-Requirements, "GBP from UK
  bank accounts"), Paysafe Interac → CA (interac-e-transfer page, "Supported region:
  Canada"). SEPA stays undeclared on both Stripe and GoCardless: the providers state a
  zone, not a country (Stripe "Europe", GoCardless "the Eurozone" on the support page,
  while collecting from non-Eurozone SEPA countries per the API docs — the two GoCardless
  statements do not even agree on the zone's edge), and a hardcoded membership list would
  screen out valid payments the day it drifts. No PSP-wide `supportedCountries` exists,
  so there is no coherence rule to add — shape (`/^[A-Z]{2}$/`) is asserted by the
  conformance suite on both halves, mirroring `currencies`.

## PayZen smartForm payment-method selection (2026-07-16)

Multi-method support for the PayZen pair, doc-verified against payzen.io the same day
(CreatePayment playground, smartForm reference/quick start, JS client reference,
KR.getPaymentMethods page, error-code tables, currency table):

- **Session-side restriction rides `Charge/CreatePayment.paymentMethods`** — the field
  shares the kr-payment-method vocabulary (`CARDS`, `APPLE_PAY`, `PAYPAL`, …), an empty/
  omitted field is PayZen's documented "offer all shop-eligible methods" default (kept
  for unrestricted sessions), and per the playground field description a single-entry
  list renders that method's entry page directly. The adapter sends `PAYPAL` in both
  environments, matching the official request samples (sent against the TEST demo
  shop); the client-side smart-button table separately lists `PAYPAL_SB` as the
  TEST-mode selector, and the docs never state which value the REST field expects in
  TEST — verify PayPal end-to-end in TEST before going live.
- **Unified mapping covers card/apple_pay/paypal.** Other smartForm methods (Bizum,
  Alma, meal vouchers) have no unified type: they surface when a session is
  unrestricted and report as `paymentMethodType: "other"` on reads. Google Pay is not
  on PayZen's compatible-methods list at all. Read-side normalization of wallet
  transactions is best-effort: the published vocabulary for the RESPONSE field
  `Transaction.paymentMethodType` documents CARD but does not enumerate wallet labels,
  so `PAYPAL`/`APPLE_PAY` map when they appear and anything unknown stays `other` —
  sandbox verification of the actual wallet labels is pending.
- **Wallet/APM enablement is a per-shop contract**, invisible to the API config-wise, so
  both adapters declare a conservative card-only default and take the established
  `paymentMethods` wholesale config override; `createPaymentSession` validates requests
  against the declared list so a direct-driven adapter cannot mint sessions the router
  would have screened out. The client's `fetchAvailablePaymentMethods()` wraps the
  documented `KR.getPaymentMethods()` for live enablement checks.
- **The smartForm owns submission.** It renders per-method pay buttons, and while
  `KR.openPaymentMethod()` can open a chosen method's pop-in, it is documented as
  incompatible with Apple Pay (which needs the buyer's own gesture) and nothing submits
  a method programmatically — so in `form: "smartform"`/`"smartform-expanded"` the
  client adapter's `confirm()` uniformly awaits the buyer's in-form completion instead
  of driving `KR.submit()`; outcomes that land before `confirm()` are buffered on the
  handle and consumed by the next call. Wallet/APM flows are declared `flow: "popup"`
  on the strength of the smartForm's documented promise that the buyer completes
  without leaving the merchant site.
- **CLIENT_-prefixed errors are browser-local and pre-transaction** (documented), so on
  the smartForm the recoverable ones (CLIENT_3xx validation, CLIENT_7xx warnings,
  CLIENT_101 abandoned 3DS) route to `onError` while the await continues; fatal client
  errors (bad key/token, CLIENT_5xx, 997–999) and every gateway-side rejection settle
  it. The embedded form's semantics are unchanged.
- Doc-sweep refinements landed with the feature: CB refusal codes 34/41 map to
  `fraud_suspected` and 38 to `expired_card`; `CLIENT_305` ("no formToken defined") is
  `invalid_request`, and unmapped CLIENT_ codes stop falling into retryable
  `processing_error`; `detailedStatus: INITIAL` explicitly maps to `processing` in
  reads and IPN parsing — INITIAL appears in the rendered playground Transaction
  reference ("temporary… no response received from the acquirer") though the
  transaction-lifecycle kb page and the machine-readable schema, which both lag the
  playground, omit it. The 2026 currency table re-check confirmed the shipped list
  exactly (38 currencies, CNY=1/KHR=0 fractional digits, BHD absent).

## PayZen bank rails via hosted payment orders (2026-07-16)

The bank rails (SEPA Direct Debit, the DSP2 pay-by-bank family, iDEAL, Multibanco) have
no embedded/smartForm surface on PayZen — their documented home is the hosted payment
page. Doc-verified against payzen.io the same day (CreatePaymentOrder playground +
url_payment_order kb, PaymentOrder answer reference, the vads_payment_cards data
dictionary, and each rail's technical-information table):

- **Transport is `Charge/CreatePaymentOrder` (channel URL), not the legacy vads form**:
  same REST auth/envelope as every adapter call, `paymentMethods` restriction with the
  identical single-method/offer-all semantics as CreatePayment, `returnMode: GET` +
  `returnUrl`, per-order `ipnTargetUrl`, and the standard V4 IPN for outcomes — so the
  webhook path needed zero changes. The answer's `paymentURL` rides
  `PaymentSession.clientSecret` (GoCardless precedent) with `status: "requires_action"`;
  `pspSessionId` stays the derived orderId, keeping Order/Get reads and the idempotency
  synthesis identical across both routes. CreatePaymentOrder documents no `contrib`
  field, so the hosted route never sends one.
- **Method mapping (vads_payment_cards vocabulary, per-rail constraints from the
  technical-information tables)**: sepa_debit → SDD (EUR; zone countries deliberately
  undeclared — the SEPA-membership list would drift); ideal → IDEAL (EUR, NL);
  bank_redirect_generic → the pay-by-bank family IP_WIRE + IP_WIRE_INST (EUR, FR),
  MYBANK (EUR; ES/GR/IT), PRZELEWY24 (EUR+PLN, PL) — one unified type, the buyer picks
  the concrete rail on the hosted page, session requests narrow the code list to
  currency-eligible entries; voucher_generic → MULTIBANCO (EUR, PT). All four default
  supported: false (per-shop contracts), same override pattern as the smartForm wallets.
- **Sessions never mix surfaces**: a request combining embedded types (card, wallets)
  with bank rails is rejected — mapping card onto the hosted page would mean guessing a
  brand list, and the two surfaces have different completion shapes. `returnUrl` is
  required on the hosted route.
- **The return trip is display-only by design** (the platform documents that return
  data must not drive database processing): handleRedirectReturn resolves a kr-shaped
  return (kr-answer in the query string) to a UX-grade outcome exactly like the
  embedded browser answer, any vads-shaped return to `processing`, and foreign URLs to
  null. The IPN / retrievePayment remain the source of truth.
- **Per-rail operational facts recorded from the tables**: SDD is deferred-capture
  (15-day authorization validity, manual validation supported, cancel before capture,
  refunds go out as wire transfers); iDEAL/MyBank/P24 capture immediately (refund yes,
  cancel no); Multibanco has no refund channel; IP_WIRE sits in WAITING_AUTHORISATION
  until the bank settles and has neither refund nor cancel. Payment orders expire per
  the shop default, 90 days maximum.
- Evidence-level notes: the REST `paymentMethods` field is an open string array (no
  schema enum) whose description mirrors vads_payment_cards semantics word-for-word;
  passing the bank-rail codes through it follows that parallel plus the field's own
  "eligible methods of the store" contract, and each rail deserves one TEST-mode pass
  before production (the guide says so). Google Pay also exists on the hosted page
  (GOOGLEPAY) but is deliberately not wired — it would belong to the smartForm/wallet
  story, a separate decision.

## PSP-native subscriptions across the contract (2026-07-17)

Supersedes the future-designs §3 ruling that PSP-native subscriptions are out of scope.
That ruling's premise — only one shipped PSP has a native product — no longer held under
a same-day documentation review: most shipped PSPs expose one, including Paysafe (whose
absence was the recorded justification). The adoption flow (list a merchant's PSP-billed
subscriptions, re-create them in the host engine on the same vault token, cancel at the
PSP so exactly one biller remains) needs PSP-side list/retrieve/create/cancel, so the
contract now carries them.

- **Contract**: `AdapterCapabilities.nativeSubscriptions` declares each operation
  separately (`{ list, retrieve, create, cancel }`, required block, all-false = no
  native product) — provider support is uneven and one boolean would fake or hide it.
  Optional `ServerPaymentAdapter` methods `listNativeSubscriptions` (limit/cursor),
  `retrieveNativeSubscription`, `createNativeSubscription`, `cancelNativeSubscription`;
  unified `NativeSubscriptionRecord` (minor-unit amount, status union
  pending/trialing/active/past_due/paused/canceled/completed/unknown — unmappable states
  normalize to `unknown`, never dropped). Create takes exactly one cadence: `interval`
  (+`intervalCount`) or an RFC 5545 `schedule`; adapters reject what their provider
  cannot express instead of approximating. Cancel is contractually verified-idempotent:
  on a cancel rejection the adapter re-fetches and treats an already-terminal
  subscription as success — the conformance suite replays a cancel and requires both
  calls to succeed. Retrieve/cancel inputs carry an optional `savedPaymentMethodToken`
  because PayZen keys subscriptions by id + token.
- **Stripe** (doc-verified 2026-07-17): list GET /v1/subscriptions returns the provider
  default (not-canceled) set; `items[].price_data` requires an existing Product id, so a
  `planId`-less create mints a Product under `${idempotencyKey}-product` then creates
  with inline price_data; `planId` = an existing Price id and the record reports the
  price's own facts. Creates send `off_session: true` + `payment_behavior:
  "error_if_incomplete"` (declines reject, no zombie incomplete subscription).
  `startAt` = future `billing_cycle_anchor` + `proration_behavior: "none"`. Cancel is a
  DELETE and Stripe ignores idempotency keys on DELETE — replay safety is the re-fetch.
  Statuses: incomplete→pending, incomplete_expired→canceled, unpaid→past_due, the rest
  1:1. `current_period_start/end` moved onto subscription items in 2025-03-31.basil; the
  adapter reads both locations so re-pinning across basil needs no change. Open item:
  the three-decimal multiples-of-10 rule is no longer findable on
  docs.stripe.com/currencies — shipped validation kept for parity, sandbox re-check
  worthwhile.
- **Paysafe** (doc-verified 2026-07-17): the Payment Scheduler (`subscriptionsplans/v1`)
  authenticates with the same server-to-server Basic API key ("Back Office" is where the
  key is retrieved, not a distinct credential) — flags statically all-true; scheduler
  enablement remains per-account provisioning. Creation is `POST
  /plans/{planId}/subscriptions` per the official OpenAPI spec — the typical-calls page
  shows a bare `POST /subscriptions` that the spec contradicts (no such path, no planId
  body field); spec followed, CI-dispatch sandbox run is the arbiter. Frequency enum is
  DAILY/MONTHLY/YEARLY (no weekly, no RRULE); plan amounts are integer minor units;
  `numberOfCycles: 0` = infinite. `input.merchantRefNum` wins over `idempotencyKey` for
  the refNum (single field); replayed creates recover by refNum lookup; inline plans
  have no refNum channel so a transport-retried creation can orphan a plan (clutter,
  never billing). Wire statuses exactly ACTIVE/CANCELLED/SUSPENDED/COMPLETED →
  active/canceled/paused/completed. Undocumented behaviors handled defensively, pending
  the sandbox probe: duplicate-refNum answer shape, already-CANCELLED PATCH answer,
  `fields` default inclusion, `meta.numberOfRecords` semantics (nextCursor derives from
  page fullness, never that field).
- **GoCardless** (doc-verified 2026-07-17): subscriptions charge a mandate — the mandate
  id is the `savedPaymentMethodToken`, the customer derives from it (`pspCustomerId`
  ignored). interval_unit weekly/monthly/yearly only: interval "day", `schedule`, and
  `planId` reject (no plan object). `merchantRefNum` → `name` (≤255, becomes each
  payment's description); `payment_reference` never sent (restricted to own-SUN
  accounts). Subscription currencies AUD/CAD/DKK/EUR/GBP/NZD/SEK/USD gate locally —
  wider than the one-off GBP/EUR `supportedCurrencies`. Statuses:
  pending_customer_approval→pending, customer_approval_denied→canceled (terminal, never
  billed), finished→completed, rest 1:1. Cancelling stops future payment creation only —
  already-created payments still collect unless cancelled separately (documented
  provider warning, surfaced in JSDoc/README/guide). `currentPeriodEnd` = earliest
  `upcoming_payments[].charge_date`; `startAt` maps to the date-only `start_date`
  keeping the caller's stated calendar date.
- **PayPal** (doc-verified 2026-07-17): `create: false` — Subscriptions v1 creation is
  buyer-approval-gated (201 APPROVAL_PENDING + approve link); the only approval-free
  shape takes a raw PAN (US/AU, non-3DS), unusable under the card-data invariant. The
  recurring amount requires `GET {id}?fields=plan` (documented `fields` values are
  exactly `last_failed_payment` and `plan`); list items omit the inline plan, so a list
  page costs 1 + N requests (N ≤ page_size ≤ 20) — amount ladder: REGULAR-cycle
  `fixed_price` × `quantity` (per-unit when the plan is quantity-supported, per the
  pricing-plans guide; quantity parsed as a positive integer, anything else invalidates
  the rung) → `billing_info.last_payment.amount` (already a collected total, never
  multiplied) → amount 0 with the truth on `raw` (never invented, and one
  un-projectable record cannot fail a list page or the adoption walk).
  Cancel declares no PayPal-Request-Id parameter and requires a `reason` body
  (fixed "Canceled by merchant"); replay safety is the ACTIVE/SUSPENDED-only state
  machine + re-fetch on 422 SUBSCRIPTION_STATUS_INVALID. Statuses:
  APPROVAL_PENDING/APPROVED→pending, SUSPENDED→paused, EXPIRED→completed (finite
  total_cycles ran out), rest 1:1; no trial/past-due status exists. The published
  OpenAPI spec lacks the list operation entirely; the live reference page is the
  authority for it. Which statuses an unfiltered list returns is undocumented — no
  `statuses` filter is guessed.
- **PayZen** (doc-verified 2026-07-17 via the GraphQL content channel; the JSON schema
  again lags the playground — `ResponseCodeAnswer.responseCode` enum lists only 0 while
  the rendered Subscription/Cancel table documents 0/30/32/99): `list: false` (no list
  API) — hosts must retain `subscriptionId` + `paymentMethodToken`, required together on
  Subscription/Get and Subscription/Cancel (composite key). V4 subscriptions carry no
  status field; derived: cancelDate set→canceled, else pastPaymentsNumber ≥
  totalPaymentsNumber (>0)→completed, else future effectDate→pending, else active.
  `interval` synthesizes `RRULE:FREQ=…;INTERVAL=n` (all four FREQ values accepted;
  sub-daily "not taken into account" → rejected locally); `schedule` passes through
  normalized to the RRULE:-prefixed form; simple FREQ+INTERVAL(+COUNT) rules project
  back onto `interval`/`intervalCount`, anything with BYxxx/UNTIL stays schedule-only.
  Charge/CreateSubscription applies immediately with no idempotency channel and no
  lookup-by-orderId API — the create is never transport-retried, a deterministic
  orderId + `payfanout_key` metadata stamp keep duplicates traceable, and hosts must
  treat creation as at-most-once (documented). Cancel is the one PayZen mutating call
  that keeps automatic transport retries: replay-safe by the verified-idempotent
  re-fetch over both rejection channels (nonzero responseCode; PSP_033/PSP_564 errors).
  New PSP error codes mapped: PSP_030/031/032/033/563/564/565/566/567.
- **Worldline** (doc-verified 2026-07-17): no native engine — recurring is
  credential-on-file, each charge merchant-initiated (`subsequentType: "recurring"`),
  already covered by the vault surface + host-side SubscriptionManager; capability
  all-false is the honest declaration.
- The host-side `SubscriptionManager` is unchanged; the guide contrasts the two engines
  and documents the adoption recipe. Sandbox smokes for the native surface ride the
  dispatch-gated integration suites (Stripe and GoCardless full round-trips, Paysafe
  defensive round-trip, PayPal list-only); PayZen has no repo sandbox credentials, so
  its derivations are doc-derived pending a future sandbox pass.

## Push-only providers in the adapter contract (2026-08-02)

Every shipped adapter can read its PSP back, and the contract quietly assumed it:
`retrievePayment` was required, `cancelPayment` had to answer a confirmed `"canceled"`,
and a `"pending"` refund had to be pollable. A provider that accepts its payment
reference only as the target of a write — no read for a payment, none for a refund,
every modification acknowledged with the real outcome arriving by webhook — could not be
modelled without lying somewhere. The gates are now capability-driven so it can be
modelled honestly.

- **Contract**: `AdapterCapabilities` gains three REQUIRED fields —
  `supportsPaymentRetrieval`, `supportsRefundRetrieval`, and
  `modificationOutcome: "synchronous" | "asynchronous"`. Required, not optional with a
  defaulted value: a silent default is exactly the dishonest declaration the flags exist
  to prevent, and it would let a push-only adapter inherit a claim it cannot back.
  `ServerPaymentAdapter.retrievePayment` becomes optional, gated by
  `supportsPaymentRetrieval`. Both retrieval flags are checked in BOTH directions: they
  gate conformance assertions, so an implemented read declared `false` would buy silence
  rather than describe the provider, and is rejected as incoherent.
- **`PaymentInfo.amountRefunded` stays required**, so a push-only acknowledgement states
  `0` — a structural placeholder, NOT a refund balance. It stays `0` even after a refund
  has been requested and acknowledged, because the adapter has no read to learn otherwise,
  so core's `getRefundState()` is not meaningful on a push-only provider: refund state
  reaches the host through the refund webhooks alone.
- **Refund retrieval is its own flag**, no longer implied by `supportsRefunds`: a PSP can
  move money out and still expose no refund read. `supportsRefundRetrieval` without
  `supportsRefunds` is incoherent and rejected; the flag→method rule moves onto it.
- **No unconfirmed terminal states.** Under `modificationOutcome: "asynchronous"`,
  `cancelPayment` and `capturePayment` resolve `"processing"`; the conformance suite
  asserts exactly one of `"canceled"`/`"processing"` per adapter, never "either is fine",
  so an adapter cannot drift into claiming a state the PSP has not confirmed.
- **Over-refund rejection is gated on `modificationOutcome`, not on the payment read.** A
  provider with no GET but synchronous POST answers still knows its own remaining
  refundable balance and must reject the excess. Only an asynchronous provider is excused:
  it merely acknowledges the request and rejects out-of-band, so demanding a local
  rejection would force adapters to invent bookkeeping PayFanout must not hold
  (statelessness).
- **`PaymentService.retrievePayment` and `retrieveRefund`** now guard on their own
  retrieval capability like every other optional surface and reject with
  `unsupported_operation`. `retrieveRefund` on `supportsRefunds` was the wrong gate:
  refunding and reading a refund back are separate provider capabilities.
- **Proof**: `packages/conformance/test/push-only-adapter.test.ts` runs the suite against
  an in-memory push-only provider, so the shape is executable rather than theoretical
  until an adapter for such a PSP exists. All shipped adapters declare
  `supportsPaymentRetrieval: true`, `supportsRefundRetrieval: true` and
  `modificationOutcome: "synchronous"` — verified against their implemented endpoints and
  unchanged in behavior.

## Webhook signature scope in the adapter contract (2026-08-02)

The conformance suite requires a re-serialized body (same JSON value, different bytes) to
fail signature verification — the express.json() bug, caught at the contract level. That
requirement silently assumed every provider signs the raw payload bytes. Providers exist
whose standard webhook signature instead covers a fixed list of values EXTRACTED from the
payload (colon-joined, HMAC'd, the signature carried inside the body). Re-serializing
preserves those values, so such an adapter can only fail the assertion by inventing a
byte-level heuristic — guessing the provider's wire format, and rejecting legitimate
deliveries the day the provider reformats one. The contract models the difference instead
of pretending it away.

- **Contract**: `AdapterCapabilities` gains a REQUIRED
  `webhookSignatureScope: "raw-bytes" | "field-values"`. Required, not defaulted: a
  silent `"raw-bytes"` default would let a field-value adapter inherit a guarantee it
  cannot back, and the flag exists precisely to stop that. `validateAdapterCapabilities`
  flags an ABSENT scope for the same reason: the flag gates an assertion, so a
  pre-upgrade adapter shape has to surface as a registration violation instead of
  switching that assertion off unannounced.
- **The flag describes the SIGNATURE, not where verification runs.** PayPal verifies by
  postback — it sends the delivery back to PayPal — and is still `"raw-bytes"`, because
  PayPal verifies the exact delivered body, which is why the adapter splices the raw event
  into the postback verbatim. All shipped adapters are `"raw-bytes"`: Stripe HMACs
  `${timestamp}.${rawBody}`, Paysafe and Worldline HMAC the body to base64, GoCardless
  HMACs the whole batched delivery to hex, PayZen HMACs the kr-answer string as received.
- **The re-serialization assertion is INVERTED, not dropped.** Under `"field-values"` the
  suite requires the re-encoded body to VERIFY — the claim the flag makes — so a
  byte-signer cannot declare the scope to escape the assertion: it fails the inverse
  instead. Tampered content and a delivery with no credentials at all must still fail for
  EVERY adapter, whatever the signature covers, and a field-value adapter additionally
  has to reject `webhook.tamperedSignedValueBody`, a fixture the adapter DECLARES (one
  signed value altered, signature as delivered) because only it knows which values its
  provider signs. The class trades one unprovable assertion for two real ones, never for
  less coverage.
- **What a `"field-values"` adapter owes its hosts**, documented in the authoring guide
  and checked, where the signature rides inside the payload, by the suite's
  credential-less case: authenticate the delivery CHANNEL by another means (endpoint
  credentials, mutual TLS, an allowlist) — a signature over values proves nothing about
  the caller — and never present a field outside the signed set as trusted, because it
  arrives unauthenticated on a delivery that verifies. The check has a limit worth
  stating: `verifyWebhookSignature(validRawBody, {})` only bites when the signature
  travels in the body, since a scheme carrying it in a header satisfies the case from the
  missing header alone, with no channel authentication anywhere.
- **Proof**: `packages/conformance/test/field-value-signature-adapter.test.ts` runs the
  suite against an in-memory field-value provider, so the shape is executable rather than
  theoretical until an adapter for such a PSP exists — the same pattern as the push-only
  fake. No shipped adapter changes behavior.

## Adyen adapter (2026-08-02)

Tokenize-first pair (`adapter-adyen` / `adapter-adyen-server`, Checkout API v72 + Adyen Web
v6) and the first **push-only** provider PayFanout ships. New adapter packages only — no
core/server/react/conformance changes. Platform facts and the choices they forced (all
doc-verified against docs.adyen.com unless noted). **No sandbox pass yet** — there is no
Adyen test account on this project, so every fact below rests on the documentation and on
Adyen's published HMAC vector, not on observed traffic. The authoring checklist calls for a
sandbox round-trip before production use, and the setup guide carries that warning:

- **Push-only is the whole shape.** The Checkout API exposes no read for a payment and none
  for a refund, and `/captures`, `/cancels`, `/refunds` and `/reversals` always answer
  `{ status: "received" }`, as does `/amountUpdates` unless the request carries
  `adjustAuthorisationData`, which makes it answer `authorised` or `refused` (the adapter
  calls neither of the last two). Capabilities therefore declare
  `supportsPaymentRetrieval: false`, `supportsRefundRetrieval: false` and
  `modificationOutcome: "asynchronous"`; capture and cancel resolve `"processing"`, refunds
  `"pending"`, no `amountCaptured` is ever synthesized, and neither `retrievePayment` nor
  `retrieveRefund` is implemented (implementing one while declaring the flag false is a
  coherence violation). The webhook endpoint is the system of record.
- **`pspPaymentId` is the composite `"{pspReference}:{value}:{currency}"`.** A capture needs
  the authorisation's currency and an amountless refund needs its value; with no read and no
  persistence the money facts must ride the reference. `cancelPayment` accepts the bare
  reference, and the part before the first `:` is Adyen's own pspReference — what webhooks
  report — so a host can always recover it. Bare references on capture/refund reject with
  `invalid_request` naming the composite rather than guessing an amount.
- **Session creation calls nothing.** Adyen's payment object only exists once `/payments`
  runs, so `createPaymentSession` returns a signed self-contained context (amount, currency,
  reference, captureMethod, returnUrl, metadata, receiptEmail + enforced `expiresAt`) as
  `pspSessionId`, which is also the `clientSecret`: Adyen Web is addressed by the public
  clientKey, so the token is what the browser needs (it reads the payload half for the
  amount). The merchant reference defaults to `pf_<sha256(idempotencyKey)[0..32]>`, so a
  replayed session creation converges on one Adyen payment.
- **Idempotency** rides the `idempotency-key` header (max 64 chars, honoured on POST only,
  keys retained ≥ 7 days). Adyen stores those keys **at company account level, not per
  endpoint**, so the header value is `sha256Hex("{path}\n{idempotencyKey}")` — still exactly
  64 characters and deterministic, but scoped to the call. Derived from the caller's key
  alone it would collide across endpoints: the documented 3-D Secure flow routes `/payments`
  and `/payments/details` through one completion handler with one key, so the second call
  would be answered with the stored `ChallengeShopper` response and the payment would never
  authorise; a host reusing one key for a capture and a refund hits the same wall.
  `errorCode` 704 (a duplicate racing the still in-flight original) maps to a retryable
  `processing_error` and the transport loop replays it; a 409 is retried only when Adyen
  sends `transient-error: true`.
  - **Rescoped 2026-09-23**, doc-verified against the API idempotency guide, the HTTP status
    codes and error codes pages, the capture/cancel/refund guides, the Checkout v72 release
    note and the v72 OpenAPI contract (`github.com/Adyen/adyen-openapi`,
    `CheckoutService-v72.json`). The guide says keys "are stored at a company account level"
    and checked for uniqueness there, so a caller key shared by two merchant accounts of one
    company, or by two steps of one multi-step action flow, replayed the first answer. The
    derivation is now split by endpoint. `/payments` and `/payments/details` send the JSON
    array `["adyen-idempotency-key/2", merchantAccount, path, idempotencyKey, submission]`
    through `sha256Hex` (internal to the adapter), where `submission` is, on
    `/payments/details`, `sha256Hex` of the canonical JSON (object keys sorted, JSON data
    only) of the request's `details` and `paymentData`, and `null` on `/payments`: each step
    is its own request while a replayed step still dedupes, and the `/payments` body stays
    out of the digest, so a completion retried under the same key dedupes whatever
    payment-method blob it carries.
    Captures, cancels and refunds keep the exported `deriveAdyenIdempotencyKey` and its 0.1.0
    output, `sha256Hex("{path}\n{idempotencyKey}")`, byte for byte: their path carries the
    payment's pspReference, which the contract calls "globally unique", so two merchant
    accounts never share one, and an unchanged header keeps a modification retried across
    the upgrade deduplicated. A completion retried by a version other than the one that
    first sent it — after an upgrade, during a rolling deploy or after a rollback — reaches
    Adyen as a new request, and Adyen captures "automatically without a delay, immediately
    after authorization" by default, so the changeset, the setup guide (§4) and the README
    tell hosts to stop retrying in-flight completions before switching versions and settle
    them from the `AUTHORISATION` webhook. Keys are valid
    for 7 to 14 days and "will not be checked for duplication in other regions". The guide
    recommends random v4 UUID keys "to prevent two API credentials under the same account
    from accessing each others responses"; the digest keeps a random caller key
    unguessable, and the setup guide asks hosts for one.
  - **Acknowledgements, 2026-09-23.** A replayed key answers the first response whatever the
    request, so an `amount` echoed on a capture or refund acknowledgement must be the amount
    and currency requested (the currency compared case-insensitively). A different echo is an
    earlier request's stored answer and rejects with a non-retryable `invalid_request` whose
    message states what Adyen already accepted under the key and that a further one needs a
    new key, never advising a resend; a malformed echo rejects with a retryable
    `processing_error`. An absent or `null` echo is accepted: the contract requires `amount`
    and its own 201 examples carry it, but the refund guide's response example omits it, and
    refusing an acknowledgement for that would report a refund Adyen accepted as failed — a
    host retrying under a new key would then refund twice. An acknowledgement without its own
    `pspReference` rejects with a retryable `processing_error` (a replay under the same key
    cannot repeat the modification), and a 2xx that is not a JSON object with a retryable
    `psp_unavailable`. The capture and cancel guides list `Transaction not found` among the
    failures their webhooks report, so an unknown `pspReference` is acknowledged there, not
    rejected in the answer. Two neighbouring behaviours are assumptions, which the fake
    models and the adapter handles either way: that a refund on an unknown reference is
    acknowledged and fails by webhook (the refund guide's failure reasons do not list it),
    and that a cancel after the capture fails in the `CANCELLATION` webhook (the cancel guide
    says only "After a payment has been captured, you can no longer cancel it."). Error 906
    ("Invalid Request: Original pspReference is invalid for this environment", cause
    "LIVE/TEST PSP mismatch") is an error response, so a modification on an unknown reference
    is acknowledged only within one environment.
  - **Classification, 2026-09-23**, from the same pages: `transient-error: true` (the value
    read case-insensitively) is retryable at any status (`processing_error` below 500,
    `psp_unavailable` from 500), `errorCode` 705 is `rate_limited`, 408 ("You can retry the
    request") a retryable `psp_unavailable`, and 501 or a 5xx typed `validation`,
    `configuration` or `security` a non-retryable `invalid_request` (the contract's generic
    500 example is `905`/`configuration`, and v72 moved only "some validation and rate limit
    errors" from 500 to 422/429). Any other 5xx is retried, without the transient header and
    under `transient-error: false` alike. That departs deliberately from the idempotency
    guide's "If the API does not return a transient error header, or returns a header with a
    value of false, do not retry the request.": the HTTP status codes page says "In the
    following scenarios, the Adyen payments platform does not accept or store submitted
    requests: … An internal error occurs on the Adyen payments platform.", and the retry
    carries the same key, so it is either the first request Adyen sees or answered from its
    store.
  - **Sandbox checks outstanding (2026-09-23):** whether live capture and refund
    acknowledgements carry `amount`; whether a fresh acknowledgement's echo always equals the
    request; what Adyen answers when a key is reused with a different body; whether a refund
    on an unknown `pspReference` is acknowledged and fails by webhook; whether a cancel after
    the capture is acknowledged and fails in the `CANCELLATION` webhook.
- **`returnUrl` is required on POST /payments in v72**, alongside `merchantAccount`,
  `amount`, `reference` and `paymentMethod`, so the adapter takes a `defaultReturnUrl`
  config (the PayPal adapter's `returnUrl` fallback is the precedent): the session's own
  `returnUrl` wins, the default fills in, and a session with neither is refused at creation
  with `invalid_request` naming the field rather than sent for Adyen to reject. The fake
  Checkout API enforces the field, so the conformance sessions prove the shape.
- **A host id containing `:` or `\` is refused at session creation.** Adyen documents no
  charset restriction on `reference`, but it echoes the value as `merchantReference`, one of
  the eight signed webhook values, and no escaping rule is documented for a signed value
  carrying the delimiter — so such an id would make every webhook for that payment fail
  verification, permanently and silently, after the shopper has paid. For a push-only
  provider that is total failure, so it is rejected while the host still owns the id.
  Revised 2026-09-23: Adyen's own validators join the signed values unescaped, and the
  verifier now accepts a `:` in `merchantReference` (see the escaping entry below). The
  refusal stays as a conservative choice, so the references the adapter creates never rely
  on that parse.
- **The CLP/CVE/IDR/ISK exclusion is enforced on captures and refunds too**, not only at
  session creation: the composite `pspPaymentId` is documented, so a host can drive a
  modification for a payment created elsewhere, and an excluded currency would be priced
  100x off.
- **Manual capture is per payment** (`additionalData.manualCapture: "true"`), not the
  account-wide switch, which would hold every payment. Multiple partial captures are
  disabled by default at Adyen and a single partial capture auto-cancels the remainder, so
  `supportsMultiCapture: false`.
- **resultCode mapping**: `Authorised` → `succeeded` (or `requires_capture` under manual
  capture), `Cancelled` → `canceled`, `Received`/`Pending`/`AuthenticationFinished`/
  `AuthenticationNotRequired` → `processing`, `RedirectShopper`/`IdentifyShopper`/
  `ChallengeShopper`/`PresentToShopper`/`PartiallyAuthorised` → `requires_action`,
  `Refused`/`Error` raise a mapped `PayFanoutError` rather than a "failed" PaymentInfo.
  Refusal codes map 2/5/46 → `card_declined`, 6 → `expired_card`, 8/24 →
  `invalid_card_data`, 11/38/42 → `authentication_required`, 12 → `insufficient_funds`,
  14/20/31 → `fraud_suspected` (31, Issuer Suspected Fraud, since 2026-09-23), 9 (Issuer
  Unavailable) → `processing_error`. None is retryable:
  replaying the same idempotency key returns the same refusal, so a fresh attempt is the
  shopper's move, and an unrecognized code is still a decline.
- **CLP, CVE, IDR and ISK are rejected locally** (`invalid_request`): Adyen prices them with
  2/0/0/2 fractional digits against ISO 4217's 0/2/2/0, and Adyen documents its own table as
  leading, so pass-through would shift the decimal point. Same shape as the PayZen CNY/KHR
  exclusion. `supportedCurrencies` is left undeclared: the capability is an allowlist and no
  complete, verified Adyen currency list was available, so declaring one would be a guess —
  the cost is that the router cannot pre-screen those four.
- **Webhook verification requires a second factor, and that is deliberate.** Adyen's HMAC-SHA256
  covers eight colon-joined values (`pspReference:originalReference:merchantAccountCode:`
  `merchantReference:value:currency:eventCode:success`), base64, carried inside the payload
  at `additionalData.hmacSignature`; the Customer Area key is hex and is decoded to bytes
  before signing (verified against Adyen's published test vector, which ships as a fixture).
  Everything else in the payload — `additionalData`, `reason`, `paymentMethod`, `eventDate`,
  all of which hosts read from `event.raw` — is unauthenticated, and the signature covers
  values rather than bytes. So the adapter additionally requires the endpoint's basic
  authentication credentials — which Adyen supports on every webhook type — to authenticate
  the channel the unsigned remainder arrived on. That is stricter than a bare Adyen
  integration; hosts enable basic auth in the Customer Area, and the setup guide says so.
  Adyen strongly recommends OAuth 2.0 for standard webhooks and offers basic authentication
  as the alternative; the adapter checks basic auth only, so an OAuth-configured endpoint
  fails every delivery. That limitation is stated in the setup guide rather than papered
  over — verifying a bearer token means holding an Adyen OAuth client, which no other part
  of the adapter needs.
  The adapter declares `webhookSignatureScope: "field-values"` and lets a re-encoded body
  verify, which is the honest reading: an earlier draft refused bodies carrying structural
  whitespace to satisfy the raw-bytes assertion, but "Adyen never emits structural
  whitespace" is a guess about the wire format that no documentation supports, and a wrong
  guess rejects every legitimate delivery. The contract now models the scope instead.
  Extended 2026-09-23, doc-verified against Adyen's Webhooks v1 OpenAPI contract
  (`Adyen/adyen-openapi`, `json/Webhooks-v1.json`, spec release of 2026-09-10) and the
  webhook structure page: before anything is signed, each item's signed values are checked
  against the types that schema gives them. `pspReference`, `merchantAccountCode`,
  `amount.currency`, `eventCode` and `success` must be present as strings,
  `originalReference` and `merchantReference` must be strings when present (a `null` in
  either reads as absent, added 2026-09-23: Adyen's Java `HMACValidator` documents "If any
  value is null, it is represented as an empty string in the final payload" and its Node
  validator's `join` does the same, so absent, `null` and `""` sign alike; `null` in a
  required value stays refused), and
  `amount.value` a safe integer ("The numeric value of the amount, in minor units",
  `integer`/`int64`); anything else is refused as `malformed_payload`. The HMAC
  authenticates the joined strings, not the JSON types carrying them: a boolean `true` and
  the string "true" join alike, so the earlier coercing reader verified a re-typed copy of a
  genuine delivery that the parser then read differently (a boolean `success` as a failure,
  an array `eventCode` as an `unknown` event with the genuine event's id). Verification and
  parsing now share one reader, so an event is built from exactly the values the signature
  covered, and an envelope holding anything but notification items is refused whole. The
  schema also lists `merchantReference` as required, but Adyen's capture and cancel examples
  omit it, so it stays optional. Only the JSON method is read: the endpoint's other methods,
  HTTP POST and SOAP, send bodies that are not JSON and fail verification.
- **No escaping rule is documented for signed values containing the `:` delimiter**, so a
  delivery whose signed values contain `:` or `\` is refused as ambiguous rather than
  verified under an escaping convention Adyen would not apply on its side.
  Revised 2026-09-23: the verification page's whole rule is "Assign an empty string to any
  fields that are empty, and use a colon (":") to delimit the values", and Adyen's own
  validators join the eight values with no escaping (`adyen-node-api-library`,
  `src/utils/hmacValidator.ts`: `signedDataList.join(HmacValidator.DATA_SEPARATOR)`;
  `adyen-java-api-library`, `HMACValidator.java`: `Util.implode(DATA_SEPARATOR,
  signedDataList)`), so the verifier joins them the same way. A `:` is now refused only in
  `pspReference`, `originalReference`, `merchantAccountCode`, `amount.currency`, `eventCode`
  and `success`: with those colon-free and `value` an integer, the joined string splits into
  the eight values one way only, so `merchantReference` may carry `:`. The `\` refusal is
  dropped, since nothing escapes it. The earlier rule failed every delivery for a payment
  created elsewhere on the same endpoint whose reference held a `:`, leaving it in Adyen's
  retry queue, which retries for up to 30 days. Session creation keeps refusing `:` and `\`
  in the references the adapter creates, as a conservative choice while no delivery from a
  test account has been observed; it no longer protects verification, which accepts them.
- **Event id is the pair `"{eventCode}:{pspReference}"`**: a redelivery repeats both, while
  `pspReference` alone is shared by a payment's own events and would collide. Modification
  events report the payment on `originalReference` and keep their own `pspReference` as
  `refundId`. `success`/`live` are compared to the exact strings `"true"`/`"false"` (the
  string `"false"` is truthy). `CANCELLATION` with `success: "false"` and `CANCEL_OR_REFUND`
  map to `"unknown"` — the first says nothing about the payment, the second does not say
  which of the two operations Adyen performed, and fabricating either would be an accounting
  claim. `CHARGEBACK_REVERSED` → `chargeback_won` and `SECOND_CHARGEBACK` →
  `chargeback_lost` follow Adyen's dispute documentation ("Lost", undefendable), with the
  caveat that a reversal is not final.
  Corrected 2026-09-23 against the webhook-handling guide, the dispute webhooks and dispute
  flow pages, and the capture, cancel and reversal guides. The pair is Adyen's own duplicate
  definition: duplicates "have the same values in the `eventCode` and `pspReference` fields,
  while the `eventDate` and other fields can be different. Your server should use the
  details from the latest webhook event." So hosts upsert on the id, keeping the latest
  `eventDate`. A bare `pspReference` is shared by several events, which is why the pair is the
  id: every event of one dispute ("All events related to a dispute have the same PSP
  reference"), `CAPTURE` and `CAPTURE_FAILED` (both carry the capture request's reference),
  `REFUND` and `REFUND_FAILED` (the refund request's), and `AUTHORISATION`, `EXPIRE` and
  `OFFER_CLOSED` (the payment's). Only refund-shaped events
  report their `pspReference` as `refundId`. `CANCEL_OR_REFUND` does name its operation, in
  `additionalData["modification.action"]` ("refund" or "cancel"), but outside the signed
  values, so it stays `unknown`: reporting an outcome from it would present an unsigned
  field as an accounting fact. `CAPTURE` with `success: "false"` → `unknown` (the capture
  guide: "Review the reason, fix the issue if possible, and resubmit the capture request"),
  and `TECHNICAL_CANCEL`, the outcome of a cancel requested by merchant reference, maps like
  `CANCELLATION`. Dispute closures follow the statuses both dispute pages give:
  `ISSUER_RESPONSE_TIMEFRAME_EXPIRED`, `PREARBITRATION_WON` and `SCHEME_ARBITRATION_WON`
  ("Won") → `chargeback_won`; `PREARBITRATION_LOST`, `SCHEME_ARBITRATION_LOST` ("Lost") and
  `DISPUTE_DEFENSE_PERIOD_ENDED` (a chargeback accepted or left undefended, its final stage)
  → `chargeback_lost`. Pending stages stay `unknown`, including
  `PREARBITRATION_ISSUER_WITHDRAWN` (the issuer can reopen pre-arbitration) and
  `PREARBITRATION_ACCEPTED`, which the dispute webhooks page lists as "Pending" and the
  dispute flow page as "Lost"; the second chargeback that follows it reports the loss either
  way. A later loss overrides a reversal's provisional win, so hosts apply a payment's
  events in `eventDate` order, with two limits: `eventDate` is unsigned, trusted only because
  basic authentication authenticates the channel, and an unparseable one reads as the epoch
  (time unknown); and a final stage (`SECOND_CHARGEBACK`, `SCHEME_ARBITRATION_WON`/`LOST`,
  `DISPUTE_DEFENSE_PERIOD_ENDED`, `ISSUER_RESPONSE_TIMEFRAME_EXPIRED`, `PREARBITRATION_WON`)
  is never overridden by a non-final one such as `CHARGEBACK_REVERSED`, whatever the dates. A
  lost scheme arbitration arrives as `SCHEME_ARBITRATION_LOST` and then as a second chargeback
  including the fees, so `chargeback_lost` is a state, never a sum.
  `pspPaymentId` comes from `originalReference`, and from `pspReference` on `AUTHORISATION`,
  `EXPIRE` and `OFFER_CLOSED`. On `CHARGEBACK_REVERSED`, `SECOND_CHARGEBACK` and
  `PREARBITRATION_WON/LOST` it also comes from `pspReference` when `originalReference` is
  absent (default, unconfirmed). The dispute webhooks page describes the Customer Area setting
  "Include the originalReference for CHARGEBACK_REVERSED events" as returning "the PSP
  reference of the payment in the `originalReference` field, and the PSP reference of the
  dispute in the `pspReference`" for those four codes, which implies that without it
  `pspReference` is the payment's. The additional-settings page says only "For
  CHARGEBACK_REVERSED webhook events, receive the `pspReference` of the original payment." A
  `pspReference` is globally unique, so a wrong reading only makes a host's lookup miss,
  while reporting none would detach the dispute's outcome from its payment. Sandbox check:
  which reference those four codes carry without the setting, which the setup guide asks
  hosts to enable. Any other event without `originalReference` names no payment, since its
  own reference is a modification's, a dispute's or, on `REPORT_AVAILABLE`, a file name.
  `REFUND_NOT_CLEARED` and `SETTLED_REVERSED`, added to the Webhooks contract on
  2026-09-10, stay `unknown` as payout-batch adjustments. `CAPTURE_FAILED` stays
  `payment.failed` even though "Technical failures are automatically re-captured by Adyen
  within 10 business days"; the setup guide flags it as not always final.
- **`PaymentInfo.createdAt` falls back to epoch** — Checkout responses carry no creation
  timestamp and there is no read to fetch one; hosts take it from their own record or the
  webhook `eventDate`. The constant also keeps a replayed `completePayment` byte-identical.
- **Client**: Adyen Web v6 from `checkoutshopper-{test|live}.cdn.adyen.com/checkoutshopper/
  sdk/{version}/` (the Drop-in guide's shorter path 404s), `window.AdyenWeb` with an async
  `AdyenCheckout()` and component classes (`new Card(checkout, options)`). The pinned build
  is 6.41.0 (released 2026-07-15, current at the time of writing per Adyen's Web release
  notes, and requiring Checkout API v69 or later, which the pinned v72 satisfies); pinning
  the 6.0.0 that opened the major would ship a checkout a year of fixes behind. The adapter
  owns `showPayButton: false` and `onChange`, forwards everything else. 3-D Secure resolves
  through an adapter-specific `handleAction(handle, action)` — inline when Adyen runs it
  natively, by a redirect to Adyen otherwise — whose inline result is a second clientToken
  (Adyen Web's `onAdditionalDetails` data, `{ details: { threeDSResult } }`) that
  `completePayment` sends to `/payments/details` — the unified contract has no action step
  because most PSPs resolve challenges inside `confirm()`. One challenge at a time per handle:
  a re-entrant `handleAction` is refused with `invalid_request` instead of replacing the
  pending resolver, which would leave the first caller's promise unsettled forever.
  - **3-D Secure 2 completion (2026-09-23)**, doc-verified against Adyen's Checkout v72
    OpenAPI spec, the native and redirect 3-D Secure guides, the 3-D Secure API reference
    and the Adyen Web 6.41.0 source; still no sandbox pass. `confirm()` resolves
    `{ paymentMethod, browserInfo?, origin?, billingAddress?, riskData? }` from Adyen Web's
    state. The server reads only those keys. It rebuilds `paymentMethod` from the
    CardDetails fields Adyen Web 6.41.0's Card emits (`type`, the `encrypted…` values
    including the Korean-card `encryptedPassword`, `holderName`, `brand`, `fundingSource`,
    `fastlaneData`, `checkoutAttemptId`, `sdkData`; the native guide lists the Card's
    complete paymentMethod, `sdkData` included, as required), leaving out the Card's
    stored-card and Click to Pay values, since the adapter supports neither flow, and
    `taxNumber`, which the v72 CardDetails schema (`additionalProperties: false`) does not
    define. It rebuilds `browserInfo` from its documented fields; forwards `billingAddress`
    only when complete and within the v72 limits (city, country, houseNumberOrName,
    postalCode and street required; postalCode at most 10 characters and five digits in the
    US, stateOrProvince at most 3, the others at most 3000), which the Card's own address
    always is, since Adyen Web fills the fields a country does not use with "N/A"; keeps
    `riskData.clientData` alone (riskData's other fields are merchant risk settings, not
    browser data); refuses a non-`"scheme"` `paymentMethod` or unencrypted card fields
    without echoing the token; and still completes the bare `paymentMethod` of earlier
    clients. With `browserInfo` and a bare origin the payment requests native 3-D Secure 2
    (`channel: "Web"`, `origin`, `nativeThreeDS: "preferred"`). An origin that is not the
    page's bare origin of at most 80 characters is dropped rather than refused, and with it
    `channel` and `nativeThreeDS`: Adyen documents that a wrong origin keeps the 3-D Secure 2
    action from being handled, a page can report one in normal use (`"null"` in a sandboxed
    frame, a hostname beyond 80 characters), and no money fact depends on it. That such a
    payment then takes Adyen's redirect flow is an inference, listed below. An action
    answered without a pspReference — Adyen's own 3-D Secure 2 web example — reads
    `requires_action` with `pspPaymentId: ""`; the v72 redirect example answers its action
    with one (`JLCMPCQ8HXSKGK82`), and the composite is then built from the session's own
    `/payments` answer. `decodeAdyenPaymentRef` refuses an empty or whitespace-only
    reference, so capture, cancel and refund send nothing for it. Details finish whichever
    payment they were issued for, so a `/payments/details` answer whose `merchantReference`
    or `amount` differs from the signed context is refused as a non-retryable
    `invalid_request` (the details finished a different payment, and a retry gets the same
    answer); one that does not name both reads `processing` with no `pspPaymentId`, and the
    AUTHORISATION webhook, whose `merchantReference` is a signed value, supplies the
    reference — Adyen's example details answer names neither. A `/payments` answer naming
    another `merchantReference` or `amount` is refused the same way, before any refusal in it
    is mapped: the request named the session's own, so the answer belongs to another request
    (an `idempotencyKey` reused across sessions replays the first answer).
    `returnUrl`/`defaultReturnUrl` are checked where they enter (absolute with a scheme, no
    whitespace, at most 1024 characters once serialized, no `//` after the domain) and sent
    WHATWG-serialized, since Adyen asks for non-ASCII characters to be URL-encoded.
    `shopperEmail` falls back to `billingDetails.email`, which is left out rather than
    refused when it is not a plausible address of at most 256 characters (a dotless domain
    such as `jane@localhost` is valid RFC 5322); an invalid `receiptEmail` is still refused.
    No `shopperIP` is sent: core's inputs carry none. The client shows and requires the
    cardholder name (`hasHolderName: false` alone hides it, since Adyen Web 6.41.0's Card
    turns `holderNameRequired` off without it), makes Enter a no-op (Adyen Web's default
    calls `submit()` without an `onSubmit`), and settles a pending `handleAction` as failed
    on unmount and on `onError` (Adyen Web 6.41.0's 3-D Secure 2 elements report timeouts
    through `onAdditionalDetails` and call `onError` only when they stop), with
    `authentication_required` unless the error reads as a load or network failure. It
    refuses `confirm()` once `handleAction` replaced the Card, and exports
    `adyenRedirectResultToken` for the redirect return page.
    - **Sandbox checks outstanding (AMBIGUOUS in the docs, 2026-09-24):** (1) `shopperIP`:
      the v72 `/payments` reference requires it for Visa and JCB 3-D Secure 2 web payments
      only "if you did not include the `shopperEmail`", while the 3-D Secure API reference
      ("required for Visa and JCB transactions for all web and mobile integrations") and the
      native and redirect guides ("required for Visa and JCB transactions on the web") give
      no such exemption. The adapter cannot send one, so run a Visa and a JCB 3-D Secure 2
      web payment with `shopperEmail` and without `shopperIP`. (2) The redirect fallback:
      that a payment without `origin`, `channel` and `nativeThreeDS` gets Adyen's redirect
      action rather than a refusal is not documented, and the redirect guide marks `channel`
      and `origin` as required too. (3) Whether real `/payments/details` answers name
      `merchantReference` and `amount` (the example does not), which decides whether a
      completion reads its result or `processing` until the webhook. (4) Which `/payments`
      action answers carry a `pspReference` (the native example has none, the redirect
      example has one).

## Production audit scope: peer dependencies (2026-08-17)

- **Every `peerDependencies` entry is mirrored in `devDependencies`.** pnpm auto-installs an
  unmet peer, and `pnpm list --prod` — the tree `scripts/audit-deps.mjs` walks — reports that
  auto-installed peer under `dependencies`. `@payfanout/conformance` declared `vitest` only as
  a peer and carried no `devDependencies` at all, so the entire test toolchain was audited as
  shipped code: the weekly gate reported high advisories for `undici` (via `jsdom`) and
  `nanoid` (via `vite` → `postcss`) as production findings. `packages/react` never had the
  problem because it always declared `react` as a peer *and* a dev dependency. Mirroring the
  peer is the fix; the peer range itself is untouched, so nothing consumers resolve changes.
- **The gate covers what ships, and the informational pass still covers everything else.**
  The production step audits 73 packages instead of 234; `--all --warn-only` still reports the
  toolchain advisories. GitHub's dependency graph classifies the same packages as
  `development` scope, so local and upstream classification now agree. A CVE inside the test
  toolchain warns rather than blocks — that is the intended split of the two-step job, not a
  relaxation: the previous blocking behaviour was an artifact of the missing manifest entry.
- **`ip-address` was the one genuine production finding** (GHSA-mwp4-54f8-5fhr plus two
  moderates), reaching the tree through the demo server's `express-rate-limit`. That range
  already admitted the patched releases, so refreshing the lockfile to 10.5.0 was sufficient
  and no manifest edit or `pnpm.overrides` entry was warranted. An override would only be
  justified if a dependency's declared range excluded every patched version, as with the
  `vite`/`esbuild` case above.

## Node 20 stays in the test matrix (2026-08-17) — superseded

Reversed the same day by the entry below. It held `jsdom` 30 and Changesets CLI 3 back to keep
a Node 20 leg alive, on the belief that raising the floor was consumer-visible. It is not: no
published package declares `engines`. The one fact worth carrying forward is that
`@changesets/cli` publishes a `maintenance-v2` dist-tag (2.31.1), so the 2.x line is upstream-
supported rather than merely lagging — which is why its hold survived that reversal. Both holds
were then removed when the release tooling moved to v2; see the last entry in this file.

## The test matrix moves to Node 22 and 24 (2026-08-17)

- **The matrix was testing a dead version and missing the current one.** Node 20 (Iron) is
  end-of-life upstream, as is Node 18; Node 22 (Jod) and Node 24 (Krypton) are both LTS, and
  Node 24 was not exercised at all. `node: [20, 22]` therefore spent one of its two legs on a
  runtime nobody should deploy while leaving the newest supported line unverified. It is now
  `node: [22, 24]`.
- **Changing the tested versions is not consumer-visible, which is the fact that makes this
  cheap.** No published package declares `engines` — all eighteen omit it — and the only
  `engines.node` in the repository, `>=18.17`, sits in the root manifest, which is
  `private: true` and never published. So this moves no floor, breaks no install and needs no
  version bump. The honest corollary: consumers on Node 18 or 20 can still install, because
  nothing declares otherwise; what changes is that the project stops *verifying* those
  versions. Adding `engines` to the published packages would be the opposite kind of change —
  breaking, and a major for every package — and is deliberately not part of this.
- **What it unblocks.** `jsdom` 30 declares `engines.node`
  `"^22.22.2 || ^24.15.0 || >=26.0.0"` and depends on `undici` 8, whose `CacheStorage` reaches
  `worker_threads.markAsUncloneable` at module scope — a helper absent from Node 20 and never
  backported, so importing `jsdom` threw outright there. That cost the Node 20 leg eleven test
  files and 338 covered statements and surfaced only as a coverage-threshold failure rather
  than as the runtime incompatibility it was. With Node 20 gone the break cannot occur, and
  `jsdom` 30 lands with this change.
- **Changesets CLI 3 is unblocked by the same move but deferred deliberately.** CLI 3 declares
  `engines.node "^22.11 || ^24 || >=26"`, which the new matrix satisfies, but it is driven only
  by `changesets/action` v2, so taking it means rewriting `release.yml` — renamed inputs and npm
  authentication moving off `NPM_TOKEN`. That touches the publish path, so it is its own change
  rather than a passenger here. Its hold stayed in `.github/dependabot.yml` until the migration
  landed later the same day; see the last entry in this file.
- **No advisory ever required any of these majors.** `js-yaml`, `undici`, `nanoid` and
  `postcss` all had patched releases inside the ranges their dependents already declared, so a
  lockfile refresh cleared them — the same reasoning as the `ip-address` entry above. This
  change is maintenance hygiene, not a security fix.
- **What now defends the runtime floor, since the Node 20 leg was the last mechanical check
  that shipped code stays runnable below Node 22.** `tsconfig.base.json` caps `lib` at
  `ES2022`, so a newer built-in does not typecheck even though `@types/node` is on 26, and the
  only Node built-in in any published source is `createHmac` / `timingSafeEqual` in
  `packages/adapter-stripe-server/src/webhook.ts`. Exposure today is nil; the intended floor
  for shipped code stays "runs on any maintained Node", and `lib: ES2022` is what holds it.
- **Revisit trigger, because the previous matrix drifted for want of one.** Node 22 has been
  *maintenance* LTS since 2025-10-21 and ends 2027-04-30; Node 24 is *active* LTS until
  2028-04-30; Node 26 becomes LTS on 2026-10-28. Revisit then: the pair should track the two
  supported LTS lines, which at that point means dropping 22 for 26 or running three legs.
  Development floor: root `engines.node` is `^22.22.2 || ^24.15.0 || >=26.0.0`, set by the test
  toolchain (`jsdom` 30), and the root manifest is private so this is not a consumer signal.

## Release tooling stays on changesets/action v1 (2026-08-17) — superseded

Reversed the same day by the entry below, once the matrix move to Node 22 and 24 retired the
engine floor that was the last coupled blocker. The reasoning below is retained because its
description of what v2 changes is what the migration then had to implement.

- **v1 is the line built for Changesets CLI 2, which is what this repository declares**, so the
  release path is internally consistent as it stands: `release.yml` passes `publish:` and
  `NPM_TOKEN`, both of which v1 understands.
- **v2 fails loudly, not silently — worth recording because the opposite is easy to assume.**
  v2 validates the declared `@changesets/cli` range before it acts on any release input and
  throws when it finds CLI 2, with an error directing CLI 2 users back to v1; the renamed-input
  check throws next. Both surface through `setFailed`, so a stray bump turns the release step
  red rather than opening a Version Packages PR that publishes nothing. There is no
  silent-mis-publish risk here.
- **The migration is three coupled changes, which is why it is held**: the input renames — v2
  renames seven of its eleven inputs, `cwd` and `github-token` keeping their names, and
  `release.yml` passes exactly one of the seven, `publish` becoming `publish-script` — npm auth
  moving off `.npmrc` to `registry-url` plus `NODE_AUTH_TOKEN` or trusted publishing, and the
  `@changesets/cli` 3 major. The Node engine floor was a fourth until the matrix moved to 22
  and 24, which retired it. Doing any subset
  leaves the release broken.
- **What the hold suppresses, precisely.** `release.yml` pins the floating `@v1` ref, so
  dependabot can only ever propose a major for this action — meaning the entry silences the
  only PR it can raise, and per GitHub's documentation it also suppresses a security PR whose
  fix requires a major. Dependabot **alerts** are unaffected and remain the signal here: no CI
  job scans Actions for advisories, because `dependency-audit` walks the npm tree through
  `scripts/audit-deps.mjs` and CodeQL is configured for `javascript-typescript` only. A v2-only
  advisory fix would need a manual bump.

## Release tooling moves to changesets/action v2 (2026-08-17)

- **Taken because the matrix move retired the last blocker.** Changesets CLI 3 needs
  `engines.node "^22.11 || ^24 || >=26"`, which `node: [22, 24]` satisfies, so the migration
  reduced to the workflow rewrite. All three coupled pieces land together: CLI `^3.0.0`, the
  `@changesets/config@4.0.0` schema, and `release.yml`. Derived from the `changesets/action`
  CHANGELOG entries for 2.0.0 (PRs #674, #678, #680, #681, #692, #695) and the major-changes
  list for `@changesets/cli` 3.0.0.
- **`publish` became `publish-script`.** v2 throws on the old name rather than ignoring it, so a
  half-done migration fails the step instead of publishing nothing.
- **npm authentication moved out of the action.** v2 no longer writes `.npmrc` from
  `NPM_TOKEN`, so `actions/setup-node` now sets `registry-url` and the publish step passes the
  same secret as `NODE_AUTH_TOKEN`. Trusted publishing via OIDC is the other supported route and
  removes the long-lived token entirely, but it needs configuration on the npm side, so it is
  not part of this change.
- **`GITHUB_TOKEN` was dropped as an environment variable, but not because it was dangerous.**
  v2 ignores the variable for configuration — the `github-token` input is what it reads, and it
  defaults to the workflow token. Its only check compares the two by *value* and fails when they
  differ, which is aimed at a custom token smuggled in through the environment; the old
  configuration passed the workflow token to both, so it would have been accepted. Removing it
  keeps the step honest about where the token comes from rather than averting a failure.
- **`push-with-git-cli: true` is deliberate.** v1 defaulted to `commitMode: "git-cli"`; v2's
  equivalent defaults to `false`, which pushes release commits and tags through the GitHub API,
  re-attributing them to the token owner under GitHub's GPG key and creating *lightweight* tag
  refs. Existing tags are annotated objects tagged by `github-actions[bot]`, so keeping the Git
  CLI preserves both attribution and tag shape.
- **What did not change.** `create-github-releases` still defaults to `true`, so GitHub Releases
  keep being created. `push-git-tags` is new in v2 and also defaults to `true`, so tag pushing —
  unconditional in v1, which had no such input — is unchanged. `commit-message` and `pr-title`
  both default to `Version Packages`, matching v1's output. `setupGitUser` is gone in v2, which
  handles git identity itself.
- **Three CLI 3 default changes are inert here, but only for reasons worth writing down.**
  Private packages are no longer versioned by default — inert because every private workspace is
  already in `ignore`. The `prettier` config option became `format` — inert because neither is
  set. Peer-dependency bumps are now `patch` rather than `major` — inert because no workspace
  package declares an internal peer dependency. Adding a private package or an internal peer
  dependency would make each of these live.
- **Verified before merge, because CLI 3 changes behaviour the gate depends on.** `changeset
  status --since=…` still exits 1 with "Some packages have been changed but no changesets were
  found" when a published package moves without one, so the `changesets` CI job keeps its
  meaning — and it still exits 0 when the only changeset present is empty, so the opt-out used
  here still satisfies it. CLI 3's "`version` exits 1 when there are no changesets" never reaches
  the workflow: v2 reads the changeset state first and only calls `version` when non-empty
  changesets exist. `.changeset/config.json` points `changelog` at `@changesets/cli/changelog`,
  which CLI 3 still exports despite being ESM-only — `status` would not have proven that, since
  only `version` loads it.
- **One behaviour genuinely changes, and it suits this repository.** When every pending changeset
  is empty — the deliberate opt-out used here for tooling-only changes — v2 logs "All changesets
  are empty; not creating PR" and stops, where v1 would open a Version Packages PR that consumed
  them and bumped nothing. Empty changesets therefore accumulate until a real one arrives, which
  consumes the whole batch. Fewer no-op release PRs, same end state.
- **Two things to watch, because `release.yml` is never exercised by pull-request CI.** A bad
  bump to this action surfaces only at release time, which is why its dependabot hold was worth
  keeping until the migration was ready. And v2 learns what to tag from a `CHANGESETS_OUTPUT`
  file rather than by parsing publish output: if that file is ever missing, it downgrades to a
  warning and reports nothing published, so packages could reach npm with no tags and no GitHub
  Releases while the step stays green. Confirm tags and Releases exist after the first release
  under v2 rather than trusting a green step.

## Stripe: payment-method error codes from 2026-08-26.dahlia (2026-09-23)

- **`expired_payment_method` maps to `expired_card` and `incorrect_postal_code` to
  `invalid_card_data`, both non-retryable, as a defensive mapping.** Doc-verified 2026-09-23
  (docs.stripe.com/changelog/dahlia/2026-08-26/adds-payment-method-error-codes): the new
  codes "are similar to existing error codes, but represent failures consistently across
  payment method types, countries, and regions", and docs.stripe.com/error-codes gives each
  the remedy of its card-specific counterpart. The release is marked non-breaking and removes
  no codes, and docs.stripe.com/testing still lists the expired-card test card as returning
  `expired_card`. Against that, the changelog says these failures "previously" used the
  card-specific `expired_card` and region-specific `incorrect_zip`, but it never says card
  declines changed, so which code a card decline now carries is not stated. The mapping only
  makes sure that one which does arrive lands where its counterpart does.
- **Server half only, and only for hosts pinned to 2026-08-26.dahlia or later.**
  `mapStripeError` sees the errors of the adapter's own calls, which carry the host's pinned
  `apiVersion`. The browser adapter follows the account's default API version through
  Stripe.js and maps none of these codes (nor `incorrect_zip`); aligning it is a follow-up.
- **The checks live in the `StripeCardError` branch only.** Neither page states which error
  `type` the new codes arrive with, so the conservative reading extends the branch that
  already handles `expired_card` and `incorrect_zip`; under any other type they fall through
  to that type's existing mapping. A sandbox run pinned to this version with the expired-card
  and lost-card test cards, recording `type`, `code`, `decline_code` and `message`, would
  show which codes those cards return on this version and, where a new code appears, its
  `type` and `decline_code`. The integration suite pins an older version, so this needs a new
  case, not a re-run. Seeing `authentication_failure` needs a failed 3-D Secure challenge
  instead, a browser step on Stripe's mock authentication page; its mapping stays a sign-off
  decision either way.
- **`authentication_failure` is left unmapped (default, unconfirmed).** It falls through to
  `card_declined`. Its docs.stripe.com/error-codes entry states no remedy; the changelog
  presents it as the general form of `payment_intent_authentication_failure` and
  `setup_intent_authentication_failure`, whose documented remedy is a new payment method.
  The Stripe browser adapter maps those two codes to `authentication_required`, as Worldline
  does `40001134` ("a failed 3-D Secure check") and Adyen `11` and `42`. Both candidates are
  non-retryable, so retries and the router cascade are unaffected; the choice decides which
  code and message the host shows. Stripe's 3-D Secure guide
  (docs.stripe.com/payments/3d-secure/authentication-flow) gives both remedies after a failed
  authentication: try a different payment method, or retry 3-D Secure by reconfirming. Which
  way the Stripe server half should go is an open decision; a unit test records the current
  fall-through so that a change is deliberate.
- **`payment_method_restricted` stays `card_declined`.** Stripe's example is a card reported
  lost or stolen; the existing `restricted_card` decline code ("it's possible it was reported
  lost or stolen") already falls through to `card_declined`, and a `lost_card` or
  `stolen_card` decline code on the same error still yields `fraud_suspected`, whose message
  is generic as docs.stripe.com/declines/codes asks. Whether Stripe sends a decline code
  alongside this code is undocumented.
