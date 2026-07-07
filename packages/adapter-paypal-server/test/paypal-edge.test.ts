import { describe, expect, it } from "vitest";
import { isPayFanoutError, type UnifiedErrorCode, type UnifiedPaymentStatus } from "@payfanout/core";
import {
  buildWebhookVerificationBody,
  fromPayPalValue,
  mapPayPalError,
  parsePayPalWebhookEvent,
  PayPalServerAdapter,
  toPayPalValue,
  type PayPalOrderLike,
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
    [422, issue("PAYER_ACTION_REQUIRED"), "authentication_required", false],
    [422, issue("PAYEE_BLOCKED_TRANSACTION"), "fraud_suspected", false],
    [422, issue("COMPLIANCE_VIOLATION"), "fraud_suspected", false],
    [422, issue("TRANSACTION_REFUSED"), "processing_error", false],
    [422, issue("ORDER_NOT_APPROVED"), "invalid_request", false],
    [422, issue("ORDER_ALREADY_CAPTURED"), "invalid_request", false],
    [422, issue("DUPLICATE_INVOICE_ID"), "invalid_request", false],
    [422, issue("REFUND_AMOUNT_EXCEEDED"), "invalid_request", false],
    [422, issue("CAPTURE_FULLY_REFUNDED"), "invalid_request", false],
    [422, issue("MAX_NUMBER_OF_REFUNDS_EXCEEDED"), "invalid_request", false],
    [422, issue("SOMETHING_BRAND_NEW"), "invalid_request", false],
    [401, { error: "invalid_client", error_description: "Client Authentication failed" }, "invalid_request", false],
    [401, { name: "INVALID_TOKEN" }, "invalid_request", false],
    [429, { name: "RATE_LIMIT_REACHED" }, "rate_limited", true],
    [200, { name: "RATE_LIMIT_REACHED" }, "rate_limited", true],
    [500, { name: "INTERNAL_SERVICE_ERROR" }, "psp_unavailable", true],
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

  it("gives declines the restart-in-popup guidance", () => {
    const mapped = mapPayPalError(422, issue("INSTRUMENT_DECLINED"));
    expect(mapped.message).toMatch(/different way to pay/);
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
    expect(info.amountRefunded).toBe(300);
    expect(info.id).toBe("order-42");
    expect(info.pspPaymentId).toBe("c1");
    expect(info.capturedAt).toBe("2026-07-07T10:00:00Z");
    expect(info.createdAt).toBe("2026-07-07T09:00:00Z");
    expect(info.paymentMethodDetails).toEqual({ wallet: "paypal" });
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
      currency: "USD",
      paymentMethodType: "paypal",
      capturedAt: "2026-05-16T05:18:59Z",
    });
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

  it("maps PENDING to processing and DECLINED to failed", async () => {
    const pending = adapterWithCapture({ status: "PENDING", amount: { currency_code: "USD", value: "1.00" } });
    expect((await pending.retrievePayment("2GG1")).status).toBe("processing");
    const declined = adapterWithCapture({ status: "DECLINED", amount: { currency_code: "USD", value: "1.00" } });
    const info = await declined.retrievePayment("2GG1");
    expect(info.status).toBe("failed");
    expect(info.capturedAt).toBeUndefined();
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

    const authEvent = await parse({
      id: "e4",
      event_type: "PAYMENT.AUTHORIZATION.VOIDED",
      resource: { id: "0AW1", supplementary_data: { related_ids: { order_id: "5O9" } } },
    });
    expect(authEvent.pspPaymentId).toBe("5O9"); // pre-capture canonical id = order id
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
