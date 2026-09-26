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
  *(Amended 2026-09-24: Paysafe reads keep these retries, but a Paysafe write is re-sent only
  after a 429, or, when it moves no money, once a lookup shows the first attempt never
  landed — Paysafe rejects a repeated `merchantRefNum` rather than replaying it. See
  "Paysafe replay safety (2026-09-24)".)*
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
  host wins everywhere else. *Update 2026-09-24:* Paysafe's protected setup key is
  `accounts` (`accounts.default`, the documented setup option for a key holding several
  accounts in one currency), not `accountId`, which setup never read; tokenize still
  carries `accountId`, as its reference documents. When the session's account is
  numeric, it replaces a host's whole `fieldOptions.accounts`: tokenize's `accountId`
  overrides the setup account and the server charges the session's account, so sibling
  entries could never route a payment.
- **Doc-verified 2026-09-24: Paysafe.js tokenize and show.** Tokenize requires
  `merchantRefNum` ("A unique identifier is provided by the merchant for every transaction
  from Paysafe JS"; the served SDK fails a missing value with 9003), so each attempt sends a
  fresh one: the session `id` minus Paysafe's global invalid characters, cut so the whole
  stays within 255 characters, then a random suffix (`crypto.randomUUID`, or
  `getRandomValues` outside secure contexts). It names the single-use handle only; the
  payment keeps the caller's `idempotencyKey`. The adapter always calls `show()` after
  setup ("The function should be invoked immediately after the setup function"): the served
  SDK makes it during setup only for a single payment method and answers a repeat call
  with the first result, so the call is harmless for the card-only fields and keeps any
  other setup from staying locked (9100).
- **`MountOptions.locale`** — BCP-47, mapped per PSP. Paysafe no longer receives it: its setup
  takes no locale (corrected 2026-09-25, see "Common appearance tokens").
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
  authorises that one billing request — no duplicate-payment risk; refined 2026-09-25:
  only while that billing request is `pending`, see the replay entry below), and the
  conformance idempotency proof moved to refunds (same key twice → the original
  refund, exactly one create).
- Webhook deliveries are **batched** (up to 250 events, one HMAC over the raw body):
  `parseWebhookEvent` throws on batched deliveries instead of dropping events;
  `parseGoCardlessWebhookEvents` (verify once, fan out per event) is the documented
  ingress. `billing_requests`/`fulfilled` maps to `payment.processing`, payment id
  from `links.payment_request_payment` (corrected 2026-09-24: only when the event names
  that payment; see the lifecycle entry below).
- `supportsSavedPaymentMethods: false` in v1: mandates are genuinely reusable
  charging handles, but async bank rails cannot meet the vault contract's
  instantly-succeeded off-session charge; mandates-as-vault is future work.
- `listRefunds` scopes with the server-side `?payment=` filter on GET /refunds
  (sandbox-verified: 200 + empty list for a refund-less payment).
- **Doc-verified 2026-09-24: billing request and payment lifecycle.** Checked against the
  OpenAPI spec for the pinned 2015-07-06 version
  (docs.gocardless.com/openapi-schema-public.json), the billing request and payment event
  references, the billing request events guide, the Drop-in and Success+ guides, and the
  scenario simulators page.
  - *Billing request status.* The spec defines `ready_to_fulfil` as "the billing request is
    ready to fulfil" and `fulfilling` as "the billing request is currently undergoing
    fulfilment". A billing request's actions are those "that can be performed before this
    billing request can be fulfilled", `bank_authorisation` is a required one on a payment
    request, and the `billing_request_fulfilled` simulator starts from "the `pending` state,
    with all actions completed except for `bank_authorisation`". Both states come after
    the payer's part, so `retrievePayment(BRQ…)` reports
    them `processing`, as it does `fulfilled`; only `pending` ("the billing request is
    pending and can be used") stays `requires_action`. They were `requires_action`, which
    invited a host to send the payer to authorise again. An undocumented status reads
    `processing` for the same reason.
  - *`billing_requests`/`fulfilled`.* The event's `links.payment_request_payment` is "the
    ID of the payment which has been created for Pay by Bank", while the Drop-in guide's
    mandate flow says of the same event "Record the mandate_id from
    links.mandate_request_mandate". A fulfilment maps to `payment.processing` only when it
    names a payment; a mandate-only one maps to `unknown`.
  - *`billing_requests`/`cancelled`* ("This billing request has been cancelled, none of the
    resources have been created") maps to `payment.canceled`, matching `retrievePayment`.
    Billing request events carry `links.billing_request` as `pspPaymentId`, except a
    fulfilment, which names its payment: the events guide's examples show
    `links.payment_request_payment` on every action, pre-fulfilment ones included, while
    the spec describes it as the payment "which has been created" (AMBIGUOUS; the
    billing request id is right under either reading). The event does not say whether the
    request had a `payment_request`, so
    a cancelled mandate-only request reads the same way; a host finds no session under a
    `BRQ…` id it did not create. `bank_authorisation_denied` stays `unknown`: "Payers can
    always return to the flow and create a new bank authorisation".
  - *Late failures.* The spec's payment `failed` status notes that "payments can fail after
    being confirmed if the failure message is sent late by the banks", and the simulators
    list `Late` as `submitted` → `confirmed` → `failed`; the `payment_late_failure_settled`
    simulator "Behaves the same as the `payment_late_failure` simulator, except that the
    late failure is additionally included as a debit item in a payout", and the Success+
    guide says "On payment failure the `failed` event will always be sent."
    `late_failure_settled` is "The
    payment was a late failure which had already been paid out, and has been debited from
    a payout", the counterpart of `chargeback_settled`, so it maps to `unknown` rather than
    a second `payment.failed`. The Success+ guide asks integrators to act on
    `late_failure_settled` because such a payment may be retried; the event is still
    delivered, and a retry arrives as `resubmission_requested` → `payment.processing`.
  - *Scheme `pad`*, listed in the spec's `payments.scheme`, maps to the unified `pad` type
    chosen for it on 2026-07-15 instead of `other`.
  - **AMBIGUOUS:** whether the payer can land on `redirect_uri` while the billing request
    is still `fulfilling` (it reads `processing` either way), and which status a billing
    request holds after a `billing_requests`/`failed` event, since the status list names
    none. Sandbox checks: read the billing request in the return handler during a browser
    run, and record the status when a `failed` event occurs.
- **Doc-verified 2026-09-25: replays of sessions, refunds and cancels.** The Limits page
  documents idempotency for creates: "When creating resources, pass an `Idempotency-Key`
  header to ensure the key can only be used for one successful request", and "If a
  resource already exists for that key, the API returns a `409
  idempotent_creation_conflict` error with a `links.conflicting_resource_id` pointing to
  the existing resource." Keys "are honoured for at least 30 days"; after that a replay
  may be treated as a new request. No comparison of the replayed parameters is
  documented, so the adapter compares them itself.
  - *Sessions.* A replayed billing request must match the input: its `payment_request`
    amount and currency, the currency of any `mandate_request` (sessions send none and
    choose no scheme), and the stamped `payfanout_id`. A mismatch rejects with
    `invalid_request` instead of handing back another payment's billing request. Once the
    billing request names its payment (`links.payment_request_payment`, the "ID of the
    payment that was created from this payment request"), the replay reads that payment
    and reports its status, as `retrievePayment` does, so a payment that already failed
    never reads `processing`. One exception (2026-09-25): a `pending_customer_approval`
    payment ("we're waiting for the customer to approve this payment") reads
    `processing` on a replay, where `retrievePayment` reports `requires_action`, because
    a replayed session whose billing request names a payment carries no `clientSecret`.
    Before the billing request names a payment, the replay reports the billing
    request's mapped status.
    The payment read happens on replays only, and if it fails the billing request's status
    stands: failing the replay would let `PaymentRouter` fail over to another PSP for a
    payment that already exists. A flow is created only while the billing request is
    `pending` ("pending and can be used") and names no payment. Past that point the payer
    has authorised, or the request is `fulfilled` ("fulfilled and a payment created") or
    `cancelled` ("cancelled and cannot be used"), and the session carries no
    `clientSecret`. This refines the 2026-07-07 flow decision above. Flows still go out
    without a key, since they cannot be read back: the spec has no GET for them, and "Each
    flow currently lasts for 7 days".
  - *Refunds: the key stamp.* Every refund is created with the SHA-256 (lowercase hex,
    computed with WebCrypto) of its idempotency key in its metadata, as
    `payfanout_key_sha256` next to `reason`. The spec allows "Up to 3 keys", "key names up
    to 50 characters and values up to 500 characters": the stamp is 64 characters, and
    `reason` plus the stamp take two keys. A hash rather than the key keeps the host's
    key, which can carry its own identifiers, out of the GoCardless dashboard at a fixed
    length; an unkeyed hash, unlike an HMAC, survives credential rotation. The stamp is
    data held at GoCardless, like `payfanout_id` on payments and PayZen's `payfanout_key`,
    not PayFanout persistence: PayFanout stores nothing, and reads the payment's refunds
    back only when a replay has to be told apart.
  - *Refunds: replays.* A replayed refund must belong to the payment and, when an amount
    is given, be for that amount. A request the remainder check refuses, as it refuses
    the replay of a refund that used up the payment, is never sent. The adapter reads
    `GET /refunds?payment=` (the spec's `payment` filter; `refund_type` defaults to
    `payment`, "refunds created against payments only") and returns the refund stamped
    with the key, checked like any replay. With none, the refusal stands, its `raw`
    holding the payment as `payment` and, when the read was refused, the read's answer as
    `lookup`: one shape either way. One page holds every refund of a payment: the adapter
    asks for `limit=500`, the most the Data Conventions page allows ("Default 50, max
    500"), and the Responses and Errors page describes `number_of_refunds_exceeded` as
    "Maximum of 5 refunds per payment already reached". Should two refunds carry the
    stamp, which a key reused past the 30-day window can cause, the newest wins. The same
    read settles a POST that GoCardless rejects with anything but the 409: a stamped
    refund is the original, and anything else rethrows the rejection. A transient failure
    of the read stays retryable, after a refusal and after a rejected POST alike (a
    rejection that reads as final could hide the original); after a rejected POST, the
    rejection rides `raw.rejection` and the read's answer `raw.lookup`, whether GoCardless
    rejected the POST or failed to answer it. Any other failure keeps the refusal, or the
    rejection marked `outcomeUnknown` (2026-09-25): whether the key already refunded
    stays open, so only the same key may follow. An answer without a `refunds` array
    counts as a failed read. While GoCardless reports an amount already
    refunded (`amount_refunded` above 0), the read also runs before the create
    (2026-09-25), so a key past the window GoCardless honours keys for is read back too.
    That read exists only to prevent a second refund, so it fails closed: the refund is
    not sent, and the call rejects retryable when the failure is transient and with a
    final `invalid_request` marked `outcomeUnknown` otherwise, whose message sends the
    host to the dashboard and back to the same key. Replays of stamped refunds therefore depend
    neither on `total_amount_confirmation` nor on whether GoCardless checks the key before
    the body (AMBIGUOUS: the docs do not state the order). Refunds created before the
    stamp carry none: a replay of one that the remainder check refuses rejects, as it
    always did, and one within the remainder relies on the 409. Past the window
    GoCardless honours keys for, a same-key refund of a stamped original is read back
    before any create while `amount_refunded` is above 0; one of a refund made before the
    stamp may be created anew.
  - *Refunds: amounts.* The spec types a payment's `amount` and `amount_refunded`, and a
    refund's `amount`, as integer or string. The refund path reads digit strings as
    integers and rejects anything else with a non-retryable `unknown` before any
    arithmetic or `RefundResult`, and an explicit `amount` of 0 rejects before any
    request.
  - **AMBIGUOUS: the `total_amount_confirmation` opt-out.** The spec defines the field as
    "the sum of the existing refunds plus the amount of the refund being created", says
    it "Must be supplied if `links[payment]` is present", and fails a mismatch with
    `total_amount_confirmation_invalid`. It also says "It is possible to opt out of
    requiring `total_amount_confirmation`", and does not say whether a value still
    supplied is checked after that. The API reference defines no cap on a refund's
    amount either; the support centre's "up to the full amount of that payment" is a step
    of the Dashboard refund flow. GoCardless lets accounts opt out of the confirmation
    check, so the adapter no longer relies on it: it still sends the value from a fresh
    read, and recognises replays by the stamp alone. What that cannot close statelessly:
    on an opted-out account two refunds under different keys that read the same
    `amount_refunded` can both be sent, so the guide asks hosts to refund one payment at a
    time there, each once the previous one shows in `amount_refunded`. **AMBIGUOUS too:
    whether `amount_refunded` counts a refund as soon as it is created**; the spec says
    only that GoCardless "will update the `amount_refunded` property of the payment"
    (sandbox check S4 below).
  - *Cancels.* Idempotency keys are documented for creates only. The official Node client
    (gocardless-nodejs `src/api/api.ts`) generates a key for every POST it is not given
    one for, cancels included, and resolves no 409 for them. Whether an action is
    deduplicated by key is AMBIGUOUS. `cancel_payment` "will fail with a
    `cancellation_failed` error unless the payment's status is `pending_submission`", and
    `cancellation_failed` covers a resource "already cancelled". The billing request
    cancel documents no error ("Immediately cancels a billing request, causing all billing
    request flows to expire"), so its answer for a request already cancelled is
    unverified. `cancelPayment` re-reads the payment or billing request on any rejection
    and resolves `canceled` when it is already cancelled, as `cancelNativeSubscription`
    does, whichever answer GoCardless gives.
  - Sandbox checks: (S2) cancel a `pending_submission` payment twice with the same key,
    and a pending billing request twice, and record whether each second call answers 200
    or 422 `cancellation_failed`; (S3) create a flow on a fulfilled and on a cancelled
    billing request and record the answer (the adapter no longer does either); (S4)
    create a refund, read the payment at once, and record whether `amount_refunded`
    includes it.

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
- **Doc-verified 2026-09-24: client callbacks follow the JS SDK v5 reference.**
  `createOrder` returns a Promise of the order id, the only form the reference's samples
  show. Errors the buttons deliver through `onError` are non-retryable `processing_error`:
  PayPal calls that handler a catch-all whose errors "aren't expected to be handled beyond
  showing a generic error message or page". A mount that throws inside `paypal.Buttons()`
  or `render()` stays a retryable `processing_error`: PayPal's docs say nothing about
  render failures, and mounting again can succeed.
- **Webhook verification via PayPal's postback API**
  (`POST /v1/notifications/verify-webhook-signature`), not local X.509 crypto:
  stateless, edge-clean, and PayPal does the certificate work. The raw body is
  spliced into the postback by string concatenation (parse + re-stringify breaks
  PayPal's verification); a missing `webhookId`, missing transmission headers, or
  transport trouble all answer `false` (fail closed, no network call where
  detectable locally). Local crypto (CRC32 + SHA256withRSA over the cert from
  `paypal-cert-url`) stays a documented optimization path, rejected for v1 because
  WebCrypto cannot import X.509 certs without hand-rolled ASN.1.
- **Doc-verified 2026-09-24:** the verification postback accepts only a body that is
  exactly one JSON object (PayPal's verify request types `webhook_event` as the event
  object and requires it posted back exactly as received); anything else answers `false`
  with no network call. `CHECKOUT.PAYMENT-APPROVAL.REVERSED` names the order as
  `resource.order_id` (no `resource.id`), the pre-capture canonical id.
- **Doc-verified 2026-09-24:** PayPal's currency codes reference no longer lists RUB.
  `PAYPAL_SUPPORTED_CURRENCIES`, and so `supportedCurrencies`, holds only the listed codes,
  and a new session or a move of an order to another currency must use one of them, so the
  router skips PayPal for a RUB payment instead of failing it there. RUB stays readable and
  formattable for payments made in it earlier: their reads, captures, refunds and
  same-currency updates keep working, and PayPal decides on them. Refusing those locally
  would block refunding money already taken, and PayPal's pages do not say what happens to
  existing RUB payments.
- **Doc-verified 2026-09-24: local limits.** A zero amount is refused on sessions, updates,
  captures and refunds (`CANNOT_BE_ZERO_OR_NEGATIVE`; the Payments v2 capture and refund
  amounts "must be a positive number"), a session `id` over 255 characters (the Orders v2
  `custom_id` limit), and a `brandName` over 127 characters or with a line break
  (`brand_name`, pattern `^.*$`). Lengths count characters, never UTF-16 units or bytes,
  so the adapter never refuses what PayPal accepts under either of those; an empty `id` or
  `brandName` is still omitted rather than refused. A `fetchEvents` cursor must start with
  the events-list path and resolve to exactly that list, a trailing slash allowed, and the
  resolved path is what is requested. **AMBIGUOUS:** the shape of the list's `next` link
  (the webhooks schema gives no example href), and whether `start_time` without `end_time`
  is honoured (the reference describes them as the two ends of one range). Sandbox checks:
  page through `GET /v1/notifications/webhooks-events?page_size=1` on an account with two
  or more events and record the `next` href, with and without `start_time`.
- **Order updates follow the Orders v2 patchable-attributes table (2026-09-24).** The table
  lists shipping's own attributes (`shipping.name`, `shipping.address`: replace, add), not
  the whole `shipping` object, and `soft_descriptor` with replace and remove only, so the
  adapter patches `shipping/name` and `shipping/address` and refuses to add a descriptor to
  an order created without one, before the PATCH. A statement descriptor longer than 22
  characters is cut to 22, since PayPal truncates it ("any content beyond 22 characters
  (including spaces) will be truncated"), instead of being dropped. The PATCH applies whole
  or not at all (RFC 5789 and RFC 6902, which PayPal's patch format follows; PayPal's pages
  do not say so themselves), so one refused operation would take an amount change down
  with it.
  - **AMBIGUOUS in PayPal's docs:** which operation an attribute takes. The error reference
    refuses an `add` over a present property and a `replace` of a missing one, while the
    schema describes `add` over an existing value as replacing it, and PayPal's own "Patch
    Order - Add Shipping Address" sample adds an address with `replace`, though the same
    schema defines `replace` as succeeding only when "the target location must exist", as
    RFC 6902 §4.3 does, and the sample does not say whether the order had a shipping object
    (PayPal's `PUHF` create samples all carry an address). JSON Patch also needs the parent
    object to exist for an `add` (RFC 6902 §4.1). The adapter replaces an attribute that is
    there, adds a missing one under an existing shipping object, and replaces into an order
    that has no shipping object, following PayPal's Add Shipping Address sample; the test
    fake models that reading, and neither operation has run against a sandbox.
    Sandbox checks to settle it: adding name and address to an order created without
    shipping, adding a `soft_descriptor` to an order without one, an `add` over an existing
    `shipping/address`, and whether an order read returns `soft_descriptor` (the refusal
    depends on it).
- **Sandbox-verified 2026-07-07:** orders created with `payment_source.paypal`
  (always, for the experience_context) answer `PAYER_ACTION_REQUIRED` immediately —
  not `CREATED` — so a fresh session reports `requires_action`; PATCH still works in
  that state, and capture/authorize still 422 `ORDER_NOT_APPROVED`. The in-memory
  fake mirrors this (bare orders without a payment_source keep `CREATED`).
- **Captures, refunds and completions follow PayPal's documentation (2026-09-24).**
  Doc-verified against the Payments v2 (2.12) and Orders v2 (2.36) OpenAPI schemas under
  developer.paypal.com/api/, the Orders troubleshooting and error-messages pages, the
  delay-capture and authorization/honor-period guides, the idempotency reference, and the
  webhook event names page.
  - *Capturing the rest.* The capture request's `amount` reads "If amount is not specified,
    the full authorized amount is captured", so after a partial capture a request without
    an amount asked for the whole authorization again. `capturePayment(id, undefined)` now
    sends the remainder explicitly: the authorized amount minus the captures that took
    money. DECLINED ("The funds could not be captured") and FAILED captures are left out.
    PENDING ones ("not yet credited to the payee's PayPal account") are kept, because
    `MAX_CAPTURE_AMOUNT_EXCEEDED` documents a default overage of "up to 115% of the order
    amount" (the authorization and honor period guide: "up to 115% or $75 USD more than the
    original authorized amount, whichever is less"): a remainder that ignored a pending
    capture could be accepted and capture that slice twice. `final_capture` ("Set to `true`
    if you do not intend to capture additional payments against the authorization") is
    `true` when the amount, explicit or implied, covers the remainder, and `false` below it;
    afterwards `AUTHORIZATION_ALREADY_CAPTURED` ("If `final_capture` is set to to `true`,
    additional captures are not possible against the authorization") refuses a second
    capture of the rest. The flag is derived from the remainder at call time, so a same-key
    retry of an explicit partial capture can send a different body; that is safe because
    PayPal replays by the PayPal-Request-Id header ("returns the latest status of the
    previous request that used that same header"). Explicit amounts are not checked against
    the remainder: the overage contradicts the same error's example ("You can only capture
    up to the original authorization amount"), so PayPal judges them. The fake now captures
    the full authorized amount for a request without an amount, closes the authorization on
    `final_capture`, refuses a capture in another currency than the authorization's
    (`AUTH_CAPTURE_CURRENCY_MISMATCH`: "Currency of capture must be the same as currency of
    authorization"), and keeps the no-overage rule.
  - *Nothing left to capture.* Capturing the rest sends no capture request when nothing is
    left (an explicit amount still goes to PayPal, which refuses it). Once earlier captures
    took the whole authorization (CAPTURED, a non-failed capture whose own `final_capture`
    is `true`, or non-failed captures covering its amount), capturing the rest answers with
    the payment, under the same key or a new one. The adapter is stateless, so it cannot
    tell a retry whose response was lost from a new call; leaving the retry to
    PayPal-Request-Id would mean sending a capture without an amount, which PayPal reads as
    the full authorized amount, and zero is not allowed ("The amount must be a positive
    number"). An authorization voided or denied before captures covered it still rejects
    with `invalid_request` before any capture request; VOIDED is also how an expired
    authorization reports ("voided either due to authorization reaching its 30 day validity
    period or… manually voided"). The capture's own `final_capture` (both the Payments and
    the Orders capture objects carry it) is read because the authorization statuses are
    defined by amount alone (PARTIALLY_CAPTURED: "an amount that is less than the amount of
    the original authorized payment"), so they cannot say that a final capture below that
    amount closed the authorization.
  - *Capture ids.* `capturePayment` and `cancelPayment` resolve a capture id, the id
    completion and every capture return, through the capture's
    `supplementary_data.related_ids.order_id`, as `retrievePayment` already did.
  - *Refund counting.* `amountRefunded` counts COMPLETED and PENDING refunds and leaves out
    FAILED ("The refund could not be processed") and CANCELLED ("The refund was
    cancelled"). Counting PENDING is deliberate: that money is on its way back, and
    counting it keeps `getRefundState` from offering it for refund again.
  - *Repeated completions.* `ORDER_ALREADY_CAPTURED` ("Order already captured. If
    'intent=CAPTURE' only one capture per order is allowed.") and `ORDER_ALREADY_AUTHORIZED`
    are answered by re-reading the order. The troubleshooting page prescribes that read for
    the first ("No further action is needed. Make a `GET` call on the order ID to get the
    capture ID"); for the second it says to "call capture as the funds have been
    authorized", so the adapter reads the order the same way to return the authorization
    that `capturePayment` captures. A PayPal session carries only the order id, so the
    order read back must be that order, COMPLETED, with the capture or authorization its
    intent creates; otherwise the rejection stands. A re-read that fails surfaces its own
    error, so an outage stays a retryable `psp_unavailable`.
  - *Refund reason withheld.* `note_to_payer` is "The reason for the refund. Appears in both
    the payer's transaction history and the emails that the payer receives". A
    `RefundRequest` carries a reason code and no text of the host's, so nothing is sent
    rather than a code, or a fixed English phrase the host did not write.
  - *Venmo.* An order with `payment_source.venmo` reports `wallet: "venmo"`. A bare capture,
    read once its order aged out, leaves `paymentMethodDetails` out: the capture object has
    no `payment_source`, so nothing says which wallet paid.
  - **Sandbox checks outstanding (AMBIGUOUS in the docs, 2026-09-24):** whether PayPal counts
    a PENDING capture against the authorization and frees the amount of a DECLINED one, as
    the adapter assumes; whether a DECLINED capture sent with `final_capture: true` leaves
    the authorization open, as the adapter also assumes; and whether an order created with
    `payment_source.paypal` and approved with Venmo reads back with `payment_source.venmo`.
- **Negative-testing setup (AMBIGUOUS in the docs, 2026-09-24):** PayPal's request-headers
  page says "REST API apps use a request header to invoke negative testing in the
  sandbox. This header configures the sandbox into a negative testing state for
  transactions that include the merchant." Its negative-testing overview lists negative
  testing as available for "Classic PayPal API versions 2.4 and later", has the business
  sandbox account's Negative Testing setting turned on before any test method, and adds
  "Without this configuration, the sandbox does not raise error conditions unless the
  error occurs through normal transaction processing." The guide and the integration
  suite ask for both. An opt-in `PAYPAL_NEGATIVE_TESTING` run with the setting off would
  settle which page holds; it runs locally only, since the integration workflow never
  passes that variable.

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
  secrets; deferred by user request. *Closed 2026-09-24:* Paysafe's signature header
  name is doc-verified as `Signature` (Payments API "Configure Webhooks" page, "Example
  Header: Signature: …"); the adapter reads it first and still tolerates `x-signature` /
  `x-paysafe-signature`. See "Paysafe webhook correlation and event ids (2026-09-24)".
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
- **Corrected 2026-09-25: Paysafe applies no `colorBackground`, and a rejected property
  drops alone.** Paysafe's setup page lists the supported CSS style names (color, opacity,
  letter-spacing, text-align, text-indent, text-decoration, text-shadow, font, font-style,
  font-weight, font-size, line-height, font-family, transition, -ms-filter), and the served
  hosted-field iframe's `sanitize` deletes every property outside its allowlist (the same list
  plus `-webkit-text-fill-color` and `box-shadow`), logging "Invalid css property: " for
  each. The `background-color` the adapter sent for `colorBackground` was therefore always
  deleted, so the token is now recognized and not applied, like `colorPrimary`. The
  sanitizer drops only the offending properties of a flat selector object, not all styling,
  as this entry first said; a Stripe key whose value is a string (`theme`, `labels`) fails
  setup with 9021 and a nested one (`rules`) with 9022, per the setup page's error table.
  `MountOptions.locale` is no longer forwarded: the setup options table (`currencyCode`,
  `environment`, `fields`, `style`, `initializationTimeout`, `threshold`, `accounts`) has no
  `locale`, and the served SDK reads one only for wallet buttons and
  `customerDetails.profile.locale`.

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
  Since 2026-09-25 one that outlives the retries carries `outcomeUnknown` (see "Renewal
  re-key paths").
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
  no channel carries the per-session `sri` to the client adapter. Updated 2026-09-23: core's
  `injectScript` can now set both attributes (`{ integrity, crossOrigin }`). With a hash it
  defaults `crossorigin` to `anonymous`, since the browser checks a cross-origin file only in
  CORS mode; it reuses a `<script>` already on the page for the URL only if every such tag
  carries the same `integrity` and a `crossorigin` attribute (the value is not compared), and
  otherwise rejects with a non-retryable `invalid_request` without injecting, as it does for
  an `integrity` holding no well-formed `sha256-`, `sha384-` or `sha512-` token. The
  algorithm name must be lowercase: the SRI draft lowercases it, but Chromium and Firefox
  match it case-sensitively and skip a token they do not recognise (verified 2026-09-23 in
  headless Chromium 151, where `SHA384-…` with a wrong digest loaded and ran), and a file
  whose every token is skipped runs unchecked. That is a conflict check, not a trust
  boundary: client adapters return before injecting once the SDK global exists.
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
  Refined 2026-09-25: such a payment now maps from its own `statusOutput.errors` rather than
  always to `card_declined`, see "Worldline decline codes (2026-09-25)"; the sandbox shape is
  still unconfirmed.
- **Decline sub-codes.** Only five reject codes are enumerated on the troubleshooting page
  (30511001 insufficient funds, 30591001 fraud, 40001134 3-D Secure, 30171001 customer
  cancelled, 30041001 issuer rejected); everything else on a 402 maps to the generic
  `card_declined`. Enumerate expired-card / invalid-card-data codes from the sandbox.
  Superseded 2026-09-25 by "Worldline decline codes (2026-09-25)": the troubleshooting page
  and the Sips response-code mapping now document those codes and many more.
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
  *(Corrected 2026-09-24: that dedupe was never documented. Paysafe documents duplicate
  rejection (409/5031 under `dupCheck`), and `/paymenthandles` accepts `dupCheck` with an
  undocumented default; the adapter sends none there. The shared key stays, as in Paysafe's
  own EFT examples, where the handle and the payment share one `merchantRefNum`. The key's
  payments and handles are now read before a handle is minted, and the payment is
  recovered by lookup, see "Paysafe replay safety (2026-09-24)".)*
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
  total_cycles ran out), rest 1:1; no trial/past-due status exists. The GitHub OpenAPI
  spec lacks the list operation; the live schema
  (developer.paypal.com/api/subscriptions/v1/schema.json) documents it with `plan_ids`,
  `statuses`, date-range filters, `filter`, `page_size` (1–20) and `page`, and a collection
  of `subscriptions` and `links` (corrected 2026-09-24: this entry said the published spec
  lacked the operation and that no `statuses` filter was documented). The adapter applies
  no filter; the reference describes the call as listing all subscriptions for the
  merchant account and gives `statuses` (ACTIVE, SUSPENDED, CANCELLED, EXPIRED) no default,
  which no sandbox run has checked. It sends `total_required`, which the reference
  documents for the plans list only, because totals end the walk exactly when PayPal
  returns them; the next link or a full page decide otherwise.
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
  sends `transient-error: true`. Since 2026-09-25 both, and a transient 4xx, carry
  `outcomeUnknown` (see "Renewal re-key paths").
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
    is acknowledged only within one environment. Since 2026-09-25 the refusal of an echo
    naming another amount carries `outcomeUnknown` and advises a new key only once the
    earlier one is known to be another: that request is only received (see "Renewal re-key
    paths").
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
  Unavailable) → `processing_error` (42 questioned 2026-09-25: see "Worldline decline codes
  (2026-09-25)" and #217). None is retryable:
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
- **The onboarding CSP lists `"*"` for `frame` and `connect`.** Doc-verified 2026-09-23:
  Adyen's recommended policy (PCI script-security guide) allows `*.adyen.com` scripts and
  sets `frame-src`, `connect-src`, `img-src` and `form-action` to a bare `*`; for frames the
  reason given is that it is "not possible to list all issuer domains loading iframes for
  3DS authentication", and the native 3-D Secure 2 guide says a strict policy can keep
  challenges from loading. The descriptor follows that policy: `script` keeps
  `https://*.adyen.com`, and `frame` and `connect` are `["*"]`. CSP3's grammar allows a bare
  `*` as a host source (`host-part = "*" / …`), so the `string[]` fields hold it and core's
  validator accepts it; core's `csp` JSDoc now reserves empty arrays for "no host needed"
  (no embedded surface, as with GoCardless), hosts and subdomain wildcards such as PayPal's
  `https://*.paypal.com` are listed as they are, and a PSP whose documentation allows any
  host lists a bare `"*"`. The earlier `https://*.adyen.com` in `frame`/`connect` let the card fields load but
  blocked live issuer challenges. The setup guide lists every directive, including the
  `style-src`, `img-src` and `form-action` the type cannot express (its `style-src` names the
  Adyen host for the Adyen Web stylesheet; Adyen's sample lists only Cash App there).
- **Client**: Adyen Web v6 from `checkoutshopper-{value}.cdn.adyen.com/checkoutshopper/
  sdk/{version}/`, `{value}` being the Adyen environment value (the Drop-in guide's shorter
  path 404s; corrected 2026-09-24: this entry said `checkoutshopper-{test|live}`, the two
  hosts the adapter loaded from until then, which sent every live account to the European
  host), `window.AdyenWeb` with an async `AdyenCheckout()` and component classes
  (`new Card(checkout, options)`). The pinned build was 6.41.0, released 2026-07-16 per
  Adyen's Web release notes and its GitHub release, and requiring Checkout API v69 or later,
  which the pinned v72 satisfies (corrected 2026-09-24: this entry said 2026-07-15 and
  "current at the time of writing", but 6.41.1 had followed on 2026-07-30, three days before
  the entry's date); pinning the 6.0.0 that opened the major would ship a checkout a year of
  fixes behind. The adapter owns `showPayButton: false` and `onChange`, forwards everything
  else. 3-D Secure resolves through an adapter-specific `handleAction(handle, action)` —
  inline when Adyen runs it natively, by a redirect to Adyen otherwise — whose inline result
  is a second clientToken (Adyen Web's `onAdditionalDetails` data,
  `{ details: { threeDSResult } }`) that `completePayment` sends to `/payments/details` —
  the unified contract has no action step because most PSPs resolve challenges inside
  `confirm()`. One challenge at a time per handle: a re-entrant `handleAction` is refused
  with `invalid_request` instead of replacing the pending resolver, which would leave the
  first caller's promise unsettled forever.
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
    US, stateOrProvince at most 3 and required for the US and Canada, the others at most
    3000); Adyen Web fills the fields a country does not use with "N/A", though its partial
    address mode can still produce an address the adapter drops; keeps
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
    (an `idempotencyKey` reused across sessions replays the first answer). Since 2026-09-25
    that refusal carries `outcomeUnknown` unless the answer is `Refused`, `Error` or
    `Cancelled` (see "Renewal re-key paths").
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
      example has one). (5) Whether `/payments` accepts, and 3-D Secure 2 passes with, a
      `billingAddress` whose street, house number or city holds characters Adyen Web 6.41.0
      stripped and 6.45.2 lets through (`?+_=!@#$%^&*(){}~<>[]\`, see the 2026-09-24 entry
      below); the server adapter forwards them as they are. (6) `live-apse`: whether an APSE
      live account takes that `environment` value and the `checkoutshopper-live-apse` hosts,
      which Adyen Web maps but Adyen's v6 guides do not list; the test platform cannot show
      it, so it takes Adyen's confirmation or an APSE live account.
  - **Adyen Web 6.45.2, Subresource Integrity and regional hosts (2026-09-24)**,
    doc-verified against Adyen's Web release notes from 6.41.1 to 6.45.2 and the matching
    GitHub releases, the 5.13.0 and 5.72.0 release notes, the web best practices, live
    endpoints and client-side authentication pages, the Advanced and Sessions flow guides,
    and the 6.41.0 and 6.45.2 source of `github.com/Adyen/adyen-web` with its PR #3769;
    still no sandbox pass. The pinned build moved to 6.45.2 (released 2026-09-21, requiring
    Checkout API v69 or later); 6.45.1 is marked "Do not use this version. A breaking bug
    prevents handling payment actions", and 6.45.2 reverts its BaseElement and UIElement
    changes. Between the two tags nothing the adapter uses changed shape: the
    `window.AdyenWeb` entry, the async `AdyenCheckout`, the Card's options and its
    `hasHolderName`/`holderNameRequired` coupling, its `state.data` (browser info, origin,
    billing address, `riskData`, `sdkData`, `checkoutAttemptId`), `onChange`,
    `handleAction`, `onAdditionalDetails`, `onEnterKeyPressed` (a handler still replaces
    `submit()`), `showValidation`, `unmount`/`remove` and the error types. Around them,
    6.41.1 no longer submits on Enter inside a select or the dual-brand selector, 6.42.0
    gives the 3-D Secure 2 challenge iframe `allow="payment *; publickey-credentials-get *"`
    for passkeys, and 6.45.0 adds a Sessions-flow review step (`onReview`, `processPayment`,
    `onAction`, none of which the adapter sets) and moves the special-character check on the
    street, house number and city fields from the formatter to validation. 6.41.0 stripped
    `?+_=!@#$%^&*(){}~<>[]\` from those fields as the shopper typed (`SPECIAL_CHARS` in
    `utils/validator-utils.ts`); 6.45.2 keeps them and refuses, on blur, only emoji,
    regional-indicator, control and format characters (PR #3769, which the 6.45.0 GitHub
    release links; the release note says "The address fields now reject unsupported special
    characters"). Those characters now reach `billingAddress`, and the server adapter
    forwards them as they are (sandbox check (5) above). The release note publishes sha384
    hashes for `adyen.js` and `adyen.css` and asks for the same hashes on test and regional
    URLs: verified 2026-09-24 by hashing the files served from `checkoutshopper-{test, live,
    live-us, live-au, live-nea, live-in, live-apse}.cdn.adyen.com`, byte-identical and equal
    to the published values, each host answering `Access-Control-Allow-Origin: *` without a
    redirect. A file carries its hash, with `crossorigin="anonymous"` (set on the stylesheet
    `<link>` before `href` and insertion), only from its default URL for the pinned build:
    any `sdkVersion`, even one naming the pinned build, drops both hashes, and `sdkUrl` and
    `stylesheetUrl` the one for their file. Both hashes are exported, as
    `ADYEN_WEB_SCRIPT_INTEGRITY` and `ADYEN_WEB_STYLESHEET_INTEGRITY`, for a host that adds
    its own tag for the default URL. The host is now `checkoutshopper-{value}.cdn.adyen.com`
    for the Adyen environment value, where every live account loaded from the European host
    before. The best practices page, both flow guides and every v6 release note document
    `test`, `live`, `live-us`, `live-au`, `live-nea` and `live-in`. `live-apse` is AMBIGUOUS
    in the docs, and accepted: Adyen Web 6.45.2 types it (`environment?: 'test' | 'live' |
    'live-us' | 'live-au' | 'live-apse' | 'live-in' | 'live-nea'` in `core/types.ts`) and
    maps it to its own API, CDN and analytics hosts (`core/Environment/constants.ts`), its
    CDN host serves the pinned files as above, and Adyen's release notes list it from 5.13.0
    ("use the `environment` **live-apse**") to the 5.72.0 host table, while no v6 guide
    table or v6 release note does (sandbox check (6) above). Adyen Web falls back to the
    European hosts for a value it does not know, so the constructor refuses any other value
    and one that contradicts `environment`. It lowercases the value first, as Adyen Web does
    before reading it (`core/core.ts`, `setOptions`: "Make environment lowercase to ensure
    consistency"), so `LIVE-US` loads from `checkoutshopper-live-us` and Adyen Web gets
    `live-us`. It also refuses a client key that does not start with `test_` on sandbox or
    `live_` on live (a legacy origin key included): the client-side authentication page
    gives every client key that prefix ("The client key for your live environment will start
    with live_") and makes the client key the only way to authenticate from Web 4.0.0, while
    Adyen Web reports a contradicting prefix only once `AdyenCheckout()` runs and still
    takes an origin key (`pub.`) with a console notice. If the script fails to load, the
    next mount fetches it again, with the stylesheet if that failed too (a `<link>` the
    adapter injected is removed when its load fails); if it loaded without defining
    `window.AdyenWeb`, the next mount checks again instead of failing from a cached result,
    and only a host `loadScript` fetches anew then, since the tag already on the page is
    reused. Adyen Web errors are read by `name` first (the 6.45.2 source defines
    `NETWORK_ERROR`, `CANCEL`, `IMPLEMENTATION_ERROR`, `API_ERROR`, `ERROR`, `SCRIPT_ERROR`
    and `SDK_ERROR`; the Sessions flow guide documents four of them): `NETWORK_ERROR` and
    `SCRIPT_ERROR` are a retryable `psp_unavailable`, `IMPLEMENTATION_ERROR` is
    `invalid_request`, or `authentication_required` while a challenge is pending as the
    setup guide states, and the others keep the message reading, since the generic `ERROR`
    also reports "secured field iframes have failed to load".

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
  Stripe.js and maps none of these codes (nor `incorrect_zip`) except `authentication_failure`
  (decided 2026-09-25, below); aligning the rest is a follow-up (#213).
- **The checks live in the `StripeCardError` branch only.** Neither page states which error
  `type` the new codes arrive with, so the conservative reading extends the branch that
  already handles `expired_card` and `incorrect_zip`; under any other type they fall through
  to that type's existing mapping. A sandbox run pinned to this version with the expired-card
  and lost-card test cards, recording `type`, `code`, `decline_code` and `message`, would
  show which codes those cards return on this version and, where a new code appears, its
  `type` and `decline_code`. The integration suite pins an older version, so this needs a new
  case, not a re-run. Seeing `authentication_failure` needs a failed 3-D Secure challenge
  instead, a browser step on Stripe's mock authentication page; its mapping was decided on
  2026-09-25 (below) without one.
- **`authentication_failure` maps to `authentication_required` (decided 2026-09-25; until
  then it fell through to `card_declined`).** Its docs.stripe.com/error-codes entry reads "The
  payment was declined because the payment method failed to pass authentication." and states no
  remedy; the changelog
  presents it as the general form of `payment_intent_authentication_failure` and
  `setup_intent_authentication_failure`, whose documented remedy is a new payment method.
  The Stripe browser adapter maps those two codes to `authentication_required`, as Worldline
  does `40001134` ("a failed 3-D Secure check") and Adyen `11` and `42`. Both candidates are
  non-retryable, so retries and the router cascade are unaffected; the choice decides which
  code and message the host shows. Stripe's 3-D Secure guide
  (docs.stripe.com/payments/3d-secure/authentication-flow) gives both remedies after a failed
  authentication: try a different payment method, or retry 3-D Secure by reconfirming. Which
  way the Stripe server half should go was left open. Decided for consistency: the browser
  adapter's intent-specific codes and every other adapter's failed 3-D Secure already surface as
  `authentication_required`, and retrying 3-D Secure is one of the two remedies Stripe's guide
  gives. Both halves now map `authentication_failure` that way, and the server half also maps
  the two intent-specific codes, which hosts pinned before dahlia still receive. On the server
  a fraud decline code on the same error still takes precedence. The browser half maps no
  fraud decline codes at all (`fraudulent`, `stolen_card`, `lost_card`,
  `merchant_blacklist`); that gap and the dahlia codes above are tracked in #213. Left
  unmapped, an account moving to dahlia could see a failed browser 3-D Secure change quietly
  from `authentication_required` to `card_declined` or `unknown`, if Stripe.js reports the
  general code there. Would be wrong if Stripe used the code for failures where no new
  authentication can succeed, where `card_declined`'s "use another card" is the only remedy.
  (Clarified 2026-09-25: this holds for a failed cardholder authentication. A 3-D Secure that
  fails outside the customer's control is `processing_error` on Worldline, and Adyen's refusal
  42 is such a failure, which still maps to `authentication_required` until #217; see
  "Worldline decline codes (2026-09-25)".)
- **`payment_method_restricted` stays `card_declined`.** Stripe's example is a card reported
  lost or stolen; the existing `restricted_card` decline code ("it's possible it was reported
  lost or stolen") already falls through to `card_declined`, and a `lost_card` or
  `stolen_card` decline code on the same error still yields `fraud_suspected`, whose message
  is generic as docs.stripe.com/declines/codes asks. Whether Stripe sends a decline code
  alongside this code is undocumented.

## Paysafe webhook correlation and event ids (2026-09-24)

- **A Paysafe delivery carries no event id, and a retry is the same notification with the
  next `attemptNumber`.** Doc-verified 2026-09-24: the SEPA and Bacs Direct Debit pages, the
  EPS, Openbucks and SafetyPay webhook pages and the Java SDK's `WebhookEvent` model
  (`payload`, `attemptNumber`, `type`, `resourceId`, `eventDate`, `eventName`) show no
  top-level event id; the EPS-style envelopes carry `links[].rel` instead of `type`. The
  Payments API reference ("Some Notes on Webhooks") says Paysafe "makes a maximum of 2
  additional attempts (total 3 attempts)" without a 200 or 202, and "In case you have
  received the same notification multiple times for an already processed event, we request
  you to ignore the duplicate notification." The old fallback id, a hash of the raw body,
  changed with every attempt, so host dedupe by `event.id` let the retries through.
- **The event id is `paysafe_` + the SHA-256 hex of `[name, resourceId, status, time]`.**
  The name is the normalized event name, the resource id `payload.id` (else `resourceId`),
  the status `payload.status`, and the time `payload.statusTime`, else `payload.txnTime`,
  else the envelope `eventDate`. `statusTime` comes first because the payment schema defines
  it as "the date and time the resource status was last updated", while the SEPA page's
  settlement examples give `eventDate` the payment's `txnTime` and a later `statusTime`; the
  official PHP SDK's webhook test fixture
  (`tests/Webhook/resources/json/valid_webhook_payload.json`) has an `eventDate` later than
  its `txnTime`, so what `eventDate` measures is unsettled and it is used only when the
  payload has no time. The price is merging: Paysafe's card and refund webhook examples
  carry no `statusTime`, so one resource reporting the same event twice at one status
  would share an id. The Paysafe guide therefore tells hosts to re-read with `retrievePayment` /
  `retrieveRefund` whether or not the id was seen. A top-level `id` is not read: the example
  payload on the Configure Webhooks page is the bare resource with its own id there, and
  keying on it would merge every event of that resource. A body naming no resource hashes
  its key-sorted JSON without `attemptNumber`. The derivation changed every Paysafe event
  id, so a host deduping across the upgrade may process one duplicate per in-flight event;
  the changeset says so.
- **`pspPaymentId` names a payment only.** A bank return reports `payload.paymentId`: on the
  SEPA and Bacs `PAYMENT_RETURN_COMPLETED` examples (`type: "PAYMENT_RETURN"`) `payload.id`
  is the return's own id, and `paymentId` / `settlementId` carry the payment's. Refund
  events report `refundId` and no `pspPaymentId`: the spec's `refunds` schema has no payment
  field and the EPS refund examples name none, so hosts match `refundId` to the one
  `refundPayment` returned. Handle, settlement and every other resource leave it unset; the
  2026-07-15 rule stands (`SETTLEMENT_*` and `PAYMENT_HANDLE_PAYABLE` delivered `unknown`,
  correlated by payload `merchantRefNum`). Nuance: a settle-with-auth payment's settlement
  can share the payment's id (the SEPA and Bacs examples' `settlementId` and `SETTLEMENT_*`
  payload ids do, as does the embedded settlement of the card delivery captured in #77),
  but a settlement made later through `POST /payments/{paymentId}/settlements` is its own
  resource with its own `id`, so a settlement id is never reported as a payment id even
  where the two coincide. Dispute names (`CHARGEBACK_*`, `DISPUTE_*`) appear on no
  Payments API page and keep reporting `payload.id`, unchanged.
- **Event names.** `REFUND_CANCELLED` ("The refund request is cancelled.", the Webhook
  Events page the Configure Webhooks page links as its event list) and `REFUND_ERRORED`
  (EPS webhooks page) now map to `payment.refund_failed`, as `mapRefundStatus` already reads
  `CANCELLED` and `ERROR`; `PAYMENT_ERRORED` (Interac e-Transfer page, "The payment has an
  error (non http status 402 error).") maps to `payment.failed`, as the `ERROR` payment
  status does. `PAYMENT_PENDING` stays mapped and advertised: the Pay by Bank (US), PayPal
  and Rapid Transfer webhook pages document it. `PAYMENT_DECLINED`, `PAYMENT_EXPIRED`,
  `PAYMENT_AUTHENTICATION_REQUIRED`, `REFUND_DECLINED` and `REFUND_ERROR` appear on no page:
  still parsed, no longer in the onboarding descriptor, whose list now derives from the
  parser's documented names. `REFUND_RECEIVED` / `_PENDING` / `_PROCESSING` stay `unknown`
  (no in-flight refund type in the unified vocabulary) but carry `refundId`.
- **The `variables` envelope is read defensively (AMBIGUOUS).** The Bacs page nests
  `payload`, `attemptNumber`, `type` and `eventDate` under `variables`; every other page,
  the Java SDK model and the delivery captured in #77 keep them at the top level. The parser
  reads either and gives both forms the same id. A real Bacs delivery would settle which
  one Paysafe sends; it needs a GBP-provisioned account and `PAYSAFE_WEBHOOK_HMAC_KEY`,
  neither of which this project has yet.
- **Delivery limits, corrected in the docs.** Same reference section: receipt is
  acknowledged by "200 OK or 202 ACCEPTED", Paysafe "does not have a notification method to
  alert you when callbacks are not reaching your endpoint URL", and "only the default HTTPS
  port 443 is supported". The Configure Webhooks page words the retry as "retry the webhook
  up to three times" after a 4XX or 5XX; the docs use the reference's count of three
  attempts in all. "Retries effectively forever" is gone from the guide, the webhooks page,
  the server README, the root README, `@payfanout/server`'s `WebhookRequest` comment and
  `webhook.ts`. The server handler answers 200, which Paysafe accepts.
- **Bank returns cannot be recovered by a read (AMBIGUOUS whether any read reflects them).**
  The spec defines no return resource, and its Direct Debit Return Codes section says
  "Because Direct Debit requests can take up to 7 days to clear, you cannot be notified of
  errors such as these via the API response", pointing to Merchant Back Office reports. The
  adapter's `retrievePayment` has no return state, so a returned debit keeps reading
  `succeeded` unless Paysafe moves the payment out of COMPLETED, which no page documents.
  The guides therefore tell hosts to act on the return webhook, reconcile bank debits
  against the Back Office return reports, and never let a read override a return. Sandbox
  check: on an EUR (SEPA) or GBP (Bacs) account with `PAYSAFE_WEBHOOK_HMAC_KEY`, trigger a
  return (no documented trigger; ask Paysafe support) and read the payment afterwards.
- **Signature, doc-verified.** Configure Webhooks: digest = HMAC_SHA256(hmacKey, UTF-8
  JSON body), signature = base64(digest), example header `Signature`; the official PHP
  SDK's `SignatureVerifier` computes the same and compares with `hash_equals`. The exported
  `verifyPaysafeWebhookSignature` now lowercases header names itself instead of relying on
  the adapter, reads `signature` first and still tolerates `x-signature` /
  `x-paysafe-signature`; raw-body hashing, constant-time comparison and key rotation are
  unchanged.

## Paysafe replay safety (2026-09-24)

- **Paysafe rejects a repeated `merchantRefNum`; it does not replay the original.**
  Doc-verified 2026-09-24 against the Payments API OpenAPI spec
  (developer.paysafe.com/fileadmin/openapi-spec/payments-api/apis/paysafe-ph-payments-api.yaml).
  On `POST /v1/payments`, `merchantRefNum` "must be unique for each request if dupCheck
  parameter is sent as "true"", and `dupCheck` "validates that this request is not a
  duplicate. A duplicate request is when the merchantRefNum has already been used in a
  previous request within the past 90 days." No default is documented there; settlements,
  refunds and verifications state "This value defaults to true". The card-errors page gives
  the answer as "409 | 5031 | The transaction you have submitted has already been
  processed.", and the spec's payment errors add "402 | 3044 | You have submitted a
  duplicate request." The about-card-payments page adds "Regardless of the payments call
  response status, the payment handle status always changes to COMPLETED when a payments
  call is made", so the first payments call spends a single-use handle and a second one
  answers 5283 ("The requested operation can only be executed on a Payment Handle with the
  status of PAYABLE."). The tokenize page says single-use handles "are not consumed by
  verification". The adapter had assumed Paysafe dedupes on `merchantRefNum`, and its
  transport re-sent every POST after a timeout, 5xx or 429. Nothing documents that. Under
  the documented behaviour a lost answer became an `invalid_request` for a payment that
  existed, and a re-sent saved-card charge (a MULTI_USE token is never spent) could charge
  twice.
- **Card and Interac completions send `dupCheck: false`; the spent handle guards their
  replay.**
  Doc-verified 2026-09-25: the spec's "Card - with Settlement" request example and the
  Paysafe.js "Transaction with Payment Handle" payment example both send `"dupCheck": false`
  with a single-use token, and the Interac guide's payment request omits the field while its
  response echoes `"dupCheck": true`, so false is sent explicitly. With `dupCheck: true` and
  a stable per-order completion key (the server guide's `complete-${order.id}`), a declined
  card left its record under the key and every later card for that order was refused as a
  duplicate. Card and Interac completions therefore send false, and a replay of the same
  handle is answered 5283 and read back. Bank debits, whose attempts can each mint a
  handle, follow the next entry. Saved-method charges (a MULTI_USE token is
  never spent), settlements, refunds and verifications keep `dupCheck: true`. Payment and
  verification records carry `paymentHandleToken` (the `payment` and `verification`
  schemas, and both lookup examples), so recovery matches on it: a record made with the
  call's token is its original, a record made with another one under the same key is an
  earlier attempt. A completion reads its key before sending anything. Its own record
  answers a replay (a decline stays that decline), and a failed attempt with another token
  leaves the key open. A live payment made with another token is returned as the key's
  payment. That last rule goes beyond "a new token is a new attempt", deliberately: the
  client adapter tokenizes on every Pay click, so a customer whose completion answer was
  lost and who pays again arrives with a new token under the same key, and processing it
  would charge the order twice. What remains open for cards is concurrency: two completions
  with different cards sent under one key before either record is visible in the lookup can
  both be charged, since no duplicate check spans them.
- **Bank-debit completions send `dupCheck: true` until a failed attempt shows under the
  key** (2026-09-25). A bank-debit attempt mints its own handle unless the lookup shows an
  uncharged one minted from the same details, so the spent-handle refusal did not span two
  attempts: two identical completions sent together, or one resubmitted while both lookups
  trailed the first, each minted a handle and debited it. Doc-verified 2026-09-25 against
  the spec: the ACH, EFT, SEPA and BACS payment request examples all send
  `"dupCheck": true`. The EFT pair mints the handle and charges it under one
  `merchantRefNum` ("4533863971"); the handle request carries no `dupCheck` (it sends
  `"dupcheck": true`, a spelling the schema does not define), and the payment, sent with
  `dupCheck: true`, answers `COMPLETED`, so a handle minted under the key does not trip the
  payment's check. Two more pairs in the spec show the same (doc-verified 2026-09-25):
  Paysafecash, `merchantRefNum` "a9318b525273ee3cda79a2f947a9", handle `PH4lXuM1iYSK64xG`
  minted `INITIATED` without `dupCheck`, then paid with `dupCheck: true` and answered
  `COMPLETED`; and Mazooma, `merchantRefNum` "285a1d9f-ab6b-4851-870b-b725148a5162", handle
  `PH0gRuaOS9Yr7PNQ`, the same sequence, also `COMPLETED`.
  The payment therefore carries `dupCheck: true` while the key's read shows no failed
  payment, whatever handles it shows: no handle stops another attempt from debiting.
  Paysafe then refuses a later payment under the key (5031, or 3044/3417), which says that
  request was not processed, so the read-back takes the key's live payment as the answer
  whichever handle made it, and ends in the non-retryable `processing_error` while none
  shows. After an unknown
  outcome only the call's own record settles it: another handle's payment does not say
  whether this one went through too. The check would refuse corrected bank details for 90
  days, so it stops at the first failed payment the key shows. Two things remain. Once a
  failed attempt shows, the check is off: two attempts sent together, or one resubmitted
  before the lookup shows the other's payment or handle, can both be debited (a test pins
  the two debits of two corrected attempts sent together). And whether the check catches a
  payment Paysafe is still processing is the first open item below. The handle mint still
  sends no `dupCheck`: among the handle instruments only `eftObject` defines it (a boolean
  with no description and no default), `achObject`, `sepaObject` and `bacsObject` do not,
  the ACH handle example sends `false`, and a handle moves no money, so a handle-level
  refusal would only add a path that reads back a handle rather than the payment that
  answers the call. A handle's mandate reference now stands in only for a payment whose
  record names that handle's token; a record that names no handle takes no mandate.
- **Writes are never re-sent blindly, and payments, settlements and refunds are not re-sent
  after an unknown outcome.** Paysafe's Java and PHP SDK pages say "The client can be
  configured to automatically retry GET requests that have failed due to network problems
  or other unpredictable events", with "60 seconds for response timeout", and warn that
  "some requests may take longer to process". The PHP SDK's retry middleware refuses every
  method except GET. After a timeout, network failure or 5xx the record is looked up with
  the documented
  `GET /v1/{payments,paymenthandles,settlements,refunds,verifications,voidauths}?merchantRefNum=`
  and returned when exactly one record is this call's (amount, currency, payment type and
  handle token, wherever both sides state them). When three reads show none, a payment,
  settlement or refund ends with a non-retryable `processing_error`: its outcome is unknown,
  and the host retries later with the same key, never a new one. Only Paysafe's duplicate
  check could stop a second one, and Paysafe does not document that check for a request
  still in flight. Payment handles, verifications and voids move no money, so they are still
  re-sent once one lookup shows nothing, bounded by `maxNetworkRetries`. A 429 (1200) is
  re-sent after backoff without a lookup, as the request was refused unprocessed. Once an
  attempt's outcome is unknown, no later answer settles the call on its own: a rejection of
  a re-send, or a 429 when the budget runs out, is followed by the same three reads and ends
  in the same `processing_error`. Reads keep their transport retries. The default
  `requestTimeoutMs` moved from 30000 to 60000.
- **Duplicate and in-progress rejections are answered with the original.** 5031, 3044,
  3417 ("There is already another request being processed on the transaction referenced
  for this request.", 402, among the refund errors), and a 5283 on a payments call that
  spends a single-use handle are recovered by reading the original back, because the lookup
  can trail the write. When it cannot be read, the call ends with a non-retryable
  `processing_error` naming the `merchantRefNum`, never `invalid_request`: a 5283 whose
  handle made no record under the key means either that the lookup trails or that another
  call spent the handle, and nothing tells the two apart. A declined original, which
  Paysafe records with its error (see the simulating-card-payments decline example, which
  carries an `id`), surfaces as the same decline. A recorded failure maps from its own code,
  and from its status where the code does not decide: the verification statuses define
  `ERROR` as a failure "for non-business reason" and `FAILED` as the gateway's 402, so
  `ERROR` and Paysafe's internal and gateway codes give `processing_error`, and anything
  else a decline. Recorded settlement, refund and verification failures are rethrown the
  same way as payments. Chosen outcomes: a record under the same reference that disagrees
  means the key was reused and gives `invalid_request` (marked `outcomeUnknown` on a
  payment, settlement or refund while that record may have moved money, since 2026-09-25;
  see "Renewal re-key paths"); several agreeing records give a
  non-retryable `processing_error`. Non-retryable is the conservative choice, because
  `withRetry` acts on `retryable` and must not act while it is unknown whether money moved.
  `PaymentRouter` fails over on any `processing_error` whatever `retryable` says. That is
  harmless here, because the router cascades session creation only, and the one Paysafe
  session that calls Paysafe mints an Interac handle, which moves no money. The lookups
  default to the last 30 days ("Default = 30 days before the endDate") against dupCheck's
  90, so an original older than 30 days can never be read back, and the error message says
  so. `startDate` is not widened because its maximum range is undocumented (re-verified
  2026-09-25 on the `payments` and `paymenthandles` lookups: a date with that default and
  no stated limit); the sandbox check is an open item below. For a bank debit the gap has a
  second effect (2026-09-25): a failed attempt 31 to 90 days old is out of the lookup's
  sight but still trips `dupCheck`, so every attempt under the key is refused, and retrying
  under it cannot get past that. The refusal's error therefore does not say "never a new
  one": it states the 90- and 30-day windows, that what refuses the key may be a payment
  the lookup does not show yet or a failed attempt older than the lookup, and that only
  once a later retry still ends in the error and the Paysafe portal shows every payment
  under it as failed or cancelled, or none at all, does the host start again under a new
  idempotency key; a payment received, pending, processing, held or completed is live
  (corrected 2026-09-25: "no successful payment" also matched a debit still processing,
  and an empty portal right after the refusal may only be lagging, hence the later
  retry). The guide adds that the replaced key is retired for good, because once the 90
  days lapse, a completion under it would start a new debit for the order. "Never a
  new one" stays where it holds, where the attempt may have been processed and the lookup
  can still show it: after an unknown outcome, and on the other rejections that stand for
  this call's own original.
- **How recovery reads.** An original is read back up to three times, 250 and 500 ms apart,
  each read a single attempt, which bounds a hung Paysafe to three more exchanges. The reads
  a call makes before it writes use the usual GET retries: a completion's key, a payment
  handle lookup, a capture or void whose pre-read shows nothing left, and a refund that
  finds no refundable settlement.
- **Endpoints without a usable duplicate rejection are made safe on this side.**
  `/paymenthandles` does accept `dupCheck`. The 2026-09-24 reading that its request carries
  none was wrong (doc-verified 2026-09-25): `paymentHandleRequest` composes
  `paymentHandleBaseRequest` with `paymentInstrument`, whose `eftObject` defines
  `dupCheck`, and the handle examples send it, false for ACH, Google Pay, Apple Pay and
  Venmo and true for the Safetypay rails. The adapter still sends none. Its default there is
  undocumented, and an attempt that follows a failed, expired or spent handle needs a new
  handle under the same key, which a duplicate check could refuse. Handles are looked up
  before one is minted and reused when found; an Interac session with several reuses the
  most advanced (COMPLETED, then PAYABLE, PROCESSING, INITIATED) among those minted for its
  customer's email. The Interac guide's handle response echoes `interacEtransfer.consumerId`
  (doc-verified 2026-09-25), and a handle minted for another email would collect from
  another alias, so, like a bank handle minted from other details, it is left alone and a
  new one is minted; the addresses compare trimmed and case-insensitively, and an echo that
  states none cannot contradict. The handle lookup's item schema (`paymentHandleResponse`,
  composing the `x-internal` `paymentInstrumentResponse` and `interacObject`) spells the
  echo `interacETransfer`, while every example and the Interac guide write
  `interacEtransfer`, and the spec has no lookup example to settle it (doc-verified
  2026-09-25), so a replay reads both spellings, and either naming another alias rules the
  handle out. A bank-debit completion
  reads its key's payments first, and a live one answers the replay whichever handle it
  spent. It then reads the key's handles and reuses an uncharged one minted from the same
  bank details. A COMPLETED handle with no payment of its own in the lookup does not prove a
  payment exists (corrected 2026-09-25; this entry said it did). Either the lookup does not
  show that payment yet, or Paysafe refused an attempt (5031, 3044 or 3417) and the refused
  call spent its handle all the same, which is the plain reading of the card page's
  "Regardless of the payments call response status, the payment handle status always
  changes to COMPLETED when a payments call is made." The payments are read again, and the
  call ends with the non-retryable `processing_error` rather than debit again. Its message
  says that a refused attempt can leave a spent handle, and that once a later retry still
  ends in the error and the Paysafe portal shows every payment under the key as failed or
  cancelled, or none at all, the host may start again under a new key: on the plain
  reading, retrying under the key never gets past such a handle. Sharing one key
  across the handle and the payment follows Paysafe's own EFT examples: the handle and the
  payment both carry `merchantRefNum` "4533863971", the payment is sent with
  `dupCheck: true` and comes back `COMPLETED`, so the handle's use of the reference does not
  make the payment a duplicate. Voidauths take no `dupCheck` (their schema has none), so a
  void recovers by lookup alone: a cancel whose pre-read shows nothing left to void looks
  for its own void first. Captures and refunds do the same when the pre-read shows nothing
  left. All three also read the lookup after a rejection, in case Paysafe runs its state
  check before the reference check. Settlement, refund and void records name no payment and
  the lookups are account-wide, so capture, cancel and refund keys must be unique across
  the account. Customer creation, vault saves and deletes read back through the Customer
  Vault instead of re-sending: profiles by `merchantCustomerId`, and saves by the
  `merchantRefNum` that vault handles carry. The Scheduler create and cancel keep their
  lookup and re-fetch recovery and are no longer re-sent after a timeout or 5xx.
- **The timeout bounds one exchange, not a call.** A read makes up to
  1 + `maxNetworkRetries` attempts, and a write up to 1 + `maxNetworkRetries` attempts with up
  to three reads after the last one, so one write step stays within
  (1 + `maxNetworkRetries`) × 4 exchanges, plus 1 + `maxNetworkRetries` for each read the
  call makes first. If Paysafe hangs on every exchange, that is minutes at the defaults. The
  config docs and the setup guide say so, and tell hosts on platforms that end requests
  after 25-30 seconds to lower `requestTimeoutMs` and `maxNetworkRetries` and to replay a
  call the platform ended with the same key.
- **The test double models the documented behaviour.** It answers 409/5031 under `dupCheck`
  (or 402/3044), spends single-use handles (5283 on reuse), including on a 5031, 3044 or
  3417 refusal, the plain reading of the card page, with a switch for the other reading
  (2026-09-25), keeps a clock so that its lookups show the last 30 days while `dupCheck`
  counts 90 (2026-09-25), records declined payments and
  verifications with their handle tokens, answers the capture, refund and void state checks
  with the documented 402 codes (3203/3204, 3402/3404, 3501/3502) and an unknown settlement
  with 400/3407, serves the six lookups, accepts `dupCheck` on handles, echoes the Interac
  alias on its handles, and takes the
  dangerous reading wherever Paysafe documents nothing: a repeated reference without
  `dupCheck` is processed again. Against it the previous adapter failed the conformance
  "same key twice, same result" case, which it had only passed because the old fake echoed
  replays. The suite passes unchanged.
- **Open, to settle in the sandbox:**
  - **What a second same-key payment answers while the first is still processing.**
    Undocumented, and it decides whether a payment, settlement or refund could ever be
    re-sent after an unknown outcome. Charge a saved card for the simulator's amount 95
    ("Approved with 30-second delay"), send the same request with the same
    `merchantRefNum` and `dupCheck: true` during the delay, and record whether the second
    answers 5031, 3044 or 3417 or is processed as a second payment, and how many payments
    the lookup then shows. The integration suite carries this probe. Until it is settled,
    those writes are not re-sent.
  - **A second payment under one reference with `dupCheck: false`.** The spec implies it is
    allowed ("unique for each request if dupCheck parameter is sent as "true""). Decline a
    card under one key, pay with another card under the same key, and confirm it goes
    through. Also record whether `/payments` defaults to `dupCheck: true` when the field is
    omitted, as the Interac response echo suggests.
  - **Whether `/paymenthandles` applies a duplicate check when `dupCheck` is omitted.** If it
    does, a new handle under a key whose earlier attempt failed would be refused, and the
    adapter would end that attempt with the non-retryable `processing_error` instead. Mint
    two EFT handles under one reference without the field.
  - **How a lookup answers an unknown reference.** An empty collection or 404/5269; both
    are handled.
  - **How long the lookup trails a write.** This sizes the three bounded reads.
  - **Whether a declined payment's lookup record carries `status`, `error` and
    `paymentHandleToken`.** The simulator's only decline example shows `error`, `id`,
    `merchantRefNum` and `settleWithAuth` with no `paymentHandleToken` or `status`, so a
    failure that names no handle is never taken as a single-use spend's own record: it
    is an earlier attempt's, a new card or bank account is sent under the key, a replay of
    the declined card itself ends in the non-retryable `processing_error` (nothing ties
    the decline to it), and a bank debit counts each such failure against one spent
    handle. Record the shape.
  - **Lookups ask for 50 records, the documented maximum** (default 10, order
    undocumented), and a full page is refused with the non-retryable `processing_error`
    instead of being paged through or read as complete: a key holding that many records
    in the 30-day window is reconciled in the portal.
  - **Whether a refused payments call spends its handle.** The adapter and the test double
    take "regardless of the payments call response status" plainly: a 5031, 3044 or 3417
    refusal leaves the handle COMPLETED with no payment, and a bank-debit key holding one
    ends every retry in the non-retryable `processing_error` until the host starts again
    under a new key, once the portal shows no live payment under it. Probe: decline a bank
    debit under a key K, mint a fresh handle and pay it under K with `dupCheck: true`,
    expect 5031, then `GET /paymenthandles/{id}` and record the handle's status. PAYABLE
    would mean a refusal leaves the handle payable, and the key could then debit once the
    failure shows. Record the same for a 400 that files no payment (5068).
  - **Whether the lookups accept a 90-day `startDate` range.** The `payments` and
    `paymenthandles` lookups document `startDate` as "Default = 30 days before the endDate"
    and state no maximum range, so the adapter reads the default window. Under a reference
    last used 31 to 90 days ago, send both lookups with `startDate` 90 days back and record
    whether the old records come back or the range is refused. If it works, a bank debit
    can see the failed attempt that refuses its key and send corrected details without
    `dupCheck`, instead of ending in the new-key guidance.
  - **Card and Interac completions, not built:** the bank-debit rule above, `dupCheck: true`
    until a failed attempt shows, would also refuse a card completion retried with a fresh
    tokenization while the first payment trails the lookup, and the second of two sent
    together. It waits on the in-flight answer above; the bank-debit case was built first
    because an identical resubmission, the common retry, debited twice there.

## Worldline decline codes (2026-09-25)

- **The `errorCode`s Worldline documents map onto the taxonomy; any other code stays
  `card_declined` on a 402, and on a REJECTED payment its error's own status decides.**
  Doc-verified 2026-09-25 against the API Troubleshooting page
  (docs.direct.worldline-solutions.com/en/integration/api-developer-guide/api-troubleshooting,
  "Fix errors.errorCode" and "Payment retry guidelines") and the Sips response-code mapping
  (docs.direct.worldline-solutions.com/en/migrate/migrate-from-sips/response-codes-mapping,
  whose third column is the Direct `errorCode`). `fraud_suspected`: 30431001 ("the card used
  has been reported as stolen"), 30411001 ("Lost card, pick up"), 30071001 ("Pick up card,
  special condition (fraud account)"), 30591001 ("the card used has been used for fraudulent
  transactions"), and 30001100, 30001101, 30001102, 30001104, 30001105, 30001106, 30001120,
  30001130, 30001140, 30001141, 30001142, 30001143, 30001158 and 30001180, each "Your Fraud
  Prevention module rejected the transaction because …". `invalid_card_data`: 30141001
  ("Invalid card number"; Sips "Invalid PAN") and 30151001 ("No such issuer").
  `expired_card`: 30331001 and 30541001 (Sips "Payment mean expired"). `insufficient_funds`:
  30511001. `authentication_required`: 40001134 ("a failed 3-D Secure check") and 40001139
  ("As the issuer insists on 3-D Secure, the transaction was rejected"; Sips A1, "the 3-D
  Secure authentication data is missing"). `processing_error`: 40001135 and 50001081 ("the
  issuer was not available to confirm the identity of the cardholder"), 40001137 ("our
  platform could not roll out 3-D Secure"), 40001138 ("due to an unexpected failure"),
  40001146 ("could not be completed within the given time"), and the Sips page's 30911001
  ("Payment mean issuer inaccessible"), 30681001 ("Response not received or received too
  late"), 30991001 ("Incident with initiator domain") and 30201001 ("Invalid response (error
  in server domain)"). `invalid_request`: 30031001 ("your MID (merchant ID) is not working properly"; Sips
  "Invalid acceptor"), 50001087 (3-D Secure could not run "because there was an technical
  issue with your request") and the Sips page's 30301001 ("Format error"). This supersedes
  the 2026-07-14 "Decline sub-codes" item.
- **Stolen, lost and fraud-module rejections are `fraud_suspected`, as in the other
  adapters.** The Stripe server adapter maps `stolen_card`, `lost_card`, `fraudulent` and
  `merchant_blacklist` there, and the merchant's own Fraud Prevention rules and blacklists are
  the analogue of `merchant_blacklist`. The PayZen adapters map the acquirer response codes 41
  (lost), 43 (stolen) and 59 the same way, and the Sips page gives those codes as 30411001,
  30431001 and 30591001. The rest agrees too: PayZen's 14, 33/54 and 51 (`invalid_card_data`,
  `expired_card`, `insufficient_funds`) are Sips 14, 33/54 and 51, that is 30141001,
  30331001/30541001 and 30511001, and both read a missing strong authentication as
  `authentication_required` (1A, which the PayZen server adapter labels "SCA soft decline";
  Sips A1, which the page maps to 40001139). The customer learns nothing more: the catalog
  message for `fraud_suspected` is the generic "Your card was declined.", and Worldline's
  `message` is never relayed, since the API contract
  (payment.preprod.direct.worldline-solutions.com/v1/public-contract-definition.yaml,
  v2.507.0) describes it as "not meant to be relayed to customer as it might tip off people
  who are trying to commit fraud". The answer stays whole on `raw`.
- **The 3-D Secure failures and an unreachable issuer are `processing_error`, and none of the
  mapped codes is retryable.** Worldline calls 40001135/50001081 and 40001137 "out of your
  control", advises resubmitting later or offering another payment method for them and for
  40001138, and asks the merchant to contact it about 40001146. `card_declined` would tell the
  customer the card is at fault, and `authentication_required` would send them back to a 3-D
  Secure step that could not complete. 30911001 and 30681001, an issuer out of reach and a
  response that never came or came too late, and 30991001 and 30201001, incidents on the
  acquiring side, follow the Adyen adapter's reading of Issuer Unavailable (refusal 9), also
  `processing_error`. `retryable` means replaying the call
  under the same idempotency key, and Worldline answers such a replay with "the same outcome
  as the original request, even with different payloads" for its idempotence period, "at
  least 24 hours"
  (docs.direct.worldline-solutions.com/en/integration/api-developer-guide/idempotent-requests),
  so a same-key retry only replays the rejection. `PaymentRouter` fails over on any
  `processing_error` whatever `retryable` says, which is harmless here: it cascades session
  creation only, and a Worldline session is an amountless CreateHostedTokenization. The
  contract's `aPIError.retriable` flag reads "the same request can safely be sent again with a
  new idempotence key", a new attempt rather than a replay; the adapter does not read it, and
  the transport retries are unchanged.
- **A failed cardholder authentication is `authentication_required`; a 3-D Secure that could
  not complete is `processing_error`.** The first is Worldline 40001134, Adyen refusal 11 ("3D
  Not Authenticated") and Stripe `authentication_failure`: the customer can authenticate
  again, and Worldline's entry for 40001134 names "legitimate authentication failures (i.e.
  technical problem with your customers' device or network, missing card readers or forgotten
  PIN codes) or fraud attempts". The second is 40001135/50001081, 40001137, 40001138 and
  40001146, where the issuer, the acquirer or the platform could not complete 3-D Secure:
  authenticating again now does not help, and Worldline advises another payment method or a
  later attempt (for 40001146, contacting it). The Adyen adapter maps its refusal 42 to
  `authentication_required`, although Adyen's refusal-reasons page
  (docs.adyen.com/development-resources/refusal-reasons) reads "The 3D Secure authentication
  failed due to an issue at the card network or issuer". That is inconsistent with this
  reading, and it is tracked in #217. The Stripe entry's `authentication_failure`
  bullet carries the same clarification.
- **The merchant's set-up and request refusals are `invalid_request`.** 30031001 is the
  acquirer refusing the merchant id: Worldline asks the merchant to "Contact us and your
  acquirer to make sure that the MID properly set up on our side and your acquirer's side",
  and the Statuses page (docs.direct.worldline-solutions.com/en/integration/api-developer-guide/statuses)
  names MIDs that are "not correctly setup" among the causes of an authorisation declined
  (status 2). 50001087 is a request 3-D Secure could not run on, and 30301001 ("Format
  error") an integration error. The merchant has to act: `processing_error`'s "please try
  again" cannot help, and `card_declined`'s "use another card" helps only when that card
  goes through another, working MID. The PayZen server adapter maps its merchant-configuration
  refusals the same way (PSP_100, the REST API not enabled on the shop; PSP_109, production
  mode not activated; PSP_610, no acceptance agreement). Its CB network table does not yet:
  PayZen's acquirer codes 03, 30, 68 and 91, the Sips codes behind 30031001, 30301001,
  30681001 and 30911001, stay `card_declined` there, tracked in #218.
- **A 429 or a 5xx is classified by its status before any code.** Before, a 5xx carrying a
  mapped code (30511001, say) came out as a non-retryable decline and skipped the transport
  retries. The order is now: 429 or 5xx; the code map; 402 → `card_declined`; 409 → the
  retryable `processing_error` of a replay racing its in-flight original; core's
  `classifyHttpFallback`. The code is the first `errors` entry's `errorCode`, else its
  deprecated `code` ("Use errorCode instead"), an empty `errorCode` counting as none, and it
  is looked up among the map's own keys only.
- **A 2xx CreatePayment carrying a REJECTED payment maps from the payment's own errors.** The
  contract's `paymentStatusOutput` says "In case of failed payments and negative scenarios,
  detailed error information is listed" in `errors`, the same `aPIError` array as an error
  body, and the troubleshooting page's "Transaction exception" example shows a REJECTED
  payment carrying `statusOutput.errors`. `payment.statusOutput.errors[0]` now goes through
  the same map, never retryable, with the whole CreatePayment response on `raw`. This
  refines the 2026-07-14 "Decline HTTP shape" item, which made every such payment a
  `card_declined`. That example's error is 50001066 `INVALID_VALUE` with `httpStatusCode`
  400, and no page documents the code. So on a REJECTED payment an error without a mapped
  code is read by its embedded `httpStatusCode`: a 4xx other than 402 is `invalid_request`,
  since Worldline refused the request rather than the card; a 5xx is `processing_error`,
  since the platform failed rather than the card, and not `psp_unavailable`, which is always
  retryable while a replay under the key answers the same rejected payment; anything else, a
  missing status included, is `card_declined`.
- **Plain declines stay `card_declined`.** 30051001 ("Do not honour"), 30121001, 30571001,
  30581001, 30621001, 30921001, 33000972, 33000973, 33000975 and 33000833 reach it through the
  402 default. 30041001 and 30171001 keep explicit entries because their descriptions invite
  another reading. The troubleshooting table gives 30041001 for a card that "Has expired" or
  "Is under suspicion of fraudulent use", its retry list calls it "Pick up card (no fraud)",
  and the Sips page sends both acquirer 04 ("Keep the payment mean") and 07 ("Keep the payment
  mean, special conditions") to it, so the conservative reading claims no fraud. 30171001 is
  the customer cancelling "on the Hosted Checkout Page by clicking on the "Cancel" button"
  (the code comment used to say "at the acquirer"). The two pages also disagree on 30581001
  (a corporate card; Sips "Transaction forbidden to the terminal") and 30621001 ("(security)
  restrictions"; Sips "Transaction awaiting payment confirmation"), declines either way, and
  the Sips page maps acquirer 65, "Allowed number of daily transactions has been exceeded", to
  40001139 as well; the troubleshooting page's reading decides. Sips codes left at the
  `card_declined` default on purpose: 30941001 ("Duplicated transaction"), 30311001 ("Id of
  the acquiring organisation unknown"), 30131001 ("Invalid amount") and 30251001
  ("Transaction not found"), whose Direct meaning no page states.
- **Recorded for a future dunning signal, not implemented.** The retry guidelines list
  "Non-Retriable Errors", which "indicated permanent issues with the transaction. We strongly
  recommend not resubmitting the payment request": 30041001, 30071001, 30121001, 30141001,
  30151001, 30411001, 30431001, 30571001, 33000972, 33000973, 33000975 and 33000833. For every
  other code, "You can retry, but limit to a maximum of 10 attempts within 30 days to stay
  compliant with card scheme guidelines and avoid potential fees." Both concern
  merchant-initiated resubmissions under the Card On File framework. Core cannot express
  either today: `retryable` covers same-key replays only, with no "never resubmit this card"
  signal and no attempt budget, and the Worldline adapter declares no vaulting, so no
  merchant-initiated retry runs through it yet.
- **Doc-derived only.** No sandbox run has observed a Worldline `errorCode` yet: which code the
  sandbox's 1302 decline carries, and whether any decline arrives as a 2xx REJECTED payment
  rather than a 402, remain open.

## Subscription renewals without a definitive answer (2026-09-25)

- **A renewal charge that fails without saying whether money moved is replayed under its
  own key, never re-keyed.** Until now every failed renewal moved on to a new attempt key
  (`-a<failedAttempts>`), so a charge whose answer was lost, a timeout after the PSP had
  processed it, could be charged again by the next dunning run. The manager now classifies
  each failure. Definitive: `card_declined`, `insufficient_funds`, `expired_card`,
  `invalid_card_data`, `authentication_required`, `fraud_suspected`, `invalid_request`,
  `session_expired`, `unsupported_operation`, a charge that resolved as failed, canceled
  or requiring action, and a pending renewal resolved as failed. Uncertain:
  `psp_unavailable`, `rate_limited`, `unknown`, any code added to the taxonomy later, and
  any error marked `outcomeUnknown`. An uncertain failure pins `renewalAttempt.replay` (the
  key and the request as sent), and later charges of the period repeat that request. The
  whole request is kept because a reused key with other parameters is refused or misread.
  Stripe's idempotent-requests reference: "The idempotency layer compares incoming
  parameters to those of the original request and errors if they're not the same".
  Worldline's idempotent-requests guide: "Our server will respond with the same outcome as
  the original request, even with different payloads." Both doc-verified 2026-09-25.
- **A replay reads the original back only where the PSP, or its adapter, makes it so.**
  Stripe keeps the result of a request that began executing: "Subsequent requests with the
  same key return the same result, including 500 errors" (idempotent-requests reference).
  Paysafe refuses a reused `merchantRefNum` under `dupCheck` (409/5031) rather than
  replaying it; its adapter reads the original back by `merchantRefNum` (PR #198) and marks
  what it cannot read back `outcomeUnknown`, as it does a key holding several records or a
  full lookup page, where it cannot tell which record is the call's own. A PSP that neither
  keeps results nor has an adapter doing so gains nothing from the replay, which is why
  core gained `PayFanoutError.outcomeUnknown` and why every refusal of a reused key must
  carry it unless the adapter has read the key's first request back as the call's own, or as
  one that finally moved no money (narrowed 2026-09-25 from any read-back): Stripe's
  `idempotency_error` now does, since it proves the key's first request ran, and so does
  Paysafe's refusal of a key another request holds (`invalid_request`) while that request's
  payment, settlement or refund may have moved money (corrected 2026-09-25: it carried none;
  see "Renewal re-key paths").
- **`processing_error` is replayed once.** Stripe's adapter maps the card-error code
  `processing_error` to it, and Stripe's decline-codes page says "Ask the customer to
  attempt the payment again"; Stripe answers a reused key with the saved result of the
  first request, so a second `processing_error` for the same request is that attempt's own
  answer, and the retry moves on to a new key. An adapter that means "outcome unknown" by a
  `processing_error` marks it `outcomeUnknown`, which is never re-keyed.
- **Replays run inside a window, then freeze.** Stripe's low-level error guide: clients
  "can safely retry requests that include an idempotency key as long as the second request
  occurs within 24 hours", and a `500` is "indeterminate": "the idempotency-cached response
  to those requests won't change", while Stripe may still complete the operation and "fire
  webhooks for new objects that are created" (doc-verified 2026-09-25). A replay after the
  key expired is a new charge, so replays follow `replayDelaysMinutes` (default 5, 30, 120,
  360 and 720 minutes) only within `replayWindowHours` (default 24) of the first send. Past
  that, or with the schedule spent, the pin is `frozen`: the cron sends nothing more, emits
  `subscription.charge_pending`, and waits for `resolvePendingRenewal`, as it does for a
  pending renewal. An unsettled charge never counts for dunning; settling it as failed
  does. An earlier draft kept replaying at the dunning pace after a spent run; that was
  dropped, because a replay 24 or 72 hours later can reach a PSP that no longer holds the
  key. The price is that a charge left unanswered for the whole window waits for the host.
- **The key rides the charge.** Every renewal charge carries `payfanout_renewal_key` in its
  metadata, derived from the key so a replay stays identical, following Stripe's advice to
  "send in a local identifier with the metadata" to cross-reference objects created during
  an incident. `resolvePendingRenewal` settles a pin only when given that key: a failure
  webhook alone cannot, because the payment it names may belong to an earlier attempt, and
  a failure naming an earlier attempt's key is a no-op. Settling as succeeded requires the
  payment id and refuses the previous period's. `parseRenewalIdempotencyKey` reads the
  subscription back from a key for PSPs that store no metadata (Paysafe echoes the key as
  `merchantRefNum`).
- **Attempt numbers never go back.** `renewalAttempt.attempt` carries the period's next
  number, so a token change, which resets `failedAttempts`, no longer reuses `-a0`, and
  `PendingRenewal.attempt` is the number of the key the pending charge used, no longer
  copied into `failedAttempts` when it resolves as failed. A pinned charge of a card the
  host has since replaced is replayed first, since it may have paid the period, and a
  decline of a replaced card, replayed, in flight or pending, costs the new card nothing.
  Plan and metadata changes wait for the pin the same way, and so does `cancelAtPeriodEnd`:
  a charge that went through moves the period end. A token change on a `past_due` record
  sets `nextRetryAt` to now instead of deleting it, so a store querying `nextRetryAt` still
  finds it.
- **Overtaken answers are dropped.** An answer that reaches the store after an overlapping
  run collected the period, or settled or made pending the same attempt, changes nothing;
  a settlement the host applies is authoritative for its attempt. Resume refuses while a
  pin is open, and a canceled record keeps its pin for reconciliation. Before a replay the
  manager checks the service can still send it (the adapter is registered and supports
  saved payment methods); otherwise the pin stays.
- **Stores that drop `renewalAttempt`** would replay every few minutes forever, so after
  saving a pin the manager reads the record back, and when it comes back as that write
  without the pin, the failure counts for dunning at once: nothing is replayed under the
  same key, and the retry follows `retryDelaysHours` under the next attempt number, as
  releases before pins did. Only fields older than `renewalAttempt` are compared (status,
  period, `failedAttempts`, `lastError.code`), since that is what a schema from before the
  field keeps; any other write landing between the save and the read keeps the pin's key.
  An earlier draft inferred a dropping store from `lastError.code` alone. It counted the
  retry of a record the previous release had left `past_due` after a timeout as a second
  failure, so a lost `-a1` was followed by `-a2` for the same period, and it replayed an
  `invalid_request` marked `outcomeUnknown` without bound on a store that really drops the
  field. The changeset leads with the requirement to persist the field.
- **A late freeze re-reads the record.** Freezing a pin whose window has passed changes only
  that pin's `frozen` flag on the record as it stands, and leaves the record alone when its
  period moved or its pin changed. It used to write back the record read at the start of
  the run, so a cancel landing in between was lost, and settling the pin later made the
  canceled subscription `active` again.
- **An answer to another request under the pinned key never settles the pin.** A card or
  plan change while a renewal charge is in flight can make an overlapping run send a
  different request under the same key. The PSP holds the first one it received, which
  neither run knows. The pin keeps the request it was first pinned with, and an answer to
  another request is dropped, but it marks the pin `contested`: from then on a failure of
  the pinned request freezes the pin instead of moving on to a new key, because it may be
  the PSP refusing the other request, and Paysafe answers a replay of a request it does not
  hold under a key with `invalid_request`. Without the mark, a run whose request was pinned
  first but reached Paysafe second would be refused that way once Paysafe's lookup showed
  the other payment, and `-a1` would charge the period again. A contested pin still settles
  on a success. Neither keeping the first pinned request nor taking the latest answer's, as
  an earlier draft did, is safe alone: each leaves one arrival order charging the period
  twice on Paysafe. Together they cover the orders in which a pin exists before the other
  request's answer arrives, not every order: when the refusal of the pinned run's request
  lands before any pin, only the adapter marking that refusal `outcomeUnknown` keeps the
  period on its key (corrected 2026-09-25; see "Renewal re-key paths").
- **`listDue` leaves out records waiting for `resolvePendingRenewal`.** A frozen pin has no
  `nextRetryAt`, so a store falling back to `currentPeriodEnd` returned it first on every
  call, and a full batch of them, which one PSP incident can produce, held back every other
  due record. The cron does nothing for a frozen pin or a pending renewal (no polling), so
  `InMemorySubscriptionStore.listDue` leaves both out and the `listDue` contract asks host
  stores to do the same.
- **`subscription.past_due` fires when a pin changes the status**, not on every replay;
  `subscription.charge_failed` fires once per uncertain answer, with its error. A failed
  attempt under dunning still emits `subscription.past_due` each time, as before, since it
  starts a new retry schedule.

## PayPal: captures after a reauthorization (2026-09-25)

Doc-verified 2026-09-25 against the Payments v2 (2.12) and Orders v2 (2.36) schemas under
developer.paypal.com/api/, the Authorize and capture page (`/v5/checkout/auth-capture`,
where `/docs/checkout/standard/customize/authorization/` now redirects), the Authorization
and honor period page (`/payment-methods/auth-honor`), the Extend an authorization guide
(`/checkout/extend-authorization`) and the webhook event names page.

- **The newest authorization that was not denied carries the hold, and captures go to it.**
  Reauthorize "Reauthorizes an authorized PayPal account payment", and its example answers
  with an authorization id different from the one reauthorized; the Extend guide says it
  generates "a new authorization with a refreshed expiration date". The capture target is
  guide-only: the Authorize and capture page ("A reauthorization generates a new
  authorization ID and restarts the 3-day honor period. Use the new authorization ID on
  subsequent captures") and the honor period page ("Perform any subsequent capture against
  the new authorization ID, not the original"); the Authorize and capture page's capture step
  also reads "The authorization ID is either the original authorization ID or the ID from
  reauthorizing the transaction". The adapter captures and reports against the newest
  authorization by `create_time`, then list position, and treats an older one as superseded
  whatever its status. One reporting no `create_time` sorts as the oldest, so the list's
  arrangement decides ties only: with A undated, B five days in and C one day in, listed B,
  A, C, the former comparator took C, and B is taken now. A denied newer authorization is
  skipped, since it replaced nothing. The adapter never reauthorizes itself; this covers a
  host that reauthorizes through PayPal.
- **Voids go to the original.** `CANNOT_BE_VOIDED`: "A reauthorization cannot be voided.
  Please void the original parent authorization." / "You cannot void a reauthorized payment.
  You must void the original parent authorized payment." `cancelPayment` voids the oldest
  authorization unless the one holding the funds already reports `VOIDED`. No documented field
  ties a reauthorization to its parent (an order's authorization links to itself, its capture,
  void and reauthorize operations and the order), so age decides. AMBIGUOUS: the reauthorize
  200 and 201 examples, and the Authorize and capture page's sample, show a `void` link on the
  new authorization, and no page says what either authorization reports once the original is
  voided. The fake voids both and answers `CANNOT_BE_VOIDED` for a reauthorization. An original
  that already reads `VOIDED` next to a live reauthorization gets the void anyway, and PayPal's
  refusal (`PREVIOUSLY_VOIDED`, "Authorization has been previously voided and hence cannot be
  voided again.") surfaces instead of a `canceled` the adapter cannot confirm.
  `CANNOT_BE_VOIDED` and `PREVIOUSLY_VOIDED` map to `invalid_request`, not retryable, as
  `PREVIOUSLY_CAPTURED` does.
- **Capturing the rest never reaches past the order.** An empty-body reauthorization
  reauthorizes "the full amount" (the schema's "Reauthorize with empty request body" flow; the
  Extend guide's "Reauthorize for the same amount" sends `{}`), so after a partial capture the
  new authorization can hold again what was taken. The remainder, and `amountCapturable`, is
  the lesser of the holding authorization's amount less the captures taken from it and the
  order amount less every capture on the order that took money, in integer minor units and
  never below zero. When captures name their authorization it is exact whether the
  reauthorization is for the full amount or for what was left. An order read reporting no
  amount (the Orders v2 response schema does not require one) is measured by the original
  authorization's amount, which is the order amount: the Orders v2 authorize request takes no
  amount, and an order "with the `COMPLETED` status" cannot be updated. It was measured by the
  holding authorization before, and a reauthorization can hold "up to 115% of original" (the
  Extend guide), so a 23.00 reauthorization after 2.00 was taken from a 20.00 order read
  21.00 left where 18.00 is. When neither the order read nor the original reports an amount,
  capturing the rest of a reauthorization needs an explicit amount (without one PayPal takes
  the reauthorization's full amount), and `amountCapturable` is left out.
  Capturing the rest answers with the payment once the order's captures cover the order
  amount. A holding authorization that reports no amount gets what the order has left as an
  explicit amount while nothing is captured, where it went out with no amount before (PayPal:
  "If amount is not specified, the full authorized amount is captured"), and needs an explicit
  amount once any capture on the order took money, not only one of its own; an explicit amount
  then closes it only when it takes all the order has left. `MAX_CAPTURE_AMOUNT_EXCEEDED` caps
  "the sum of all captures to be up to 115% of the order amount" (its example says "You can
  only capture up to the original authorization amount"), and the honor period page caps
  captures at "up to 115% or $75 USD more than the original authorized amount, whichever is
  less", so an explicit amount still goes to PayPal as it is. The fake enforces both, the
  second against each authorization's own amount (USD 75 applied in USD only). AMBIGUOUS:
  which cap PayPal applies to the captures from a reauthorization, its own amount, the
  original's or only the order's; no page says.
- **Captures count against the authorization they name, else by time (AMBIGUOUS on the order
  read).** `supplementary_data.related_ids.authorization_id` is a Payments v2 capture field,
  and a Payments v2 capture's `up` link points to its authorization. The Orders v2 capture
  schema has no `supplementary_data` or `related_ids`, and its examples link `up` to the
  order, so an order read may name no authorization at all. A capture naming none counts
  against every authorization created no later than it, by `create_time`, since an
  authorization cannot give a capture taken before it existed. The former rule counted every
  capture against the new authorization once one named none: on a 20.00 order with 7.00
  taken and a reauthorization of the 13.00 left, the rest read 6.00 and its capture went out
  final, closing the reauthorization with 7.00 still on it (an explicit 10.00 went out final
  too, leaving 3.00), so the next capture met `AUTHORIZATION_ALREADY_CAPTURED`. A missing
  `create_time`, on the capture or on an authorization, rules nothing out, which errs low;
  the order clamp still bounds the result. AMBIGUOUS: the Orders v2 capture schema defines
  `create_time` (through `activity_timestamps`, "The date and time when the transaction
  occurred") and the Orders v2 capture examples carry it, but no example shows the captures
  of an AUTHORIZE order's read. An estimate never closes a hold: when a capture naming no
  authorization took money and another authorization could have given it, the capture goes
  out with `final_capture: false`, even when it takes the whole estimate, and only a capture
  of all the order has left closes the authorization. That holds even when the holding
  authorization still covers what the order has left: a final capture the count relies on,
  taken from the superseded original outside the adapter, may not have closed this one
  (review of 2026-09-25). The hold stays open for whatever the
  estimate missed, which a capture with an explicit amount can take; once the estimate
  reaches zero, capturing the rest answers with the payment, as when captures cover the
  authorization, and `amountCapturable` reads 0. What is never captured is left to expire:
  `cancelPayment` voids only an authorization with no capture yet, so it releases nothing
  here. The fake's order reads carry no attribution unless a test opts in, which makes the
  time rule the default path, and its reauthorizations are stamped by its own clock, moved
  on four days first; it refuses to reauthorize an original that is voided
  (`AUTHORIZATION_VOIDED`, "A voided authorization cannot be captured or reauthorized") or
  fully captured (the Extend guide lists "authorization already captured or voided" among
  the failures). The `up` link is parsed as the order link is: one path segment, no
  decoding.
- **Repeatability (AMBIGUOUS).** The sources conflict. Once: `reauthorize_request` ("You can
  reauthorize a payment only once from days four to 29", "You can reauthorize an authorized
  payment once"), `REAUTHORIZATION_NOT_SUPPORTED` ("cannot be attempted on an authorization_id
  that is the result of a prior reauthorization"), `REAUTHORIZATION_TOO_SOON` ("only allowed
  once from Day 4 to Day 29") and the Extend guide ("Each authorization can be reauthorized a
  single time"). Several: the reauthorize operation ("you can issue multiple
  re-authorizations after the honor period expires"), the Authorize and capture page, and the
  honor period page, whose table shows a "Reauthorization 2" on day 8. The adapter reads any
  number of authorizations and reauthorizes none.
- **The original's status after a reauthorization (AMBIGUOUS).** No page says it. The tests
  cover it staying `CREATED` and turning `VOIDED`; capturing and reporting behave the same
  either way.
- **Webhooks (AMBIGUOUS).** `PAYMENT.AUTHORIZATION.VOIDED` still maps to `payment.canceled`.
  The event names page gives its causes as the authorization "reaching its 30 day validity
  period" or being "manually voided using the Void Authorized Payment API", and neither it nor
  the Payments v2 callbacks name a reauthorization event. A `VOIDED` event for a superseded
  original would contradict `retrievePayment`, which follows the newest authorization; the
  guide tells hosts to re-read the payment before acting on the event.
- **Sandbox check outstanding.** Reauthorization is refused within the honor period, so every
  order needs an authorization at least four days old. On a first AUTHORIZE order, capture
  part, reauthorize with an empty body, and record in an order GET the new authorization's
  amount, both authorizations' statuses, and whether the captures carry `create_time`,
  `related_ids.authorization_id` or an `up` link to their authorization. GET the
  reauthorization itself (`GET /v2/payments/authorizations/{id}`) and record whether its
  Payments v2 `supplementary_data.related_ids.authorization_id` names the parent; then
  reauthorize a second time, from the original and from the reauthorization. On a second
  order, capture part, reauthorize for less than what is left, and capture more than that
  reauthorization's own amount but less than the order has left, to learn which cap applies.
  On a third order with no capture, reauthorize, void the reauthorization (expected
  `CANNOT_BE_VOIDED`), void the original, and record both statuses. On the first order,
  also capture from the original after the reauthorization and record whether PayPal
  accepts it. Record every webhook PayPal sends for all three orders.

## Renewal re-key paths (2026-09-25)

- **Paysafe marks its refusal of a key another live request holds `outcomeUnknown`.** The
  final review of the renewal replays found an arrival order the `contested` mark misses.
  Run A reads a subscription with the old card; the host sets a new one, and run B reads it.
  B sends `-a0` with the new card, which Paysafe charges while the answer and every
  read-back are lost. A's `-a0` with the old card is refused (5031), the lookup shows B's
  payment, and A's `invalid_request`, a definitive code, reached the store first, before any
  pin: the attempt moved on to 1, B's uncertain answer was dropped as overtaken, and `-a1`
  charged the new card again. On a payment, settlement or refund, the refusal of a key whose
  records disagree with the call (another amount, currency, type or handle) now carries
  `outcomeUnknown` while any of those records may have moved money, since it may be the money
  the call was meant to move, and its message says to start again under a new key only once
  that record is known to be another one. A record that failed moved none, and nor did one
  voided, cancelled or expired: the Payments API spec gives a payment's `CANCELLED` as "The
  request has been fully voided (reversed)", and its settlement and refund statuses add
  `CANCELLED` ("The transaction request is cancelled.") and `EXPIRED` ("The transaction
  request is expired."); the adapter's portal advice and its refund's settlement filter
  already read `CANCELLED` as no money. When every record is one of those, nothing
  under the key moved money and the call's own request was refused (the duplicate check
  counts failed requests, and a failed payment spent its single-use handle), so the refusal
  keeps no flag; two requests in flight together remain the first open item of the Paysafe
  replay entry. Payment handles, verifications and voids move no money and are unchanged,
  except in a bank-debit completion, whose key's handles are read before the handle is
  minted: a handle spent (`COMPLETED`, "The Payment request was initiated successfully using
  the Payment Handle.") that no failed payment of the key accounts for may be a payment the
  lookup does not show yet, so the refusal of another request's handle carries the flag while
  one is under the key. A manager-over-Paysafe test runs that exact order and ends with one
  renewal payment and the pin `contested`, then frozen; the same run without the flag charges
  `-a1`.
- **A store that drops `lastError` along with `renewalAttempt` no longer replays without
  bound.** The dropped-pin check compared `lastError.code`, so on such a store it never
  matched, and `-a0` went out every 5 minutes. A `lastError` missing from the read-back now
  matches; a present one must still hold the saved code, and status, period and
  `failedAttempts` still tell a host write that landed in between apart.
- **On a store that drops the pin, a replaced card's failure no longer counts.** The
  fallback counted every uncertain failure, so a card replaced while its charge was in
  flight, with `failedAttempts` at the limit, canceled the subscription before the new card
  was ever charged. That failure is now recorded as a replaced card's decline is: not
  counted, the status as it was before the pin, and the new card due on the next run. On
  such a store the next attempt number still comes from `failedAttempts`, as releases before
  pins derived it, and the card change resets `failedAttempts` to 0, so the new card is sent
  under a number the period may already have used. A PSP still holding that key refuses it
  (Stripe removes keys only "after they're at least 24 hours old", and answers other
  parameters with `idempotency_error`; Paysafe's duplicate check covers "the past 90 days",
  5031), that refusal counts for dunning, and the next retry charges the new card under the
  following number. Nothing such a store keeps can carry the period's used numbers past a
  card change, so this stays open with the dropped pin itself; a test pins the sequence.
- **An empty object compares like an absent field.** A pinned request and the one sent are
  the same charge when one side has `{}` (as `metadata`, or inside `billingDetails`) where
  the other has nothing: a store that drops empty objects, or writes them, made a replay look
  like another request, and its own pin was marked `contested`.
- **Conflicts with a request still in progress under the same key carry `outcomeUnknown` on
  Adyen, PayPal and Worldline.** Doc-verified 2026-09-25. Adyen's API idempotency guide: "If
  you submit a duplicate request before the first request has completed, the API returns an
  HTTP 422 – Unprocessable Entity or HTTP 409 - Conflict status with the error code 704:
  "request already processed or in progress"", and a transient error "could come from a race
  condition of sending two payment requests with the same idempotency key at the same time.
  One will end up being processed while the other will return a transient error." Its
  response-handling page gives 409 as "A conflict occurred because the request was already
  processed or is in progress." Worldline's idempotent-requests guide: "For requests in
  progress: A response with an HTTP status code of 409 (Conflict) will indicate that the
  request is currently being processed", and its API troubleshooting page: "Either you
  submitted a duplicate request or you are trying to create something with a duplicate
  key." PayPal's idempotency reference: "When you send two simultaneous API requests with
  same `PayPal-Request-Id` header, PayPal processes the first request and might fail the
  second request", and its Payments v2 schema documents the 409 `RESOURCE_CONFLICT` with
  `PREVIOUS_REQUEST_IN_PROGRESS` ("A previous request on this resource is currently in
  progress") on authorization capture and void and on capture refund. Each can be the
  refusal of a request whose key's first request is still running and may go through, which
  the adapter cannot read back, so a caller moving to a new key could repeat the payment,
  capture or refund. The mappers now set `outcomeUnknown` on them (Adyen's 704, its other
  409s and its transient 4xx; Worldline's 409; PayPal's 409), keeping their codes and
  `retryable`. A cancel's conflict gets it too, since the flag only says that the call may
  have taken effect. None of these adapters supports saved payment methods, so the
  subscription engine does not reach them: the flag is for hosts.
- **A request read back under the key keeps the flag while it may be the call's money, on
  Adyen and GoCardless too.** Reading the key's first request back lifts the flag only when
  it shows the call's own request, which then answers the call, or one that finally moved no
  money; the adapter-authoring rule now says so. Doc-verified 2026-09-25. Adyen answers a
  reused key with "the response to the first attempt" (API idempotency guide), and a capture
  or refund answer is only an acknowledgement, `status` `received`: "Your capture request
  will be processed asynchronously. You will receive the result in a webhook." (capture
  guide; "The refund process is asynchronous.", refund guide). A capture or refund
  acknowledgement echoing another amount therefore always carries `outcomeUnknown`, and a
  completion answered with another request's stored payment carries it unless that answer's
  `resultCode` is `Refused`, `Error` or `Cancelled`: the result-codes page lists them among
  its "Final state result codes" with `Authorised`, and `Cancelled` is "The payment was
  cancelled (by either the shopper or your own system) before processing was completed".
  The same page opens with "The status of a payment can sometimes change after you get the
  result code"; a final code is weighed as final here, and a later change reaches the host
  by webhook.
  GoCardless answers a consumed key with "a `409 idempotent_creation_conflict` error with a
  `links.conflicting_resource_id` pointing to the existing resource" (limits page), which the
  adapter reads back and compares with the call, refunds also by their key stamp. The
  refusal now carries the flag unless that billing request is `cancelled` ("the billing
  request has been cancelled and cannot be used"), the payment it created `failed` or
  `cancelled` (the adapter reads `customer_approval_denied` and `charged_back` as failed
  too), or the refund `cancelled`, `bounced` ("the refund has failed to be paid") or
  `funds_returned` ("the refund has had its funds returned"), per the OpenAPI spec's status
  enums. A failed GoCardless payment can be retried by an explicit
  `POST /payments/{id}/actions/retry`, or automatically when the billing request asked for
  `payment_request.retry_if_possible` ("On failure, automatically retry payments using
  intelligent retries. Default is `false`"). The adapter never sends that field, so a failed
  payment counts as final; adding the field would reopen this decision. The messages follow Paysafe's:
  use a new key only once that record is known to be another one.
- **Left unmarked.** PayZen has no idempotency channel, so no refusal of a reused key exists
  to mark, and its unanswered writes stay `psp_unavailable`. Stripe does not save a request
  that "conflicts with another request that's executing concurrently" (idempotent-requests
  reference, doc-verified 2026-09-25); stripe-node 22.6.2 retries a 409 and raises one that
  persists as `StripeAPIError`, which the adapter maps to `psp_unavailable`, already open. An
  Adyen `/payments/details` answer naming another payment is no reused key's answer, since
  that endpoint's key also covers the details: they finished the payment they were issued
  for, and the refusal stays unmarked. A Paysafe Interac session refuses another request's
  handle under the session key, while the payment goes under the completion key, which the
  session cannot read, and a session moves no money.
- **Stripe renewals charged by a release before pins.** Sent again after the upgrade under
  the same key, now with `payfanout_renewal_key` in the metadata, such a renewal is refused
  as a key reused with other parameters (`idempotency_error`, marked `outcomeUnknown`) while
  Stripe keeps the key, so it is pinned and ends frozen, and the host settles it by hand:
  the original carries only `payfanout_subscription_id`. The recurring guide says so.
- **What stays uncovered.** A store that drops `renewalAttempt` counts an uncertain failure
  at once and retries under a new key, and sends a card set meanwhile under a number the
  period may have used. Two requests under one key that both reach Paysafe
  before either is filed can both be charged. A replay is never sent past
  `replayWindowHours`, and a lock around `chargeDueSubscriptions` removes overlapping runs
  altogether. The recurring guide and the `chargeDueSubscriptions` JSDoc now say this
  instead of calling concurrent runs safe for money.

## Paysafe answers mapped as documented (2026-09-26)

- **The card error codes Paysafe documents map onto the taxonomy instead of the HTTP
  fallback.** Doc-verified 2026-09-26 against the card errors page
  (developer.paysafe.com/en/api-docs/payments-api/add-payment-methods/cards/card-errors/,
  unchanged from the copy read on 2026-09-24). `authentication_required`, never retryable:
  "402 | 3060 | Your request has been declined because Strong Customer Authentication is
  required." and "402 | 3039 | Your request has been declined due to an invalid
  authentication value."; the customer comes back on-session, and a replay cannot help.
  `fraud_suspected`: "402 | 3054 | The transaction was declined due to suspected fraud.",
  "402 | 3016 | The bank has requested that you retrieve the card from the cardholder - it
  may be a lost or stolen card.", "402 | 4001 | The card number or email address associated
  with this transaction is in our negative database." and "402 | 4002 | The transaction was
  declined by our Risk Management department."; the Stripe adapter maps a lost or stolen
  card the same way. `invalid_card_data`, as 3017 already was: "400 | 3002 | You submitted
  an invalid card number or brand or combination of card number and brand with your
  request.", "400 | 3005 | You submitted an incorrect CVV value with your request.", "402 |
  3012 | Your request has been declined by the issuing bank because the credit card expiry
  date submitted is invalid.", "402 | 3019 | Your request has failed the CVV check. Please
  note that the amount may still have been reserved on the customer's card, in which case
  it will be released in 3-5 business days." and "402 | 3007 | Your request has failed the
  AVS check. Note that the amount has still been reserved on the customer's card and will
  be released in 3-5 business days. Please ensure the billing address is accurate before
  retrying the transaction."; the customer can correct each, and the Stripe adapter maps an
  incorrect CVC or postal code the same way. The hold 3019 and 3007 describe is released,
  not captured, so they stay definitive failures. The 402s had fallen to `card_declined`,
  and 3002 and 3005, the 400s, to `invalid_request`. A failed record read back with one of
  these codes maps the same way.
  The card simulator
  (developer.paysafe.com/en/api-docs/payments-api/add-payment-methods/cards/simulating-card-payments/)
  returns 4002, 4001, 3007 and 3060 for the amounts 23, 25, 24 and 77 (3060 "Applies for
  Acquiring (UK/EU)."); no sandbox run has done so yet.
- **Four more capture and refund state checks are `invalid_request`.** "402 | 3202 | You
  have exceeded the maximum number of Settlements allowed.", "402 | 3205 | The Authorization
  you are attempting to settle has expired.", "402 | 3403 | You have already processed the
  maximum number of refunds allowed for this Settlement." and "402 | 3405 | The Settlement
  you are attempting to Refund has expired." join 3203, 3204, 3402, 3404, 3501, 3502 and
  3506: the settlement or the authorization cannot take the request, and the card is not at
  fault.
- **An operation the transaction, its card type or the account's gateway does not support
  is `unsupported_operation`, never retryable.** "402 | 3419 | This type of transaction
  cannot be refunded." and "402 | 3507 | The Authorization does not support a partial Void
  (Authorization Reversal)." refuse the operation itself, not the request's amount or the
  record's state, so they map as `refundPayment` refuses a SEPA or Bacs refund and as
  `PaymentService`'s capability guards refuse what an adapter lacks. The page's other
  answers of that kind map with them: "402 | 3416 | The external processing gateway for
  which your merchant account is configured does not support partial Settlements.", "402 |
  3418 | The external processing gateway for which your merchant account is configured does
  not support partial Credits.", "402 | 3503 | The Void (Authorization Reversal) transaction
  is not supported for the card type used for the Authorization you are attempting to
  reverse." and "402 | 3504 | The external processing gateway for which your merchant
  account is configured does not support partial Voids (Authorization Reversals)." The
  adapter declares partial refunds and multi-capture, and `cancelPayment` voids what is
  left of an authorization, a partial void once part of it is settled: on an account whose
  gateway supports none of these, those calls meet 3418, 3416, 3504 or 3507 at run time,
  while the full operation may still go through.
- **Every other 402 code on the page stays on the `card_declined` default, deliberately.**
  The issuer's, the network's and the gateway's refusals of the card or of the transaction
  are card declines: 3011, 3013, 3014, 3015, 3018, 3020, 3023, 3024, 3027, 3029, 3030,
  3035, 3036, 3037, 3040, 3041, 3042 and 3057 among the authorization errors, 3206 ("The
  external processing gateway has rejected the transaction.") and 3207 ("Due to issuer
  policies, this type of transaction is not allowed") among the settlement errors, 3421
  ("The purchase return authorization has been declined by the issuing bank.") and 3422
  ("The purchase return authorization has failed.") among the refund errors, and 5021
  ("Your transaction request has been declined.") among the common ones. 3018 and 3020
  ("The bank has requested that you retry the transaction.") and 3041 ("Your request has
  been declined due to a timeout.") stay non-retryable: Paysafe files the attempt as
  declined, so a replay under the same key reads that decline back, and only a new attempt,
  the customer's or the host's call, can follow. 3415 ("You cannot cancel this transaction
  as it is no longer in a pending state.") answers a cancellation the adapter never sends.
- **Refunds the merchant account cannot fund are `invalid_request`,** as the state checks
  are: 3412 ("The Refund transaction you attempted was not permitted because your merchant
  account is in overdraft.") and 3413 ("The requested Refund amount exceeds the permissible
  Visa credit ratio."), an amount limit like 3402. The card is not at fault, so a decline
  would mislead the merchant. Two 400 rows that refuse the card itself are `card_declined`
  rather than the 400 fallback's `invalid_request`: 3073 ("Your request has been declined
  due to closed customer account.") and 3008 ("You submitted a card type for which the
  merchant account is not configured."); the customer can pay with another card. The other
  400 rows are request errors and stay on the fallback. 3417 is a replay answer (below). The
  Merchant Advice and ISO response codes the page lists ride `error.additionalDetails`, not
  `error.code`, and stay on `raw`.
- **8000 and 8001 stay `fraud_suspected`, although no current Paysafe error table lists
  them.** Neither code appears on the card errors page, nor on any of the 195 pages linked
  from the Payments API documentation's navigation (Payments API, Paysafe Checkout, Paysafe
  JS, 3-D Secure, Payment Scheduler and the rest), read on 2026-09-26. Dropping them would
  turn an answer an account may still receive into a plain decline, so they stay, with a
  comment saying so.
- **The replay answers keep their HTTP fallback.** 5031, 3044, 3417 and 5283 stay out of the
  map (409 and 400 → `invalid_request`, 402 → `card_declined`): `sendWrite` recognizes them
  by the Paysafe code on `raw`, so "Paysafe replay safety (2026-09-24)" is unchanged, and a
  test pins the fallback.
- **A 429 or a 5xx is classified by its status before its code.** `mapPaysafeError` answers
  `rate_limited` or `psp_unavailable`, retryable, whatever code the body carries, as
  `mapWorldlineError` does, and the code map speaks for the other statuses only. A 5xx is
  how `sendWrite` learns that a write's outcome is unknown and must be looked up: a code
  mapped to a final answer, a decline on a 502 say, would have ended the call without that
  lookup although Paysafe may have processed the write. No 429 or 5xx row on the page (1000,
  1001, 1002, 1003, 1007, 1008, 1020, 1200, 3028, 3420, 3423, 3424, 3505, 5050, 9000)
  carries a mapped code, so no documented answer changes. `sendWrite` still reads the replay
  codes and the lookups' 5269 from the body on `raw`, whatever the mapped code. Only the
  map's own keys count as codes, as in the Worldline adapter, so a code such as
  "constructor" falls through to the HTTP fallback.
- **The test double already answered the state checks as documented.** Since #198 it
  refuses an over-refund with 402/3402 and an over-capture with 402/3204, where it once
  answered 400/3407 and 400/5050. The card errors page gives 3407 as "400 | 3407 | The
  Settlement referred to by the transaction response ID you provided cannot be found.",
  which the double still returns for an unknown settlement, and 5050 as a 500 ("An error
  occurred with your merchant account configuration."). No test asserted the old answers.
  Its scheduler rejections still use 400/5050, where the Payment Scheduler errors page
  (developer.paysafe.com/en/api-docs/payment-scheduler/test-and-go-live/common-api-errors/)
  documents "400 | PLAN-SUBSCRIPTION-3 | Subscription not modifiable." and "400 |
  PLAN-SUBSCRIPTION-1 | Plan not modifiable."; the adapter reads no code there.
- **Terminal refund and verification statuses follow the spec's enums.** Doc-verified
  2026-09-26 against the Payments API OpenAPI spec
  (developer.paysafe.com/fileadmin/openapi-spec/payments-api/apis/paysafe-ph-payments-api.yaml).
  A refund in "EXPIRED - The transaction request is expired." is `failed`: it had fallen to
  `pending`, a refund that would never settle, while nothing went back to the customer. A
  verification in "ERROR - The verification has errored - failed for non-business reason
  (non http status 402 error)." is `failed`, as FAILED is; it had fallen to `processing`.
  RECEIVED ("A verification request was received from merchant, but it has not yet been
  sent to downstream gateway.") stays `processing`.
- **An expired settlement moved no money, like a cancelled or failed one.** The settlement
  enum is RECEIVED, INITIATED, PENDING, FAILED, CANCELLED, EXPIRED and COMPLETED, EXPIRED
  reading "The transaction request is expired." Every settlement sum on a `PaymentInfo`
  (`amount`, `amountCaptured`, `amountRefunded`, `capturedAt`) and the choice of the
  settlement a refund comes out of now skip it, through the rule the replay logic already
  uses (failed, cancelled or expired, or filed with an error, in any letter case); the old
  filters skipped only CANCELLED and FAILED. An expired settlement reporting
  `availableToRefund: 0` had read as fully refunded, and one still reporting a balance
  could be refunded against. The payment-level witnesses are unchanged: a completed
  settle-with-auth payment still reports its full amount captured, and a manual-capture
  payment with no settlement that moved money still derives it from `availableToSettle`.
  What Paysafe reports on the payment once its settlement expires is undocumented.
- **SEPA and Bacs refunds are refused locally with `unsupported_operation`.** Doc-verified
  2026-09-26: the SEPA Direct Debit page
  (developer.paysafe.com/en/api-docs/payments-api/add-payment-methods/sepa-direct-debit/)
  lists "Refunds | Not Supported" and the Bacs Direct Debit page
  (developer.paysafe.com/en/api-docs/payments-api/add-payment-methods/bacs-direct-debit/)
  "Refunds | NA". The ACH, EFT and Interac e-Transfer pages say nothing about refunds, and
  the spec is no firmer: the `refunds` schema's `paymentType` enum lists CARD, PAYSAFECARD,
  PAYSAFECASH, RAPID_TRANSFER, SKRILL, SKRILL1TAP, MYBANK and EPS, with no bank rail and no
  Interac, while the refund endpoint's own examples also refund TRUSTLY, MBWAY and
  MULTIBANCO payments, which the enum leaves out. Whether Paysafe refunds an ACH or EFT
  payment is therefore uncertain; since the enum is no complete list and no page refuses
  them, those refunds still go to Paysafe, whose answer stands, and the sandbox check below
  settles it. Only the payment names its rail, so `refundPayment` reads it first, then
  refuses a SEPA or BACS payment, non-retryable and with the payment on `raw`, before the
  settlement lookup or any refund write. `supportsRefunds` stays true: the contract has no
  per-rail refund flag, so the refusal and the guide carry the limit. This extends the
  2026-07-15 bank-rails note, which recorded the Bacs case only.
- **Timestamps come out as ISO 8601 whatever form Paysafe sends them in.** The spec types
  every `txnTime` as a date-time string, but six of its POST /v1/payments response examples
  ("Card - with Settlement" among them) carry the embedded settlement's as epoch
  milliseconds (`"txnTime": 1674814529000`, the instant of the payment's own
  `"2023-01-27T10:15:29Z"`), which the adapter passed through as `capturedAt`, a number.
  `createdAt` on payments, verifications and refunds, and `capturedAt`, now go through one
  reader: a number or a string of digits is epoch milliseconds when it lies between 1e11
  (1973-03-03) and 8.64e15, the last instant a `Date` holds, any other string goes through
  core's `normalizeTime`, and an unreadable value is left out of the optional fields, while
  the required `createdAt` keeps its epoch fallback. An ISO string comes back normalized
  (`2026-07-04T10:10:00Z` becomes `2026-07-04T10:10:00.000Z`). Epoch seconds are not guessed
  at, since no Paysafe example sends them: they fall below the range, as a digits-only date
  such as "20260704" does, so they count as unreadable rather than as an instant in January
  1970.
- **Card expiry strings are read.** `cardExpiry.month` and `year` are numbers in the schema
  (examples 12 and 2022), but 27 of the spec's 28 response examples that carry an expiry
  send strings (`{"month": "10", "year": "2025"}`), on the payment, verification, payment
  handle and Customer Vault endpoints among others, and the adapter read numbers only, so
  those instruments reported no expiry. Both forms are read now; anything but a whole
  month from 1 to 12 or a four-digit year, the ranges `PaymentMethodDetails` documents, is
  left out. `PaysafeCardLike.cardExpiry` and the `txnTime` of
  `PaysafePaymentLike.settlements` entries, both exported, widen to the forms the examples
  show (`PaysafeSettlementLike`, the entries' type, is not exported itself); TypeScript code
  reading them as a plain number or string must handle both.
- **Card brands follow the cardType enum.** The spec's `baseCard.cardType` reads "MD –
  Maestro" and "SO – Solo" (its internal `cardTypeConfig` also lists "MD - Maestro"). MD
  had been reported as "mastercard", under a "Debit MasterCard" comment; it is "maestro"
  now, and SO, which had no mapping and so no brand, is "solo". DC ("DC - Diners Club" in
  `cardTypeConfig`) and UP, in no current Paysafe enum, keep their earlier brands.
- **Doc-derived only; to settle in the sandbox:**
  - **The simulated declines.** Charge a card account the simulator's amounts 23, 25, 24
    and 77 and record that they answer 4002, 4001, 3007 and 3060 (3060 on UK/EU acquiring
    only). No
    sandbox run has returned any code this entry maps.
  - **The statuses and shapes read here.** Record an expired refund or settlement, an
    `ERROR` verification, an epoch-millisecond settlement time or a string expiry if a run
    meets one; none has yet.
  - **An ACH and an EFT refund.** Refund a completed ACH payment and a completed EFT payment
    once the settlement batch has run, and record whether Paysafe refunds each, and the code
    of any refusal. The CAD sandbox account completed an EFT debit on 2026-07-15, so EFT can
    run first; ACH needs an account provisioned for it. A refusal means refusing that rail
    locally, as SEPA and Bacs are.
