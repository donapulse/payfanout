import {
  assertMinorUnitAmount,
  getCurrencyExponent,
  lowercaseKeys,
  normalizeCurrency,
  normalizeSecrets,
  PayFanoutError,
  type AdapterCapabilities,
  type ChargeSavedPaymentMethodInput,
  type CreateCustomerInput,
  type CreatePaymentSessionInput,
  type CustomerRef,
  type FetchEventsInput,
  type FetchEventsResult,
  type ListPaymentsInput,
  type ListPaymentsResult,
  type ListRefundsInput,
  type ListRefundsResult,
  type MinorUnitAmount,
  type PaymentInfo,
  type PaymentMethodCapability,
  type PaymentMethodDetails,
  type PaymentSession,
  type RefundInfo,
  type RefundRequest,
  type RefundResult,
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
import { mapStripeError } from "./error-map.js";
import type {
  StripeChargeLike,
  StripeClientLike,
  StripePaymentIntentLike,
  StripePaymentMethodLike,
  StripeRefundLike,
  StripeServerAdapterConfig,
  StripeSetupIntentLike,
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
      // The SDK's timeout option takes whole milliseconds and rejects fractions.
      throw PayFanoutError.invalidRequest(
        "StripeServerAdapter config.requestTimeoutMs must be a positive integer (milliseconds)",
      );
    }
    this.config = config;
  }

  getCapabilities(): AdapterCapabilities {
    return {
      pspName: this.pspName,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      supportsManualCapture: true,
      supportsMultiCapture: false, // one capture per PaymentIntent; the rest of the auth is released
      supportsPaymentMethodVerification: this.verificationEnabled(),
      // PSP-side vaulting: Stripe Customers + attached PaymentMethods. Cards
      // live at Stripe only; PayFanout and the host see opaque pm_… tokens.
      supportsSavedPaymentMethods: true,
      supportsSessionUpdate: true, // PaymentIntents update in place
      supportsEventPolling: true, // GET /v1/events
      supportsListing: true,
      requiresServerCompletion: false, // Stripe confirms on the client (§4a)
      paymentMethods: this.config.paymentMethods ?? DEFAULT_METHODS,
    };
  }

  async createPaymentSession(input: CreatePaymentSessionInput): Promise<PaymentSession> {
    assertMinorUnitAmount(input.amount, "amount");
    const currency = normalizeCurrency(input.currency);
    // Stripe expresses amounts in the same integer minor units as core, but
    // requires three-decimal currency amounts to end in 0 (e.g. BHD 1000, not 1001).
    if (getCurrencyExponent(currency) === 3 && input.amount % 10 !== 0) {
      throw PayFanoutError.invalidRequest(
        `Stripe requires three-decimal ${currency} amounts to be a multiple of 10 minor units, got ${input.amount}`,
      );
    }

    if (input.savePaymentMethod && !input.customer) {
      throw PayFanoutError.invalidRequest(
        "savePaymentMethod requires `customer` — create one with createCustomer first",
      );
    }
    if (input.amount === 0) return this.createVerificationSession(input, currency);

    const metadata = withPayfanoutId(input.metadata, input.id);
    const params: Record<string, unknown> = {
      amount: input.amount,
      currency: currency.toLowerCase(),
      capture_method: input.captureMethod ?? "automatic",
      ...(metadata ? { metadata } : {}),
      ...(input.customer ? { customer: input.customer } : {}),
      // Vault-during-checkout: the confirmed PaymentMethod attaches to the
      // customer; the token surfaces on PaymentInfo.savedPaymentMethodToken.
      ...(input.savePaymentMethod ? { setup_future_usage: "off_session" } : {}),
      ...this.paymentMethodParams(input.paymentMethodTypes),
      ...checkoutFieldParams(input),
      ...scaParams(input.sca),
    };

    return this.run(async (client) => {
      const pi = await client.paymentIntents.create(params, { idempotencyKey: input.idempotencyKey });
      return this.toPaymentSession(pi, input.id, metadata);
    });
  }

  /**
   * Cart total changed? Stripe PaymentIntents update in place — same
   * pspSessionId, same clientSecret, no client remount needed (the Payment
   * Element re-fetches the amount on confirm).
   */
  async updatePaymentSession(input: UpdatePaymentSessionInput): Promise<PaymentSession> {
    if (input.pspSessionId.startsWith("seti_")) {
      throw PayFanoutError.invalidRequest(
        "Verification sessions are amountless — nothing on them can be updated",
      );
    }
    if (input.amount !== undefined) assertMinorUnitAmount(input.amount, "amount");
    const currency = input.currency !== undefined ? normalizeCurrency(input.currency) : undefined;
    // The 3-decimal multiple-of-10 rule can only be pre-checked when the call
    // names the currency; otherwise Stripe re-validates it server-side.
    if (input.amount !== undefined && currency && getCurrencyExponent(currency) === 3 && input.amount % 10 !== 0) {
      throw PayFanoutError.invalidRequest(
        `Stripe requires three-decimal ${currency} amounts to be a multiple of 10 minor units, got ${input.amount}`,
      );
    }
    const params: Record<string, unknown> = {
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
      ...(currency ? { currency: currency.toLowerCase() } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...checkoutFieldParams(input),
    };
    return this.run(async (client) => {
      const pi = await client.paymentIntents.update(input.pspSessionId, params, {
        idempotencyKey: input.idempotencyKey,
      });
      return this.toPaymentSession(pi, pi.metadata?.payfanout_id, pi.metadata);
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

  async capturePayment(
    pspPaymentId: string,
    amount: MinorUnitAmount | undefined,
    idempotencyKey: string,
  ): Promise<PaymentInfo> {
    if (amount !== undefined) assertMinorUnitAmount(amount, "capture amount");
    return this.run(async (client) => {
      const pi = await client.paymentIntents.capture(
        pspPaymentId,
        amount !== undefined ? { amount_to_capture: amount } : {},
        { idempotencyKey },
      );
      return this.toPaymentInfo(pi);
    });
  }

  async cancelPayment(pspPaymentId: string, idempotencyKey: string): Promise<PaymentInfo> {
    return this.run(async (client) => {
      const pi = await client.paymentIntents.cancel(pspPaymentId, {}, { idempotencyKey });
      return this.toPaymentInfo(pi);
    });
  }

  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    if (req.amount !== undefined) assertMinorUnitAmount(req.amount, "refund amount");
    return this.run(async (client) => {
      const refund = await client.refunds.create(
        {
          payment_intent: req.pspPaymentId,
          ...(req.amount !== undefined ? { amount: req.amount } : {}),
          // RefundReason is exactly Stripe's own vocabulary — passed through as-is.
          ...(req.reason ? { reason: req.reason } : {}),
        },
        { idempotencyKey: req.idempotencyKey },
      );
      return toRefundResult(refund);
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

  async listPayments(input: ListPaymentsInput = {}): Promise<ListPaymentsResult> {
    const params: Record<string, unknown> = {
      limit: clampPageSize(input.limit),
      ...createdRange(input),
      ...(input.cursor ? { starting_after: input.cursor } : {}),
      expand: ["data.latest_charge"], // amountRefunded lives on the charge
    };
    return this.run(async (client) => {
      const page = await client.paymentIntents.list(params);
      const payments = page.data.map((pi) => this.toPaymentInfo(pi));
      const last = page.data[page.data.length - 1];
      return { payments, ...(page.has_more && last ? { nextCursor: last.id } : {}) };
    });
  }

  async listRefunds(input: ListRefundsInput = {}): Promise<ListRefundsResult> {
    const params: Record<string, unknown> = {
      limit: clampPageSize(input.limit),
      ...(input.pspPaymentId ? { payment_intent: input.pspPaymentId } : {}),
      ...createdRange(input),
      ...(input.cursor ? { starting_after: input.cursor } : {}),
    };
    return this.run(async (client) => {
      const page = await client.refunds.list(params);
      const refunds = page.data.map((refund) => toRefundInfo(refund));
      const last = page.data[page.data.length - 1];
      return { refunds, ...(page.has_more && last ? { nextCursor: last.id } : {}) };
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
    if (getCurrencyExponent(currency) === 3 && input.amount % 10 !== 0) {
      throw PayFanoutError.invalidRequest(
        `Stripe requires three-decimal ${currency} amounts to be a multiple of 10 minor units, got ${input.amount}`,
      );
    }
    const metadata = withPayfanoutId(input.metadata, input.id);
    return this.run(async (client) => {
      const pi = await client.paymentIntents.create(
        {
          amount: input.amount,
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
      return this.toPaymentInfo(pi);
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
      if (e.type === "StripeConnectionError" || e.statusCode === 429 || (e.statusCode ?? 0) >= 500) {
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
  ): PaymentSession {
    return {
      id: payfanoutId ?? pi.metadata?.payfanout_id ?? pi.id,
      pspName: this.pspName,
      pspSessionId: pi.id,
      clientSecret: pi.client_secret ?? undefined,
      amount: pi.amount,
      currency: pi.currency.toUpperCase(),
      status: mapPaymentIntentStatus(pi),
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  }

  private paymentMethodParams(types?: UnifiedPaymentMethodType[]): Record<string, unknown> {
    if (!types || types.length === 0) {
      // Embedded-first default: let Stripe choose, but never a full-page redirect.
      return { automatic_payment_methods: { enabled: true, allow_redirects: "never" } };
    }
    const mapped = new Set<string>();
    for (const type of types) {
      const stripeType = METHOD_TYPE_TO_STRIPE[type];
      if (!stripeType) {
        throw PayFanoutError.invalidRequest(`Stripe adapter does not support payment method type "${type}"`);
      }
      mapped.add(stripeType);
    }
    return { payment_method_types: [...mapped] };
  }

  private toPaymentInfo(pi: StripePaymentIntentLike): PaymentInfo {
    const charge = typeof pi.latest_charge === "object" && pi.latest_charge !== null ? pi.latest_charge : undefined;
    const chargeType = charge?.payment_method_details?.type;
    const methodDetails = toPaymentMethodDetails(charge);
    const mandateReference = extractMandate(charge);
    // Session vaulted the instrument -> hand the host the token to store.
    const chargedWith =
      typeof charge?.payment_method === "string" ? charge.payment_method : charge?.payment_method?.id;
    const savedPaymentMethodToken = pi.setup_future_usage && chargedWith ? chargedWith : undefined;
    return {
      id: pi.metadata?.payfanout_id ?? pi.id,
      pspName: this.pspName,
      pspPaymentId: pi.id,
      status: mapPaymentIntentStatus(pi),
      // After a (partial) capture Stripe keeps `amount` at the authorized value;
      // the money actually collected is amount_received. Refund state must be
      // derived against collected funds, so that wins once it exists.
      amount: pi.amount_received && pi.amount_received > 0 ? pi.amount_received : pi.amount,
      amountRefunded: charge?.amount_refunded ?? 0,
      ...(pi.amount_received !== undefined ? { amountCaptured: pi.amount_received } : {}),
      ...(pi.amount_capturable !== undefined ? { amountCapturable: pi.amount_capturable } : {}),
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

function toRefundResult(refund: StripeRefundLike): RefundResult {
  const status: RefundResult["status"] =
    refund.status === "succeeded" ? "succeeded"
    : refund.status === "failed" || refund.status === "canceled" ? "failed"
    : "pending";
  return { refundId: refund.id, status, amount: refund.amount, raw: refund };
}

function toRefundInfo(refund: StripeRefundLike): RefundInfo {
  const pspPaymentId =
    typeof refund.payment_intent === "string" ? refund.payment_intent : refund.payment_intent?.id;
  return {
    ...toRefundResult(refund),
    ...(pspPaymentId ? { pspPaymentId } : {}),
    ...(refund.created ? { createdAt: new Date(refund.created * 1000).toISOString() } : {}),
  };
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
    // Idempotency keys make network retries safe; the SDK backs off on its own.
    maxNetworkRetries: config.maxNetworkRetries ?? 2,
    // Bounds each request (headers and body); unset, the SDK's own 80s default applies.
    ...(config.requestTimeoutMs !== undefined ? { timeout: config.requestTimeoutMs } : {}),
  }) as StripeClientLike;
}
