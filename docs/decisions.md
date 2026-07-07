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

## Open items requiring humans or infrastructure

- Webhook delivery verification (both PSPs) needs a public URL/tunnel + real webhook
  secrets; deferred by user request. Paysafe's signature **header name** is still
  unconfirmed (adapter accepts `signature` / `x-signature` / `x-paysafe-signature`).
- Team sign-off on every *(default, unconfirmed)* item above.
