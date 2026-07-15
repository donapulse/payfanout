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
  deterministic and hosts stay inside the platform's 5-minute skew. `X-GCS-Date` is noted in
  code as the edge-runtime alternative when the `Date` header cannot be set.
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
  `{ idRoundTrip: true, metadataEcho: false }`.
- **CreatePayment wiring (corrected in review, 2026-07-15):** `hostedTokenizationId` rides
  at the ROOT of the CreatePayment request — the platform's current domain model declares it
  there and `CardPaymentMethodSpecificInput` has no such field (the guide's "replace the
  card property" wording is about replacing card DATA, not a nesting instruction). The 3-D
  Secure return URL is sent BOTH as `cardPaymentMethodSpecificInput.returnUrl` (the field
  the Hosted Tokenization guide names) and in its `threeDSecure.redirectionData.returnUrl`
  form — both are current in the models; sandbox-verify one challenge flow.
- **Refund reads (corrected in review, 2026-07-15):** Direct has NO refund-by-id endpoint —
  `GET /{merchantId}/refunds/{refundId}` is Connect-era; the only read surface is
  `GET /v2/{merchantId}/payments/{paymentId}/refunds`. `refundPayment` therefore returns a
  composite `refundId` (`{paymentId}:{refundId}`, the suffix being Worldline's raw refund
  id, the one webhooks report) and `retrieveRefund` resolves it through the per-payment
  list. With no documented refund-failure webhook (below), this polling path is the only
  reliable refund-failure signal.
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
- **Manual capture (not multi-capture):** `PRE_AUTHORIZATION` authorizes, `POST /capture
  { amount?, isFinal: true }` settles — a partial capture settles that amount and RELEASES
  the uncaptured remainder (Worldline finalizes the capture, and referenced refunds are only
  accepted once the capture is finalized). `supportsMultiCapture` is **false**: the core
  `capturePayment(id, amount, key)` contract carries no `isFinal` signal, so an authorization
  cannot be held open across several captures. `retrievePayment` sums `GET /captures` and
  `GET /refunds` (separate sub-resources) for `amountCaptured` / `amountCapturable` (0 once
  the payment is a completed sale/capture) / `amountRefunded`.
- **Webhooks:** `X-GCS-Signature` = base64(HMAC-SHA256(webhookSecret, rawBody)) over the
  EXACT raw bytes, key selected by `X-GCS-KeyId` (array of `{keyId, secretKey}` for
  rotation, any active key verifying wins). One event per delivery. The documented event
  list (2026-07-15) is `payment.created / redirected / authorization_requested /
  pending_approval / pending_completion / pending_capture / capture_requested / captured /
  rejected / rejected_capture / cancelled / refunded`, `refund.refund_requested`,
  `paymentlink.*`, and `payment.test`; the documented terminal refund signal is
  `payment.refunded`, and there is NO documented refund-failure event — refund failure is
  observed by polling `retrieveRefund`. Mapping: `payment.captured` → `payment.succeeded`,
  `payment.rejected`/`rejected_capture` → `payment.failed`, `payment.cancelled` →
  `payment.canceled`, `payment.refunded` → `payment.refunded`, pending payment states →
  `payment.processing`. `refund.refund_requested` maps to `unknown` deliberately — it is
  recognized but non-terminal, and the unified vocabulary has no in-flight refund state;
  fabricating a terminal type would misreport it. The parser additionally TOLERATES
  `payment.paid`, `payment.pending_fraud_approval`, `refund.refunded`, `refund.rejected`
  and `refund.cancelled` — none are on the documented list, and the onboarding descriptor
  advertises only the documented set so hosts never subscribe to undocumented types.

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
- **Minor-unit semantics for 0/3-decimal currencies.** Amounts are documented only as an
  integer in "the least subunit … in some cases smaller"; nothing found on 0- or 3-decimal
  currencies. ISO 4217 minor units are forwarded per the core invariant — run one sandbox
  payment in a 0-decimal currency (JPY) before routing such currencies here, and declare an
  adapter-local constraint (as with the PayZen CNY/KHR decision) if the platform disagrees.
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
