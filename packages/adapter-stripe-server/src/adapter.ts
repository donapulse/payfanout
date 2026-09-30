import {
  assertMinorUnitAmount,
  lowercaseKeys,
  NATIVE_SUBSCRIPTION_INTERVALS,
  normalizeCurrency,
  normalizeSecrets,
  PayFanoutError,
  type AdapterCapabilities,
  type CancelNativeSubscriptionInput,
  type ChargeSavedPaymentMethodInput,
  type CreateCustomerInput,
  type CreateNativeSubscriptionInput,
  type CreatePaymentSessionInput,
  type CustomerRef,
  type FetchEventsInput,
  type FetchEventsResult,
  type ListNativeSubscriptionsInput,
  type ListNativeSubscriptionsResult,
  type ListPaymentsInput,
  type ListPaymentsResult,
  type ListRefundsInput,
  type ListRefundsResult,
  type MinorUnitAmount,
  type NativeSubscriptionInterval,
  type NativeSubscriptionRecord,
  type NativeSubscriptionStatus,
  type PaymentInfo,
  type PaymentMethodCapability,
  type PaymentMethodDetails,
  type PaymentSession,
  type RefundInfo,
  type RefundRequest,
  type RefundResult,
  type RetrieveNativeSubscriptionInput,
  type SavedPaymentMethod,
  type ScaPreference,
  type ServerPaymentAdapter,
  type ShippingDetails,
  type UnifiedPaymentMethodType,
  type UnifiedPaymentStatus,
  type UnifiedWebhookEvent,
  type UpdatePaymentSessionInput,
  type VerifyCredentialsResult,
  type VerifyPaymentMethodInput,
} from "@payfanout/core";
import {
  assertReportablePage,
  assertSendableCurrency,
  assertThreeDecimalRule,
  readStripeAmounts,
  REFUSED_CURRENCIES,
  refusesUnconverted,
  toStripeAmount,
  type RecordUse,
  type StripeRecord,
} from "./currency-units.js";
import { mapStripeError } from "./error-map.js";
import type {
  StripeChargeLike,
  StripeClientLike,
  StripeListLike,
  StripePaymentIntentLike,
  StripePaymentMethodLike,
  StripeRefundLike,
  StripeServerAdapterConfig,
  StripeSetupIntentLike,
  StripeSubscriptionLike,
} from "./types.js";
import { parseStripeWebhookEvent, stripeEventBodyToUnified, verifyStripeWebhookSignature } from "./webhook.js";

export const STRIPE_PSP_NAME = "stripe";

/** unified type -> Stripe payment_method_types entry (embedded/redirect honesty lives in capabilities). */
const METHOD_TYPE_TO_STRIPE: Partial<Record<UnifiedPaymentMethodType, string>> = {
  card: "card",
  apple_pay: "card", // wallets ride the card rails in the Payment Element
  google_pay: "card",
  ideal: "ideal",
  sepa_debit: "sepa_debit",
  ach: "us_bank_account",
  bacs_debit: "bacs_debit",
};

const STRIPE_CHARGE_TYPE_TO_UNIFIED: Record<string, UnifiedPaymentMethodType> = {
  card: "card",
  ideal: "ideal",
  sepa_debit: "sepa_debit",
  us_bank_account: "ach",
  bacs_debit: "bacs_debit",
};

/**
 * Defaults mirror the client adapter. iDEAL/SEPA/ACH/Bacs are per-account
 * dashboard enablements — config.paymentMethods overrides for accounts that
 * differ. Their currencies are the rail's, fixed by the customer's country
 * rather than the account's: a US account collecting SEPA still presents EUR.
 */
const DEFAULT_METHODS: PaymentMethodCapability[] = [
  { type: "card", flow: "embedded", supported: true },
  { type: "apple_pay", flow: "popup", supported: true },
  { type: "google_pay", flow: "popup", supported: true },
  // Countries are the CUSTOMER's, per Stripe's support matrix: iDEAL pays
  // from Dutch accounts, ACH from US ones, Bacs from UK ones. SEPA stays
  // country-unrestricted — the zone is a moving membership list, not a
  // country, and a stale list would screen out valid payments.
  { type: "ideal", flow: "redirect", supported: true, currencies: ["EUR"], countries: ["NL"] },
  { type: "sepa_debit", flow: "embedded", supported: true, currencies: ["EUR"] },
  { type: "ach", flow: "embedded", supported: true, currencies: ["USD"], countries: ["US"] },
  { type: "bacs_debit", flow: "embedded", supported: true, currencies: ["GBP"], countries: ["GB"] },
];

/**
 * The Stripe server adapter: PaymentIntents, Refunds, Customers and Billing
 * over the Stripe Node SDK, confirm-on-client.
 *
 * Amounts cross it in PayFanout's minor units (core's getCurrencyExponent,
 * which follows ISO 4217) and are converted where Stripe's API reads a
 * currency in other units (see "Currencies with Stripe-specific units" in the
 * setup guide). ISK is sent multiplied by 100 and reported divided by 100, as
 * Stripe takes it as a two-decimal value whose decimals are always 00; an ISK
 * amount Stripe reports that is not a multiple of 100 cannot be reported and
 * fails the read. MGA, a zero-decimal currency at Stripe, is sent divided by
 * 100 and reported multiplied by 100, and an MGA amount that is not whole
 * ariary (a multiple of 100) is refused with `invalid_request` before any
 * request. Where the caller names the currency (session creation, an update
 * naming amount and currency, saved-method charges, native subscriptions),
 * three-decimal amounts must be multiples of 10, a rule from an earlier
 * version of Stripe's currencies page that the adapter keeps.
 *
 * UGX is refused, as Stripe's currencies page gives it both units: a call
 * that would send a UGX amount rejects with `invalid_request` before the
 * request that would carry it; reads of a UGX record reject with
 * `unsupported_operation`, as do the answers of calls that went through
 * without sending an amount (a capture, cancellation or refund with no amount,
 * a metadata-only update, a subscription cancellation), marked outcomeUnknown;
 * a list page holding one fails whole, its `raw` naming each such record and
 * carrying the page's `nextCursor`; and webhook and polled events in UGX carry
 * no `amount`. A zero-amount session is a SetupIntent, which carries no
 * amount or currency, and is left alone in every currency. UGX is declared in
 * `unsupportedCurrencies`, so the router skips Stripe for a UGX session and
 * PaymentService refuses one with `unsupported_operation`, zero-amount
 * sessions included.
 *
 * Earlier releases sent UGX amounts, and MGA amounts that are not whole
 * ariary, unconverted, so a retry under the same key after the upgrade may
 * meet money they already moved. Their refusal is therefore marked
 * outcomeUnknown on `chargeSavedPaymentMethod` and `createNativeSubscription`,
 * whose earlier attempt the adapter cannot read back; on `capturePayment`,
 * unless the PaymentIntent it reads is still `requires_capture`; on
 * `refundPayment`, unless the PaymentIntent's refund list, read on the way to
 * the refusal, is complete and holds only failed or canceled refunds; and on
 * `updatePaymentSession` when the update names UGX or sends an amount for a
 * UGX PaymentIntent (a currency change away from a UGX PaymentIntent, whose
 * amount cannot be kept, is refused final). These refusals, final or not, ask
 * the host to check the Stripe Dashboard for that request under the
 * idempotency key before sending another.
 *
 * `updatePaymentSession`, `capturePayment` and `refundPayment` read the
 * PaymentIntent first whenever the currency of the amount they send is not
 * in the call (see each method), one more request each time.
 */
export class StripeServerAdapter implements ServerPaymentAdapter {
  readonly pspName = STRIPE_PSP_NAME;
  private readonly config: StripeServerAdapterConfig;
  private clientPromise?: Promise<StripeClientLike>;

  constructor(config: StripeServerAdapterConfig) {
    for (const key of ["secretKey", "apiVersion"] as const) {
      if (!config[key]) {
        throw PayFanoutError.invalidRequest(`StripeServerAdapter config.${key} is required`);
      }
    }
    if (normalizeSecrets(config.webhookSigningSecret).length === 0) {
      throw PayFanoutError.invalidRequest(
        "StripeServerAdapter config.webhookSigningSecret is required (one secret, or several during rotation)",
      );
    }
    if (config.environment !== "sandbox" && config.environment !== "live") {
      throw PayFanoutError.invalidRequest(
        'StripeServerAdapter config.environment must be explicitly "sandbox" or "live" — it is never inferred from key prefixes',
      );
    }
    if (config.webhookToleranceSeconds !== undefined && !(config.webhookToleranceSeconds > 0)) {
      throw PayFanoutError.invalidRequest("StripeServerAdapter config.webhookToleranceSeconds must be > 0");
    }
    if (
      config.requestTimeoutMs !== undefined &&
      (!Number.isInteger(config.requestTimeoutMs) || config.requestTimeoutMs <= 0)
    ) {
      // The SDK takes whole milliseconds and silently swaps any non-integer
      // for its 80000 default, so a bad setting would go unnoticed; zero and
      // negative integers it would pass through.
      throw PayFanoutError.invalidRequest(
        "StripeServerAdapter config.requestTimeoutMs must be a positive integer (milliseconds)",
      );
    }
    if (
      config.maxNetworkRetries !== undefined &&
      (!Number.isInteger(config.maxNetworkRetries) || config.maxNetworkRetries < 0)
    ) {
      // A non-integer would silently become the SDK's default of 2 retries.
      throw PayFanoutError.invalidRequest("StripeServerAdapter config.maxNetworkRetries must be an integer >= 0");
    }
    this.config = config;
  }

  getCapabilities(): AdapterCapabilities {
    return {
      pspName: this.pspName,
      // UGX: every amount in it is refused before it is sent (currency-units.ts);
      // declared so the router skips Stripe instead of ending its cascade there.
      unsupportedCurrencies: [...REFUSED_CURRENCIES],
      supportsPaymentRetrieval: true, // GET /v1/payment_intents/:id
      supportsRefunds: true,
      supportsPartialRefunds: true,
      supportsRefundRetrieval: true, // GET /v1/refunds/:id
      supportsManualCapture: true,
      supportsMultiCapture: false, // one capture per PaymentIntent; the rest of the auth is released
      modificationOutcome: "synchronous", // capture/cancel/refund answer with the updated object
      supportsPaymentMethodVerification: this.verificationEnabled(),
      // PSP-side vaulting: Stripe Customers + attached PaymentMethods. Cards
      // live at Stripe only; PayFanout and the host see opaque pm_… tokens.
      supportsSavedPaymentMethods: true,
      supportsSessionUpdate: true, // PaymentIntents update in place
      supportsEventPolling: true, // GET /v1/events
      supportsListing: true,
      // Stripe Billing subscriptions: the PSP schedules and collects each
      // installment itself, against a vaulted PaymentMethod.
      nativeSubscriptions: { list: true, retrieve: true, create: true, cancel: true },
      // Stripe-Signature v1 = HMAC-SHA256 over `${timestamp}.${rawBody}`.
      webhookSignatureScope: "raw-bytes",
      requiresServerCompletion: false, // Stripe confirms on the client (§4a)
      paymentMethods: this.config.paymentMethods ?? DEFAULT_METHODS,
    };
  }

  async createPaymentSession(input: CreatePaymentSessionInput): Promise<PaymentSession> {
    assertMinorUnitAmount(input.amount, "amount");
    const currency = normalizeCurrency(input.currency);
    if (input.savePaymentMethod && !input.customer) {
      throw PayFanoutError.invalidRequest(
        "savePaymentMethod requires `customer` — create one with createCustomer first",
      );
    }
    // A SetupIntent carries no amount or currency, so no unit applies to it.
    if (input.amount === 0) return this.createVerificationSession(input, currency);

    const amount = toStripeAmount(input.amount, currency, { label: "amount" });
    assertThreeDecimalRule(input.amount, currency);
    const metadata = withPayfanoutId(input.metadata, input.id);
    const params: Record<string, unknown> = {
      amount,
      currency: currency.toLowerCase(),
      capture_method: input.captureMethod ?? "automatic",
      ...(metadata ? { metadata } : {}),
      ...(input.customer ? { customer: input.customer } : {}),
      // Vault-during-checkout: the confirmed PaymentMethod attaches to the
      // customer; the token surfaces on PaymentInfo.savedPaymentMethodToken.
      ...(input.savePaymentMethod ? { setup_future_usage: "off_session" } : {}),
      ...this.paymentMethodParams(input.paymentMethodTypes, currency),
      ...checkoutFieldParams(input),
      ...scaParams(input.sca),
    };

    return this.run(async (client) => {
      const pi = await client.paymentIntents.create(params, { idempotencyKey: input.idempotencyKey });
      return this.toPaymentSession(pi, input.id, metadata, { kind: "answer", action: "session creation" });
    });
  }

  /**
   * Cart total changed? Stripe PaymentIntents update in place — same
   * pspSessionId, same clientSecret, no client remount needed (the Payment
   * Element re-fetches the amount on confirm).
   *
   * Stripe's units for the amount depend on the currency, so an update that
   * carries `amount` without `currency`, or `currency` without `amount`,
   * first reads the PaymentIntent (GET /v1/payment_intents/:id, one more
   * request): the first to learn the currency the amount is sent in, the
   * second to keep the session's amount, in PayFanout's minor units, across
   * the change. A currency change always sends the kept amount converted for
   * the new currency, so its parameters depend only on the state it asks for
   * and a retry under the same key sends the same request: a session of
   * amount 1000 moved from ISK to USD still has amount 1000 (USD 10.00),
   * where Stripe alone would keep its 100000 (USD 1,000.00). An update that
   * names both, or neither, reads nothing first. Refusals of the amount (UGX,
   * MGA amounts that are not whole ariary, and, when the update names both
   * amount and currency, three-decimal amounts that are not multiples of 10)
   * come before the update is sent. A UGX refusal, whether the update names
   * UGX or sends an amount for a UGX PaymentIntent, is marked outcomeUnknown,
   * as an earlier release sent such updates unconverted under the same key.
   *
   * A currency change without an amount writes the amount it read, so an
   * amount update landing between that read and its write is overwritten:
   * send the updates of one session one at a time.
   */
  async updatePaymentSession(input: UpdatePaymentSessionInput): Promise<PaymentSession> {
    if (input.pspSessionId.startsWith("seti_")) {
      throw PayFanoutError.invalidRequest(
        "Verification sessions are amountless — nothing on them can be updated",
      );
    }
    if (input.amount !== undefined) assertMinorUnitAmount(input.amount, "amount");
    const currency = input.currency !== undefined ? normalizeCurrency(input.currency) : undefined;
    if (currency !== undefined) {
      assertSendableCurrency(currency, { label: "amount", sentBefore: { what: "an update", open: true } });
    }
    let amount: number | undefined;
    if (input.amount !== undefined && currency !== undefined) {
      amount = toStripeAmount(input.amount, currency, { label: "amount" });
      assertThreeDecimalRule(input.amount, currency);
    }
    const fields = checkoutFieldParams(input);
    return this.run(async (client) => {
      if (input.amount !== undefined && currency === undefined) {
        const current = await client.paymentIntents.retrieve(input.pspSessionId);
        amount = toStripeAmount(input.amount, current.currency, {
          label: "amount",
          record: {
            ...paymentIntentRecord(current),
            action: "update",
            remedy:
              "Check the Stripe Dashboard for an update under this idempotency key, then cancel it and take the " +
              "payment with another provider",
            outcomeUnknown: true,
          },
        });
      } else if (input.amount === undefined && currency !== undefined) {
        const current = await client.paymentIntents.retrieve(input.pspSessionId);
        const kept = readStripeAmounts(paymentIntentRecord(current), { amount: current.amount }, { kind: "keep" });
        amount = toStripeAmount(kept.amount, currency, { label: "the amount the currency change keeps" });
      }
      const params: Record<string, unknown> = {
        ...(amount !== undefined ? { amount } : {}),
        ...(currency ? { currency: currency.toLowerCase() } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...fields,
      };
      const pi = await client.paymentIntents.update(input.pspSessionId, params, {
        idempotencyKey: input.idempotencyKey,
      });
      return this.toPaymentSession(pi, pi.metadata?.payfanout_id, pi.metadata, { kind: "answer", action: "update" });
    });
  }

  // Stripe never needs completePayment: the client's confirm() finalizes,
  // including 3DS. The method is absent (requiresServerCompletion: false).

  async retrievePayment(pspPaymentId: string): Promise<PaymentInfo> {
    return this.run(async (client) => {
      const pi = await client.paymentIntents.retrieve(pspPaymentId, { expand: ["latest_charge"] });
      return this.toPaymentInfo(pi);
    });
  }

  /**
   * A capture that states `amount` first reads the PaymentIntent (one more
   * request) to send it in Stripe's units for the payment's currency, and
   * refuses one Stripe cannot be sent (see the class notes) before the
   * capture. An earlier release sent such captures unconverted, so the
   * refusal of a UGX amount, or of an MGA amount that is not whole ariary, is
   * marked outcomeUnknown unless the PaymentIntent read is still
   * `requires_capture`, which shows nothing was captured; either way it asks
   * the host to check the Stripe Dashboard under the key before sending
   * another. Without `amount`, Stripe captures its own `amount_capturable`
   * and nothing is read first.
   */
  async capturePayment(
    pspPaymentId: string,
    amount: MinorUnitAmount | undefined,
    idempotencyKey: string,
  ): Promise<PaymentInfo> {
    if (amount !== undefined) assertMinorUnitAmount(amount, "capture amount");
    return this.run(async (client) => {
      let params: Record<string, unknown> = {};
      if (amount !== undefined) {
        const current = await client.paymentIntents.retrieve(pspPaymentId);
        const moved = current.status !== "requires_capture";
        params = {
          amount_to_capture: toStripeAmount(amount, current.currency, {
            label: "amount_to_capture",
            record: {
              ...paymentIntentRecord(current),
              action: "capture",
              remedy: "Check the Stripe Dashboard for a capture under this idempotency key before capturing it there",
              outcomeUnknown: moved,
            },
            sentBefore: { what: "a capture", open: moved },
          }),
        };
      }
      const pi = await client.paymentIntents.capture(pspPaymentId, params, { idempotencyKey });
      return this.toPaymentInfo(pi, { kind: "answer", action: "capture" });
    });
  }

  async cancelPayment(pspPaymentId: string, idempotencyKey: string): Promise<PaymentInfo> {
    return this.run(async (client) => {
      const pi = await client.paymentIntents.cancel(pspPaymentId, {}, { idempotencyKey });
      return this.toPaymentInfo(pi, { kind: "answer", action: "cancellation" });
    });
  }

  /**
   * A refund that states `amount` first reads the PaymentIntent (one more
   * request) to send it in Stripe's units for the payment's currency, and
   * refuses one Stripe cannot be sent (see the class notes) before the
   * refund. An earlier release sent such refunds unconverted, so on the way
   * to refusing a UGX amount, or an MGA amount that is not whole ariary, the
   * adapter lists the PaymentIntent's refunds (GET /v1/refunds, one request
   * more): the refusal is final only when that list is complete and holds
   * nothing but failed or canceled refunds, and is marked outcomeUnknown
   * otherwise, including when the list cannot be read. Either way it asks the
   * host to check the Stripe Dashboard under the key before sending another.
   * A refund that is sent lists nothing. Without `amount`, Stripe refunds what
   * remains and nothing is read first.
   */
  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    if (req.amount !== undefined) assertMinorUnitAmount(req.amount, "refund amount");
    return this.run(async (client) => {
      let amount: number | undefined;
      let paymentCurrency: string | undefined;
      if (req.amount !== undefined) {
        const current = await client.paymentIntents.retrieve(req.pspPaymentId);
        paymentCurrency = current.currency;
        const moved =
          refusesUnconverted(req.amount, current.currency) && (await refundsMayHaveMoved(client, req.pspPaymentId));
        amount = toStripeAmount(req.amount, current.currency, {
          label: "amount",
          record: {
            ...paymentIntentRecord(current),
            action: "refund",
            remedy: "Check the Stripe Dashboard for a refund under this idempotency key before refunding it there",
            outcomeUnknown: moved,
          },
          sentBefore: { what: "a refund", open: moved },
        });
      }
      const refund = await client.refunds.create(
        {
          payment_intent: req.pspPaymentId,
          ...(amount !== undefined ? { amount } : {}),
          // RefundReason is exactly Stripe's own vocabulary — passed through as-is.
          ...(req.reason ? { reason: req.reason } : {}),
        },
        { idempotencyKey: req.idempotencyKey },
      );
      return toRefundResult(refund, { kind: "answer", action: "refund" }, paymentCurrency);
    });
  }

  /** Polls an async refund ("pending" from refundPayment) to its terminal state. */
  async retrieveRefund(refundId: string): Promise<RefundInfo> {
    return this.run(async (client) => {
      const refund = await client.refunds.retrieve(refundId);
      return toRefundInfo(refund);
    });
  }

  /**
   * Missed-webhook recovery over GET /v1/events: the same payload shapes
   * webhooks deliver, normalized by the same mapper — dedupe by event.id works
   * identically for delivered and fetched events. Stripe retains ~30 days.
   */
  async fetchEvents(input: FetchEventsInput = {}): Promise<FetchEventsResult> {
    const params: Record<string, unknown> = {
      limit: clampPageSize(input.limit),
      ...(input.since !== undefined ? { created: { gte: toEpochSeconds(input.since, "since") } } : {}),
      ...(input.cursor ? { starting_after: input.cursor } : {}),
    };
    return this.run(async (client) => {
      const page = await client.events.list(params);
      const events: UnifiedWebhookEvent[] = page.data.map((event) => stripeEventBodyToUnified(event));
      const last = page.data[page.data.length - 1];
      return { events, ...(page.has_more && last ? { nextCursor: last.id } : {}) };
    });
  }

  /**
   * A page holding a PaymentIntent whose amounts cannot be reported (UGX, or
   * an ISK amount that is not a multiple of 100) fails whole with
   * `unsupported_operation`: `raw.records` names each such PaymentIntent, and
   * `raw.nextCursor` is the cursor the page would have carried, so later
   * pages stay reachable (a `limit` of 1 steps past each one).
   */
  async listPayments(input: ListPaymentsInput = {}): Promise<ListPaymentsResult> {
    const params: Record<string, unknown> = {
      limit: clampPageSize(input.limit),
      ...createdRange(input),
      ...(input.cursor ? { starting_after: input.cursor } : {}),
      expand: ["data.latest_charge"], // amountRefunded lives on the charge
    };
    return this.run(async (client) => {
      const page = await client.paymentIntents.list(params);
      const nextCursor = pageCursor(page);
      assertReportablePage(
        page.data.map((pi) => ({ id: pi.id, currency: pi.currency, amounts: Object.values(paymentIntentAmounts(pi)) })),
        "PaymentIntent",
        nextCursor,
      );
      const payments = page.data.map((pi) => this.toPaymentInfo(pi));
      return { payments, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    });
  }

  /** A page holding a refund whose amount cannot be reported fails whole, as listPayments describes. */
  async listRefunds(input: ListRefundsInput = {}): Promise<ListRefundsResult> {
    const params: Record<string, unknown> = {
      limit: clampPageSize(input.limit),
      ...(input.pspPaymentId ? { payment_intent: input.pspPaymentId } : {}),
      ...createdRange(input),
      ...(input.cursor ? { starting_after: input.cursor } : {}),
    };
    return this.run(async (client) => {
      const page = await client.refunds.list(params);
      const nextCursor = pageCursor(page);
      assertReportablePage(
        page.data.map((refund) => ({ id: refund.id, currency: refund.currency, amounts: [refund.amount] })),
        "refund",
        nextCursor,
      );
      const refunds = page.data.map((refund) => toRefundInfo(refund));
      return { refunds, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    });
  }

  // --- PSP-native subscriptions (Stripe Billing) --------------------------

  /**
   * Pages GET /v1/subscriptions. Stripe's default listing is what this
   * returns: every subscription that has NOT been canceled (canceled ones are
   * excluded unless queried directly by id) — the live set an adoption flow
   * needs, newest first. A page holding a subscription whose installment
   * cannot be reported fails whole, as listPayments describes.
   */
  async listNativeSubscriptions(input: ListNativeSubscriptionsInput = {}): Promise<ListNativeSubscriptionsResult> {
    const params: Record<string, unknown> = {
      limit: clampPageSize(input.limit),
      ...(input.cursor ? { starting_after: input.cursor } : {}),
    };
    return this.run(async (client) => {
      const page = await client.subscriptions.list(params);
      const nextCursor = pageCursor(page);
      assertReportablePage(
        page.data.map((sub) => ({ id: sub.id, currency: subscriptionCurrency(sub), amounts: [installment(sub)] })),
        "subscription",
        nextCursor,
      );
      const subscriptions = page.data.map((sub) => this.toNativeSubscription(sub));
      return { subscriptions, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    });
  }

  /** Stripe keys subscriptions by id alone — `savedPaymentMethodToken` is not needed and ignored. */
  async retrieveNativeSubscription(input: RetrieveNativeSubscriptionInput): Promise<NativeSubscriptionRecord> {
    return this.run(async (client) => this.toNativeSubscription(await client.subscriptions.retrieve(input.subscriptionId)));
  }

  /**
   * POST /v1/subscriptions against `customer` + `default_payment_method` (the
   * vaulted token — it must belong to that customer, so `pspCustomerId` is
   * required here). `planId` (when given) is an existing Stripe Price id;
   * without one the adapter builds the price inline via `items[].price_data`,
   * which requires an existing Product — created on the fly (name
   * `merchantRefNum`, falling back to "Subscription"; it shows on customer
   * invoices) under a derived idempotency key so replays reuse it.
   * `off_session: true` + `payment_behavior: "error_if_incomplete"`: a first
   * invoice that cannot be paid rejects with the mapped card error instead of
   * leaving an incomplete subscription behind — server-only creation has no
   * customer present to finish authentication. `startAt` maps to a future
   * `billing_cycle_anchor` with `proration_behavior: "none"`, making the span
   * until the anchor free and the first full invoice due at `startAt`.
   */
  async createNativeSubscription(input: CreateNativeSubscriptionInput): Promise<NativeSubscriptionRecord> {
    if (!input.pspCustomerId) {
      throw PayFanoutError.invalidRequest(
        "Stripe subscriptions belong to a customer — pspCustomerId is required (create one with createCustomer first)",
      );
    }
    if (input.schedule !== undefined) {
      throw PayFanoutError.invalidRequest(
        "Stripe subscriptions accept no RRULE schedule — express the cadence as interval (+ optional intervalCount)",
      );
    }
    if (!input.interval) {
      throw PayFanoutError.invalidRequest("createNativeSubscription requires interval (day, week, month, or year)");
    }
    if (input.intervalCount !== undefined && (!Number.isInteger(input.intervalCount) || input.intervalCount < 1)) {
      throw PayFanoutError.invalidRequest("intervalCount must be a positive integer");
    }
    assertMinorUnitAmount(input.amount, "amount");
    if (input.amount === 0) {
      throw PayFanoutError.invalidRequest("createNativeSubscription requires a positive amount");
    }
    const currency = normalizeCurrency(input.currency);
    // Checked with a planId too, though that path sends the Price's own amount.
    const unitAmount = toStripeAmount(input.amount, currency, {
      label: "amount",
      sentBefore: { what: "a subscription", open: true },
    });
    assertThreeDecimalRule(input.amount, currency);
    const anchor = input.startAt !== undefined ? toEpochSeconds(input.startAt, "startAt") : undefined;
    const metadata = withMerchantRef(input.metadata, input.merchantRefNum);

    return this.run(async (client) => {
      let item: Record<string, unknown>;
      if (input.planId) {
        item = { price: input.planId };
      } else {
        const product = await client.products.create(
          { name: input.merchantRefNum ?? "Subscription" },
          { idempotencyKey: `${input.idempotencyKey}-product` },
        );
        item = {
          price_data: {
            currency: currency.toLowerCase(),
            product: product.id,
            recurring: {
              interval: input.interval,
              ...(input.intervalCount !== undefined ? { interval_count: input.intervalCount } : {}),
            },
            unit_amount: unitAmount,
          },
        };
      }
      const sub = await client.subscriptions.create(
        {
          customer: input.pspCustomerId,
          items: [item],
          default_payment_method: input.savedPaymentMethodToken,
          off_session: true,
          payment_behavior: "error_if_incomplete",
          ...(anchor !== undefined ? { billing_cycle_anchor: anchor, proration_behavior: "none" } : {}),
          ...(metadata ? { metadata } : {}),
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return this.toNativeSubscription(sub, { kind: "answer", action: "subscription creation" });
    });
  }

  /**
   * DELETE /v1/subscriptions/:id — immediate cancellation. Stripe ignores
   * idempotency keys on DELETE ("no effect" per its idempotency docs), so
   * none is sent; replay safety is verified instead: when the cancel call
   * rejects, the subscription is re-fetched and an already-canceled one
   * resolves as success — a replayed cancel can never fail on its own
   * earlier success. A UGX subscription is cancelled all the same, but its
   * record cannot be reported: the call rejects with `unsupported_operation`
   * marked outcomeUnknown.
   */
  async cancelNativeSubscription(input: CancelNativeSubscriptionInput): Promise<NativeSubscriptionRecord> {
    return this.run(async (client) => {
      let sub: StripeSubscriptionLike;
      try {
        sub = await client.subscriptions.cancel(input.subscriptionId);
      } catch (err) {
        let current: StripeSubscriptionLike | undefined;
        try {
          current = await client.subscriptions.retrieve(input.subscriptionId);
        } catch {
          // The re-fetch adds nothing here — surface the original cancel error below.
        }
        if (current === undefined || mapSubscriptionStatus(current.status) !== "canceled") throw mapStripeError(err);
        sub = current;
      }
      return this.toNativeSubscription(sub, { kind: "answer", action: "cancellation" });
    });
  }

  /**
   * Zero-amount verification via SetupIntent (§8 option a). A succeeded
   * SetupIntent attaches a PaymentMethod, which collides with no-vaulting —
   * so the PaymentMethod is detached on EVERY path (success, failed
   * verification, or error) before this method returns.
   */
  async verifyPaymentMethod(input: VerifyPaymentMethodInput): Promise<PaymentInfo> {
    if (!this.verificationEnabled()) {
      throw PayFanoutError.invalidRequest(
        "Payment method verification is disabled for this Stripe adapter (verifyPaymentMethodStrategy: 'disabled')",
      );
    }
    const client = await this.getClient();
    let seti: StripeSetupIntentLike | undefined;
    let primaryError: unknown;
    try {
      seti = await client.setupIntents.retrieve(input.pspSessionId);
    } catch (err) {
      primaryError = err;
    }

    const paymentMethodId =
      typeof seti?.payment_method === "string" ? seti.payment_method : seti?.payment_method?.id;
    // SAVE-mode SetupIntents (created with a customer) KEEP the
    // instrument vaulted — the whole point. Detach applies only to customer-less
    // verification, where storage would violate the caller's intent.
    const saveMode = Boolean(seti?.customer);
    if (saveMode && seti) {
      return {
        id: seti.metadata?.payfanout_id ?? seti.id,
        pspName: this.pspName,
        pspPaymentId: seti.id,
        status: seti.status === "succeeded" ? "succeeded" : seti.last_setup_error ? "failed" : mapSetupIntentStatus(seti),
        amount: 0,
        amountRefunded: 0,
        currency: "USD",
        paymentMethodType: "card",
        ...(seti.status === "succeeded" && paymentMethodId
          ? { savedPaymentMethodToken: paymentMethodId }
          : {}),
        createdAt: new Date(seti.created * 1000).toISOString(),
        raw: seti,
      };
    }

    // Guaranteed detach — the "finally" of this flow, without clobbering errors.
    if (paymentMethodId) {
      try {
        await client.paymentMethods.detach(paymentMethodId);
      } catch (detachErr) {
        // A PaymentMethod that was never attached to a customer (our SetupIntents
        // are customer-less) cannot be detached — nothing is stored, constraint met.
        if (!isNotAttachedError(detachErr)) {
          primaryError ??= new PayFanoutError({
            code: "processing_error",
            message:
              "Verification completed but detaching the temporary payment method failed — detach it manually to honor the no-vaulting constraint",
            retryable: true,
            raw: detachErr,
            pspName: this.pspName,
          });
        }
      }
    }
    if (primaryError) throw mapStripeError(primaryError);
    if (!seti) throw mapStripeError(new Error("SetupIntent could not be retrieved"));

    return {
      id: seti.metadata?.payfanout_id ?? seti.id,
      pspName: this.pspName,
      pspPaymentId: seti.id,
      status: seti.status === "succeeded" ? "succeeded" : seti.last_setup_error ? "failed" : mapSetupIntentStatus(seti),
      amount: 0,
      amountRefunded: 0,
      currency: "USD", // verification is amountless; currency is not meaningful here
      paymentMethodType: "card",
      createdAt: new Date(seti.created * 1000).toISOString(),
      raw: seti,
    };
  }

  // --- Vaulting / recurring surface (PSP-side storage only) ---------------

  async createCustomer(input: CreateCustomerInput): Promise<CustomerRef> {
    const metadata = withPayfanoutId(input.metadata, input.id);
    return this.run(async (client) => {
      const customer = await client.customers.create(
        {
          ...(input.email ? { email: input.email } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(metadata ? { metadata } : {}),
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return {
        pspName: this.pspName,
        pspCustomerId: customer.id,
        ...(input.id ? { id: input.id } : {}),
        raw: customer,
      };
    });
  }

  // Stripe has no savePaymentMethod: confirm-on-client PSPs vault during
  // checkout (session `customer` + `savePaymentMethod`) — the method is
  // absent, and PaymentService explains that to callers.

  async listSavedPaymentMethods(pspCustomerId: string): Promise<SavedPaymentMethod[]> {
    return this.run(async (client) => {
      // Stripe pages at 100 max; a customer can hold more — follow has_more so
      // no vaulted instrument is silently truncated away.
      const methods: SavedPaymentMethod[] = [];
      let startingAfter: string | undefined;
      do {
        const page = await client.customers.listPaymentMethods(pspCustomerId, {
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
        for (const pm of page.data) methods.push(toSavedPaymentMethod(this.pspName, pspCustomerId, pm));
        startingAfter = page.has_more ? page.data[page.data.length - 1]?.id : undefined;
      } while (startingAfter);
      return methods;
    });
  }

  async deleteSavedPaymentMethod(pspCustomerId: string, token: string): Promise<void> {
    return this.run(async (client) => {
      // Ownership check: never detach an instrument belonging to a different
      // customer because a host mixed its ids up.
      const pm = await client.paymentMethods.retrieve(token);
      const owner = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
      if (owner !== pspCustomerId) {
        throw PayFanoutError.invalidRequest(
          `Payment method "${token}" does not belong to customer "${pspCustomerId}"`,
          pm,
        );
      }
      await client.paymentMethods.detach(token);
    });
  }

  /**
   * Off-session (merchant-initiated) charge of a vaulted instrument. The
   * networks' credential-on-file rules ride the off_session flag; a bank
   * demanding authentication surfaces as `authentication_required`
   * (retryable ONLY by bringing the customer back on-session).
   */
  async chargeSavedPaymentMethod(input: ChargeSavedPaymentMethodInput): Promise<PaymentInfo> {
    assertMinorUnitAmount(input.amount, "amount");
    const currency = normalizeCurrency(input.currency);
    const amount = toStripeAmount(input.amount, currency, {
      label: "amount",
      sentBefore: { what: "a charge", open: true },
    });
    assertThreeDecimalRule(input.amount, currency);
    const metadata = withPayfanoutId(input.metadata, input.id);
    return this.run(async (client) => {
      const pi = await client.paymentIntents.create(
        {
          amount,
          currency: currency.toLowerCase(),
          customer: input.pspCustomerId,
          payment_method: input.savedPaymentMethodToken,
          confirm: true,
          // Without this, dashboard-enabled redirect methods would force a
          // return_url on confirm — a stored-token charge never redirects.
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
          // "initial" = customer present for the agreement's first charge (CIT);
          // everything else is merchant-initiated (MIT).
          off_session: (input.occurrence ?? "recurring") !== "initial",
          ...(metadata ? { metadata } : {}),
          ...checkoutFieldParams({ statementDescriptor: input.statementDescriptor }),
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return this.toPaymentInfo(pi, { kind: "answer", action: "charge" });
    });
  }

  /**
   * "Test connection" probe: one read-only GET /v1/events, classified so a host
   * UI can tell a bad key (`auth`) from a transient outage (`network`). Returns a
   * result on every path instead of throwing, and never surfaces the credential.
   */
  async verifyCredentials(): Promise<VerifyCredentialsResult> {
    try {
      const client = await this.getClient();
      await client.events.list({ limit: 1 });
      return { ok: true };
    } catch (err) {
      const e = (err ?? {}) as { type?: string; statusCode?: number };
      if (
        e.statusCode === 401 ||
        e.statusCode === 403 ||
        e.type === "StripeAuthenticationError" ||
        e.type === "StripePermissionError"
      ) {
        return { ok: false, category: "auth", message: "Authentication failed — check the Stripe secret key." };
      }
      // StripeAPIError covers unlisted statuses, non-JSON bodies and, from stripe 22.6, a body
      // severed mid-transfer; the error map already treats it as a retryable outage.
      if (
        e.type === "StripeConnectionError" ||
        e.type === "StripeAPIError" ||
        e.statusCode === 429 ||
        (e.statusCode ?? 0) >= 500
      ) {
        return { ok: false, category: "network", message: "Could not reach Stripe — try again." };
      }
      return { ok: false, category: "internal", message: "Could not verify Stripe credentials." };
    }
  }

  async verifyWebhookSignature(rawBody: string, headers: Record<string, string>): Promise<boolean> {
    return verifyStripeWebhookSignature(
      rawBody,
      lowercaseKeys(headers),
      normalizeSecrets(this.config.webhookSigningSecret),
      this.config.webhookToleranceSeconds ?? 300,
      (this.config.now ?? Date.now)(),
    );
  }

  async parseWebhookEvent(rawBody: string): Promise<UnifiedWebhookEvent> {
    return parseStripeWebhookEvent(rawBody);
  }

  /**
   * amount === 0 -> SetupIntent-backed session (client confirms with
   * confirmSetup). Two modes: verification (no customer — the PaymentMethod is
   * detached afterwards) and SAVE (customer + savePaymentMethod — the
   * instrument stays vaulted, usage "off_session" for future MIT charges).
   */
  private async createVerificationSession(
    input: CreatePaymentSessionInput,
    currency: string,
  ): Promise<PaymentSession> {
    const metadata = withPayfanoutId(input.metadata, input.id);
    const saveMode = Boolean(input.savePaymentMethod && input.customer);
    return this.run(async (client) => {
      const seti = await client.setupIntents.create(
        {
          ...(metadata ? { metadata } : {}),
          ...(saveMode ? { customer: input.customer, usage: "off_session" } : {}),
          ...this.paymentMethodParams(input.paymentMethodTypes),
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return {
        id: input.id ?? seti.id,
        pspName: this.pspName,
        pspSessionId: seti.id,
        clientSecret: seti.client_secret ?? undefined,
        amount: 0,
        currency,
        status: mapSetupIntentStatus(seti),
        ...(metadata ? { metadata } : {}),
      };
    });
  }

  private toPaymentSession(
    pi: StripePaymentIntentLike,
    payfanoutId: string | undefined,
    metadata: Record<string, string> | undefined,
    use: RecordUse,
  ): PaymentSession {
    const { amount } = readStripeAmounts(paymentIntentRecord(pi), { amount: pi.amount }, use);
    return {
      id: payfanoutId ?? pi.metadata?.payfanout_id ?? pi.id,
      pspName: this.pspName,
      pspSessionId: pi.id,
      clientSecret: pi.client_secret ?? undefined,
      amount,
      currency: pi.currency.toUpperCase(),
      status: mapPaymentIntentStatus(pi),
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  }

  /**
   * `currency` is present on the PaymentIntent path only: an explicit
   * `payment_method_types` entry that cannot settle the intent currency is
   * dropped before the call, using the same declared per-method gates
   * screening reads (config overrides included), so the drop is inspectable
   * via getCapabilities(), never a PSP-side surprise. SetupIntents are
   * currencyless — the verification path passes no currency and narrows
   * nothing.
   */
  private paymentMethodParams(types?: UnifiedPaymentMethodType[], currency?: string): Record<string, unknown> {
    if (!types || types.length === 0) {
      // Embedded-first default: let Stripe choose, but never a full-page redirect.
      return { automatic_payment_methods: { enabled: true, allow_redirects: "never" } };
    }
    const methods = this.getCapabilities().paymentMethods;
    const eligible = !currency
      ? types
      : types.filter((type) => {
          const declared = methods.find((m) => m.type === type)?.currencies;
          return !declared?.length || declared.some((c) => c.toUpperCase() === currency);
        });
    if (eligible.length === 0) {
      throw PayFanoutError.invalidRequest(
        `None of the requested payment method types can settle in ${String(currency)}: ${types.join(", ")}`,
      );
    }
    const mapped = new Set<string>();
    for (const type of eligible) {
      const stripeType = METHOD_TYPE_TO_STRIPE[type];
      if (!stripeType) {
        throw PayFanoutError.invalidRequest(`Stripe adapter does not support payment method type "${type}"`);
      }
      mapped.add(stripeType);
    }
    return { payment_method_types: [...mapped] };
  }

  private toPaymentInfo(pi: StripePaymentIntentLike, use: RecordUse = { kind: "read" }): PaymentInfo {
    const charge = expandedCharge(pi);
    const chargeType = charge?.payment_method_details?.type;
    const methodDetails = toPaymentMethodDetails(charge);
    const mandateReference = extractMandate(charge);
    // Session vaulted the instrument -> hand the host the token to store.
    const chargedWith =
      typeof charge?.payment_method === "string" ? charge.payment_method : charge?.payment_method?.id;
    const savedPaymentMethodToken = pi.setup_future_usage && chargedWith ? chargedWith : undefined;
    const { amount, amountRefunded, amountCaptured, amountCapturable } = readStripeAmounts(
      paymentIntentRecord(pi),
      paymentIntentAmounts(pi),
      use,
    );
    return {
      id: pi.metadata?.payfanout_id ?? pi.id,
      pspName: this.pspName,
      pspPaymentId: pi.id,
      status: mapPaymentIntentStatus(pi),
      amount,
      amountRefunded,
      ...(amountCaptured !== undefined ? { amountCaptured } : {}),
      ...(amountCapturable !== undefined ? { amountCapturable } : {}),
      currency: pi.currency.toUpperCase(),
      paymentMethodType:
        (chargeType ? STRIPE_CHARGE_TYPE_TO_UNIFIED[chargeType] : undefined) ??
        (pi.payment_method_types?.[0] ? STRIPE_CHARGE_TYPE_TO_UNIFIED[pi.payment_method_types[0]] : undefined) ??
        "other",
      ...(pi.metadata && Object.keys(pi.metadata).length > 0 ? { metadata: pi.metadata } : {}),
      ...(methodDetails ? { paymentMethodDetails: methodDetails } : {}),
      ...(mandateReference ? { mandateReference } : {}),
      ...(savedPaymentMethodToken ? { savedPaymentMethodToken } : {}),
      createdAt: new Date(pi.created * 1000).toISOString(),
      // Stripe does not report a capture timestamp on the PI; left undefined.
      raw: pi,
    };
  }

  /**
   * Unified projection of a Stripe subscription. Amount is the per-installment
   * total: Σ price.unit_amount × quantity over the items — tiered/custom
   * prices (unit_amount null) and metered prices (billed by reported usage)
   * have no fixed installment and contribute 0 rather than an invented one;
   * `raw` keeps the truth. The total is converted from Stripe's units into
   * PayFanout's minor units (ISK and MGA differ; a UGX subscription cannot be
   * reported). Cadence comes from the first item's price (Stripe
   * holds every item on a subscription to one shared billing interval).
   * Period bounds read the subscription's own current_period_* (API versions
   * before 2025-03-31.basil, the pinned 2024-06-20 included) and fall back to
   * the first item's (basil moved them there).
   */
  private toNativeSubscription(
    sub: StripeSubscriptionLike,
    use: RecordUse = { kind: "read" },
  ): NativeSubscriptionRecord {
    const items = sub.items?.data ?? [];
    const first = items[0];
    const price = first?.price ?? undefined;
    const { amount } = readStripeAmounts(
      { subject: `Subscription ${sub.id}`, currency: subscriptionCurrency(sub), raw: sub },
      { amount: installment(sub) },
      use,
    );
    const recurring = price?.recurring ?? undefined;
    const interval =
      recurring?.interval && (NATIVE_SUBSCRIPTION_INTERVALS as readonly string[]).includes(recurring.interval)
        ? (recurring.interval as NativeSubscriptionInterval)
        : undefined;
    const periodStart = sub.current_period_start ?? first?.current_period_start;
    const periodEnd = sub.current_period_end ?? first?.current_period_end;
    const pspCustomerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
    const token =
      typeof sub.default_payment_method === "string" ? sub.default_payment_method : sub.default_payment_method?.id;
    const merchantRefNum = sub.metadata?.[MERCHANT_REF_METADATA_KEY];
    return {
      id: sub.id,
      pspName: this.pspName,
      status: mapSubscriptionStatus(sub.status),
      amount,
      currency: (sub.currency ?? price?.currency ?? "").toUpperCase(),
      ...(interval ? { interval } : {}),
      ...(interval && recurring?.interval_count !== undefined ? { intervalCount: recurring.interval_count } : {}),
      ...(periodStart !== undefined ? { currentPeriodStart: new Date(periodStart * 1000).toISOString() } : {}),
      ...(periodEnd !== undefined ? { currentPeriodEnd: new Date(periodEnd * 1000).toISOString() } : {}),
      ...(token ? { savedPaymentMethodToken: token } : {}),
      ...(pspCustomerId ? { pspCustomerId } : {}),
      ...(merchantRefNum ? { merchantRefNum } : {}),
      ...(price ? { planId: price.id } : {}),
      raw: sub,
    };
  }

  private verificationEnabled(): boolean {
    return (this.config.verifyPaymentMethodStrategy ?? "setup_intent_detach") !== "disabled";
  }

  private getClient(): Promise<StripeClientLike> {
    this.clientPromise ??= this.config.client
      ? Promise.resolve(this.config.client)
      : loadStripeSdk(this.config);
    return this.clientPromise;
  }

  private async run<T>(fn: (client: StripeClientLike) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    try {
      return await fn(client);
    } catch (err) {
      throw mapStripeError(err);
    }
  }
}

function mapPaymentIntentStatus(pi: StripePaymentIntentLike): UnifiedPaymentStatus {
  // A failed attempt drops the PI back to requires_payment_method with
  // last_payment_error set — surface that as "failed".
  if (pi.status === "requires_payment_method" && pi.last_payment_error) return "failed";
  return pi.status;
}

function mapSetupIntentStatus(seti: StripeSetupIntentLike): UnifiedPaymentStatus {
  return seti.status;
}

function withPayfanoutId(
  metadata: Record<string, string> | undefined,
  id: string | undefined,
): Record<string, string> | undefined {
  if (!id) return metadata;
  return { ...metadata, payfanout_id: id };
}

/**
 * Stripe subscriptions have no dedicated merchant-reference field (the
 * `description` is customer-facing), so `merchantRefNum` rides metadata under
 * this key and is echoed back from it on every read.
 */
const MERCHANT_REF_METADATA_KEY = "payfanout_merchant_ref";

function withMerchantRef(
  metadata: Record<string, string> | undefined,
  merchantRefNum: string | undefined,
): Record<string, string> | undefined {
  if (!merchantRefNum) return metadata;
  return { ...metadata, [MERCHANT_REF_METADATA_KEY]: merchantRefNum };
}

/**
 * Stripe subscription statuses onto the unified vocabulary. Every wire value
 * is mapped deliberately:
 *  - incomplete: awaiting its first successful invoice payment (23-hour
 *    window) -> "pending".
 *  - incomplete_expired: that window lapsed — terminal, invoice voided,
 *    nothing was ever billed -> "canceled".
 *  - unpaid: retries exhausted, invoicing continues but collection stopped
 *    pending intervention -> "past_due" (still owed, not terminated).
 *  - paused: Stripe's paused state (trial ended without a payment method);
 *    resumable, no invoices while paused -> "paused".
 * Stripe has no finite-installment plans, so nothing maps to "completed";
 * unrecognized values fall through to "unknown", never dropped.
 */
const STRIPE_SUBSCRIPTION_STATUS_TO_UNIFIED: Record<string, NativeSubscriptionStatus> = {
  incomplete: "pending",
  incomplete_expired: "canceled",
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "past_due",
  canceled: "canceled",
  paused: "paused",
};

function mapSubscriptionStatus(status: string): NativeSubscriptionStatus {
  return STRIPE_SUBSCRIPTION_STATUS_TO_UNIFIED[status] ?? "unknown";
}

/**
 * statementDescriptor -> statement_descriptor_suffix: on card charges Stripe
 * composes <account prefix>* <suffix>; the standalone statement_descriptor
 * param is rejected for cards on modern API versions. 22 chars is the network
 * ceiling for the composed text — enforced here so the failure is immediate
 * and local, not a PSP roundtrip later.
 */
function checkoutFieldParams(
  input: Pick<CreatePaymentSessionInput, "statementDescriptor" | "receiptEmail" | "shippingDetails">,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (input.statementDescriptor !== undefined) {
    const suffix = input.statementDescriptor.trim();
    if (suffix.length === 0 || suffix.length > 22 || /[<>\\'"*]/.test(suffix)) {
      throw PayFanoutError.invalidRequest(
        "statementDescriptor must be 1-22 characters and cannot contain < > \\ ' \" *",
      );
    }
    params["statement_descriptor_suffix"] = suffix;
  }
  if (input.receiptEmail !== undefined) params["receipt_email"] = input.receiptEmail;
  if (input.shippingDetails !== undefined) params["shipping"] = toStripeShipping(input.shippingDetails);
  return params;
}

function toStripeShipping(shipping: ShippingDetails): Record<string, unknown> {
  if (!shipping.name) {
    // Stripe hard-requires a recipient name on the shipping hash.
    throw PayFanoutError.invalidRequest("Stripe requires shippingDetails.name when shipping details are sent");
  }
  const address = shipping.address ?? {};
  return {
    name: shipping.name,
    ...(shipping.phone ? { phone: shipping.phone } : {}),
    address: {
      ...(address.line1 ? { line1: address.line1 } : {}),
      ...(address.line2 ? { line2: address.line2 } : {}),
      ...(address.city ? { city: address.city } : {}),
      ...(address.state ? { state: address.state } : {}),
      ...(address.postalCode ? { postal_code: address.postalCode } : {}),
      ...(address.country ? { country: address.country } : {}),
    },
  };
}

/** SCA tuning rides payment_method_options.card — absent unless the host asked for something. */
function scaParams(sca: ScaPreference | undefined): Record<string, unknown> {
  if (!sca) return {};
  const card: Record<string, unknown> = {};
  if (sca.challenge === "force") card["request_three_d_secure"] = "challenge";
  if (sca.exemption === "moto") card["moto"] = true;
  return Object.keys(card).length > 0 ? { payment_method_options: { card } } : {};
}

function toSavedPaymentMethod(
  pspName: string,
  pspCustomerId: string,
  pm: StripePaymentMethodLike,
): SavedPaymentMethod {
  const details: PaymentMethodDetails = {
    ...(pm.card?.brand ? { brand: pm.card.brand.toLowerCase() } : {}),
    ...(pm.card?.last4 ? { last4: pm.card.last4 } : {}),
    ...(pm.card?.exp_month ? { expMonth: pm.card.exp_month } : {}),
    ...(pm.card?.exp_year ? { expYear: pm.card.exp_year } : {}),
  };
  return {
    token: pm.id,
    pspName,
    pspCustomerId,
    paymentMethodType: pm.type && STRIPE_CHARGE_TYPE_TO_UNIFIED[pm.type] ? STRIPE_CHARGE_TYPE_TO_UNIFIED[pm.type]! : "card",
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...(pm.created ? { createdAt: new Date(pm.created * 1000).toISOString() } : {}),
    raw: pm,
  };
}

/**
 * `paymentCurrency` stands in for a refund that states no currency of its
 * own, which Stripe's Refund object always does.
 */
function toRefundResult(refund: StripeRefundLike, use: RecordUse, paymentCurrency?: string): RefundResult {
  const status: RefundResult["status"] =
    refund.status === "succeeded" ? "succeeded"
    : refund.status === "failed" || refund.status === "canceled" ? "failed"
    : "pending";
  const { amount } = readStripeAmounts(
    { subject: `Refund ${refund.id}`, currency: refund.currency ?? paymentCurrency, raw: refund },
    { amount: refund.amount },
    use,
  );
  return { refundId: refund.id, status, amount, raw: refund };
}

function toRefundInfo(refund: StripeRefundLike): RefundInfo {
  const pspPaymentId =
    typeof refund.payment_intent === "string" ? refund.payment_intent : refund.payment_intent?.id;
  return {
    ...toRefundResult(refund, { kind: "read" }),
    ...(pspPaymentId ? { pspPaymentId } : {}),
    ...(refund.created ? { createdAt: new Date(refund.created * 1000).toISOString() } : {}),
  };
}

function expandedCharge(pi: StripePaymentIntentLike): StripeChargeLike | undefined {
  return typeof pi.latest_charge === "object" && pi.latest_charge !== null ? pi.latest_charge : undefined;
}

function paymentIntentRecord(pi: StripePaymentIntentLike): StripeRecord {
  return { subject: `PaymentIntent ${pi.id}`, currency: pi.currency, raw: pi };
}

/** The Stripe amounts toPaymentInfo reports, by PaymentInfo field; list pages check the same ones. */
function paymentIntentAmounts(pi: StripePaymentIntentLike) {
  return {
    // After a (partial) capture Stripe keeps `amount` at the authorized value;
    // the money actually collected is amount_received. Refund state must be
    // derived against collected funds, so that wins once it exists.
    amount: pi.amount_received && pi.amount_received > 0 ? pi.amount_received : pi.amount,
    amountRefunded: expandedCharge(pi)?.amount_refunded ?? 0,
    amountCaptured: pi.amount_received,
    amountCapturable: pi.amount_capturable,
  };
}

/**
 * The per-installment total in Stripe's units: Σ price.unit_amount ×
 * quantity, skipping prices with no unit amount and metered ones (see
 * toNativeSubscription).
 */
function installment(sub: StripeSubscriptionLike): number {
  let total = 0;
  for (const item of sub.items?.data ?? []) {
    if (typeof item.price?.unit_amount !== "number") continue;
    if (item.price.recurring?.usage_type === "metered") continue;
    total += item.price.unit_amount * (item.quantity ?? 1);
  }
  return total;
}

function subscriptionCurrency(sub: StripeSubscriptionLike): string | undefined {
  return sub.currency ?? sub.items?.data[0]?.price?.currency;
}

function pageCursor(page: StripeListLike<{ id: string }>): string | undefined {
  const last = page.data[page.data.length - 1];
  return page.has_more && last ? last.id : undefined;
}

/**
 * Whether refunds may already have moved money on a PaymentIntent. Only a
 * complete list of its refunds (`has_more` false) holding nothing but failed
 * or canceled ones, or none, shows that none did: a pending or
 * `requires_action` refund may still move money, and Stripe does not say
 * whether a charge's `amount_refunded` counts it.
 */
async function refundsMayHaveMoved(client: StripeClientLike, paymentIntent: string): Promise<boolean> {
  try {
    const page = await client.refunds.list({ payment_intent: paymentIntent, limit: 100 });
    return page.has_more !== false || page.data.some((r) => r.status !== "failed" && r.status !== "canceled");
  } catch {
    // A list that cannot be read shows nothing, so the refusal stays open.
    return true;
  }
}

/** Stripe list endpoints accept 1-100. */
function clampPageSize(limit: number | undefined): number {
  if (limit === undefined) return 100;
  return Math.min(100, Math.max(1, Math.trunc(limit)));
}

function toEpochSeconds(value: string | Date, field: string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(ms)) {
    throw PayFanoutError.invalidRequest(`${field} must be a Date or an ISO 8601 string, got "${String(value)}"`);
  }
  return Math.floor(ms / 1000);
}

function createdRange(input: { createdAfter?: string | Date; createdBefore?: string | Date }): Record<string, unknown> {
  const created: Record<string, number> = {};
  if (input.createdAfter !== undefined) created["gte"] = toEpochSeconds(input.createdAfter, "createdAfter");
  if (input.createdBefore !== undefined) created["lte"] = toEpochSeconds(input.createdBefore, "createdBefore");
  return Object.keys(created).length > 0 ? { created } : {};
}

/** "Visa •••• 4242"-grade display facts from the charge — never enough to charge with. */
function toPaymentMethodDetails(charge: StripeChargeLike | undefined): PaymentMethodDetails | undefined {
  const card = charge?.payment_method_details?.card;
  if (!card) return undefined;
  const details: PaymentMethodDetails = {
    ...(card.brand ? { brand: card.brand.toLowerCase() } : {}),
    ...(card.last4 ? { last4: card.last4 } : {}),
    ...(card.wallet?.type ? { wallet: card.wallet.type } : {}),
    ...(card.exp_month ? { expMonth: card.exp_month } : {}),
    ...(card.exp_year ? { expYear: card.exp_year } : {}),
  };
  return Object.keys(details).length > 0 ? details : undefined;
}

/** Debit rails (sepa_debit / us_bank_account / bacs_debit) report their mandate under their own key. */
function extractMandate(charge: StripeChargeLike | undefined): string | undefined {
  const details = charge?.payment_method_details;
  const rail = details?.type;
  if (!details || !rail) return undefined;
  const railDetails = details[rail];
  if (railDetails && typeof railDetails === "object" && "mandate" in railDetails) {
    const mandate = (railDetails as { mandate?: unknown }).mandate;
    return typeof mandate === "string" && mandate.length > 0 ? mandate : undefined;
  }
  return undefined;
}

/** Stripe: "The payment method ... is not attached to a customer so detachment is impossible." */
function isNotAttachedError(err: unknown): boolean {
  const e = err as { type?: string; message?: string } | undefined;
  return e?.type === "StripeInvalidRequestError" && /not attached/i.test(e?.message ?? "");
}

async function loadStripeSdk(config: StripeServerAdapterConfig): Promise<StripeClientLike> {
  const mod = (await import("stripe")) as unknown as { default: new (key: string, opts: object) => unknown };
  const StripeCtor = mod.default;
  return new StripeCtor(config.secretKey, {
    // Pinned apiVersion: never rely on the account default, which changes silently.
    apiVersion: config.apiVersion,
    // Retried POSTs reuse one idempotency key and the SDK backs off on its own; subscriptions.cancel
    // (a DELETE, where keys have no effect) is made replay-safe by its re-fetch instead.
    maxNetworkRetries: config.maxNetworkRetries ?? 2,
    // Bounds each request (headers and body); unset, the SDK's own 80s default applies.
    ...(config.requestTimeoutMs !== undefined ? { timeout: config.requestTimeoutMs } : {}),
  }) as StripeClientLike;
}
