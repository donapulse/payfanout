import { describe, expect, it } from "vitest";
import {
  fromPayPalValue,
  parsePayPalWebhookEvent,
  PAYPAL_SUPPORTED_CURRENCIES,
  PayPalServerAdapter,
  toPayPalValue,
} from "../src/index.js";

const OAUTH_OK = JSON.stringify({ access_token: "tok", token_type: "Bearer", expires_in: 3600 });

/**
 * An adapter over fixed routes that records every API request it sends. A route
 * key is `"METHOD /path"`, or a bare path for a GET; a `null` answer is an empty 204.
 */
function recordingAdapter(routes: Record<string, unknown>): {
  adapter: PayPalServerAdapter;
  requests: string[];
  sent: Map<string, unknown>;
} {
  const requests: string[] = [];
  const sent = new Map<string, unknown>();
  const adapter = new PayPalServerAdapter({
    clientId: "id",
    clientSecret: "secret",
    environment: "sandbox",
    maxNetworkRetries: 0,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/oauth2/token")) return new Response(OAUTH_OK, { status: 200 });
      const { pathname } = new URL(url);
      const request = `${init?.method ?? "GET"} ${pathname}`;
      requests.push(request);
      if (typeof init?.body === "string") sent.set(request, JSON.parse(init.body));
      const body = request in routes ? routes[request] : request.startsWith("GET ") ? routes[pathname] : undefined;
      if (body === undefined) {
        return new Response(JSON.stringify({ name: "RESOURCE_NOT_FOUND", message: "missing" }), { status: 404 });
      }
      if (body === null) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch,
  });
  return { adapter, requests, sent };
}

const RUB_ORDER = {
  id: "O1",
  intent: "AUTHORIZE",
  status: "COMPLETED",
  purchase_units: [
    {
      amount: { currency_code: "RUB", value: "1500.00" },
      payments: {
        authorizations: [{ id: "A1", status: "CREATED", amount: { currency_code: "RUB", value: "1500.00" } }],
      },
    },
  ],
};

describe("PayPal currencies", () => {
  it("accepts for new payments exactly the currencies PayPal's reference lists", () => {
    expect([...PAYPAL_SUPPORTED_CURRENCIES].sort()).toEqual([
      "AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD", "HUF", "ILS",
      "JPY", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN", "SEK", "SGD", "THB", "TWD", "USD",
    ]);
    const { adapter } = recordingAdapter({});
    expect(adapter.getCapabilities().supportedCurrencies).not.toContain("RUB");
  });

  it("refuses a new session in RUB before calling PayPal", async () => {
    const { adapter, requests } = recordingAdapter({});
    await expect(
      adapter.createPaymentSession({ amount: 150000, currency: "RUB", idempotencyKey: "k-rub" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/RUB/) });
    expect(requests).toEqual([]);
  });

  it("refuses moving an order to RUB, sending no update", async () => {
    const { adapter, requests } = recordingAdapter({
      "/v2/checkout/orders/5O1": {
        id: "5O1",
        status: "CREATED",
        purchase_units: [{ amount: { currency_code: "USD", value: "20.00" } }],
      },
    });
    await expect(
      adapter.updatePaymentSession({ pspSessionId: "5O1", amount: 150000, currency: "RUB", idempotencyKey: "k-up" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/RUB/) });
    expect(requests).toEqual(["GET /v2/checkout/orders/5O1"]);
  });

  it("still reads, formats and parses the amounts of a payment made earlier in RUB", async () => {
    const { adapter } = recordingAdapter({
      "/v2/payments/captures/2GG1": {
        id: "2GG1",
        status: "COMPLETED",
        amount: { currency_code: "RUB", value: "1500.00" },
      },
    });
    await expect(adapter.retrievePayment("2GG1")).resolves.toMatchObject({
      pspPaymentId: "2GG1",
      status: "succeeded",
      amount: 150000,
      currency: "RUB",
    });
    // Captures and refunds of such a payment send RUB amounts as before.
    expect(toPayPalValue(150000, "RUB")).toBe("1500.00");
    expect(fromPayPalValue("1500.00", "RUB")).toBe(150000);
  });

  it("still captures part of an earlier RUB authorization, sending RUB", async () => {
    const { adapter, sent } = recordingAdapter({
      "/v2/checkout/orders/O1": RUB_ORDER,
      "POST /v2/payments/authorizations/A1/capture": {
        id: "CAP1",
        status: "COMPLETED",
        amount: { currency_code: "RUB", value: "700.00" },
      },
    });
    await adapter.capturePayment("O1", 70000, "k-cap-rub");
    expect(sent.get("POST /v2/payments/authorizations/A1/capture")).toEqual({
      amount: { currency_code: "RUB", value: "700.00" },
      final_capture: false,
    });
  });

  it("still refunds an earlier RUB capture, sending RUB", async () => {
    const { adapter, sent } = recordingAdapter({
      "/v2/payments/captures/CAP1": { id: "CAP1", status: "COMPLETED", amount: { currency_code: "RUB", value: "1500.00" } },
      "POST /v2/payments/captures/CAP1/refund": {
        id: "R1",
        status: "COMPLETED",
        amount: { currency_code: "RUB", value: "500.00" },
      },
    });
    await expect(
      adapter.refundPayment({ pspPaymentId: "CAP1", amount: 50000, idempotencyKey: "k-refund-rub" }),
    ).resolves.toMatchObject({ refundId: "R1", status: "succeeded", amount: 50000 });
    expect(sent.get("POST /v2/payments/captures/CAP1/refund")).toEqual({
      amount: { currency_code: "RUB", value: "500.00" },
    });
  });

  it("still updates the amount of an earlier RUB order, however the currency is spelled", async () => {
    for (const currency of [undefined, "rub"]) {
      const { adapter, requests } = recordingAdapter({
        "/v2/checkout/orders/O2": {
          id: "O2",
          status: "CREATED",
          purchase_units: [{ amount: { currency_code: "RUB", value: "1500.00" } }],
        },
        "PATCH /v2/checkout/orders/O2": null,
      });
      await adapter.updatePaymentSession({
        pspSessionId: "O2",
        amount: 200000,
        ...(currency ? { currency } : {}),
        idempotencyKey: "k-up-rub",
      });
      expect(requests, String(currency)).toContain("PATCH /v2/checkout/orders/O2");
    }
  });

  it("still reads the amount of a RUB capture webhook", async () => {
    const event = await parsePayPalWebhookEvent(
      JSON.stringify({
        id: "WH-TEST-RUB",
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: { id: "2GG1", amount: { currency_code: "RUB", value: "1500.00" } },
      }),
    );
    expect(event).toMatchObject({ type: "payment.succeeded", amount: 150000, currency: "RUB" });
  });
});
