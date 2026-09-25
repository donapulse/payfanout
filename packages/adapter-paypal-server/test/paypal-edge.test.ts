import { describe, expect, it } from "vitest";
import { getRefundState, isPayFanoutError, type UnifiedErrorCode, type UnifiedPaymentStatus } from "@payfanout/core";
import {
  buildWebhookVerificationBody,
  fromPayPalValue,
  mapPayPalError,
  parsePayPalWebhookEvent,
  PayPalServerAdapter,
  toPayPalValue,
  type PayPalCaptureLike,
  type PayPalOrderLike,
  type PayPalRefundLike,
} from "../src/index.js";

const OAUTH_OK = JSON.stringify({ access_token: "tok", token_type: "Bearer", expires_in: 3600 });

/** Adapter whose API answers OAuth normally and serves fixed route responses. */
function adapterWithRoutes(routes: Record<string, { status: number; body: unknown }>): PayPalServerAdapter {
  return new PayPalServerAdapter({
    clientId: "id",
    clientSecret: "secret",
    environment: "sandbox",
    maxNetworkRetries: 0,
    fetch: (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/oauth2/token")) return new Response(OAUTH_OK, { status: 200 });
      const { pathname } = new URL(url);
      const route = routes[pathname];
      if (!route) {
        return new Response(JSON.stringify({ name: "RESOURCE_NOT_FOUND", message: "missing" }), { status: 404 });
      }
      return new Response(JSON.stringify(route.body), { status: route.status });
    }) as typeof fetch,
  });
}

function adapterWithOrder(order: Partial<PayPalOrderLike>): PayPalServerAdapter {
  return adapterWithRoutes({
    "/v2/checkout/orders/5O1": { status: 200, body: { id: "5O1", ...order } },
  });
}

describe("PayPal money conversion", () => {
  it("renders 2-decimal currencies with pure string math", () => {
    expect(toPayPalValue(1099, "USD")).toBe("10.99");
    expect(toPayPalValue(5, "EUR")).toBe("0.05");
    expect(toPayPalValue(100, "GBP")).toBe("1.00");
    expect(toPayPalValue(0, "USD")).toBe("0.00");
  });

  it("renders whole-unit currencies without a decimal point", () => {
    expect(toPayPalValue(500, "JPY")).toBe("500");
    expect(toPayPalValue(0, "JPY")).toBe("0");
    expect(toPayPalValue(105000, "HUF")).toBe("1050"); // ISO minor units / 100
    expect(toPayPalValue(9900, "TWD")).toBe("99");
  });

  it("rejects HUF/TWD amounts with sub-unit remainders (whole-unit rule)", () => {
    expect(() => toPayPalValue(1050, "HUF")).toThrowError(/whole HUF units/);
    expect(() => toPayPalValue(101, "TWD")).toThrowError(/whole TWD units/);
  });

  it("rejects unsupported currencies by name — including all 3-decimal ones", () => {
    for (const currency of ["BHD", "KWD", "TND", "XYZ", "INR"]) {
      expect(() => toPayPalValue(1000, currency), currency).toThrowError(new RegExp(currency));
      expect(() => fromPayPalValue("1.000", currency), currency).toThrowError(new RegExp(currency));
    }
  });

  it("parses PayPal decimal strings back to minor units", () => {
    expect(fromPayPalValue("10.99", "USD")).toBe(1099);
    expect(fromPayPalValue("0.05", "EUR")).toBe(5);
    expect(fromPayPalValue("7", "USD")).toBe(700); // bare integers are valid decimals
    expect(fromPayPalValue("500", "JPY")).toBe(500);
    expect(fromPayPalValue("1050", "HUF")).toBe(105000);
    expect(fromPayPalValue("99", "TWD")).toBe(9900);
    expect(fromPayPalValue("10.9", "USD")).toBe(1090);
    expect(fromPayPalValue("10.990", "USD")).toBe(1099); // trailing zeros beyond the exponent
  });

  it("round-trips every supported shape", () => {
    for (const [minor, currency] of [
      [1099, "USD"],
      [5, "EUR"],
      [500, "JPY"],
      [105000, "HUF"],
      [123456789, "CAD"],
    ] as const) {
      expect(fromPayPalValue(toPayPalValue(minor, currency), currency)).toBe(minor);
    }
  });

  it("rejects garbage, negatives, excess precision, and unsafe magnitudes", () => {
    expect(() => fromPayPalValue("abc", "USD")).toThrowError(/Cannot parse/);
    expect(() => fromPayPalValue("-1.00", "USD")).toThrowError(/Cannot parse/);
    expect(() => fromPayPalValue("1.005", "USD")).toThrowError(/precision/);
    expect(() => fromPayPalValue("500.5", "JPY")).toThrowError(/precision/);
    expect(() => fromPayPalValue("99999999999999999", "JPY")).toThrowError(/safe integer/);
    expect(() => toPayPalValue(10.5, "USD")).toThrowError(/minor units/);
    expect(() => toPayPalValue(-1, "USD")).toThrowError(/minor units/);
  });
});

describe("mapPayPalError", () => {
  const issue = (name: string) => ({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: name }] });
  const cases: Array<[number, unknown, UnifiedErrorCode, boolean]> = [
    [422, issue("INSTRUMENT_DECLINED"), "card_declined", false],
    [422, issue("REDIRECT_PAYER_FOR_ALTERNATE_FUNDING"), "card_declined", false],
    [422, issue("PAYMENT_DENIED"), "card_declined", false],
    [422, issue("PAYER_CANNOT_PAY"), "card_declined", false],
    [422, issue("PAYER_ACCOUNT_RESTRICTED"), "card_declined", false],
    [422, issue("PAYER_ACCOUNT_LOCKED_OR_CLOSED"), "card_declined", false],
    [422, issue("MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED"), "card_declined", false],
    [422, issue("PAYER_ACTION_REQUIRED"), "authentication_required", false],
    [422, issue("PAYEE_BLOCKED_TRANSACTION"), "fraud_suspected", false],
    [422, issue("TRANSACTION_BLOCKED_BY_PAYEE"), "fraud_suspected", false],
    [422, issue("COMPLIANCE_VIOLATION"), "fraud_suspected", false],
    [422, issue("TRANSACTION_REFUSED"), "processing_error", false],
    [422, issue("TRANSACTION_RECEIVING_LIMIT_EXCEEDED"), "processing_error", false],
    [422, issue("ORDER_NOT_APPROVED"), "invalid_request", false],
    [422, issue("ORDER_ALREADY_CAPTURED"), "invalid_request", false],
    [422, issue("DUPLICATE_INVOICE_ID"), "invalid_request", false],
    [422, issue("REFUND_AMOUNT_EXCEEDED"), "invalid_request", false],
    [422, issue("CAPTURE_FULLY_REFUNDED"), "invalid_request", false],
    [422, issue("MAX_NUMBER_OF_REFUNDS_EXCEEDED"), "invalid_request", false],
    [422, issue("AUTHORIZATION_ALREADY_CAPTURED"), "invalid_request", false],
    [422, issue("AUTHORIZATION_DENIED"), "invalid_request", false],
    [422, issue("AUTH_CAPTURE_CURRENCY_MISMATCH"), "invalid_request", false],
    [422, issue("SOMETHING_BRAND_NEW"), "invalid_request", false],
    // Malformed details never break the mapping: null entries are skipped, a non-list is ignored.
    [422, { name: "UNPROCESSABLE_ENTITY", details: [null, { issue: "INSTRUMENT_DECLINED" }] }, "card_declined", false],
    [422, { name: "UNPROCESSABLE_ENTITY", details: "INSTRUMENT_DECLINED" }, "invalid_request", false],
    [500, null, "psp_unavailable", true],
    [401, { error: "invalid_client", error_description: "Client Authentication failed" }, "invalid_request", false],
    [401, { name: "INVALID_TOKEN" }, "invalid_request", false],
    [429, { name: "RATE_LIMIT_REACHED" }, "rate_limited", true],
    [200, { name: "RATE_LIMIT_REACHED" }, "rate_limited", true],
    [500, { name: "INTERNAL_SERVICE_ERROR" }, "psp_unavailable", true],
    // PayPal's documented name for its 500, recognised whatever status carries it.
    [400, { name: "INTERNAL_SERVER_ERROR" }, "psp_unavailable", true],
    [503, "<html>gateway</html>", "psp_unavailable", true],
    [409, { name: "CONFLICT" }, "processing_error", true],
    [400, { name: "INVALID_REQUEST" }, "invalid_request", false],
    [404, { name: "RESOURCE_NOT_FOUND" }, "invalid_request", false],
  ];
  for (const [status, body, expected, retryable] of cases) {
    it(`maps HTTP ${status} ${JSON.stringify(body).slice(0, 60)} -> ${expected}`, () => {
      const mapped = mapPayPalError(status, body);
      expect(mapped.code).toBe(expected);
      expect(mapped.retryable).toBe(retryable);
      expect(mapped.raw).toBe(body);
      expect(mapped.pspName).toBe("paypal");
    });
  }

  it("gives funding-source declines the restart-in-popup guidance", () => {
    for (const name of ["INSTRUMENT_DECLINED", "REDIRECT_PAYER_FOR_ALTERNATE_FUNDING"]) {
      expect(mapPayPalError(422, issue(name)).message, name).toMatch(/different way to pay in the PayPal window/);
    }
  });

  it("tells declines of the payer's account to use another payment method", () => {
    for (const name of [
      "PAYMENT_DENIED",
      "PAYER_CANNOT_PAY",
      "PAYER_ACCOUNT_RESTRICTED",
      "PAYER_ACCOUNT_LOCKED_OR_CLOSED",
      "MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED",
    ]) {
      expect(mapPayPalError(422, issue(name)).message, name).toMatch(/another payment method/);
    }
  });
});

describe("PayPal order state mapping", () => {
  const unit = (payments?: object) => [{ reference_id: "default", amount: { currency_code: "USD", value: "20.00" }, ...(payments ? { payments } : {}) }];
  const cases: Array<[Partial<PayPalOrderLike>, UnifiedPaymentStatus]> = [
    [{ status: "CREATED", purchase_units: unit() }, "requires_payment_method"],
    [{ status: "SAVED", purchase_units: unit() }, "requires_payment_method"],
    [{ status: "PAYER_ACTION_REQUIRED", purchase_units: unit() }, "requires_action"],
    [{ status: "APPROVED", purchase_units: unit() }, "requires_confirmation"],
    [{ status: "VOIDED", purchase_units: unit() }, "canceled"],
    [{ status: "COMPLETED", purchase_units: unit({ captures: [{ id: "c1", status: "COMPLETED", amount: { currency_code: "USD", value: "20.00" } }] }) }, "succeeded"],
    [{ status: "COMPLETED", purchase_units: unit({ captures: [{ id: "c1", status: "PENDING", amount: { currency_code: "USD", value: "20.00" } }] }) }, "processing"],
    [{ status: "COMPLETED", purchase_units: unit({ captures: [{ id: "c1", status: "DECLINED", amount: { currency_code: "USD", value: "20.00" } }] }) }, "failed"],
    [{ status: "COMPLETED", purchase_units: unit({ authorizations: [{ id: "a1", status: "CREATED" }] }) }, "requires_capture"],
    [{ status: "COMPLETED", purchase_units: unit({ authorizations: [{ id: "a1", status: "PARTIALLY_CAPTURED" }] }) }, "requires_capture"],
    [{ status: "COMPLETED", purchase_units: unit({ authorizations: [{ id: "a1", status: "VOIDED" }] }) }, "canceled"],
    [{ status: "COMPLETED", purchase_units: unit({ authorizations: [{ id: "a1", status: "DENIED" }] }) }, "failed"],
    [{ status: "COMPLETED", purchase_units: unit({ authorizations: [{ id: "a1", status: "CAPTURED" }] }) }, "succeeded"],
    [{ status: "COMPLETED", purchase_units: unit({}) }, "processing"],
    [{ status: "SOMETHING_NEW", purchase_units: unit() }, "processing"],
  ];
  for (const [order, expected] of cases) {
    const label = `${order.status}${JSON.stringify(order.purchase_units?.[0]?.payments ?? {})}`;
    it(`maps ${label} -> ${expected}`, async () => {
      const info = await adapterWithOrder(order).retrievePayment("5O1");
      expect(info.status).toBe(expected);
    });
  }

  it("sums multi-capture amounts and reads refunds from the payments collection", async () => {
    const info = await adapterWithOrder({
      status: "COMPLETED",
      create_time: "2026-07-07T09:00:00Z",
      purchase_units: [
        {
          reference_id: "default",
          custom_id: "order-42",
          amount: { currency_code: "USD", value: "20.00" },
          payments: {
            captures: [
              { id: "c1", status: "COMPLETED", amount: { currency_code: "USD", value: "7.00" }, create_time: "2026-07-07T10:00:00Z" },
              { id: "c2", status: "COMPLETED", amount: { currency_code: "USD", value: "5.00" } },
              { id: "c3", status: "DECLINED", amount: { currency_code: "USD", value: "99.00" } },
            ],
            refunds: [{ id: "r1", status: "COMPLETED", amount: { currency_code: "USD", value: "3.00" } }],
          },
        },
      ],
      payment_source: { paypal: { email_address: "b@example.com" } },
    }).retrievePayment("5O1");
    expect(info.amount).toBe(1200); // 7.00 + 5.00; the declined 99.00 never counts
    expect(info.amountCaptured).toBe(1200);
    expect(info.amountCapturable).toBeUndefined(); // no authorization on a CAPTURE-intent order
    expect(info.amountRefunded).toBe(300);
    expect(info.id).toBe("order-42");
    expect(info.pspPaymentId).toBe("c1");
    expect(info.capturedAt).toBe("2026-07-07T10:00:00Z");
    expect(info.createdAt).toBe("2026-07-07T09:00:00Z");
    expect(info.paymentMethodDetails).toEqual({ wallet: "paypal" });
  });

  it("a PENDING capture counts toward amount but not amountCaptured (nothing settled)", async () => {
    const info = await adapterWithOrder({
      status: "COMPLETED",
      purchase_units: [
        {
          reference_id: "default",
          amount: { currency_code: "USD", value: "20.00" },
          payments: { captures: [{ id: "c1", status: "PENDING", amount: { currency_code: "USD", value: "20.00" } }] },
        },
      ],
    }).retrievePayment("5O1");
    expect(info.amount).toBe(2000);
    expect(info.amountCaptured).toBe(0);
  });

  it("derives amountCapturable from the authorization state", async () => {
    const withAuth = (status: string, captures: PayPalCaptureLike[] = []) =>
      adapterWithOrder({
        status: "COMPLETED",
        purchase_units: [
          {
            reference_id: "default",
            amount: { currency_code: "USD", value: "50.00" },
            payments: {
              authorizations: [{ id: "a1", status, amount: { currency_code: "USD", value: "50.00" } }],
              ...(captures.length > 0 ? { captures } : {}),
            },
          },
        ],
      }).retrievePayment("5O1");

    const open = await withAuth("CREATED");
    expect(open.amountCapturable).toBe(5000);
    expect(open.amountCaptured).toBe(0);

    const partial = await withAuth("PARTIALLY_CAPTURED", [
      { id: "c1", status: "COMPLETED", amount: { currency_code: "USD", value: "20.00" } },
    ]);
    expect(partial.amountCapturable).toBe(3000);
    expect(partial.amountCaptured).toBe(2000);

    const voided = await withAuth("VOIDED");
    expect(voided.amountCapturable).toBe(0);

    // No amount on the authorization: the remainder is not derivable — omitted.
    const amountless = await adapterWithOrder({
      status: "COMPLETED",
      purchase_units: [
        {
          reference_id: "default",
          amount: { currency_code: "USD", value: "50.00" },
          payments: { authorizations: [{ id: "a1", status: "CREATED" }] },
        },
      ],
    }).retrievePayment("5O1");
    expect(amountless.amountCapturable).toBeUndefined();
  });

  it("derives amountRefunded from a fully REFUNDED capture when refunds[] is absent", async () => {
    const capture = { id: "c1", status: "REFUNDED", amount: { currency_code: "USD", value: "20.00" } };
    const info = await adapterWithOrder({
      status: "COMPLETED",
      purchase_units: [{ reference_id: "default", amount: { currency_code: "USD", value: "20.00" }, payments: { captures: [capture] } }],
    }).retrievePayment("5O1");
    expect(info.amountRefunded).toBe(2000);
    expect(info.status).toBe("succeeded"); // refund state is derived, never a payment status
  });

  it("counts only refunds that returned money or are returning it", async () => {
    const withRefunds = (refunds: object[]) =>
      adapterWithOrder({
        status: "COMPLETED",
        purchase_units: [
          {
            reference_id: "default",
            amount: { currency_code: "USD", value: "20.00" },
            payments: {
              captures: [{ id: "c1", status: "PARTIALLY_REFUNDED", amount: { currency_code: "USD", value: "20.00" } }],
              refunds: refunds as PayPalRefundLike[],
            },
          },
        ],
      }).retrievePayment("5O1");

    const failedThenCompleted = await withRefunds([
      { id: "r1", status: "FAILED", amount: { currency_code: "USD", value: "5.00" } },
      { id: "r2", status: "COMPLETED", amount: { currency_code: "USD", value: "3.00" } },
    ]);
    expect(failedThenCompleted.amountRefunded).toBe(300);

    // PENDING money is on its way back and counts; a CANCELLED refund returned nothing.
    const pendingAndCancelled = await withRefunds([
      { id: "r3", status: "PENDING", amount: { currency_code: "USD", value: "2.00" } },
      { id: "r4", status: "CANCELLED", amount: { currency_code: "USD", value: "4.00" } },
    ]);
    expect(pendingAndCancelled.amountRefunded).toBe(200);
    expect(getRefundState(pendingAndCancelled)).toBe("partial");

    const onlyFailed = await withRefunds([
      { id: "r5", status: "FAILED", amount: { currency_code: "USD", value: "20.00" } },
    ]);
    expect(onlyFailed.amountRefunded).toBe(0);
    expect(getRefundState(onlyFailed)).toBe("none");
  });

  it("reports a Venmo-funded order with the venmo wallet", async () => {
    const info = await adapterWithOrder({
      status: "COMPLETED",
      purchase_units: [
        {
          reference_id: "default",
          amount: { currency_code: "USD", value: "20.00" },
          payments: { captures: [{ id: "c1", status: "COMPLETED", amount: { currency_code: "USD", value: "20.00" } }] },
        },
      ],
      payment_source: { venmo: { email_address: "buyer@example.com", user_name: "example-buyer" } },
    }).retrievePayment("5O1");
    expect(info.paymentMethodType).toBe("paypal");
    expect(info.paymentMethodDetails).toEqual({ wallet: "venmo" });
  });

  it("surfaces guest-checkout card facts when payment_source.card appears", async () => {
    const info = await adapterWithOrder({
      status: "COMPLETED",
      purchase_units: [
        {
          reference_id: "default",
          amount: { currency_code: "USD", value: "20.00" },
          payments: { captures: [{ id: "c1", status: "COMPLETED", amount: { currency_code: "USD", value: "20.00" } }] },
        },
      ],
      payment_source: { card: { brand: "VISA", last_digits: "4242" } },
    }).retrievePayment("5O1");
    expect(info.paymentMethodDetails).toEqual({ wallet: "paypal", brand: "visa", last4: "4242" });
  });
});

describe("PayPal bare-capture mapping (order aged out of GET)", () => {
  function adapterWithCapture(capture: object): PayPalServerAdapter {
    return adapterWithRoutes({
      "/v2/payments/captures/2GG1": { status: 200, body: { id: "2GG1", ...capture } },
    });
  }

  it("maps a COMPLETED capture with the capture id as canonical", async () => {
    const info = await adapterWithCapture({
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "50.00" },
      custom_id: "order-77",
      create_time: "2026-05-16T05:18:59Z",
    }).retrievePayment("2GG1");
    expect(info).toMatchObject({
      id: "order-77",
      pspPaymentId: "2GG1",
      status: "succeeded",
      amount: 5000,
      amountRefunded: 0,
      amountCaptured: 5000,
      currency: "USD",
      paymentMethodType: "paypal",
      capturedAt: "2026-05-16T05:18:59Z",
    });
    // A capture carries no payment source, so no wallet is claimed for it.
    expect(info.paymentMethodDetails).toBeUndefined();
  });

  it("REFUNDED reports the full amount; PARTIALLY_REFUNDED honestly reports 0", async () => {
    const refunded = await adapterWithCapture({
      status: "REFUNDED",
      amount: { currency_code: "USD", value: "50.00" },
    }).retrievePayment("2GG1");
    expect(refunded.amountRefunded).toBe(5000);

    // PayPal exposes no cumulative refunded total on the capture object.
    const partial = await adapterWithCapture({
      status: "PARTIALLY_REFUNDED",
      amount: { currency_code: "USD", value: "50.00" },
    }).retrievePayment("2GG1");
    expect(partial.amountRefunded).toBe(0);
    expect(partial.status).toBe("succeeded");
  });

  it("resolves the parent order for cumulative refunds while it is still retrievable", async () => {
    const adapter = adapterWithRoutes({
      "/v2/payments/captures/2GG1": {
        status: 200,
        body: {
          id: "2GG1",
          status: "PARTIALLY_REFUNDED",
          amount: { currency_code: "USD", value: "30.00" },
          supplementary_data: { related_ids: { order_id: "5O1" } },
        },
      },
      "/v2/checkout/orders/5O1": {
        status: 200,
        body: {
          id: "5O1",
          status: "COMPLETED",
          purchase_units: [
            {
              reference_id: "default",
              custom_id: "order-9",
              amount: { currency_code: "USD", value: "30.00" },
              payments: {
                captures: [
                  { id: "2GG1", status: "PARTIALLY_REFUNDED", amount: { currency_code: "USD", value: "30.00" } },
                ],
                refunds: [{ id: "r1", status: "COMPLETED", amount: { currency_code: "USD", value: "10.00" } }],
              },
            },
          ],
        },
      },
    });
    const info = await adapter.retrievePayment("2GG1");
    expect(info.amountRefunded).toBe(1000); // the order's embedded refunds, not the bare capture's 0
    expect(info.pspPaymentId).toBe("2GG1");
    expect(info.id).toBe("order-9");
  });

  it("falls back to bare capture facts when the parent order aged out of GET", async () => {
    const info = await adapterWithCapture({
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "50.00" },
      links: [{ href: "https://api.paypal.com/v2/checkout/orders/5OGONE", rel: "up", method: "GET" }],
    }).retrievePayment("2GG1");
    expect(info.pspPaymentId).toBe("2GG1");
    expect(info.amount).toBe(5000);
    expect(info.amountCaptured).toBe(5000);
  });

  it("maps PENDING to processing and DECLINED to failed", async () => {
    const pending = adapterWithCapture({ status: "PENDING", amount: { currency_code: "USD", value: "1.00" } });
    const pendingInfo = await pending.retrievePayment("2GG1");
    expect(pendingInfo.status).toBe("processing");
    expect(pendingInfo.amountCaptured).toBe(0); // nothing settled yet
    const declined = adapterWithCapture({ status: "DECLINED", amount: { currency_code: "USD", value: "1.00" } });
    const info = await declined.retrievePayment("2GG1");
    expect(info.status).toBe("failed");
    expect(info.capturedAt).toBeUndefined();
  });
});

type Exchange = { status: number; body: unknown };

/**
 * Fixed responses keyed by "METHOD /path" (a list answers one entry per call,
 * its last entry repeating); records what the adapter read and posted.
 */
function adapterWithExchanges(routes: Record<string, Exchange | Exchange[]>): {
  adapter: PayPalServerAdapter;
  gets: string[];
  posts: Array<{ path: string; body: unknown }>;
} {
  const gets: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  const served = new Map<string, number>();
  const adapter = new PayPalServerAdapter({
    clientId: "id",
    clientSecret: "secret",
    environment: "sandbox",
    maxNetworkRetries: 0,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/oauth2/token")) return new Response(OAUTH_OK, { status: 200 });
      const method = init?.method ?? "GET";
      const { pathname } = new URL(url);
      if (method === "POST") posts.push({ path: pathname, body: JSON.parse(String(init?.body)) as unknown });
      else gets.push(pathname);
      const key = `${method} ${pathname}`;
      const route = routes[key];
      if (!route) {
        return new Response(JSON.stringify({ name: "RESOURCE_NOT_FOUND", message: "missing" }), { status: 404 });
      }
      const call = served.get(key) ?? 0;
      served.set(key, call + 1);
      const exchange = Array.isArray(route) ? route[Math.min(call, route.length - 1)]! : route;
      return new Response(JSON.stringify(exchange.body), { status: exchange.status });
    }) as typeof fetch,
  });
  return { adapter, gets, posts };
}

const authorizedOrder = (payments: object): Exchange => ({
  status: 200,
  body: {
    id: "5O1",
    intent: "AUTHORIZE",
    status: "COMPLETED",
    purchase_units: [{ reference_id: "default", amount: { currency_code: "USD", value: "20.00" }, payments }],
  },
});

const alreadyCaptured = {
  status: 422,
  body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] },
};

describe("PayPal capture requests", () => {
  const capturedOk = { status: 201, body: { id: "c9", status: "COMPLETED" } };

  it("declined and failed captures took nothing from the authorization", async () => {
    const { adapter, posts } = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": authorizedOrder({
        authorizations: [{ id: "A1", status: "CREATED", amount: { currency_code: "USD", value: "20.00" } }],
        captures: [
          { id: "c1", status: "DECLINED", amount: { currency_code: "USD", value: "7.00" } },
          { id: "c2", status: "FAILED", amount: { currency_code: "USD", value: "3.00" } },
        ],
      }),
      "POST /v2/payments/authorizations/A1/capture": capturedOk,
    });
    await adapter.capturePayment("5O1", undefined, "k-rest");
    expect(posts).toEqual([
      {
        path: "/v2/payments/authorizations/A1/capture",
        body: { amount: { currency_code: "USD", value: "20.00" }, final_capture: true },
      },
    ]);
  });

  it("an authorization that reports no amount: a first capture takes it all, later ones need an amount", async () => {
    const fresh = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": authorizedOrder({ authorizations: [{ id: "A1", status: "CREATED" }] }),
      "POST /v2/payments/authorizations/A1/capture": capturedOk,
    });
    await fresh.adapter.capturePayment("5O1", undefined, "k-all");
    // No amount: PayPal captures the full authorized amount, so it is final.
    expect(fresh.posts[0]?.body).toEqual({ final_capture: true });

    const partial = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": authorizedOrder({
        authorizations: [{ id: "A1", status: "PARTIALLY_CAPTURED" }],
        captures: [{ id: "c1", status: "COMPLETED", amount: { currency_code: "USD", value: "5.00" } }],
      }),
      "POST /v2/payments/authorizations/A1/capture": capturedOk,
    });
    await expect(partial.adapter.capturePayment("5O1", undefined, "k-rest")).rejects.toThrowError(
      /remainder after earlier captures is unknown/,
    );
    expect(partial.posts).toHaveLength(0);
    // An explicit amount still goes out, and keeps the authorization open.
    await partial.adapter.capturePayment("5O1", 300, "k-part");
    expect(partial.posts[0]?.body).toEqual({ amount: { currency_code: "USD", value: "3.00" }, final_capture: false });
  });

  it("treats an authorization reporting no status as closed — nothing is captured", async () => {
    const { adapter, posts } = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": authorizedOrder({
        authorizations: [{ id: "A1", amount: { currency_code: "USD", value: "20.00" } }],
      }),
    });
    await expect(adapter.capturePayment("5O1", undefined, "k")).rejects.toThrowError(/in an unreported state/);
    expect(posts).toHaveLength(0);
  });

  it("surfaces an outage while resolving the order instead of probing for a capture", async () => {
    const { adapter, gets, posts } = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": { status: 503, body: { name: "INTERNAL_SERVICE_ERROR" } },
    });
    await expect(adapter.capturePayment("5O1", 100, "k")).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
    });
    expect(gets).toEqual(["/v2/checkout/orders/5O1"]);
    expect(posts).toHaveLength(0);
  });

  it("rejects a capture id whose capture names no parent order", async () => {
    const { adapter, posts } = adapterWithExchanges({
      "GET /v2/payments/captures/2GG1": {
        status: 200,
        body: { id: "2GG1", status: "COMPLETED", amount: { currency_code: "USD", value: "5.00" } },
      },
    });
    await expect(adapter.capturePayment("2GG1", 100, "k")).rejects.toThrowError(/names no parent order/);
    expect(posts).toHaveLength(0);
  });

  it("cancelling by a capture id whose capture names no parent order points to a refund", async () => {
    const { adapter, posts } = adapterWithExchanges({
      "GET /v2/payments/captures/2GG1": {
        status: 200,
        body: { id: "2GG1", status: "COMPLETED", amount: { currency_code: "USD", value: "5.00" } },
      },
    });
    await expect(adapter.cancelPayment("2GG1", "k-void")).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/names no parent order — captured payments cannot be canceled, refund them instead/),
    });
    expect(posts).toHaveLength(0);
  });

  it("capturing the rest of an authorization voided before captures covered it rejects without a capture", async () => {
    // PayPal reports an authorization that expired after a partial capture as VOIDED.
    const { adapter, posts } = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": authorizedOrder({
        authorizations: [{ id: "A1", status: "VOIDED", amount: { currency_code: "USD", value: "20.00" } }],
        captures: [{ id: "c1", status: "COMPLETED", amount: { currency_code: "USD", value: "5.00" } }],
      }),
    });
    await expect(adapter.capturePayment("5O1", undefined, "k-rest")).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
      message: expect.stringMatching(/nothing left to capture \(authorization A1 is VOIDED\)/),
    });
    expect(posts).toHaveLength(0);
  });

  it("capturing the rest once captures cover the authorization, a pending one included, answers with the payment", async () => {
    const { adapter, posts } = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": authorizedOrder({
        authorizations: [{ id: "A1", status: "PARTIALLY_CAPTURED", amount: { currency_code: "USD", value: "20.00" } }],
        captures: [
          { id: "c1", status: "COMPLETED", amount: { currency_code: "USD", value: "12.00" } },
          { id: "c2", status: "PENDING", amount: { currency_code: "USD", value: "8.00" } },
        ],
      }),
    });
    const info = await adapter.capturePayment("5O1", undefined, "k-rest");
    expect(info).toMatchObject({ pspPaymentId: "c1", amountCaptured: 1200, amountCapturable: 0 });
    expect(posts).toHaveLength(0);
  });

  it("a capture that took money as the final one closes the authorization", async () => {
    // The capture's own final_capture closes it whatever status the authorization reports.
    const closed = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": authorizedOrder({
        authorizations: [{ id: "A1", status: "PARTIALLY_CAPTURED", amount: { currency_code: "USD", value: "20.00" } }],
        captures: [{ id: "c1", status: "COMPLETED", final_capture: true, amount: { currency_code: "USD", value: "12.00" } }],
      }),
    });
    expect((await closed.adapter.retrievePayment("5O1")).amountCapturable).toBe(0);
    await expect(closed.adapter.capturePayment("5O1", undefined, "k-rest")).resolves.toMatchObject({
      amountCaptured: 1200,
      amountCapturable: 0,
    });
    expect(closed.posts).toHaveLength(0);

    // A declined capture took nothing, so its final_capture closed nothing either.
    const declined = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": authorizedOrder({
        authorizations: [{ id: "A1", status: "CREATED", amount: { currency_code: "USD", value: "20.00" } }],
        captures: [{ id: "c1", status: "DECLINED", final_capture: true, amount: { currency_code: "USD", value: "20.00" } }],
      }),
      "POST /v2/payments/authorizations/A1/capture": capturedOk,
    });
    await declined.adapter.capturePayment("5O1", undefined, "k-rest");
    expect(declined.posts).toEqual([
      {
        path: "/v2/payments/authorizations/A1/capture",
        body: { amount: { currency_code: "USD", value: "20.00" }, final_capture: true },
      },
    ]);
  });
});

describe("PayPal authorizations after a reauthorization", () => {
  const capturedOk = { status: 201, body: { id: "c9", status: "COMPLETED" } };
  const voidedOk = { status: 200, body: {} };
  const usd = (value: string) => ({ currency_code: "USD", value });
  const day = (n: number) => new Date(Date.parse("2026-09-01T10:00:00Z") + n * 24 * 3600 * 1000).toISOString();

  it("orders authorizations by create_time whatever the list order, one reporting none as the oldest", async () => {
    const a = { id: "A", status: "CREATED", amount: usd("20.00") };
    const b = { id: "B", status: "CREATED", amount: usd("20.00"), create_time: day(5) };
    const c = { id: "C", status: "CREATED", amount: usd("20.00"), create_time: day(1) };
    for (const listed of [[b, a, c], [a, b, c], [c, a, b]]) {
      const { adapter, posts } = adapterWithExchanges({
        "GET /v2/checkout/orders/5O1": authorizedOrder({ authorizations: listed }),
        "POST /v2/payments/authorizations/B/capture": capturedOk,
        "POST /v2/payments/authorizations/A/void": voidedOk,
      });
      await adapter.capturePayment("5O1", 500, "k-cap");
      await adapter.cancelPayment("5O1", "k-void");
      // The newest carries the hold; the oldest takes the void.
      expect(posts.map((post) => post.path), listed.map((authorization) => authorization.id).join("")).toEqual([
        "/v2/payments/authorizations/B/capture",
        "/v2/payments/authorizations/A/void",
      ]);
    }
  });

  it("voids the oldest authorization when the list names the reauthorization first", async () => {
    const { adapter, posts } = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": authorizedOrder({
        authorizations: [
          { id: "R", status: "CREATED", amount: usd("20.00"), create_time: day(4) },
          { id: "O", status: "CREATED", amount: usd("20.00"), create_time: day(0) },
        ],
      }),
      "POST /v2/payments/authorizations/O/void": voidedOk,
    });
    await adapter.cancelPayment("5O1", "k-void");
    expect(posts.map((post) => post.path)).toEqual(["/v2/payments/authorizations/O/void"]);
  });

  it("reads a capture's authorization from its up link whatever the link's form", async () => {
    const order = (upToA1: string, relToA2: string): Exchange =>
      authorizedOrder({
        authorizations: [
          { id: "A1", status: "PARTIALLY_CAPTURED", amount: usd("20.00"), create_time: day(0) },
          { id: "A2", status: "PARTIALLY_CAPTURED", amount: usd("10.00"), create_time: day(4) },
        ],
        captures: [
          {
            id: "c1",
            status: "COMPLETED",
            amount: usd("7.00"),
            // A link without a rel and an up link without an href are passed over.
            links: [{ href: "https://api-m.paypal.com/v2/payments/captures/c1" }, { rel: "up" }, { rel: "up", href: upToA1 }],
          },
          {
            id: "c2",
            status: "COMPLETED",
            amount: usd("2.00"),
            links: [{ rel: relToA2, href: "https://api-m.paypal.com/v2/payments/authorizations/A2" }],
          },
        ],
      });
    // A trailing slash with a query, and an upper-case rel, still name the authorization:
    // A2 holds 10.00 and 2.00 of it is taken, while the order has 11.00 left.
    const named = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": order("https://api-m.paypal.com/v2/payments/authorizations/A1/?page=1", "UP"),
    });
    expect((await named.adapter.retrievePayment("5O1")).amountCapturable).toBe(800);

    // A malformed escape names no authorization of the order, so every capture counts.
    const malformed = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": order("https://api-m.paypal.com/v2/payments/authorizations/%E0%A4%A", "up"),
    });
    expect((await malformed.adapter.retrievePayment("5O1")).amountCapturable).toBe(100);
  });

  it("capturing the rest once the order's captures cover it answers with the payment, the reauthorization still open", async () => {
    // The host took 5.00 from the reauthorization itself, without final_capture.
    const { adapter, posts } = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": authorizedOrder({
        authorizations: [
          { id: "A1", status: "PARTIALLY_CAPTURED", amount: usd("20.00"), create_time: day(0) },
          { id: "A2", status: "PARTIALLY_CAPTURED", amount: usd("20.00"), create_time: day(4) },
        ],
        captures: [
          { id: "c1", status: "COMPLETED", amount: usd("15.00"), supplementary_data: { related_ids: { authorization_id: "A1" } } },
          { id: "c2", status: "COMPLETED", amount: usd("5.00"), supplementary_data: { related_ids: { authorization_id: "A2" } } },
        ],
      }),
    });
    const info = await adapter.capturePayment("5O1", undefined, "k-rest");
    expect(info).toMatchObject({ amountCaptured: 2000, amountCapturable: 0 });
    expect(posts).toHaveLength(0);
  });

  it("measures the order by the holding authorization when the order reports no amount, and reads a bare order amount in its currency", async () => {
    // A reauthorization of the 13.00 left after a 7.00 capture from the original.
    const authorizations = [
      { id: "A1", status: "PARTIALLY_CAPTURED", amount: usd("20.00"), create_time: day(0) },
      { id: "A2", status: "CREATED", amount: usd("13.00"), create_time: day(4) },
    ];
    const captures = [
      { id: "c1", status: "COMPLETED", amount: usd("7.00"), supplementary_data: { related_ids: { authorization_id: "A1" } } },
    ];
    const orderWith = (amount?: object): Exchange => ({
      status: 200,
      body: {
        id: "5O1",
        intent: "AUTHORIZE",
        status: "COMPLETED",
        purchase_units: [{ reference_id: "default", ...(amount ? { amount } : {}), payments: { authorizations, captures } }],
      },
    });
    // No order amount: the 7.00 counts against A2's 13.00 too, so the rest errs low.
    const amountless = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": orderWith(),
      "POST /v2/payments/authorizations/A2/capture": capturedOk,
    });
    expect((await amountless.adapter.retrievePayment("5O1")).amountCapturable).toBe(600);
    await amountless.adapter.capturePayment("5O1", undefined, "k-rest");
    expect(amountless.posts.at(-1)?.body).toEqual({ amount: usd("6.00"), final_capture: true });

    const bare = adapterWithExchanges({ "GET /v2/checkout/orders/5O1": orderWith({ value: "20.00" }) });
    expect((await bare.adapter.retrievePayment("5O1")).amountCapturable).toBe(1300);
  });

  it("capturing the rest of an authorization PayPal closed as CAPTURED answers with the payment", async () => {
    // Its captures cover less than the order, and none went out as the final one.
    const { adapter, posts } = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": authorizedOrder({
        authorizations: [{ id: "A1", status: "CAPTURED", amount: usd("20.00") }],
        captures: [{ id: "c1", status: "COMPLETED", amount: usd("12.00") }],
      }),
    });
    await expect(adapter.capturePayment("5O1", undefined, "k-rest")).resolves.toMatchObject({
      amountCaptured: 1200,
      amountCapturable: 0,
    });
    expect(posts).toHaveLength(0);
  });

  it("capturing the rest of a reauthorization reporting no amount needs an explicit amount once the order has a capture", async () => {
    const { adapter, posts } = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": authorizedOrder({
        authorizations: [
          { id: "A1", status: "PARTIALLY_CAPTURED", amount: usd("20.00"), create_time: day(0) },
          { id: "A2", status: "CREATED", create_time: day(4) },
        ],
        captures: [
          { id: "c1", status: "COMPLETED", amount: usd("7.00"), supplementary_data: { related_ids: { authorization_id: "A1" } } },
        ],
      }),
    });
    // Without an amount PayPal would capture A2's full amount, which can reach past the order.
    await expect(adapter.capturePayment("5O1", undefined, "k-rest")).rejects.toThrowError(
      /remainder after earlier captures is unknown/,
    );
    expect(posts).toHaveLength(0);
  });
});

describe("PayPal completion replays (ORDER_ALREADY_CAPTURED)", () => {
  const complete = (adapter: PayPalServerAdapter) =>
    adapter.completePayment({ pspSessionId: "5O1", clientToken: "5O1", idempotencyKey: "k-again" });

  it("keeps the rejection when the re-read order is not completed", async () => {
    const { adapter, gets } = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": {
        status: 200,
        body: { id: "5O1", intent: "CAPTURE", status: "APPROVED", purchase_units: [{ reference_id: "default" }] },
      },
      "POST /v2/checkout/orders/5O1/capture": alreadyCaptured,
    });
    await expect(complete(adapter)).rejects.toMatchObject({
      code: "invalid_request",
      raw: { details: [{ issue: "ORDER_ALREADY_CAPTURED" }] },
    });
    expect(gets).toEqual(["/v2/checkout/orders/5O1", "/v2/checkout/orders/5O1"]); // read, then re-read
  });

  it("keeps the rejection when the re-read answers another order or carries no capture", async () => {
    const capturedUnit = {
      reference_id: "default",
      amount: { currency_code: "USD", value: "20.00" },
      payments: { captures: [{ id: "c1", status: "COMPLETED", amount: { currency_code: "USD", value: "20.00" } }] },
    };
    const otherOrder = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": {
        status: 200,
        body: { id: "5OOTHER", intent: "CAPTURE", status: "COMPLETED", purchase_units: [capturedUnit] },
      },
      "POST /v2/checkout/orders/5O1/capture": alreadyCaptured,
    });
    await expect(complete(otherOrder.adapter)).rejects.toMatchObject({ code: "invalid_request" });

    const noCapture = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": {
        status: 200,
        body: { id: "5O1", intent: "CAPTURE", status: "COMPLETED", purchase_units: [{ reference_id: "default", payments: {} }] },
      },
      "POST /v2/checkout/orders/5O1/capture": alreadyCaptured,
    });
    await expect(complete(noCapture.adapter)).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("surfaces a failed re-read as its own error, not the original rejection", async () => {
    const { adapter, gets } = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": [
        {
          status: 200,
          body: { id: "5O1", intent: "CAPTURE", status: "APPROVED", purchase_units: [{ reference_id: "default" }] },
        },
        { status: 503, body: { name: "INTERNAL_SERVICE_ERROR" } },
      ],
      "POST /v2/checkout/orders/5O1/capture": alreadyCaptured,
    });
    await expect(complete(adapter)).rejects.toMatchObject({ code: "psp_unavailable", retryable: true });
    expect(gets).toEqual(["/v2/checkout/orders/5O1", "/v2/checkout/orders/5O1"]); // read, then the failed re-read
  });

  it("rethrows every other completion error without re-reading", async () => {
    const declined = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": {
        status: 200,
        body: { id: "5O1", intent: "CAPTURE", status: "APPROVED", purchase_units: [{ reference_id: "default" }] },
      },
      "POST /v2/checkout/orders/5O1/capture": {
        status: 422,
        body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] },
      },
    });
    await expect(complete(declined.adapter)).rejects.toMatchObject({ code: "card_declined" });
    expect(declined.gets).toHaveLength(1);

    const outage = adapterWithExchanges({
      "GET /v2/checkout/orders/5O1": {
        status: 200,
        body: { id: "5O1", intent: "CAPTURE", status: "APPROVED", purchase_units: [{ reference_id: "default" }] },
      },
      "POST /v2/checkout/orders/5O1/capture": { status: 500, body: { name: "INTERNAL_SERVICE_ERROR" } },
    });
    await expect(complete(outage.adapter)).rejects.toMatchObject({ code: "psp_unavailable", retryable: true });
    expect(outage.gets).toHaveLength(1);
  });
});

describe("PayPal webhook event mapping", () => {
  const parse = (event: object) => parsePayPalWebhookEvent(JSON.stringify(event));

  it("maps the capture lifecycle, both DENIED spellings included", async () => {
    const variants: Array<[string, string]> = [
      ["PAYMENT.CAPTURE.COMPLETED", "payment.succeeded"],
      ["PAYMENT.CAPTURE.PENDING", "payment.processing"],
      ["PAYMENT.CAPTURE.DENIED", "payment.failed"],
      ["PAYMENT.CAPTURE.DECLINED", "payment.failed"],
      ["PAYMENT.CAPTURE.REFUNDED", "payment.refunded"],
      ["PAYMENT.CAPTURE.REVERSED", "payment.chargeback_lost"],
      ["PAYMENT.REFUND.FAILED", "payment.refund_failed"],
      ["PAYMENT.AUTHORIZATION.VOIDED", "payment.canceled"],
      ["CHECKOUT.PAYMENT-APPROVAL.REVERSED", "payment.canceled"],
      ["CUSTOMER.DISPUTE.CREATED", "payment.chargeback"],
      ["CUSTOMER.DISPUTE.UPDATED", "payment.chargeback"],
      ["CHECKOUT.ORDER.APPROVED", "unknown"],
      ["CHECKOUT.ORDER.COMPLETED", "unknown"],
      ["BILLING.PLAN.CREATED", "unknown"],
    ];
    for (const [eventType, expected] of variants) {
      const event = await parse({ id: `evt-${eventType}`, event_type: eventType, create_time: "2026-07-07T10:00:00Z", resource: { id: "res-1" } });
      expect(event.type, eventType).toBe(expected);
      expect(event.pspName).toBe("paypal");
    }
  });

  it("resolves dispute outcomes by outcome_code, never guessing unknown ones", async () => {
    const resolved = (outcome?: string) =>
      parse({
        id: "evt-d",
        event_type: "CUSTOMER.DISPUTE.RESOLVED",
        resource: {
          dispute_id: "PP-D-1",
          ...(outcome ? { dispute_outcome: { outcome_code: outcome } } : {}),
          disputed_transactions: [{ seller_transaction_id: "2GG279541U471931P" }],
        },
      });
    expect((await resolved("RESOLVED_SELLER_FAVOUR")).type).toBe("payment.chargeback_won");
    expect((await resolved("RESOLVED_BUYER_FAVOUR")).type).toBe("payment.chargeback_lost");
    expect((await resolved("RESOLVED_WITH_PAYOUT")).type).toBe("unknown");
    expect((await resolved(undefined)).type).toBe("unknown");
    // Dispute payloads carry the CAPTURE id — our canonical post-capture id.
    expect((await resolved("RESOLVED_SELLER_FAVOUR")).pspPaymentId).toBe("2GG279541U471931P");
  });

  it("keys capture events on the capture id and refund events on the parent capture", async () => {
    const captureEvent = await parse({
      id: "e1",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "2GGCAP", supplementary_data: { related_ids: { order_id: "5O1" } } },
    });
    expect(captureEvent.pspPaymentId).toBe("2GGCAP");

    const refundEvent = await parse({
      id: "e2",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: {
        id: "1JUREFUND",
        links: [{ href: "https://api.paypal.com/v2/payments/captures/2GGCAP", rel: "up", method: "GET" }],
      },
    });
    expect(refundEvent.pspPaymentId).toBe("2GGCAP"); // NOT the refund id

    const refundNoLinks = await parse({ id: "e3", event_type: "PAYMENT.REFUND.FAILED", resource: { id: "1JUREFUND" } });
    expect(refundNoLinks.pspPaymentId).toBe("1JUREFUND"); // honest fallback
    expect(refundNoLinks.refundId).toBe("1JUREFUND"); // still the refund id either way

    const authEvent = await parse({
      id: "e4",
      event_type: "PAYMENT.AUTHORIZATION.VOIDED",
      resource: { id: "0AW1", supplementary_data: { related_ids: { order_id: "5O9" } } },
    });
    expect(authEvent.pspPaymentId).toBe("5O9"); // pre-capture canonical id = order id
  });

  it("normalizes money facts and the refund id where the payload carries them", async () => {
    const captureEvent = await parse({
      id: "e-money",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "2GGCAP", amount: { currency_code: "USD", value: "50.00" } },
    });
    expect(captureEvent.amount).toBe(5000);
    expect(captureEvent.currency).toBe("USD");
    expect(captureEvent.refundId).toBeUndefined(); // not refund-shaped

    const refundEvent = await parse({
      id: "e-refund",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: {
        id: "1JUREFUND",
        amount: { currency_code: "EUR", value: "12.34" },
        links: [{ href: "https://api.paypal.com/v2/payments/captures/2GGCAP", rel: "up", method: "GET" }],
      },
    });
    expect(refundEvent.refundId).toBe("1JUREFUND");
    expect(refundEvent.pspPaymentId).toBe("2GGCAP"); // the parent capture, not the refund
    expect(refundEvent.amount).toBe(1234);
    expect(refundEvent.currency).toBe("EUR");

    const wholeUnit = await parse({
      id: "e-jpy",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "2GGJPY", amount: { currency_code: "JPY", value: "500" } },
    });
    expect(wholeUnit.amount).toBe(500);

    // Malformed or unsupported money never fails parsing — facts are withheld.
    const badMoney = await parse({
      id: "e-bad",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "2GGBAD", amount: { currency_code: "XYZ", value: "1.00" } },
    });
    expect(badMoney.amount).toBeUndefined();
    expect(badMoney.currency).toBeUndefined();

    const noMoney = await parse({ id: "e-none", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "2GGNONE" } });
    expect(noMoney.amount).toBeUndefined();
    expect(noMoney.refundId).toBeUndefined();
  });

  it("hashes a stable dedupe id when PayPal omits one and falls back on timestamps", async () => {
    const raw = JSON.stringify({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "2GG1" } });
    const first = await parsePayPalWebhookEvent(raw);
    const second = await parsePayPalWebhookEvent(raw);
    expect(first.id).toMatch(/^paypal_[0-9a-f]{64}$/);
    expect(second.id).toBe(first.id);
    expect(first.occurredAt).toBe("1970-01-01T00:00:00.000Z");

    const resourceTime = await parse({ id: "e", event_type: "X", resource: { create_time: "2026-07-07T10:00:00Z" } });
    expect(resourceTime.occurredAt).toBe("2026-07-07T10:00:00.000Z");
  });

  it("throws invalid_request on garbage and non-object payloads", async () => {
    for (const bad of ["not json", "null", '"just a string"'] as const) {
      try {
        await parsePayPalWebhookEvent(bad);
        expect.unreachable("expected rejection");
      } catch (err) {
        expect(isPayFanoutError(err)).toBe(true);
        if (isPayFanoutError(err)) expect(err.code).toBe("invalid_request");
      }
    }
  });
});

describe("buildWebhookVerificationBody", () => {
  const headers = {
    "paypal-transmission-id": "t-1",
    "paypal-transmission-time": "2026-07-07T10:00:00Z",
    "paypal-transmission-sig": "c2ln",
    "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-auth-algo": "SHA256withRSA",
  };
  const rawBody = '{"id":"WH-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED"}'; // deliberate double space

  it("splices the raw body verbatim — byte-for-byte, whitespace preserved", () => {
    const body = buildWebhookVerificationBody(rawBody, headers, "WHID");
    expect(body).toBeDefined();
    expect(body).toContain(`"webhook_event":${rawBody}}`);
    const parsed = JSON.parse(body!) as Record<string, unknown>;
    expect(parsed["transmission_id"]).toBe("t-1");
    expect(parsed["webhook_id"]).toBe("WHID");
    expect(parsed["auth_algo"]).toBe("SHA256withRSA");
  });

  it("returns undefined for missing headers, empty bodies, or a missing webhook id", () => {
    expect(buildWebhookVerificationBody(rawBody, headers, undefined)).toBeUndefined();
    expect(buildWebhookVerificationBody("", headers, "WHID")).toBeUndefined();
    expect(buildWebhookVerificationBody("   ", headers, "WHID")).toBeUndefined();
    for (const name of Object.keys(headers)) {
      const partial = { ...headers } as Record<string, string>;
      delete partial[name];
      expect(buildWebhookVerificationBody(rawBody, partial, "WHID"), name).toBeUndefined();
    }
  });
});
