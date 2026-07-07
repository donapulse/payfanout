/**
 * In-memory PayPal REST API (Orders v2 + Payments v2 + Notifications v1).
 * Reproduces the behaviors the adapter is written against: OAuth token expiry,
 * PayPal-Request-Id replay (same id -> original response), ORDER_NOT_APPROVED /
 * INSTRUMENT_DECLINED / ORDER_ALREADY_CAPTURED 422s, refund guards, and the
 * verify-webhook-signature postback that only accepts byte-identical raw
 * event bodies.
 */

interface FakeMoney {
  currency_code: string;
  value: string;
}

interface FakeCapture {
  id: string;
  status: string;
  amount: FakeMoney;
  final_capture: boolean;
  custom_id?: string;
  seller_protection: { status: string; dispute_categories: string[] };
  supplementary_data: { related_ids: { order_id: string; authorization_id?: string } };
  create_time: string;
  update_time: string;
  links: Array<{ href: string; rel: string; method: string }>;
}

interface FakeAuthorization {
  id: string;
  status: string;
  amount: FakeMoney;
  expiration_time: string;
  create_time: string;
}

interface FakeRefund {
  id: string;
  status: string;
  amount: FakeMoney;
  seller_payable_breakdown: {
    gross_amount: FakeMoney;
    paypal_fee: FakeMoney;
    net_amount: FakeMoney;
    total_refunded_amount: FakeMoney;
  };
  create_time: string;
  links: Array<{ href: string; rel: string; method: string }>;
}

interface FakePurchaseUnit {
  reference_id: string;
  amount: FakeMoney;
  custom_id?: string;
  soft_descriptor?: string;
  shipping?: unknown;
  payments?: { captures?: FakeCapture[]; authorizations?: FakeAuthorization[]; refunds?: FakeRefund[] };
}

interface FakeOrder {
  id: string;
  intent: string;
  status: string;
  create_time: string;
  purchase_units: FakePurchaseUnit[];
  payment_source?: Record<string, unknown>;
  payer?: Record<string, unknown>;
  links: Array<{ href: string; rel: string; method: string }>;
  declineCapture?: boolean;
  pendingCapture?: boolean;
}

interface WebhookFixture {
  rawBody: string;
  headers: Record<string, string>;
}

const SUPPORTED_CURRENCIES = new Set([
  "AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD", "HUF", "ILS",
  "JPY", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN", "RUB", "SEK", "SGD", "THB", "TWD", "USD",
]);
const WHOLE_UNIT = new Set(["HUF", "JPY", "TWD"]);
const BASE = "https://api-m.sandbox.paypal.com";

export class FakePayPalApi {
  private readonly orders = new Map<string, FakeOrder>();
  private readonly captures = new Map<string, { capture: FakeCapture; orderId: string }>();
  private readonly authorizations = new Map<string, { auth: FakeAuthorization; orderId: string; captured: number }>();
  private readonly refunds = new Map<string, FakeRefund>();
  private readonly replays = new Map<string, { status: number; body: string }>();
  private readonly tokens = new Map<string, number>();
  private readonly webhookFixtures: WebhookFixture[] = [];
  private failQueue: Array<{ status: number; body: unknown }> = [];
  private seededEvents: object[] = [];
  private seq = 0;

  readonly clientId: string;
  readonly clientSecret: string;
  readonly webhookId: string;
  now: () => number;
  tokenTtlSeconds: number;

  uniqueOrderCreations = 0;
  uniqueRefundCreations = 0;
  tokenMints = 0;
  verifyCalls = 0;
  requestCount = 0;
  lastRequestBody: unknown;
  lastRequestHeaders: Record<string, string> = {};

  constructor(options: { clientId?: string; clientSecret?: string; webhookId?: string; now?: () => number; tokenTtlSeconds?: number } = {}) {
    this.clientId = options.clientId ?? "fake-client-id";
    this.clientSecret = options.clientSecret ?? "fake-client-secret";
    this.webhookId = options.webhookId ?? "1JE4291016473214C";
    this.now = options.now ?? Date.now;
    this.tokenTtlSeconds = options.tokenTtlSeconds ?? 31668;
  }

  // --- test helpers ---------------------------------------------------------

  /** Simulates the buyer approving the popup (the only path to a capturable order). */
  approveOrder(orderId: string, options: { decline?: boolean; pendingCapture?: boolean; email?: string } = {}): void {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`FakePayPalApi.approveOrder: no such order ${orderId}`);
    order.status = "APPROVED";
    order.declineCapture = options.decline ?? false;
    order.pendingCapture = options.pendingCapture ?? false;
    order.payer = { payer_id: "QYR5Z8XDVJNXQ", email_address: options.email ?? "customer@example.com" };
    order.payment_source = {
      paypal: {
        email_address: options.email ?? "customer@example.com",
        account_id: "QYR5Z8XDVJNXQ",
        account_status: "VERIFIED",
        name: { given_name: "John", surname: "Doe" },
        address: { country_code: "US" },
      },
    };
  }

  registerWebhookFixture(rawBody: string, headers: Record<string, string>): void {
    this.webhookFixtures.push({ rawBody, headers: lowercase(headers) });
  }

  seedEvents(events: object[]): void {
    this.seededEvents = events;
  }

  /** Queues transport-level failures; each queued entry fails one request. */
  failNextWith(status: number, body: unknown, times = 1): void {
    for (let i = 0; i < times; i++) this.failQueue.push({ status, body });
  }

  /** Invalidates every issued token — the next call 401s and must re-mint. */
  revokeTokens(): void {
    this.tokens.clear();
  }

  // --- fetch impersonator ----------------------------------------------------

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const parsed = new URL(url);
    const path = parsed.pathname;
    const headers = lowercase((init?.headers ?? {}) as Record<string, string>);
    const rawBody = init?.body === undefined || init?.body === null ? undefined : String(init.body);
    this.requestCount++;

    const queued = this.failQueue.shift();
    if (queued) return json(queued.status, queued.body);

    if (method === "POST" && path === "/v1/oauth2/token") return this.mintToken(headers, rawBody);

    const bearer = /^Bearer (.+)$/.exec(headers["authorization"] ?? "")?.[1];
    const expiry = bearer ? this.tokens.get(bearer) : undefined;
    if (expiry === undefined || expiry <= this.now()) {
      return json(401, { name: "INVALID_TOKEN", message: "Token signature verification failed", debug_id: debugId() });
    }

    this.lastRequestHeaders = headers;
    const body = rawBody !== undefined && isJson(rawBody) ? (JSON.parse(rawBody) as unknown) : undefined;
    // Tracks the last request that CARRIED a body (bodiless GETs don't erase it).
    if (body !== undefined && path !== "/v1/notifications/verify-webhook-signature") this.lastRequestBody = body;

    const requestId = headers["paypal-request-id"];
    const replayKey = requestId ? `${method}:${path}:${requestId}` : undefined;
    if (replayKey && this.replays.has(replayKey)) {
      // Idempotent replay: latest status of the previous request, HTTP 200.
      return new Response(this.replays.get(replayKey)!.body, { status: 200, headers: JSON_HEADERS });
    }
    const remember = (status: number, payload: unknown): Response => {
      const text = JSON.stringify(payload);
      if (replayKey && status < 400) this.replays.set(replayKey, { status, body: text });
      return new Response(text, { status, headers: JSON_HEADERS });
    };

    if (method === "POST" && path === "/v2/checkout/orders") {
      return this.createOrder(body as Record<string, unknown>, remember);
    }
    let match = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(path);
    if (match) {
      const order = this.orders.get(decodeURIComponent(match[1]!));
      if (!order) return notFound();
      if (method === "GET") return json(200, publicOrder(order));
      if (method === "PATCH") return this.patchOrder(order, body as Array<Record<string, unknown>>);
    }
    match = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(path);
    if (method === "POST" && match) return this.captureOrder(decodeURIComponent(match[1]!), remember);
    match = /^\/v2\/checkout\/orders\/([^/]+)\/authorize$/.exec(path);
    if (method === "POST" && match) return this.authorizeOrder(decodeURIComponent(match[1]!), remember);
    match = /^\/v2\/payments\/authorizations\/([^/]+)\/capture$/.exec(path);
    if (method === "POST" && match) {
      return this.captureAuthorization(decodeURIComponent(match[1]!), body as Record<string, unknown>, remember);
    }
    match = /^\/v2\/payments\/authorizations\/([^/]+)\/void$/.exec(path);
    if (method === "POST" && match) return this.voidAuthorization(decodeURIComponent(match[1]!));
    match = /^\/v2\/payments\/captures\/([^/]+)$/.exec(path);
    if (method === "GET" && match) {
      const entry = this.captures.get(decodeURIComponent(match[1]!));
      return entry ? json(200, entry.capture) : notFound();
    }
    match = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(path);
    if (method === "POST" && match) {
      return this.refundCapture(decodeURIComponent(match[1]!), body as Record<string, unknown> | undefined, remember);
    }
    match = /^\/v2\/payments\/refunds\/([^/]+)$/.exec(path);
    if (method === "GET" && match) {
      const refund = this.refunds.get(decodeURIComponent(match[1]!));
      return refund ? json(200, refund) : notFound();
    }
    if (method === "POST" && path === "/v1/notifications/verify-webhook-signature") {
      return this.verifyWebhookSignature(rawBody ?? "");
    }
    if (method === "GET" && path === "/v1/notifications/webhooks-events") {
      return this.listEvents(parsed.searchParams);
    }
    return json(404, { name: "RESOURCE_NOT_FOUND", message: `No route ${method} ${path}`, debug_id: debugId() });
  };

  // --- routes ----------------------------------------------------------------

  private mintToken(headers: Record<string, string>, rawBody: string | undefined): Response {
    const expected = `Basic ${base64(`${this.clientId}:${this.clientSecret}`)}`;
    if (headers["authorization"] !== expected || rawBody !== "grant_type=client_credentials") {
      return json(401, { error: "invalid_client", error_description: "Client Authentication failed" });
    }
    const token = `A21AA-fake-${++this.seq}`;
    this.tokens.set(token, this.now() + this.tokenTtlSeconds * 1000);
    this.tokenMints++;
    return json(200, {
      scope: "https://uri.paypal.com/services/payments/payment",
      access_token: token,
      token_type: "Bearer",
      app_id: "APP-80W284485P519543T",
      expires_in: this.tokenTtlSeconds,
      nonce: `${this.iso()}-fake`,
    });
  }

  private createOrder(body: Record<string, unknown>, remember: (s: number, p: unknown) => Response): Response {
    const units = body["purchase_units"] as Array<Record<string, unknown>> | undefined;
    const amount = units?.[0]?.["amount"] as { currency_code?: string; value?: string } | undefined;
    const currency = amount?.currency_code ?? "";
    const value = amount?.value ?? "";
    if (!SUPPORTED_CURRENCIES.has(currency)) {
      return json(422, unprocessable("INVALID_CURRENCY_CODE", "Currency code is invalid or is not currently supported."));
    }
    const decimals = /\.(\d+)$/.exec(value)?.[1] ?? "";
    if ((WHOLE_UNIT.has(currency) && value.includes(".")) || decimals.length > 2) {
      return json(422, unprocessable("DECIMAL_PRECISION", "If the currency supports decimals, only two decimal place precision is supported."));
    }
    const id = `5O190127TN${String(++this.seq).padStart(6, "0")}`;
    const order: FakeOrder = {
      id,
      intent: (body["intent"] as string) ?? "CAPTURE",
      // Sandbox-verified: orders created with payment_source.paypal answer
      // PAYER_ACTION_REQUIRED immediately; bare orders answer CREATED.
      status: (body["payment_source"] as Record<string, unknown> | undefined)?.["paypal"]
        ? "PAYER_ACTION_REQUIRED"
        : "CREATED",
      create_time: this.iso(),
      purchase_units: [
        {
          reference_id: "default",
          amount: { currency_code: currency, value },
          ...(units?.[0]?.["custom_id"] !== undefined ? { custom_id: units[0]!["custom_id"] as string } : {}),
          ...(units?.[0]?.["soft_descriptor"] !== undefined ? { soft_descriptor: units[0]!["soft_descriptor"] as string } : {}),
          ...(units?.[0]?.["shipping"] !== undefined ? { shipping: units[0]!["shipping"] } : {}),
        },
      ],
      ...(body["payment_source"] !== undefined ? { payment_source: body["payment_source"] as Record<string, unknown> } : {}),
      links: [
        { href: `${BASE}/v2/checkout/orders/${id}`, rel: "self", method: "GET" },
        { href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" },
      ],
    };
    this.orders.set(order.id, order);
    this.uniqueOrderCreations++;
    return remember(201, publicOrder(order));
  }

  private patchOrder(order: FakeOrder, ops: Array<Record<string, unknown>>): Response {
    // Sandbox-verified: PATCH works on PAYER_ACTION_REQUIRED orders (pre-approval).
    if (order.status !== "CREATED" && order.status !== "PAYER_ACTION_REQUIRED" && order.status !== "APPROVED") {
      return json(422, unprocessable("ORDER_ALREADY_COMPLETED", "The order cannot be patched after it is completed."));
    }
    const unit = order.purchase_units[0]!;
    for (const op of ops ?? []) {
      const path = op["path"] as string;
      if (path === "/purchase_units/@reference_id=='default'/amount") {
        unit.amount = op["value"] as FakeMoney;
      } else if (path === "/purchase_units/@reference_id=='default'/soft_descriptor") {
        unit.soft_descriptor = op["value"] as string;
      } else if (path === "/purchase_units/@reference_id=='default'/shipping") {
        unit.shipping = op["value"];
      } else {
        return json(400, { name: "INVALID_REQUEST", message: `Unsupported patch path ${path}`, debug_id: debugId() });
      }
    }
    return new Response(null, { status: 204 });
  }

  private captureOrder(orderId: string, remember: (s: number, p: unknown) => Response): Response {
    const order = this.orders.get(orderId);
    if (!order) return notFound();
    if (order.status === "CREATED" || order.status === "PAYER_ACTION_REQUIRED") {
      return json(422, unprocessable("ORDER_NOT_APPROVED", "Payer has not yet approved the Order for payment."));
    }
    if (order.status === "COMPLETED") {
      return json(422, unprocessable("ORDER_ALREADY_CAPTURED", "Order already captured. If 'intent=CAPTURE' only one capture per order is allowed."));
    }
    if (order.declineCapture) {
      return json(
        422,
        unprocessable(
          "INSTRUMENT_DECLINED",
          "The instrument presented was either declined by the processor or bank, or it can't be used for this payment.",
        ),
      );
    }
    const unit = order.purchase_units[0]!;
    const capture = this.newCapture(order, unit.amount, order.pendingCapture ? "PENDING" : "COMPLETED", unit.custom_id);
    unit.payments = { ...(unit.payments ?? {}), captures: [...(unit.payments?.captures ?? []), capture] };
    order.status = "COMPLETED";
    return remember(201, publicOrder(order));
  }

  private authorizeOrder(orderId: string, remember: (s: number, p: unknown) => Response): Response {
    const order = this.orders.get(orderId);
    if (!order) return notFound();
    if (order.status === "CREATED" || order.status === "PAYER_ACTION_REQUIRED") {
      return json(422, unprocessable("ORDER_NOT_APPROVED", "Payer has not yet approved the Order for payment."));
    }
    if (order.status === "COMPLETED") {
      return json(422, unprocessable("ORDER_ALREADY_AUTHORIZED", "Order already authorized."));
    }
    const unit = order.purchase_units[0]!;
    const auth: FakeAuthorization = {
      id: `0AW21844481083${String(++this.seq).padStart(4, "0")}`,
      status: "CREATED",
      amount: { ...unit.amount },
      expiration_time: new Date(this.now() + 29 * 24 * 3600 * 1000).toISOString(),
      create_time: this.iso(),
    };
    unit.payments = { ...(unit.payments ?? {}), authorizations: [auth] };
    order.status = "COMPLETED";
    this.authorizations.set(auth.id, { auth, orderId: order.id, captured: 0 });
    return remember(201, publicOrder(order));
  }

  private captureAuthorization(
    authId: string,
    body: Record<string, unknown> | undefined,
    remember: (s: number, p: unknown) => Response,
  ): Response {
    const entry = this.authorizations.get(authId);
    if (!entry) return notFound();
    if (entry.auth.status === "VOIDED") {
      return json(422, unprocessable("AUTHORIZATION_VOIDED", "A voided authorization cannot be captured."));
    }
    const order = this.orders.get(entry.orderId)!;
    const unit = order.purchase_units[0]!;
    const authorized = decimalToCents(entry.auth.amount.value);
    const requestedMoney = body?.["amount"] as FakeMoney | undefined;
    const requested = requestedMoney ? decimalToCents(requestedMoney.value) : authorized - entry.captured;
    if (entry.captured + requested > authorized) {
      return json(422, unprocessable("MAX_CAPTURE_AMOUNT_EXCEEDED", "Capture amount specified exceeded allowable limit."));
    }
    const amount: FakeMoney = requestedMoney ?? { ...entry.auth.amount };
    const capture = this.newCapture(order, amount, "COMPLETED", unit.custom_id, authId);
    entry.captured += requested;
    entry.auth.status = entry.captured >= authorized ? "CAPTURED" : "PARTIALLY_CAPTURED";
    unit.payments = { ...(unit.payments ?? {}), captures: [...(unit.payments?.captures ?? []), capture] };
    return remember(201, capture);
  }

  private voidAuthorization(authId: string): Response {
    const entry = this.authorizations.get(authId);
    if (!entry) return notFound();
    if (entry.captured > 0) {
      return json(422, unprocessable("PREVIOUSLY_CAPTURED", "Authorization has been previously captured and hence cannot be voided."));
    }
    if (entry.auth.status === "VOIDED") {
      return json(422, unprocessable("AUTHORIZATION_VOIDED", "Authorization has been previously voided."));
    }
    entry.auth.status = "VOIDED";
    return new Response(null, { status: 204 });
  }

  private refundCapture(
    captureId: string,
    body: Record<string, unknown> | undefined,
    remember: (s: number, p: unknown) => Response,
  ): Response {
    const entry = this.captures.get(captureId);
    if (!entry) return notFound();
    const { capture } = entry;
    const captured = decimalToCents(capture.amount.value);
    const alreadyRefunded = [...this.refunds.values()]
      .filter((r) => r.links.some((l) => l.rel === "up" && l.href.endsWith(`/captures/${captureId}`)))
      .reduce((sum, r) => sum + decimalToCents(r.amount.value), 0);
    if (alreadyRefunded >= captured) {
      return json(422, unprocessable("CAPTURE_FULLY_REFUNDED", "The capture has already been fully refunded."));
    }
    const requestedMoney = body?.["amount"] as FakeMoney | undefined;
    const requested = requestedMoney ? decimalToCents(requestedMoney.value) : captured - alreadyRefunded;
    if (alreadyRefunded + requested > captured) {
      return json(422, unprocessable("REFUND_AMOUNT_EXCEEDED", "The refund amount must be less than or equal to the capture amount that has not yet been refunded."));
    }
    const total = alreadyRefunded + requested;
    const currency = capture.amount.currency_code;
    const refundId = `1JU089027816${String(++this.seq).padStart(5, "0")}`;
    const refund: FakeRefund = {
      id: refundId,
      status: "COMPLETED",
      amount: requestedMoney ?? { currency_code: currency, value: centsToDecimal(requested, currency) },
      seller_payable_breakdown: {
        gross_amount: { currency_code: currency, value: centsToDecimal(requested, currency) },
        paypal_fee: { currency_code: currency, value: centsToDecimal(0, currency) },
        net_amount: { currency_code: currency, value: centsToDecimal(requested, currency) },
        total_refunded_amount: { currency_code: currency, value: centsToDecimal(total, currency) },
      },
      create_time: this.iso(),
      links: [
        { href: `${BASE}/v2/payments/refunds/${refundId}`, rel: "self", method: "GET" },
        { href: `${BASE}/v2/payments/captures/${captureId}`, rel: "up", method: "GET" },
      ],
    };
    this.refunds.set(refund.id, refund);
    this.uniqueRefundCreations++;
    capture.status = total >= captured ? "REFUNDED" : "PARTIALLY_REFUNDED";
    // Order GETs list refunds under the purchase unit's payments collection.
    const order = this.orders.get(entry.orderId);
    const unit = order?.purchase_units[0];
    if (unit) unit.payments = { ...(unit.payments ?? {}), refunds: [...(unit.payments?.refunds ?? []), refund] };
    return remember(201, refund);
  }

  private verifyWebhookSignature(rawPosted: string): Response {
    this.verifyCalls++;
    const marker = '"webhook_event":';
    const markerIndex = rawPosted.indexOf(marker);
    if (markerIndex === -1 || !rawPosted.endsWith("}")) return json(200, { verification_status: "FAILURE" });
    // Byte-fidelity check: the spliced webhook_event must equal a delivered
    // fixture EXACTLY — re-serialized JSON (same value, different bytes) fails.
    const rawEvent = rawPosted.slice(markerIndex + marker.length, rawPosted.length - 1);
    const parsed = JSON.parse(rawPosted) as Record<string, string>;
    const fixture = this.webhookFixtures.find((f) => f.rawBody === rawEvent);
    const headersMatch =
      fixture !== undefined &&
      parsed["transmission_id"] === fixture.headers["paypal-transmission-id"] &&
      parsed["transmission_time"] === fixture.headers["paypal-transmission-time"] &&
      parsed["cert_url"] === fixture.headers["paypal-cert-url"] &&
      parsed["auth_algo"] === fixture.headers["paypal-auth-algo"] &&
      parsed["transmission_sig"] === fixture.headers["paypal-transmission-sig"];
    const ok = headersMatch && parsed["webhook_id"] === this.webhookId;
    return json(200, { verification_status: ok ? "SUCCESS" : "FAILURE" });
  }

  private listEvents(params: URLSearchParams): Response {
    const pageSize = Number(params.get("page_size") ?? "10");
    const startIndex = Number(params.get("start_index") ?? "0");
    const startTime = params.get("start_time");
    const all = this.seededEvents.filter((event) => {
      if (!startTime) return true;
      const created = (event as { create_time?: string }).create_time;
      return created !== undefined && Date.parse(created) >= Date.parse(startTime);
    });
    const page = all.slice(startIndex, startIndex + pageSize);
    const more = startIndex + pageSize < all.length;
    return json(200, {
      events: page,
      count: page.length,
      links: [
        { href: `${BASE}/v1/notifications/webhooks-events?page_size=${pageSize}&start_index=${startIndex}`, rel: "self", method: "GET" },
        ...(more
          ? [{ href: `${BASE}/v1/notifications/webhooks-events?page_size=${pageSize}&start_index=${startIndex + pageSize}`, rel: "next", method: "GET" }]
          : []),
      ],
    });
  }

  // --- internals ---------------------------------------------------------------

  private newCapture(
    order: FakeOrder,
    amount: FakeMoney,
    status: string,
    customId: string | undefined,
    authorizationId?: string,
  ): FakeCapture {
    const captureId = `2GG279541U${String(++this.seq).padStart(6, "0")}P`;
    const capture: FakeCapture = {
      id: captureId,
      status,
      amount: { ...amount },
      final_capture: authorizationId === undefined,
      ...(customId !== undefined ? { custom_id: customId } : {}),
      seller_protection: { status: "ELIGIBLE", dispute_categories: ["ITEM_NOT_RECEIVED", "UNAUTHORIZED_TRANSACTION"] },
      supplementary_data: {
        related_ids: { order_id: order.id, ...(authorizationId ? { authorization_id: authorizationId } : {}) },
      },
      create_time: this.iso(),
      update_time: this.iso(),
      links: [
        { href: `${BASE}/v2/payments/captures/${captureId}`, rel: "self", method: "GET" },
        { href: `${BASE}/v2/payments/captures/${captureId}/refund`, rel: "refund", method: "POST" },
        { href: `${BASE}/v2/checkout/orders/${order.id}`, rel: "up", method: "GET" },
      ],
    };
    this.captures.set(capture.id, { capture, orderId: order.id });
    return capture;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

const JSON_HEADERS = { "content-type": "application/json" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function notFound(): Response {
  return json(404, {
    name: "RESOURCE_NOT_FOUND",
    message: "The specified resource does not exist.",
    debug_id: debugId(),
    details: [{ issue: "INVALID_RESOURCE_ID", description: "Specified resource ID does not exist. Please check the resource ID and try again." }],
  });
}

function unprocessable(issue: string, description: string): unknown {
  return {
    name: "UNPROCESSABLE_ENTITY",
    message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
    debug_id: debugId(),
    details: [{ issue, description }],
    links: [{ href: `https://developer.paypal.com/docs/api/orders/v2/#error-${issue}`, rel: "information_link" }],
  };
}

/** The order as GET returns it — internal test flags stripped. */
function publicOrder(order: FakeOrder): unknown {
  const { declineCapture: _declineCapture, pendingCapture: _pendingCapture, ...visible } = order;
  return JSON.parse(JSON.stringify(visible)) as unknown;
}

let debugSeq = 0;
function debugId(): string {
  return `fakedebug${++debugSeq}`;
}

function isJson(text: string): boolean {
  const first = text.trim()[0];
  return first === "{" || first === "[";
}

function lowercase(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** Fake-internal decimal helpers (2-decimal and whole-unit currencies only). */
function decimalToCents(value: string): number {
  const [units = "0", frac = ""] = value.split(".");
  return Number(units) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
}

function centsToDecimal(cents: number, currency: string): string {
  if (WHOLE_UNIT.has(currency)) return String(Math.round(cents / 100));
  const units = Math.trunc(cents / 100);
  return `${units}.${String(cents % 100).padStart(2, "0")}`;
}
