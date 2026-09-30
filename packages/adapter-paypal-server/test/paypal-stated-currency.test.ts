import { describe, expect, it } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import { PayPalServerAdapter, type PayPalOrderLike } from "../src/index.js";

const OAUTH_OK = JSON.stringify({ access_token: "tok", token_type: "Bearer", expires_in: 3600 });

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

/** Serves `routes` keyed "METHOD /path" (null answers 204, a Response answers as given) and records every API call but OAuth. */
function recordingAdapter(routes: Record<string, unknown>): { adapter: PayPalServerAdapter; sent: Sent[] } {
  const sent: Sent[] = [];
  const adapter = new PayPalServerAdapter({
    clientId: "id",
    clientSecret: "secret",
    environment: "sandbox",
    maxNetworkRetries: 0,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/oauth2/token")) return new Response(OAUTH_OK, { status: 200 });
      const method = (init?.method ?? "GET").toUpperCase();
      const { pathname } = new URL(url);
      sent.push({ method, path: pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const key = `${method} ${pathname}`;
      if (!(key in routes)) {
        return new Response(JSON.stringify({ name: "RESOURCE_NOT_FOUND", message: "missing" }), { status: 404 });
      }
      const body = routes[key];
      if (body instanceof Response) return body.clone();
      return body === null ? new Response(null, { status: 204 }) : new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch,
  });
  return { adapter, sent };
}

/** An AUTHORIZE order none of whose records states a currency (PayPal's schemas make every `amount` optional). */
const AUTHORIZED_WITHOUT_AMOUNTS: PayPalOrderLike = {
  id: "5O1",
  intent: "AUTHORIZE",
  status: "COMPLETED",
  purchase_units: [{ reference_id: "default", payments: { authorizations: [{ id: "A1", status: "CREATED" }] } }],
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("PayPal never reports or sends a currency no record states", () => {
  it("reads an order that states no currency as XXX, never USD", async () => {
    const { adapter } = recordingAdapter({ "GET /v2/checkout/orders/5O1": AUTHORIZED_WITHOUT_AMOUNTS });
    const info = await adapter.retrievePayment("5O1");
    expect(info.currency).toBe("XXX");
    expect(info.amount).toBe(0);
  });

  it("reads a bare capture that states no currency as XXX", async () => {
    const { adapter } = recordingAdapter({ "GET /v2/payments/captures/C9": { id: "C9", status: "COMPLETED" } });
    const info = await adapter.retrievePayment("C9");
    expect(info.currency).toBe("XXX");
    expect(info.amount).toBe(0);
  });

  it("takes the currency another record of the order states", async () => {
    const { adapter } = recordingAdapter({
      "GET /v2/checkout/orders/5O2": {
        id: "5O2",
        intent: "CAPTURE",
        status: "COMPLETED",
        purchase_units: [
          {
            reference_id: "default",
            payments: { captures: [{ id: "C1", status: "COMPLETED", amount: { currency_code: "JPY", value: "1500" } }] },
          },
        ],
      },
    });
    const info = await adapter.retrievePayment("5O2");
    expect(info.currency).toBe("JPY");
    expect(info.amount).toBe(1500);
  });

  it("scales an amount missing its currency_code by the currency its order states elsewhere", async () => {
    const { adapter } = recordingAdapter({
      "GET /v2/checkout/orders/5O3": {
        id: "5O3",
        intent: "CAPTURE",
        status: "APPROVED",
        purchase_units: [
          {
            reference_id: "default",
            amount: { value: "1500" },
            payments: { authorizations: [{ id: "A3", status: "CREATED", amount: { currency_code: "JPY", value: "1500" } }] },
          },
        ],
      },
    });
    const info = await adapter.retrievePayment("5O3");
    expect(info.currency).toBe("JPY");
    expect(info.amount).toBe(1500); // JPY has no minor unit: never 150000
  });

  it("reads values no record states a currency for with XXX's default exponent, under XXX", async () => {
    const { adapter } = recordingAdapter({
      "GET /v2/checkout/orders/5O7": {
        id: "5O7",
        intent: "CAPTURE",
        status: "APPROVED",
        purchase_units: [{ reference_id: "default", amount: { value: "10.00" } }],
      },
    });
    const info = await adapter.retrievePayment("5O7");
    expect(info.currency).toBe("XXX");
    expect(info.amount).toBe(1000);
  });

  it("refuses a refund read whose amount states no currency, since a refund has no currency field to flag it", async () => {
    const { adapter } = recordingAdapter({
      "GET /v2/payments/refunds/R1": { id: "R1", status: "COMPLETED", amount: { value: "5.00" } },
    });
    const err = await rejection(adapter.retrieveRefund("R1"));
    expect(isPayFanoutError(err) && err.code).toBe("processing_error");
    expect(isPayFanoutError(err) && err.retryable).toBe(false);
    expect(String((err as Error).message)).toMatch(/refund R1 of "5\.00" without a currency/);
  });

  it("refuses an explicit capture amount before sending when no record states the currency", async () => {
    const { adapter, sent } = recordingAdapter({ "GET /v2/checkout/orders/5O1": AUTHORIZED_WITHOUT_AMOUNTS });
    const err = await rejection(adapter.capturePayment("5O1", 500, "capture-key"));
    expect(isPayFanoutError(err) && err.code).toBe("invalid_request");
    expect(String((err as Error).message)).toMatch(/states no currency for its order or authorizations/);
    expect(sent.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("captures all of an untouched authorization whose amounts state no currency, sending no amount", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/checkout/orders/5O8": {
        id: "5O8",
        intent: "AUTHORIZE",
        status: "COMPLETED",
        purchase_units: [
          {
            reference_id: "default",
            amount: { value: "10.00" },
            payments: { authorizations: [{ id: "A8", status: "CREATED", amount: { value: "10.00" } }] },
          },
        ],
      },
      "POST /v2/payments/authorizations/A8/capture": { id: "C8", status: "COMPLETED" },
    });
    await adapter.capturePayment("5O8", undefined, "capture-key");
    // PayPal captures the full authorized amount when none is sent: the same money.
    expect(sent.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: "/v2/payments/authorizations/A8/capture", body: { final_capture: true } },
    ]);
  });

  it("sends a partial refund by capture id in the currency its parent order states", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/payments/captures/C1": {
        id: "C1",
        status: "COMPLETED",
        amount: { value: "10.00" },
        supplementary_data: { related_ids: { order_id: "O1" } },
      },
      "GET /v2/checkout/orders/O1": {
        id: "O1",
        intent: "CAPTURE",
        status: "COMPLETED",
        purchase_units: [{ reference_id: "default", amount: { currency_code: "EUR", value: "10.00" } }],
      },
      "POST /v2/payments/captures/C1/refund": {
        id: "R1",
        status: "COMPLETED",
        amount: { currency_code: "EUR", value: "5.00" },
      },
    });
    const result = await adapter.refundPayment({ pspPaymentId: "C1", amount: 500, idempotencyKey: "refund-key" });
    expect(result.amount).toBe(500);
    expect(sent.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: "/v2/payments/captures/C1/refund", body: { amount: { currency_code: "EUR", value: "5.00" } } },
    ]);
  });

  it("answers a full refund with the value PayPal reports, not the whole capture", async () => {
    // What was left after an earlier partial refund: 7.00 of the 10.00 captured.
    const { adapter } = recordingAdapter({
      "GET /v2/payments/captures/C2": { id: "C2", status: "PARTIALLY_REFUNDED", amount: { value: "10.00" } },
      "POST /v2/payments/captures/C2/refund": { id: "R2", status: "COMPLETED", amount: { value: "7.00" } },
    });
    const result = await adapter.refundPayment({ pspPaymentId: "C2", idempotencyKey: "refund-key" });
    expect(result.amount).toBe(700);
  });

  it("scales a refund answer missing its currency_code by the capture's currency", async () => {
    const { adapter } = recordingAdapter({
      "GET /v2/payments/captures/C3": {
        id: "C3",
        status: "PARTIALLY_REFUNDED",
        amount: { currency_code: "JPY", value: "1500" },
      },
      "POST /v2/payments/captures/C3/refund": { id: "R3", status: "COMPLETED", amount: { value: "1000" } },
    });
    const result = await adapter.refundPayment({ pspPaymentId: "C3", idempotencyKey: "refund-key" });
    expect(result.amount).toBe(1000); // JPY has no minor unit: never 100000
  });

  it("reads a refund whose amount states no currency by the currency of its capture", async () => {
    const { adapter } = recordingAdapter({
      "GET /v2/payments/refunds/R4": {
        id: "R4",
        status: "COMPLETED",
        amount: { value: "5.00" },
        links: [{ rel: "up", href: "https://api-m.sandbox.paypal.com/v2/payments/captures/C4" }],
      },
      "GET /v2/payments/captures/C4": { id: "C4", status: "PARTIALLY_REFUNDED", amount: { currency_code: "EUR", value: "10.00" } },
    });
    const info = await adapter.retrieveRefund("R4");
    expect(info.amount).toBe(500);
    expect(info.pspPaymentId).toBe("C4");
  });

  it("reads such a refund by its capture's order when the capture states no currency either", async () => {
    const { adapter } = recordingAdapter({
      "GET /v2/payments/refunds/R5": {
        id: "R5",
        status: "COMPLETED",
        amount: { value: "500" },
        links: [{ rel: "up", href: "https://api-m.sandbox.paypal.com/v2/payments/captures/C5" }],
      },
      "GET /v2/payments/captures/C5": {
        id: "C5",
        status: "PARTIALLY_REFUNDED",
        supplementary_data: { related_ids: { order_id: "O5" } },
      },
      "GET /v2/checkout/orders/O5": {
        id: "O5",
        status: "COMPLETED",
        purchase_units: [{ amount: { currency_code: "JPY", value: "1000" } }],
      },
    });
    expect((await adapter.retrieveRefund("R5")).amount).toBe(500);
  });

  it("refuses a refund read whose capture no longer reads, as when nothing states its currency", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/payments/refunds/R11": {
        id: "R11",
        status: "COMPLETED",
        amount: { value: "5.00" },
        links: [{ rel: "up", href: "https://api-m.sandbox.paypal.com/v2/payments/captures/C11" }],
      },
    });
    const err = await rejection(adapter.retrieveRefund("R11"));
    expect(isPayFanoutError(err) && err.code).toBe("processing_error");
    expect(String((err as Error).message)).toMatch(/refund R11 of "5\.00" without a currency/);
    expect(sent.map((call) => call.path)).toEqual(["/v2/payments/refunds/R11", "/v2/payments/captures/C11"]);
  });

  it("takes the currency a refund of the order states when nothing else states one", async () => {
    const { adapter } = recordingAdapter({
      "GET /v2/checkout/orders/5O10": {
        id: "5O10",
        intent: "CAPTURE",
        status: "COMPLETED",
        purchase_units: [
          {
            reference_id: "default",
            payments: {
              captures: [{ id: "C10", status: "REFUNDED" }],
              refunds: [{ id: "R10", status: "COMPLETED", amount: { currency_code: "EUR", value: "10.00" } }],
            },
          },
        ],
      },
    });
    const info = await adapter.retrievePayment("5O10");
    expect(info.currency).toBe("EUR");
    expect(info.amountRefunded).toBe(1000);
  });

  it("reads a malformed currency_code as no currency, never throwing", async () => {
    const { adapter } = recordingAdapter({
      "GET /v2/checkout/orders/5O11": {
        id: "5O11",
        intent: "CAPTURE",
        status: "APPROVED",
        purchase_units: [{ reference_id: "default", amount: { currency_code: "EURO", value: "10.00" } }],
      },
    });
    const info = await adapter.retrievePayment("5O11");
    expect(info.currency).toBe("XXX");
    expect(info.amount).toBe(1000);
  });

  it("refuses the remainder it would compute when the order states amounts but no currency", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/checkout/orders/5O9": {
        id: "5O9",
        intent: "AUTHORIZE",
        status: "COMPLETED",
        purchase_units: [
          {
            reference_id: "default",
            amount: { value: "10.00" },
            payments: {
              authorizations: [{ id: "A9", status: "PARTIALLY_CAPTURED", amount: { value: "10.00" } }],
              captures: [
                {
                  id: "C9a",
                  status: "COMPLETED",
                  amount: { value: "4.00" },
                  supplementary_data: { related_ids: { authorization_id: "A9" } },
                },
              ],
            },
          },
        ],
      },
    });
    const err = await rejection(adapter.capturePayment("5O9", undefined, "capture-key"));
    expect(isPayFanoutError(err) && err.code).toBe("invalid_request");
    expect(String((err as Error).message)).toMatch(/capture it in the PayPal dashboard/);
    expect(sent.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("answers a full refund whose amounts state no currency with the capture's amount, never an error", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/payments/captures/C8": { id: "C8", status: "COMPLETED", amount: { value: "7.00" } },
      "POST /v2/payments/captures/C8/refund": { id: "R8", status: "COMPLETED", amount: { value: "7.00" } },
    });
    const result = await adapter.refundPayment({ pspPaymentId: "C8", idempotencyKey: "refund-key" });
    expect(result.refundId).toBe("R8");
    expect(result.amount).toBe(700);
    expect(sent.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: "/v2/payments/captures/C8/refund", body: {} },
    ]);
  });

  it("still captures such an authorization in full, sending no amount", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/checkout/orders/5O1": AUTHORIZED_WITHOUT_AMOUNTS,
      "POST /v2/payments/authorizations/A1/capture": { id: "C1", status: "COMPLETED" },
    });
    const info = await adapter.capturePayment("5O1", undefined, "capture-key");
    const posts = sent.filter((call) => call.method === "POST");
    expect(posts).toEqual([
      { method: "POST", path: "/v2/payments/authorizations/A1/capture", body: { final_capture: true } },
    ]);
    expect(info.currency).toBe("XXX");
  });

  it("refuses a partial refund before sending when neither the capture nor its order states a currency", async () => {
    const { adapter, sent } = recordingAdapter({ "GET /v2/payments/captures/C9": { id: "C9", status: "COMPLETED" } });
    const err = await rejection(adapter.refundPayment({ pspPaymentId: "C9", amount: 500, idempotencyKey: "refund-key" }));
    expect(isPayFanoutError(err) && err.code).toBe("invalid_request");
    expect(String((err as Error).message)).toMatch(/Capture C9 of payment "C9" states no currency/);
    expect(sent.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("refuses such a partial refund the same way when the capture's order no longer reads", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/payments/captures/C10": {
        id: "C10",
        status: "COMPLETED",
        supplementary_data: { related_ids: { order_id: "O10" } },
      },
    });
    const err = await rejection(adapter.refundPayment({ pspPaymentId: "C10", amount: 500, idempotencyKey: "refund-key" }));
    expect(isPayFanoutError(err) && err.code).toBe("invalid_request");
    expect(String((err as Error).message)).toMatch(/Capture C10 of payment "C10" states no currency/);
    expect(sent.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v2/checkout/orders/C10",
      "GET /v2/payments/captures/C10",
      "GET /v2/checkout/orders/O10",
    ]);
  });

  it("refuses to capture the order's amount on a reauthorization when nothing states the currency", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/checkout/orders/5O7": {
        id: "5O7",
        intent: "AUTHORIZE",
        status: "COMPLETED",
        purchase_units: [
          {
            reference_id: "default",
            amount: { value: "10.00" },
            payments: {
              authorizations: [
                { id: "A7", status: "CREATED", create_time: "2026-09-01T10:00:00Z" },
                { id: "A7r", status: "CREATED", create_time: "2026-09-05T10:00:00Z" },
              ],
            },
          },
        ],
      },
    });
    // Sending no amount would let PayPal take all of the reauthorization, which can hold more than the order.
    const err = await rejection(adapter.capturePayment("5O7", undefined, "capture-key"));
    expect(isPayFanoutError(err) && err.code).toBe("invalid_request");
    expect(String((err as Error).message)).toMatch(/capture it in the PayPal dashboard/);
    expect(sent.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("still refunds such a capture in full, sending no amount", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/payments/captures/C9": { id: "C9", status: "COMPLETED" },
      "POST /v2/payments/captures/C9/refund": { id: "R9", status: "COMPLETED" },
    });
    const result = await adapter.refundPayment({ pspPaymentId: "C9", idempotencyKey: "refund-key" });
    expect(result.refundId).toBe("R9");
    expect(sent.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: "/v2/payments/captures/C9/refund", body: {} },
    ]);
  });

  it("sends a partial refund in the order's currency when the capture states none", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/checkout/orders/5O4": {
        id: "5O4",
        intent: "CAPTURE",
        status: "COMPLETED",
        purchase_units: [
          {
            reference_id: "default",
            amount: { currency_code: "EUR", value: "10.00" },
            payments: { captures: [{ id: "C4", status: "COMPLETED" }] },
          },
        ],
      },
      "POST /v2/payments/captures/C4/refund": {
        id: "R4",
        status: "COMPLETED",
        amount: { currency_code: "EUR", value: "5.00" },
      },
    });
    const result = await adapter.refundPayment({ pspPaymentId: "5O4", amount: 500, idempotencyKey: "refund-key" });
    expect(result.amount).toBe(500);
    expect(sent.filter((call) => call.method === "POST")).toEqual([
      {
        method: "POST",
        path: "/v2/payments/captures/C4/refund",
        body: { amount: { currency_code: "EUR", value: "5.00" } },
      },
    ]);
  });

  it("refuses an amount-only update before any PATCH when the order states no currency", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/checkout/orders/5O5": {
        id: "5O5",
        intent: "CAPTURE",
        status: "CREATED",
        purchase_units: [{ reference_id: "default" }],
      },
    });
    const err = await rejection(
      adapter.updatePaymentSession({ pspSessionId: "5O5", amount: 500, idempotencyKey: "update-key" }),
    );
    expect(isPayFanoutError(err) && err.code).toBe("invalid_request");
    expect(String((err as Error).message)).toMatch(/pass currency with the amount/);
    expect(sent.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("sends an update that names its currency even when the order states none", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/checkout/orders/5O5": {
        id: "5O5",
        intent: "CAPTURE",
        status: "CREATED",
        purchase_units: [{ reference_id: "default" }],
      },
      "PATCH /v2/checkout/orders/5O5": null,
    });
    const session = await adapter.updatePaymentSession({
      pspSessionId: "5O5",
      amount: 500,
      currency: "EUR",
      idempotencyKey: "update-key",
    });
    expect(sent.filter((call) => call.method === "PATCH")).toEqual([
      {
        method: "PATCH",
        path: "/v2/checkout/orders/5O5",
        body: [
          {
            op: "replace",
            path: "/purchase_units/@reference_id=='default'/amount",
            value: { currency_code: "EUR", value: "5.00" },
          },
        ],
      },
    ]);
    // The re-read order still states none, so the session reports none.
    expect(session.currency).toBe("XXX");
  });

  it("sends nothing when an update only restates the order's own currency", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/checkout/orders/5O6": {
        id: "5O6",
        intent: "CAPTURE",
        status: "CREATED",
        purchase_units: [{ reference_id: "default", amount: { currency_code: "EUR", value: "10.00" } }],
      },
    });
    const session = await adapter.updatePaymentSession({
      pspSessionId: "5O6",
      currency: "eur",
      idempotencyKey: "update-key",
    });
    expect(sent.filter((call) => call.method !== "GET")).toEqual([]);
    expect(session.currency).toBe("EUR");
    expect(session.amount).toBe(1000);
  });

  it("compares a restated currency with the one the order's records state when its amount states none", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/checkout/orders/5O8": {
        id: "5O8",
        intent: "AUTHORIZE",
        status: "COMPLETED",
        purchase_units: [
          {
            reference_id: "default",
            payments: {
              authorizations: [{ id: "A8", status: "CREATED", amount: { currency_code: "EUR", value: "10.00" } }],
            },
          },
        ],
      },
    });
    const session = await adapter.updatePaymentSession({
      pspSessionId: "5O8",
      currency: "EUR",
      idempotencyKey: "update-key",
    });
    expect(sent.filter((call) => call.method !== "GET")).toEqual([]);
    expect(session.currency).toBe("EUR");
  });
});

describe("PayPal reads a currency from related records only as far as it needs one", () => {
  const unavailable = (): Response =>
    new Response(JSON.stringify({ name: "SERVICE_UNAVAILABLE", message: "down" }), { status: 503 });
  /** A capture that states no currency and names its order. */
  const bareCapture = (id: string, orderId: string): Record<string, unknown> => ({
    id,
    status: "COMPLETED",
    amount: { value: "10.00" },
    supplementary_data: { related_ids: { order_id: orderId } },
  });

  it("refuses to capture what a reauthorization holds past the order after a capture, when nothing states the currency", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/checkout/orders/5O15": {
        id: "5O15",
        intent: "AUTHORIZE",
        status: "COMPLETED",
        purchase_units: [
          {
            reference_id: "default",
            amount: { value: "10.00" },
            payments: {
              authorizations: [
                { id: "A15", status: "PARTIALLY_CAPTURED", amount: { value: "10.00" }, create_time: "2026-09-01T10:00:00Z" },
                { id: "A15r", status: "CREATED", amount: { value: "10.00" }, create_time: "2026-09-05T10:00:00Z" },
              ],
              captures: [
                {
                  id: "C15",
                  status: "COMPLETED",
                  amount: { value: "4.00" },
                  create_time: "2026-09-02T10:00:00Z",
                  supplementary_data: { related_ids: { authorization_id: "A15" } },
                },
              ],
            },
          },
        ],
      },
    });
    // 6.00 is left on the order; sending no amount would let PayPal take all 10.00 of A15r.
    const err = await rejection(adapter.capturePayment("5O15", undefined, "capture-key"));
    expect(isPayFanoutError(err) && err.code).toBe("invalid_request");
    expect(String((err as Error).message)).toMatch(/capture it in the PayPal dashboard/);
    expect(sent.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("keeps an outage on the order read retryable for a partial refund, which needs the currency", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/payments/captures/C12": bareCapture("C12", "O12"),
      "GET /v2/checkout/orders/O12": unavailable(),
    });
    const err = await rejection(adapter.refundPayment({ pspPaymentId: "C12", amount: 500, idempotencyKey: "refund-key" }));
    expect(err).toMatchObject({ code: "psp_unavailable", retryable: true });
    expect(sent.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("still refunds in full when the order read fails, as a full refund sends no amount", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/payments/captures/C12": bareCapture("C12", "O12"),
      "GET /v2/checkout/orders/O12": unavailable(),
      "POST /v2/payments/captures/C12/refund": { id: "R12", status: "COMPLETED" },
    });
    const result = await adapter.refundPayment({ pspPaymentId: "C12", idempotencyKey: "refund-key" });
    expect(result.refundId).toBe("R12");
    expect(sent.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: "/v2/payments/captures/C12/refund", body: {} },
    ]);
  });

  it("keeps an outage on the capture read retryable for a refund read", async () => {
    const { adapter } = recordingAdapter({
      "GET /v2/payments/refunds/R13": {
        id: "R13",
        status: "COMPLETED",
        amount: { value: "5.00" },
        links: [{ rel: "up", href: "https://api-m.sandbox.paypal.com/v2/payments/captures/C13" }],
      },
      "GET /v2/payments/captures/C13": unavailable(),
    });
    expect(await rejection(adapter.retrieveRefund("R13"))).toMatchObject({ code: "psp_unavailable", retryable: true });
  });

  it("reads a refund that states no amount as 0 without reading its capture", async () => {
    const { adapter, sent } = recordingAdapter({
      "GET /v2/payments/refunds/R14": {
        id: "R14",
        status: "PENDING",
        links: [{ rel: "up", href: "https://api-m.sandbox.paypal.com/v2/payments/captures/C14" }],
      },
    });
    const info = await adapter.retrieveRefund("R14");
    expect(info).toMatchObject({ refundId: "R14", status: "pending", amount: 0, pspPaymentId: "C14" });
    expect(sent.map((call) => call.path)).toEqual(["/v2/payments/refunds/R14"]);
  });
});
