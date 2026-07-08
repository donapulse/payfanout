import {
  assertMinorUnitAmount,
  normalizeCurrency,
  PayFanoutError,
  requestWithTimeout,
  safeJson,
  utf8ToBase64,
  withTransportRetries,
  type AdapterCapabilities,
  type CompletePaymentInput,
  type CreatePaymentSessionInput,
  type FetchEventsInput,
  type FetchEventsResult,
  type MinorUnitAmount,
  type PaymentInfo,
  type PaymentMethodDetails,
  type PaymentSession,
  type RefundInfo,
  type RefundRequest,
  type RefundResult,
  type ServerPaymentAdapter,
  type ShippingDetails,
  type UnifiedPaymentStatus,
  type UnifiedWebhookEvent,
  type UpdatePaymentSessionInput,
} from "@payfanout/core";
import { mapPayPalError, PAYPAL_PSP_NAME } from "./error-map.js";
import { derivePayPalRequestId } from "./request-id.js";
import { fromPayPalValue, PAYPAL_SUPPORTED_CURRENCIES, toPayPalValue } from "./money.js";
import {
  buildWebhookVerificationBody,
  captureIdFromLinks,
  parsePayPalWebhookEvent,
  payPalEventBodyToUnified,
  type PayPalEventBody,
} from "./webhook.js";

export interface PayPalServerAdapterConfig {
  /** REST app client id (the same value the browser SDK uses — public). */
  clientId: string;
  /** REST app secret — server-side only, authenticates the client id. */
  clientSecret: string;
  /** Explicit, never inferred. sandbox -> api-m.sandbox.paypal.com, live -> api-m.paypal.com. */
  environment: "sandbox" | "live";
  /**
   * The webhook id PayPal assigned when the listener URL was registered.
   * Required for webhook verification — verifyWebhookSignature returns false
   * without it (verification postbacks need it, fail closed).
   */
  webhookId?: string;
  /** Shown instead of the business name in the PayPal window. */
  brandName?: string;
  /** BCP-47 checkout locale (e.g. "fr-FR"); PayPal auto-detects when omitted. */
  locale?: string;
  /**
   * Label on the popup's final button. Default "CONTINUE": the popup approves
   * and control returns to the page, where PayFanout's own Pay button
   * completes the payment (PAY_NOW belongs to flows that capture on approval).
   * The client adapter's `userAction` (the SDK's commit param) must agree.
   */
  userAction?: "CONTINUE" | "PAY_NOW";
  /** Fallback approval return URL when the session input carries none. */
  returnUrl?: string;
  /** Where PayPal sends the buyer on cancel; defaults to the return URL. */
  cancelUrl?: string;
  /**
   * Abort a hung PayPal connection after this many milliseconds (default
   * 30000). The timer covers the whole exchange including the response body
   * read. Mutating calls carry a deterministic PayPal-Request-Id, so a
   * timed-out request is safe to retry. Timeouts surface as retryable
   * psp_unavailable errors.
   */
  requestTimeoutMs?: number;
  /**
   * Automatic retries for transport-level trouble only (network failure,
   * timeout, HTTP 5xx, 429) with exponential backoff. Default 2. Safe because
   * retries reuse the same PayPal-Request-Id — PayPal's own guidance for a
   * 5xx on /capture. Business errors (declines, 422 state errors) are NEVER
   * retried here.
   */
  maxNetworkRetries?: number;
  baseUrl?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Injected clock (ms since epoch) for OAuth-cache tests. */
  now?: () => number;
  /** Injected backoff sleep for retry tests; defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** Structural shapes of the Orders v2 / Payments v2 responses the adapter reads. */
export interface PayPalMoney {
  currency_code?: string;
  value?: string;
}

export interface PayPalLinkLike {
  href?: string;
  rel?: string;
  method?: string;
}

export interface PayPalCaptureLike {
  id: string;
  status?: string;
  amount?: PayPalMoney;
  final_capture?: boolean;
  custom_id?: string;
  invoice_id?: string;
  create_time?: string;
  update_time?: string;
  supplementary_data?: { related_ids?: { order_id?: string; authorization_id?: string } };
  links?: PayPalLinkLike[];
}

export interface PayPalAuthorizationLike {
  id: string;
  status?: string;
  amount?: PayPalMoney;
  expiration_time?: string;
  create_time?: string;
}

export interface PayPalRefundLike {
  id: string;
  status?: string;
  amount?: PayPalMoney;
  create_time?: string;
  seller_payable_breakdown?: { total_refunded_amount?: PayPalMoney };
  links?: PayPalLinkLike[];
}

export interface PayPalOrderLike {
  id: string;
  intent?: string;
  status?: string;
  create_time?: string;
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    soft_descriptor?: string;
    amount?: PayPalMoney;
    payments?: {
      captures?: PayPalCaptureLike[];
      authorizations?: PayPalAuthorizationLike[];
      refunds?: PayPalRefundLike[];
    };
  }>;
  payment_source?: {
    paypal?: { email_address?: string; account_id?: string };
    card?: { brand?: string; last_digits?: string };
  };
  links?: PayPalLinkLike[];
}

type PayPalHttpMethod = "GET" | "POST" | "PATCH";

interface PayPalRequestOptions {
  json?: unknown;
  /** Pre-built body sent byte-for-byte (the webhook postback splices the raw event). */
  rawBody?: string;
  requestId?: string;
}

const EPOCH = "1970-01-01T00:00:00.000Z";

export class PayPalServerAdapter implements ServerPaymentAdapter {
  readonly pspName = PAYPAL_PSP_NAME;
  private readonly config: PayPalServerAdapterConfig;
  private readonly baseUrl: string;
  /** OAuth credential cache — NOT payment state, statelessness holds. */
  private tokenCache?: { token: string; expiresAt: number };
  /** In-flight mint — concurrent cold-cache requests share one token POST. */
  private tokenMint?: Promise<string>;

  constructor(config: PayPalServerAdapterConfig) {
    for (const key of ["clientId", "clientSecret"] as const) {
      if (!config[key]) throw PayFanoutError.invalidRequest(`PayPalServerAdapter config.${key} is required`);
    }
    if (config.environment !== "sandbox" && config.environment !== "live") {
      throw PayFanoutError.invalidRequest(
        'PayPalServerAdapter config.environment must be explicitly "sandbox" or "live" — it is never inferred',
      );
    }
    if (config.userAction !== undefined && config.userAction !== "CONTINUE" && config.userAction !== "PAY_NOW") {
      throw PayFanoutError.invalidRequest('PayPalServerAdapter config.userAction must be "CONTINUE" or "PAY_NOW"');
    }
    if (config.requestTimeoutMs !== undefined && !(config.requestTimeoutMs > 0)) {
      throw PayFanoutError.invalidRequest("PayPalServerAdapter config.requestTimeoutMs must be > 0");
    }
    if (config.maxNetworkRetries !== undefined && !(config.maxNetworkRetries >= 0)) {
      throw PayFanoutError.invalidRequest("PayPalServerAdapter config.maxNetworkRetries must be >= 0");
    }
    this.config = config;
    this.baseUrl =
      config.baseUrl ??
      (config.environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
  }

  getCapabilities(): AdapterCapabilities {
    return {
      pspName: this.pspName,
      // Router pre-screen; money.ts revalidates locally as defense-in-depth.
      supportedCurrencies: [...PAYPAL_SUPPORTED_CURRENCIES],
      supportsRefunds: true,
      supportsPartialRefunds: true,
      supportsManualCapture: true, // intent AUTHORIZE + authorization capture
      // final_capture=false keeps an authorization open for repeated partial
      // captures (CAPTURE-intent orders settle exactly once).
      supportsMultiCapture: true,
      supportsPaymentMethodVerification: false, // no zero-amount check for wallet approvals
      supportsSavedPaymentMethods: false, // v3 vault (payment-tokens) is the documented future path
      supportsSessionUpdate: true, // PATCH order pre-approval
      supportsEventPolling: true, // GET /v1/notifications/webhooks-events
      supportsListing: false, // Orders/Payments v2 are GET-by-id only — no list endpoints exist
      requiresServerCompletion: true, // tokenize-first: the popup approves, money moves at server capture
      paymentMethods: [{ type: "paypal", flow: "popup", supported: true }],
    };
  }

  async createPaymentSession(input: CreatePaymentSessionInput): Promise<PaymentSession> {
    assertMinorUnitAmount(input.amount, "amount");
    const currency = normalizeCurrency(input.currency);
    // Validates PayPal's currency allowlist + the HUF/TWD/JPY whole-unit rule.
    const value = toPayPalValue(input.amount, currency);
    if (input.paymentMethodTypes?.some((t) => t !== "paypal")) {
      throw PayFanoutError.invalidRequest(
        `PayPal adapter supports only the "paypal" payment method type, got: ${input.paymentMethodTypes.join(", ")}`,
        { paymentMethodTypes: input.paymentMethodTypes },
      );
    }
    const returnUrl = input.returnUrl ?? this.config.returnUrl;
    const cancelUrl = this.config.cancelUrl ?? returnUrl;
    const shipping = toPayPalShipping(input.shippingDetails);
    const softDescriptor = toSoftDescriptor(input.statementDescriptor);
    const order = await this.request<PayPalOrderLike>("POST", "/v2/checkout/orders", {
      requestId: await derivePayPalRequestId(input.idempotencyKey),
      json: {
        intent: input.captureMethod === "manual" ? "AUTHORIZE" : "CAPTURE",
        purchase_units: [
          {
            amount: { currency_code: currency, value },
            // Host id round-trip: custom_id reappears on captures and webhooks.
            ...(input.id ? { custom_id: input.id } : {}),
            ...(softDescriptor ? { soft_descriptor: softDescriptor } : {}),
            ...(shipping ? { shipping } : {}),
          },
        ],
        payment_source: {
          paypal: {
            ...(input.billingDetails?.email ? { email_address: input.billingDetails.email } : {}),
            experience_context: {
              user_action: this.config.userAction ?? "CONTINUE",
              ...(returnUrl ? { return_url: returnUrl } : {}),
              ...(cancelUrl ? { cancel_url: cancelUrl } : {}),
              ...(this.config.brandName ? { brand_name: this.config.brandName } : {}),
              ...(this.config.locale ? { locale: this.config.locale } : {}),
              ...(shipping ? { shipping_preference: "SET_PROVIDED_ADDRESS" } : {}),
            },
          },
        },
      },
    });
    return {
      id: input.id ?? order.id,
      pspName: this.pspName,
      pspSessionId: order.id,
      // The order id is also the client artifact: paypal.Buttons' createOrder returns it.
      clientSecret: order.id,
      amount: input.amount,
      currency,
      status: this.orderStateToStatus(order),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
  }

  /**
   * Tokenize-first completion: the client's confirm() resolves with the
   * approved order id as clientToken; money moves here. CAPTURE-intent orders
   * capture, AUTHORIZE-intent orders authorize (capture comes later via
   * capturePayment).
   */
  async completePayment(input: CompletePaymentInput): Promise<PaymentInfo> {
    if (!input.clientToken) {
      throw PayFanoutError.invalidRequest("completePayment requires the clientToken produced by confirm()", {
        pspSessionId: input.pspSessionId,
      });
    }
    if (input.clientToken !== input.pspSessionId) {
      // Tamper guard: the approved order the browser reports must be the
      // session's own order — a swapped id would capture someone else's cart.
      throw PayFanoutError.invalidRequest(
        "clientToken does not match pspSessionId — the approved PayPal order is not this session's order",
        { pspSessionId: input.pspSessionId, clientToken: input.clientToken },
      );
    }
    const order = await this.request<PayPalOrderLike>(
      "GET",
      `/v2/checkout/orders/${encodeURIComponent(input.pspSessionId)}`,
    );
    const action = (order.intent ?? "CAPTURE").toUpperCase() === "AUTHORIZE" ? "authorize" : "capture";
    const finalized = await this.request<PayPalOrderLike>(
      "POST",
      `/v2/checkout/orders/${encodeURIComponent(input.pspSessionId)}/${action}`,
      { json: {}, requestId: await derivePayPalRequestId(input.idempotencyKey) },
    );
    return this.orderToPaymentInfo(finalized);
  }

  /**
   * Accepts the order id (active payment window) or the capture id (the
   * durable canonical id — PaymentInfo.pspPaymentId after capture). Orders
   * age out of GET a few days after completion, captures do not.
   */
  async retrievePayment(pspPaymentId: string): Promise<PaymentInfo> {
    try {
      const order = await this.request<PayPalOrderLike>(
        "GET",
        `/v2/checkout/orders/${encodeURIComponent(pspPaymentId)}`,
      );
      return this.orderToPaymentInfo(order);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      const capture = await this.request<PayPalCaptureLike>(
        "GET",
        `/v2/payments/captures/${encodeURIComponent(pspPaymentId)}`,
      );
      // The bare capture reports no cumulative refunds — while the parent
      // order is still GETtable its embedded payments collection is the money
      // truth; once it ages out the capture's own facts are all that is left.
      const orderId = parentOrderId(capture);
      if (orderId) {
        try {
          const order = await this.request<PayPalOrderLike>(
            "GET",
            `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
          );
          return this.orderToPaymentInfo(order);
        } catch (orderErr) {
          if (!isNotFound(orderErr)) throw orderErr;
        }
      }
      return this.captureToPaymentInfo(capture);
    }
  }

  /**
   * Manual capture of an AUTHORIZE-intent payment; pspPaymentId is the order
   * id. Each partial capture is its own charge under its own required key —
   * a reused key replays the earlier capture via PayPal-Request-Id and moves
   * no new money.
   */
  async capturePayment(
    pspPaymentId: string,
    amount: MinorUnitAmount | undefined,
    idempotencyKey: string,
  ): Promise<PaymentInfo> {
    if (amount !== undefined) assertMinorUnitAmount(amount, "capture amount");
    const order = await this.request<PayPalOrderLike>(
      "GET",
      `/v2/checkout/orders/${encodeURIComponent(pspPaymentId)}`,
    );
    const unit = order.purchase_units?.[0];
    const authorization = unit?.payments?.authorizations?.[0];
    if (!authorization) {
      throw PayFanoutError.invalidRequest(
        `Payment "${pspPaymentId}" has no authorization to capture — only manual-capture (AUTHORIZE) orders support capturePayment`,
        order,
      );
    }
    const currency = (unit?.amount?.currency_code ?? "USD").toUpperCase();
    await this.request<PayPalCaptureLike>(
      "POST",
      `/v2/payments/authorizations/${encodeURIComponent(authorization.id)}/capture`,
      {
        requestId: await derivePayPalRequestId(idempotencyKey),
        json: {
          ...(amount !== undefined ? { amount: { currency_code: currency, value: toPayPalValue(amount, currency) } } : {}),
          // Leave the authorization open for further partial captures; PayPal
          // releases whatever is left when the authorization expires.
          final_capture: false,
        },
      },
    );
    return this.retrievePayment(pspPaymentId);
  }

  /**
   * Voids the authorization of an AUTHORIZE-intent payment. CAPTURE-intent
   * orders cannot be cancelled via the API — they expire on their own, so
   * cancelling one is rejected rather than faked.
   */
  async cancelPayment(pspPaymentId: string, idempotencyKey: string): Promise<PaymentInfo> {
    let order: PayPalOrderLike;
    try {
      order = await this.request<PayPalOrderLike>(
        "GET",
        `/v2/checkout/orders/${encodeURIComponent(pspPaymentId)}`,
      );
    } catch (err) {
      if (!isNotFound(err)) throw err;
      throw PayFanoutError.invalidRequest(
        `No PayPal order with id "${pspPaymentId}" — captured payments cannot be canceled, refund them instead`,
        (err as PayFanoutError).raw,
      );
    }
    const unit = order.purchase_units?.[0];
    const captures = (unit?.payments?.captures ?? []).filter((c) => !isFailedCaptureStatus(c.status));
    if (captures.length > 0) {
      throw PayFanoutError.invalidRequest(
        `Payment "${pspPaymentId}" is already captured — refund it instead of cancelling`,
        order,
      );
    }
    const authorization = unit?.payments?.authorizations?.[0];
    if (authorization) {
      if ((authorization.status ?? "").toUpperCase() !== "VOIDED") {
        await this.request<undefined>(
          "POST",
          `/v2/payments/authorizations/${encodeURIComponent(authorization.id)}/void`,
          {
            json: {},
            requestId: await derivePayPalRequestId(idempotencyKey),
          },
        );
      }
      return this.retrievePayment(pspPaymentId);
    }
    throw PayFanoutError.invalidRequest(
      "PayPal has no order-cancel API — an un-captured order simply expires; void applies only to authorized (AUTHORIZE-intent) payments",
      order,
    );
  }

  /** Refunds settle against the CAPTURE — order ids are resolved to it here. */
  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    if (req.amount !== undefined) assertMinorUnitAmount(req.amount, "refund amount");
    const target = await this.resolveCapture(req.pspPaymentId);
    const refund = await this.request<PayPalRefundLike>(
      "POST",
      `/v2/payments/captures/${encodeURIComponent(target.captureId)}/refund`,
      {
        requestId: await derivePayPalRequestId(req.idempotencyKey),
        json: {
          ...(req.amount !== undefined
            ? { amount: { currency_code: target.currency, value: toPayPalValue(req.amount, target.currency) } }
            : {}),
          // PayPal caps note_to_payer at 255 characters.
          ...(req.reason ? { note_to_payer: req.reason.slice(0, 255) } : {}),
        },
      },
    );
    return {
      refundId: refund.id,
      status: mapRefundStatus(refund.status),
      amount:
        refund.amount?.value !== undefined
          ? fromPayPalValue(refund.amount.value, refund.amount.currency_code ?? target.currency)
          : (req.amount ?? target.amountMinor),
      raw: refund,
    };
  }

  /** Polls an async refund (eCheck-funded ones sit PENDING) to a terminal state. */
  async retrieveRefund(refundId: string): Promise<RefundInfo> {
    const refund = await this.request<PayPalRefundLike>(
      "GET",
      `/v2/payments/refunds/${encodeURIComponent(refundId)}`,
    );
    const currency = refund.amount?.currency_code ?? "USD";
    const captureId = captureIdFromLinks(refund.links);
    return {
      refundId: refund.id,
      status: mapRefundStatus(refund.status),
      amount: refund.amount?.value !== undefined ? fromPayPalValue(refund.amount.value, currency) : 0,
      ...(captureId ? { pspPaymentId: captureId } : {}),
      ...(refund.create_time ? { createdAt: refund.create_time } : {}),
      raw: refund,
    };
  }

  /**
   * PATCH-amends a CREATED/APPROVED order in place (same order id, so the
   * mounted PayPal button keeps working). COMPLETED orders reject with
   * invalid_request. Currency changes require an explicit amount — the old
   * minor amount is not silently reinterpreted in the new currency.
   */
  async updatePaymentSession(input: UpdatePaymentSessionInput): Promise<PaymentSession> {
    if (input.amount !== undefined) assertMinorUnitAmount(input.amount, "amount");
    const order = await this.request<PayPalOrderLike>(
      "GET",
      `/v2/checkout/orders/${encodeURIComponent(input.pspSessionId)}`,
    );
    const unit = order.purchase_units?.[0];
    const currentCurrency = (unit?.amount?.currency_code ?? "USD").toUpperCase();
    const currency = input.currency !== undefined ? normalizeCurrency(input.currency) : currentCurrency;
    const unitPath = "/purchase_units/@reference_id=='default'";
    const ops: Array<Record<string, unknown>> = [];
    if (input.amount !== undefined || input.currency !== undefined) {
      if (input.amount === undefined && currency !== currentCurrency) {
        throw PayFanoutError.invalidRequest("Changing the currency of a PayPal order requires an explicit amount", {
          from: currentCurrency,
          to: currency,
        });
      }
      const minor =
        input.amount ?? (unit?.amount?.value !== undefined ? fromPayPalValue(unit.amount.value, currentCurrency) : 0);
      ops.push({
        op: "replace",
        path: `${unitPath}/amount`,
        value: { currency_code: currency, value: toPayPalValue(minor, currency) },
      });
    }
    const softDescriptor = toSoftDescriptor(input.statementDescriptor);
    if (softDescriptor) {
      ops.push({ op: unit?.soft_descriptor ? "replace" : "add", path: `${unitPath}/soft_descriptor`, value: softDescriptor });
    }
    const shipping = toPayPalShipping(input.shippingDetails);
    if (shipping) {
      ops.push({ op: "add", path: `${unitPath}/shipping`, value: shipping });
    }
    if (ops.length > 0) {
      // PATCH answers 204 No Content — the refreshed order needs its own GET.
      await this.request<undefined>("PATCH", `/v2/checkout/orders/${encodeURIComponent(input.pspSessionId)}`, {
        json: ops,
      });
    }
    const updated =
      ops.length > 0
        ? await this.request<PayPalOrderLike>("GET", `/v2/checkout/orders/${encodeURIComponent(input.pspSessionId)}`)
        : order;
    return this.orderToSession(updated, input.metadata);
  }

  /**
   * Missed-webhook recovery over GET /v1/notifications/webhooks-events: the
   * same payload shapes webhooks deliver, normalized by the same mapper, so
   * dedupe by event.id — which real PayPal events always carry — works
   * identically for delivered and fetched events. PayPal retains roughly
   * 30 days.
   */
  async fetchEvents(input: FetchEventsInput = {}): Promise<FetchEventsResult> {
    let path: string;
    if (input.cursor) {
      if (!input.cursor.startsWith("/v1/notifications/webhooks-events")) {
        throw PayFanoutError.invalidRequest("fetchEvents cursor was not produced by this adapter", {
          cursor: input.cursor,
        });
      }
      path = input.cursor;
    } else {
      const params = new URLSearchParams();
      if (input.limit !== undefined) params.set("page_size", String(Math.max(1, Math.trunc(input.limit))));
      if (input.since !== undefined) params.set("start_time", toIsoTime(input.since));
      const query = params.toString();
      path = `/v1/notifications/webhooks-events${query ? `?${query}` : ""}`;
    }
    const page = await this.request<{ events?: PayPalEventBody[]; links?: PayPalLinkLike[] } | undefined>(
      "GET",
      path,
    );
    const events: UnifiedWebhookEvent[] = await Promise.all(
      (page?.events ?? []).map((event) => payPalEventBodyToUnified(event)),
    );
    const nextHref = page?.links?.find((link) => (link.rel ?? "").toLowerCase() === "next")?.href;
    const nextCursor = nextHref ? relativeEventsPath(nextHref) : undefined;
    return { events, ...(nextCursor ? { nextCursor } : {}) };
  }

  /**
   * Postback verification: PayPal itself confirms the delivery headers +
   * exact raw bytes. Missing headers, a missing webhookId, or an empty body
   * answer false locally without a network call; transport trouble fails
   * closed (false), never open.
   */
  async verifyWebhookSignature(rawBody: string, headers: Record<string, string>): Promise<boolean> {
    const body = buildWebhookVerificationBody(rawBody, headers, this.config.webhookId);
    if (!body) return false;
    try {
      const result = await this.request<{ verification_status?: string } | undefined>(
        "POST",
        "/v1/notifications/verify-webhook-signature",
        { rawBody: body },
      );
      return result?.verification_status === "SUCCESS";
    } catch {
      // Fail closed: an unverifiable webhook is an unverified webhook.
      return false;
    }
  }

  async parseWebhookEvent(rawBody: string): Promise<UnifiedWebhookEvent> {
    return parsePayPalWebhookEvent(rawBody);
  }

  // --- mapping ------------------------------------------------------------

  private orderStateToStatus(order: PayPalOrderLike): UnifiedPaymentStatus {
    const unit = order.purchase_units?.[0];
    switch ((order.status ?? "").toUpperCase()) {
      case "CREATED":
      case "SAVED":
        return "requires_payment_method";
      case "PAYER_ACTION_REQUIRED":
        return "requires_action";
      case "APPROVED":
        return "requires_confirmation"; // buyer approved; server completion pending
      case "VOIDED":
        return "canceled";
      case "COMPLETED":
        return completedOrderStatus(unit?.payments?.captures ?? [], unit?.payments?.authorizations ?? []);
      default:
        return "processing";
    }
  }

  private orderToSession(order: PayPalOrderLike, metadata?: Record<string, string>): PaymentSession {
    const unit = order.purchase_units?.[0];
    const currency = (unit?.amount?.currency_code ?? "USD").toUpperCase();
    return {
      id: unit?.custom_id ?? order.id,
      pspName: this.pspName,
      pspSessionId: order.id,
      clientSecret: order.id,
      amount: unit?.amount?.value !== undefined ? fromPayPalValue(unit.amount.value, currency) : 0,
      currency,
      status: this.orderStateToStatus(order),
      ...(metadata ? { metadata } : {}),
    };
  }

  private orderToPaymentInfo(order: PayPalOrderLike): PaymentInfo {
    const unit = order.purchase_units?.[0];
    const captures = unit?.payments?.captures ?? [];
    const refunds = unit?.payments?.refunds ?? [];
    const currency = (unit?.amount?.currency_code ?? captures[0]?.amount?.currency_code ?? "USD").toUpperCase();
    const activeCaptures = captures.filter((c) => !isFailedCaptureStatus(c.status));
    const captured = sumPayPalAmounts(activeCaptures.map((c) => c.amount), currency);
    let refunded = sumPayPalAmounts(refunds.map((r) => r.amount), currency);
    if (refunds.length === 0) {
      // Without an embedded refunds[] list the capture status is the only
      // witness: full REFUNDED maps to the capture amount; PARTIALLY_REFUNDED
      // alone cannot yield a total (PayPal exposes no cumulative refunded
      // amount on the capture object) — hosts keep refund records.
      refunded = sumPayPalAmounts(
        activeCaptures.filter((c) => (c.status ?? "").toUpperCase() === "REFUNDED").map((c) => c.amount),
        currency,
      );
    }
    const primaryCapture = activeCaptures[0] ?? captures[0];
    const settledCapture = activeCaptures.find((c) => isSettledCaptureStatus(c.status));
    const details = detailsFrom(order.payment_source);
    // Settled money only — a PENDING (eCheck) capture holds funds but has not
    // captured them yet.
    const amountCaptured = sumPayPalAmounts(
      activeCaptures.filter((c) => isSettledCaptureStatus(c.status)).map((c) => c.amount),
      currency,
    );
    const authorization = unit?.payments?.authorizations?.[0];
    const amountCapturable = authorization ? capturableRemainder(authorization, captured, currency) : undefined;
    return {
      id: unit?.custom_id ?? order.id,
      pspName: this.pspName,
      // Post-capture the CAPTURE id is canonical: orders age out of GET, the
      // capture is the durable money object refunds and webhooks key on.
      pspPaymentId: primaryCapture?.id ?? order.id,
      status: this.orderStateToStatus(order),
      amount:
        captured > 0
          ? captured
          : unit?.amount?.value !== undefined
            ? fromPayPalValue(unit.amount.value, currency)
            : 0,
      amountRefunded: refunded,
      amountCaptured,
      ...(amountCapturable !== undefined ? { amountCapturable } : {}),
      currency,
      paymentMethodType: "paypal",
      ...(details ? { paymentMethodDetails: details } : {}),
      createdAt: order.create_time ?? primaryCapture?.create_time ?? EPOCH,
      ...(settledCapture?.create_time ? { capturedAt: settledCapture.create_time } : {}),
      raw: order,
    };
  }

  private captureToPaymentInfo(capture: PayPalCaptureLike): PaymentInfo {
    const currency = (capture.amount?.currency_code ?? "USD").toUpperCase();
    const amount = capture.amount?.value !== undefined ? fromPayPalValue(capture.amount.value, currency) : 0;
    const state = (capture.status ?? "").toUpperCase();
    const status: UnifiedPaymentStatus = isSettledCaptureStatus(state)
      ? "succeeded"
      : isFailedCaptureStatus(state)
        ? "failed"
        : "processing";
    return {
      id: capture.custom_id ?? capture.id,
      pspName: this.pspName,
      pspPaymentId: capture.id,
      status,
      amount,
      // The bare capture exposes no cumulative refunded total and PayPal has
      // no refunds-list endpoint: full REFUNDED is the whole amount,
      // PARTIALLY_REFUNDED reports 0 — hosts keep refund records
      // (statelessness already demands it; see the PayPal guide).
      amountRefunded: state === "REFUNDED" ? amount : 0,
      amountCaptured: status === "succeeded" ? amount : 0,
      currency,
      paymentMethodType: "paypal",
      paymentMethodDetails: { wallet: "paypal" },
      createdAt: capture.create_time ?? EPOCH,
      ...(status === "succeeded" && capture.create_time ? { capturedAt: capture.create_time } : {}),
      raw: capture,
    };
  }

  private async resolveCapture(
    pspPaymentId: string,
  ): Promise<{ captureId: string; currency: string; amountMinor: MinorUnitAmount }> {
    let order: PayPalOrderLike | undefined;
    try {
      order = await this.request<PayPalOrderLike>(
        "GET",
        `/v2/checkout/orders/${encodeURIComponent(pspPaymentId)}`,
      );
    } catch (err) {
      if (!isNotFound(err)) throw err;
      // Not an order (or one that aged out of GET): treat the id as a capture id.
      const capture = await this.request<PayPalCaptureLike>(
        "GET",
        `/v2/payments/captures/${encodeURIComponent(pspPaymentId)}`,
      );
      return captureTarget(capture);
    }
    const captures = (order.purchase_units?.[0]?.payments?.captures ?? []).filter(
      (c) => !isFailedCaptureStatus(c.status),
    );
    if (captures.length > 1) {
      // Silently picking captures[0] would refund an arbitrary settlement.
      throw PayFanoutError.invalidRequest(
        `Payment "${pspPaymentId}" has ${captures.length} captures (${captures.map((c) => c.id).join(", ")}) — refund by capture id (PaymentInfo.pspPaymentId)`,
        order,
      );
    }
    const capture = captures[0];
    if (!capture) {
      throw PayFanoutError.invalidRequest(
        `Payment "${pspPaymentId}" has no capture to refund — it has not been captured yet`,
        order,
      );
    }
    return captureTarget(capture);
  }

  // --- transport ------------------------------------------------------------

  /**
   * Transport with timeout + transient-only retries. Mutating retries are
   * safe: they reuse the same PayPal-Request-Id, so a replay can never
   * double-charge. Business errors (4xx other than 429) never retry.
   */
  private request<T>(method: PayPalHttpMethod, path: string, options: PayPalRequestOptions = {}): Promise<T> {
    return withTransportRetries(() => this.requestOnce<T>(method, path, options), {
      attempts: 1 + (this.config.maxNetworkRetries ?? 2),
      sleep: this.config.sleep,
    });
  }

  private async requestOnce<T>(method: PayPalHttpMethod, path: string, options: PayPalRequestOptions): Promise<T> {
    let exchange = await this.send(method, path, options, await this.accessToken());
    if (exchange.response.status === 401) {
      // The cached token went stale or was revoked — re-mint once and replay.
      this.tokenCache = undefined;
      exchange = await this.send(method, path, options, await this.accessToken());
    }
    const { response, text } = exchange;
    const json = text ? safeJson(text) : undefined;
    if (!response.ok) throw mapPayPalError(response.status, json ?? text);
    return json as T; // 204 No Content (PATCH, void) resolves as undefined
  }

  private send(
    method: PayPalHttpMethod,
    path: string,
    options: PayPalRequestOptions,
    token: string,
  ): Promise<{ response: Response; text: string }> {
    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    const body = options.rawBody ?? (options.json !== undefined ? JSON.stringify(options.json) : undefined);
    return requestWithTimeout(
      { fetch: this.config.fetch ?? fetch, timeoutMs, onFailure: this.transportFailure(timeoutMs) },
      `${this.baseUrl}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(options.requestId ? { "paypal-request-id": options.requestId } : {}),
          // Minimal responses omit purchase_units — the mappers need the money objects.
          ...(method === "POST" ? { prefer: "return=representation" } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      },
    );
  }

  private transportFailure(timeoutMs: number): (timedOut: boolean, cause: unknown) => PayFanoutError {
    return (timedOut, cause) =>
      new PayFanoutError({
        code: "psp_unavailable",
        message: timedOut ? `PayPal did not respond within ${timeoutMs}ms.` : "Could not reach PayPal.",
        retryable: true,
        raw: cause,
        pspName: this.pspName,
      });
  }

  /**
   * Client-credentials token with an in-instance cache, per PayPal's own
   * rate-limit guidance ("cache tokens"). Refreshes 60s before expiry so a
   * token never dies mid-request. The mint itself is single-flight —
   * concurrent cold-cache requests share one POST — and a rejected mint
   * clears the in-flight slot so the next caller retries.
   */
  private async accessToken(): Promise<string> {
    if (this.tokenCache && this.now() < this.tokenCache.expiresAt - 60_000) return this.tokenCache.token;
    this.tokenMint ??= this.mintAccessToken().finally(() => {
      this.tokenMint = undefined;
    });
    return this.tokenMint;
  }

  private async mintAccessToken(): Promise<string> {
    const now = this.now();
    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    const { response, text } = await requestWithTimeout(
      { fetch: this.config.fetch ?? fetch, timeoutMs, onFailure: this.transportFailure(timeoutMs) },
      `${this.baseUrl}/v1/oauth2/token`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${utf8ToBase64(`${this.config.clientId}:${this.config.clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      },
    );
    const json = text ? safeJson(text) : undefined;
    if (!response.ok) throw mapPayPalError(response.status, json ?? text);
    const body = json as { access_token?: string; expires_in?: number } | undefined;
    if (!body?.access_token) {
      throw new PayFanoutError({
        code: "psp_unavailable",
        message: "PayPal returned no access token.",
        retryable: true,
        raw: json ?? text,
        pspName: this.pspName,
      });
    }
    this.tokenCache = { token: body.access_token, expiresAt: now + (body.expires_in ?? 0) * 1000 };
    return body.access_token;
  }

  private now(): number {
    return (this.config.now ?? Date.now)();
  }
}

function completedOrderStatus(
  captures: PayPalCaptureLike[],
  authorizations: PayPalAuthorizationLike[],
): UnifiedPaymentStatus {
  if (captures.length > 0) {
    const states = captures.map((c) => (c.status ?? "").toUpperCase());
    if (states.some((s) => isSettledCaptureStatus(s))) return "succeeded";
    if (states.some((s) => s === "PENDING")) return "processing";
    return "failed"; // every capture DECLINED/FAILED
  }
  const authorization = authorizations[0];
  if (authorization) {
    const state = (authorization.status ?? "").toUpperCase();
    if (state === "VOIDED") return "canceled";
    if (state === "DENIED") return "failed";
    if (state === "CAPTURED") return "succeeded";
    return "requires_capture"; // CREATED / PENDING / PARTIALLY_CAPTURED
  }
  return "processing"; // COMPLETED with no money object yet — still settling
}

/** Money moved and stayed (or was later refunded — refund state is separate). */
function isSettledCaptureStatus(status: string | undefined): boolean {
  const state = (status ?? "").toUpperCase();
  return state === "COMPLETED" || state === "REFUNDED" || state === "PARTIALLY_REFUNDED";
}

function isFailedCaptureStatus(status: string | undefined): boolean {
  const state = (status ?? "").toUpperCase();
  return state === "DECLINED" || state === "FAILED";
}

/**
 * Authorized-but-uncaptured remainder. `held` counts every non-failed capture
 * (PENDING ones already reserve their slice); VOIDED/DENIED/CAPTURED
 * authorizations report 0 — nothing is left to take.
 */
function capturableRemainder(
  authorization: PayPalAuthorizationLike,
  held: MinorUnitAmount,
  fallbackCurrency: string,
): MinorUnitAmount | undefined {
  if (authorization.amount?.value === undefined) return undefined;
  const authorized = fromPayPalValue(
    authorization.amount.value,
    authorization.amount.currency_code ?? fallbackCurrency,
  );
  const state = (authorization.status ?? "").toUpperCase();
  const open = state === "CREATED" || state === "PENDING" || state === "PARTIALLY_CAPTURED";
  return open ? Math.max(0, authorized - held) : 0;
}

function sumPayPalAmounts(amounts: Array<PayPalMoney | undefined>, fallbackCurrency: string): number {
  let total = 0;
  for (const amount of amounts) {
    if (amount?.value === undefined) continue;
    total += fromPayPalValue(amount.value, amount.currency_code ?? fallbackCurrency);
  }
  return total;
}

/** The order a capture settled, from supplementary data or the links[rel=up] href. */
function parentOrderId(capture: PayPalCaptureLike): string | undefined {
  const fromSupplementary = capture.supplementary_data?.related_ids?.order_id;
  if (fromSupplementary) return fromSupplementary;
  for (const link of capture.links ?? []) {
    if ((link.rel ?? "").toLowerCase() !== "up") continue;
    const match = /\/v2\/checkout\/orders\/([^/?#]+)/.exec(link.href ?? "");
    if (match) return match[1];
  }
  return undefined;
}

function captureTarget(capture: PayPalCaptureLike): {
  captureId: string;
  currency: string;
  amountMinor: MinorUnitAmount;
} {
  const currency = (capture.amount?.currency_code ?? "USD").toUpperCase();
  return {
    captureId: capture.id,
    currency,
    amountMinor: capture.amount?.value !== undefined ? fromPayPalValue(capture.amount.value, currency) : 0,
  };
}

function detailsFrom(source: PayPalOrderLike["payment_source"]): PaymentMethodDetails | undefined {
  if (!source) return undefined;
  // The branded flow reports payment_source.paypal only; a guest card entry
  // may surface payment_source.card instead — prefer its display facts.
  const card = source.card;
  return {
    wallet: "paypal",
    ...(card?.brand ? { brand: card.brand.toLowerCase() } : {}),
    ...(card?.last_digits ? { last4: card.last_digits } : {}),
  };
}

function mapRefundStatus(status: string | undefined): RefundResult["status"] {
  switch ((status ?? "").toUpperCase()) {
    case "COMPLETED":
      return "succeeded";
    case "FAILED":
    case "CANCELLED":
      return "failed";
    default: // PENDING (eCheck) and anything new
      return "pending";
  }
}

/**
 * Card statements truncate the soft descriptor at 22 characters — anything
 * longer is withheld rather than failing the payment (checkout-field rule:
 * validate locally, withhold what the PSP would reject).
 */
function toSoftDescriptor(statementDescriptor: string | undefined): string | undefined {
  const trimmed = statementDescriptor?.trim();
  if (!trimmed || trimmed.length > 22) return undefined;
  return trimmed;
}

/** PayPal requires country_code on any provided address — withhold rather than 400. */
function toPayPalShipping(details: ShippingDetails | undefined): Record<string, unknown> | undefined {
  const address = details?.address;
  if (!address?.country) return undefined;
  return {
    ...(details?.name ? { name: { full_name: details.name } } : {}),
    address: {
      ...(address.line1 ? { address_line_1: address.line1 } : {}),
      ...(address.line2 ? { address_line_2: address.line2 } : {}),
      ...(address.city ? { admin_area_2: address.city } : {}),
      ...(address.state ? { admin_area_1: address.state } : {}),
      ...(address.postalCode ? { postal_code: address.postalCode } : {}),
      country_code: address.country,
    },
  };
}

function isNotFound(err: unknown): boolean {
  if (!(err instanceof PayFanoutError)) return false;
  return (err.raw as { name?: string } | undefined)?.name === "RESOURCE_NOT_FOUND";
}

function relativeEventsPath(href: string): string | undefined {
  try {
    const url = new URL(href, "https://api-m.paypal.com");
    return url.pathname.startsWith("/v1/notifications/webhooks-events") ? `${url.pathname}${url.search}` : undefined;
  } catch {
    // A malformed next link is PayPal's bug — stop paginating instead of throwing.
    return undefined;
  }
}

function toIsoTime(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw PayFanoutError.invalidRequest(`Invalid "since" timestamp: ${String(value)}`, { since: value });
  }
  return parsed.toISOString();
}
