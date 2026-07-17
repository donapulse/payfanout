import type {
  GoCardlessBillingRequestLike,
  GoCardlessEventLike,
  GoCardlessPaymentLike,
  GoCardlessRefundLike,
  GoCardlessSubscriptionLike,
} from "../src/index.js";

interface FakeBillingRequest extends GoCardlessBillingRequestLike {
  actions?: Array<{ type: string; required: boolean; status: string }>;
  fallback_enabled?: boolean;
}

interface FakeFlow {
  id: string;
  authorisation_url: string;
  redirect_uri?: string;
  exit_uri?: string;
  prefilled_customer?: Record<string, string>;
  auto_fulfil: boolean;
  expires_at: string;
  created_at: string;
  links: { billing_request: string };
}

interface FakeMandate {
  id: string;
  reference: string;
  scheme: string;
  status: string;
  created_at: string;
}

const BASE_TIME = Date.parse("2026-07-07T10:00:00.000Z");

/**
 * In-memory GoCardless Billing Requests API impersonating the REST surface at
 * the HTTP layer. Reproduces the documented behaviors the adapter depends on:
 * envelope-wrapped JSON, Bearer + GoCardless-Version header requirements,
 * Idempotency-Key consumption answering 409 idempotent_creation_conflict with
 * links.conflicting_resource_id (billing requests, refunds, and subscriptions
 * — flow creates never dedupe, matching the sandbox), invalid_state on bad
 * transitions (including cancelling an already-cancelled/finished
 * subscription), the refunds feature gate (403 until enabled),
 * total_amount_confirmation checking, the ?payment= filter on GET /refunds,
 * and cursor pagination.
 */
export class FakeGoCardlessApi {
  private readonly billingRequests = new Map<string, FakeBillingRequest>();
  private readonly flows = new Map<string, FakeFlow>();
  private readonly payments = new Map<string, GoCardlessPaymentLike>();
  private readonly refunds = new Map<string, GoCardlessRefundLike>();
  private readonly mandates = new Map<string, FakeMandate>();
  private readonly subscriptions = new Map<string, GoCardlessSubscriptionLike>();
  private readonly events: Array<GoCardlessEventLike & { id: string; created_at: string }> = [];
  /** Consumed Idempotency-Keys per collection — replay 409s like the real API. */
  private readonly idempotencyKeys = new Map<string, string>();
  private seq = 0;
  private failure: { status: number; body: unknown; times: number } | undefined;
  private networkFailure = 0;

  refundsEnabled = true;
  mandateLookupFails = false;
  uniqueBillingRequestCreations = 0;
  uniqueRefundCreations = 0;
  uniqueSubscriptionCreations = 0;
  /** Total fetch invocations — asserts the verifyCredentials probe is single-shot. */
  callCount = 0;
  lastRequestBody: Record<string, unknown> | undefined;
  lastRequestUrl: string | undefined;
  readonly idempotencyKeysSeen: Array<{ path: string; key: string }> = [];

  /** Injects an HTTP failure for the next `times` requests (transient-error tests). */
  failNextWith(status: number, body: unknown, times = 1): void {
    this.failure = { status, body, times };
  }

  /** Rejects the next `times` requests at the transport layer (fetch throws) — the psp_unavailable path. */
  failNextWithNetworkError(times = 1): void {
    this.networkFailure = times;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    this.callCount += 1;
    // A transport failure (DNS/connection/timeout): fetch rejects before the
    // request is processed, exercising the adapter's onFailure mapping.
    if (this.networkFailure > 0) {
      this.networkFailure -= 1;
      throw new TypeError("simulated GoCardless network failure");
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const parsed = new URL(url);
    const path = parsed.pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    this.lastRequestUrl = url;
    this.lastRequestBody = body;
    const headers = init?.headers as Record<string, string> | undefined;
    const idempotencyKey = headers?.["idempotency-key"];
    if (idempotencyKey) this.idempotencyKeysSeen.push({ path, key: idempotencyKey });

    if (this.failure && this.failure.times > 0) {
      this.failure.times -= 1;
      return json(this.failure.status, this.failure.body);
    }

    // Every request must authenticate and pin the API version.
    if (!headers?.["authorization"]?.startsWith("Bearer ") || !headers?.["gocardless-version"]) {
      return json(401, {
        error: {
          message: "Access token not found or invalid",
          type: "invalid_api_usage",
          code: 401,
          errors: [{ reason: "access_token_not_found", message: "Access token not found or invalid" }],
        },
      });
    }

    if (method === "POST" && path === "/billing_requests") {
      return this.createBillingRequest(body!, idempotencyKey);
    }
    if (method === "POST" && path === "/billing_request_flows") {
      return this.createFlow(body!);
    }
    if (method === "POST" && path === "/refunds") return this.createRefund(body!, idempotencyKey);
    if (method === "POST" && path === "/subscriptions") {
      return this.createSubscription(body!, idempotencyKey);
    }
    if (method === "GET" && path === "/subscriptions") {
      const { page, after } = this.paginate([...this.subscriptions.values()], parsed.searchParams);
      return json(200, { subscriptions: page, meta: { cursors: { before: null, after }, limit: 50 } });
    }
    const subCancelMatch = /^\/subscriptions\/([^/]+)\/actions\/cancel$/.exec(path);
    if (method === "POST" && subCancelMatch) {
      const subscription = this.subscriptions.get(decodeURIComponent(subCancelMatch[1]!));
      if (!subscription) return notFound("subscription");
      // Real API: cancel fails with cancellation_failed once the subscription
      // is already cancelled or finished.
      if (subscription.status === "cancelled" || subscription.status === "finished") {
        return invalidState("Subscription is already cancelled or finished");
      }
      subscription.status = "cancelled";
      subscription.upcoming_payments = [];
      this.recordEvent("subscriptions", "cancelled", { subscription: subscription.id });
      return json(200, { subscriptions: subscription });
    }
    const subMatch = /^\/subscriptions\/([^/]+)$/.exec(path);
    if (method === "GET" && subMatch) {
      const subscription = this.subscriptions.get(decodeURIComponent(subMatch[1]!));
      if (!subscription) return notFound("subscription");
      return json(200, { subscriptions: subscription });
    }

    const brMatch = /^\/billing_requests\/([^/]+)$/.exec(path);
    if (method === "GET" && brMatch) {
      const br = this.billingRequests.get(decodeURIComponent(brMatch[1]!));
      if (!br) return notFound("billing request");
      return json(200, { billing_requests: br });
    }
    const brCancelMatch = /^\/billing_requests\/([^/]+)\/actions\/cancel$/.exec(path);
    if (method === "POST" && brCancelMatch) {
      const br = this.billingRequests.get(decodeURIComponent(brCancelMatch[1]!));
      if (!br) return notFound("billing request");
      if (br.status === "fulfilled" || br.status === "cancelled") {
        return invalidState("Billing request cannot be cancelled in its current state");
      }
      br.status = "cancelled";
      this.recordEvent("billing_requests", "cancelled", { billing_request: br.id });
      return json(200, { billing_requests: br });
    }
    if (method === "GET" && path === "/payments") {
      const { page, after } = this.paginate([...this.payments.values()], parsed.searchParams);
      return json(200, { payments: page, meta: { cursors: { before: null, after }, limit: 50 } });
    }
    const paymentMatch = /^\/payments\/([^/]+)$/.exec(path);
    if (method === "GET" && paymentMatch) {
      const payment = this.payments.get(decodeURIComponent(paymentMatch[1]!));
      if (!payment) return notFound("payment");
      return json(200, { payments: payment });
    }
    const paymentCancelMatch = /^\/payments\/([^/]+)\/actions\/cancel$/.exec(path);
    if (method === "POST" && paymentCancelMatch) {
      const payment = this.payments.get(decodeURIComponent(paymentCancelMatch[1]!));
      if (!payment) return notFound("payment");
      // Real API: only pending_submission payments cancel.
      if (payment.status !== "pending_submission") {
        return json(422, {
          error: {
            message: "Payment cannot be cancelled",
            type: "invalid_state",
            code: 422,
            request_id: "req_fake",
            documentation_url: "https://developer.gocardless.com/api-reference#invalid_state",
            errors: [{ reason: "cancellation_failed", message: "This payment has already been submitted" }],
          },
        });
      }
      payment.status = "cancelled";
      this.recordEvent("payments", "cancelled", { payment: payment.id });
      return json(200, { payments: payment });
    }
    if (method === "GET" && path === "/refunds") {
      // Sandbox-verified: GET /refunds accepts ?payment= and scopes the list.
      const paymentFilter = parsed.searchParams.get("payment");
      const scoped = [...this.refunds.values()].filter(
        (refund) => !paymentFilter || refund.links?.payment === paymentFilter,
      );
      const { page, after } = this.paginate(scoped, parsed.searchParams);
      return json(200, { refunds: page, meta: { cursors: { before: null, after }, limit: 50 } });
    }
    const refundMatch = /^\/refunds\/([^/]+)$/.exec(path);
    if (method === "GET" && refundMatch) {
      const refund = this.refunds.get(decodeURIComponent(refundMatch[1]!));
      if (!refund) return notFound("refund");
      return json(200, { refunds: refund });
    }
    const mandateMatch = /^\/mandates\/([^/]+)$/.exec(path);
    if (method === "GET" && mandateMatch) {
      if (this.mandateLookupFails) {
        return json(500, { error: { message: "Internal error", type: "gocardless", code: 500 } });
      }
      const mandate = this.mandates.get(decodeURIComponent(mandateMatch[1]!));
      if (!mandate) return notFound("mandate");
      return json(200, { mandates: mandate });
    }
    if (method === "GET" && path === "/events") {
      const { page, after } = this.paginate(this.events, parsed.searchParams);
      return json(200, { events: page, meta: { cursors: { before: null, after }, limit: 50 } });
    }

    return notFound(`route ${method} ${path}`);
  };

  private createBillingRequest(body: Record<string, unknown>, idempotencyKey?: string): Response {
    const replay = this.idempotentReplay("billing_requests", idempotencyKey);
    if (replay) return replay;
    const request = body["billing_requests"] as FakeBillingRequest & {
      payment_request?: {
        amount?: number;
        currency?: string;
        description?: string;
        scheme?: string;
        metadata?: Record<string, string>;
      };
    };
    const paymentRequest = request?.payment_request;
    if (paymentRequest && !["GBP", "EUR"].includes(paymentRequest.currency ?? "")) {
      return validationFailed("currency", "must be GBP or EUR for payment requests");
    }
    // Sandbox-verified: description is mandatory on payment requests.
    if (paymentRequest && !paymentRequest.description) {
      return validationFailed("payment_request", "can't be blank", "/billing_requests/payment_request/description");
    }
    const br: FakeBillingRequest = {
      id: `BRQ${String(++this.seq).padStart(6, "0")}`,
      created_at: this.nextTimestamp(),
      status: "pending",
      ...(paymentRequest ? { payment_request: { ...paymentRequest } } : {}),
      ...(request?.metadata ? { metadata: request.metadata as Record<string, string> } : {}),
      ...(request?.fallback_enabled !== undefined ? { fallback_enabled: request.fallback_enabled } : {}),
      actions: [
        { type: "collect_customer_details", required: true, status: "pending" },
        { type: "collect_bank_account", required: true, status: "pending" },
        { type: "bank_authorisation", required: true, status: "pending" },
      ],
      links: {},
    };
    this.billingRequests.set(br.id, br);
    this.consumeKey("billing_requests", idempotencyKey, br.id);
    this.uniqueBillingRequestCreations++;
    this.recordEvent("billing_requests", "created", { billing_request: br.id });
    return json(201, { billing_requests: br });
  }

  // Sandbox-verified: flow creates never dedupe — the same Idempotency-Key
  // yields a fresh flow (new id, new authorisation_url) on every POST.
  private createFlow(body: Record<string, unknown>): Response {
    const request = body["billing_request_flows"] as {
      redirect_uri?: string;
      exit_uri?: string;
      prefilled_customer?: Record<string, string>;
      links?: { billing_request?: string };
    };
    const brId = request?.links?.billing_request;
    if (!brId || !this.billingRequests.has(brId)) {
      return validationFailed("links.billing_request", "must exist");
    }
    const id = `BRF${String(++this.seq).padStart(6, "0")}`;
    const flow: FakeFlow = {
      id,
      authorisation_url: `https://pay.gocardless.com/billing/static/flow?id=${id}`,
      ...(request.redirect_uri ? { redirect_uri: request.redirect_uri } : {}),
      ...(request.exit_uri ? { exit_uri: request.exit_uri } : {}),
      ...(request.prefilled_customer ? { prefilled_customer: request.prefilled_customer } : {}),
      auto_fulfil: true,
      created_at: this.nextTimestamp(),
      expires_at: new Date(BASE_TIME + 7 * 24 * 3600 * 1000).toISOString(),
      links: { billing_request: brId },
    };
    this.flows.set(id, flow);
    return json(201, { billing_request_flows: flow });
  }

  private createRefund(body: Record<string, unknown>, idempotencyKey?: string): Response {
    if (!this.refundsEnabled) {
      // Refunds are disabled by default on GoCardless accounts.
      return json(403, {
        error: {
          message: "You do not have the correct permissions to make this request",
          type: "invalid_api_usage",
          code: 403,
          errors: [{ reason: "forbidden", message: "Refunds are not enabled for this account" }],
        },
      });
    }
    const replay = this.idempotentReplay("refunds", idempotencyKey);
    if (replay) return replay;
    const request = body["refunds"] as {
      amount?: number;
      total_amount_confirmation?: number;
      links?: { payment?: string };
      metadata?: Record<string, string>;
    };
    const payment = request?.links?.payment ? this.payments.get(request.links.payment) : undefined;
    if (!payment) return validationFailed("links.payment", "must exist");
    if (typeof request.amount !== "number") return validationFailed("amount", "is required");
    const alreadyRefunded = payment.amount_refunded ?? 0;
    if (alreadyRefunded + request.amount > (payment.amount ?? 0)) {
      return validationFailed("amount", "exceeds the refundable amount");
    }
    if (request.total_amount_confirmation !== alreadyRefunded + request.amount) {
      return json(422, {
        error: {
          message: "Validation failed",
          type: "validation_failed",
          code: 422,
          errors: [
            {
              reason: "total_amount_confirmation_invalid",
              field: "total_amount_confirmation",
              message: "does not match the total amount refunded",
            },
          ],
        },
      });
    }
    const refund: GoCardlessRefundLike = {
      id: `RF${String(++this.seq).padStart(6, "0")}`,
      created_at: this.nextTimestamp(),
      amount: request.amount,
      currency: payment.currency,
      status: "created",
      links: { payment: payment.id },
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };
    payment.amount_refunded = alreadyRefunded + request.amount;
    this.refunds.set(refund.id, refund);
    this.consumeKey("refunds", idempotencyKey, refund.id);
    this.uniqueRefundCreations++;
    this.recordEvent("refunds", "created", { refund: refund.id, payment: payment.id });
    return json(201, { refunds: refund });
  }

  private createSubscription(body: Record<string, unknown>, idempotencyKey?: string): Response {
    const replay = this.idempotentReplay("subscriptions", idempotencyKey);
    if (replay) return replay;
    const request = body["subscriptions"] as {
      amount?: number;
      currency?: string;
      interval_unit?: string;
      interval?: number;
      start_date?: string;
      name?: string;
      metadata?: Record<string, string>;
      links?: { mandate?: string };
    };
    const mandateId = request?.links?.mandate;
    if (!mandateId || !this.mandates.has(mandateId)) {
      return validationFailed("links.mandate", "must exist");
    }
    if (typeof request.amount !== "number" || request.amount <= 0) {
      return validationFailed("amount", "must be greater than 0");
    }
    if (!["AUD", "CAD", "DKK", "EUR", "GBP", "NZD", "SEK", "USD"].includes(request.currency ?? "")) {
      return validationFailed("currency", "is not a supported subscription currency");
    }
    if (!["weekly", "monthly", "yearly"].includes(request.interval_unit ?? "")) {
      return validationFailed("interval_unit", "must be one of weekly, monthly, yearly");
    }
    if (request.start_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(request.start_date)) {
      return validationFailed("start_date", "must be formatted YYYY-MM-DD");
    }
    if (request.metadata && Object.keys(request.metadata).length > 3) {
      return validationFailed("metadata", "must have at most 3 keys");
    }
    if (request.name !== undefined && request.name.length > 255) {
      return validationFailed("name", "must not exceed 255 characters");
    }
    const interval = request.interval ?? 1;
    // Real API: start_date defaults to the mandate's next_possible_charge_date.
    const start = request.start_date ?? this.nextTimestamp().slice(0, 10);
    const stepDays = request.interval_unit === "weekly" ? 7 : request.interval_unit === "monthly" ? 30 : 365;
    const subscription: GoCardlessSubscriptionLike = {
      id: `SB${String(++this.seq).padStart(6, "0")}`,
      created_at: this.nextTimestamp(),
      amount: request.amount,
      currency: request.currency!,
      status: "active",
      start_date: start,
      interval,
      interval_unit: request.interval_unit!,
      upcoming_payments: [
        { charge_date: start, amount: request.amount },
        { charge_date: addDays(start, stepDays * interval), amount: request.amount },
      ],
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
      links: { mandate: mandateId },
    };
    this.subscriptions.set(subscription.id, subscription);
    this.consumeKey("subscriptions", idempotencyKey, subscription.id);
    this.uniqueSubscriptionCreations++;
    this.recordEvent("subscriptions", "created", { subscription: subscription.id });
    return json(201, { subscriptions: subscription });
  }

  // --- Scenario helpers (sandbox-simulator stand-ins) ------------------------

  /** Hosted-flow completion: fulfils the billing request, creating its payment + mandate. */
  fulfilBillingRequest(billingRequestId: string): { paymentId: string; mandateId: string } {
    const br = this.billingRequests.get(billingRequestId);
    if (!br) throw new Error(`no billing request ${billingRequestId}`);
    const mandate: FakeMandate = {
      id: `MD${String(++this.seq).padStart(6, "0")}`,
      reference: `REF-${this.seq}`,
      scheme: "faster_payments",
      status: "active",
      created_at: this.nextTimestamp(),
    };
    this.mandates.set(mandate.id, mandate);
    const payment: GoCardlessPaymentLike = {
      id: `PM${String(++this.seq).padStart(6, "0")}`,
      created_at: this.nextTimestamp(),
      amount: br.payment_request?.amount ?? 0,
      amount_refunded: 0,
      currency: br.payment_request?.currency ?? "GBP",
      scheme: br.payment_request?.scheme ?? "faster_payments",
      status: "pending_submission",
      // Real API: payment_request.metadata is stored on the created payment.
      ...(br.payment_request?.metadata ? { metadata: { ...br.payment_request.metadata } } : {}),
      links: { mandate: mandate.id },
    };
    this.payments.set(payment.id, payment);
    br.status = "fulfilled";
    br.links = { ...br.links, payment_request_payment: payment.id };
    this.recordEvent("billing_requests", "fulfilled", {
      billing_request: br.id,
      payment_request_payment: payment.id,
    });
    this.recordEvent("payments", "created", { payment: payment.id });
    return { paymentId: payment.id, mandateId: mandate.id };
  }

  confirmPayment(paymentId: string): void {
    const payment = this.mustPayment(paymentId);
    payment.status = "confirmed";
    this.recordEvent("payments", "confirmed", { payment: paymentId });
  }

  failPayment(paymentId: string): void {
    const payment = this.mustPayment(paymentId);
    payment.status = "failed";
    this.recordEvent("payments", "failed", { payment: paymentId });
  }

  setPaymentStatus(paymentId: string, status: string): void {
    this.mustPayment(paymentId).status = status;
  }

  /** Forces a billing request state without side effects (fulfilled-before-payment-link races). */
  setBillingRequestStatus(billingRequestId: string, status: string): void {
    const br = this.billingRequests.get(billingRequestId);
    if (!br) throw new Error(`no billing request ${billingRequestId}`);
    br.status = status;
  }

  setRefundStatus(refundId: string, status: string): void {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error(`no refund ${refundId}`);
    refund.status = status;
  }

  /** Seeds an active mandate directly — the charging handle subscriptions require. */
  seedMandate(fields: Partial<FakeMandate> = {}): { id: string } {
    const mandate: FakeMandate = {
      id: `MD${String(++this.seq).padStart(6, "0")}`,
      reference: `REF-${this.seq}`,
      scheme: "bacs",
      status: "active",
      created_at: this.nextTimestamp(),
      ...fields,
    };
    this.mandates.set(mandate.id, mandate);
    return { id: mandate.id };
  }

  /** Seeds a subscription directly (status tables, mapping tests). */
  seedSubscription(fields: Partial<GoCardlessSubscriptionLike> = {}): GoCardlessSubscriptionLike {
    const subscription: GoCardlessSubscriptionLike = {
      id: `SB${String(++this.seq).padStart(6, "0")}`,
      created_at: this.nextTimestamp(),
      amount: 2500,
      currency: "GBP",
      status: "active",
      interval: 1,
      interval_unit: "monthly",
      links: { mandate: this.seedMandate().id },
      ...fields,
    };
    this.subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  setSubscriptionStatus(subscriptionId: string, status: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) throw new Error(`no subscription ${subscriptionId}`);
    subscription.status = status;
  }

  /** Seeds a payment directly (status tables, listing tests). */
  seedPayment(fields: Partial<GoCardlessPaymentLike> = {}): GoCardlessPaymentLike {
    const payment: GoCardlessPaymentLike = {
      id: `PM${String(++this.seq).padStart(6, "0")}`,
      created_at: this.nextTimestamp(),
      amount: 1000,
      amount_refunded: 0,
      currency: "GBP",
      scheme: "faster_payments",
      status: "confirmed",
      ...fields,
    };
    this.payments.set(payment.id, payment);
    this.recordEvent("payments", "created", { payment: payment.id });
    return payment;
  }

  private mustPayment(paymentId: string): GoCardlessPaymentLike {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error(`no payment ${paymentId}`);
    return payment;
  }

  private recordEvent(resourceType: string, action: string, links: Record<string, string>): void {
    this.events.push({
      id: `EV${String(++this.seq).padStart(6, "0")}`,
      created_at: this.nextTimestamp(),
      resource_type: resourceType,
      action,
      links,
      details: { origin: "gocardless", cause: `${resourceType}_${action}` },
    });
  }

  private nextTimestamp(): string {
    return new Date(BASE_TIME + this.seq * 1000).toISOString();
  }

  /** Cursor pagination over insertion order with created_at range filters. */
  private paginate<T extends { id?: string; created_at?: string }>(
    items: T[],
    params: URLSearchParams,
  ): { page: T[]; after: string | null } {
    const gte = params.get("created_at[gte]");
    const lte = params.get("created_at[lte]");
    let filtered = items;
    if (gte) filtered = filtered.filter((item) => (item.created_at ?? "") >= gte);
    if (lte) filtered = filtered.filter((item) => (item.created_at ?? "") <= lte);
    const after = params.get("after");
    if (after) {
      const index = filtered.findIndex((item) => item.id === after);
      filtered = index >= 0 ? filtered.slice(index + 1) : filtered;
    }
    const limit = Number(params.get("limit") ?? "50");
    const page = filtered.slice(0, limit);
    const more = filtered.length > limit;
    return { page, after: more && page.length > 0 ? (page[page.length - 1]!.id ?? null) : null };
  }

  private idempotentReplay(collection: string, idempotencyKey: string | undefined): Response | undefined {
    if (!idempotencyKey) return undefined;
    const existing = this.idempotencyKeys.get(`${collection}:${idempotencyKey}`);
    if (!existing) return undefined;
    // Verbatim-shape 409 from the docs: the caller must fetch the named resource.
    return json(409, {
      error: {
        message: "A resource has already been created with this idempotency key",
        type: "invalid_state",
        code: 409,
        request_id: "req_fake_409",
        documentation_url: "https://developer.gocardless.com/api-reference#invalid_state",
        errors: [
          {
            reason: "idempotent_creation_conflict",
            message: "A resource has already been created with this idempotency key",
            links: { conflicting_resource_id: existing },
          },
        ],
      },
    });
  }

  private consumeKey(collection: string, idempotencyKey: string | undefined, resourceId: string): void {
    if (idempotencyKey) this.idempotencyKeys.set(`${collection}:${idempotencyKey}`, resourceId);
  }
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function notFound(what: string): Response {
  return json(404, {
    error: {
      message: `Not found: ${what}`,
      type: "invalid_api_usage",
      code: 404,
      errors: [{ reason: "resource_not_found", message: `Not found: ${what}` }],
    },
  });
}

function validationFailed(field: string, message: string, requestPointer?: string): Response {
  return json(422, {
    error: {
      message: "Validation failed",
      type: "validation_failed",
      code: 422,
      documentation_url: "https://developer.gocardless.com/api-reference#validation_failed",
      errors: [{ field, message, request_pointer: requestPointer ?? `/${field}` }],
    },
  });
}

function invalidState(message: string): Response {
  return json(422, {
    error: {
      message,
      type: "invalid_state",
      code: 422,
      documentation_url: "https://developer.gocardless.com/api-reference#invalid_state",
      errors: [{ reason: "cancellation_failed", message }],
    },
  });
}
