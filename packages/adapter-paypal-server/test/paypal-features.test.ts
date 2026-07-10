import { describe, expect, it } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import {
  derivePayPalRequestId,
  PayPalServerAdapter,
  type PayPalServerAdapterConfig,
} from "../src/index.js";
import { FakePayPalApi } from "./fake-paypal-api.js";

const WEBHOOK_ID = "1JE4291016473214C";

function makePair(
  config: Partial<PayPalServerAdapterConfig> = {},
  fakeOptions: ConstructorParameters<typeof FakePayPalApi>[0] = {},
): { adapter: PayPalServerAdapter; fake: FakePayPalApi } {
  const fake = new FakePayPalApi({ webhookId: WEBHOOK_ID, ...fakeOptions });
  const adapter = new PayPalServerAdapter({
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    environment: "sandbox",
    webhookId: WEBHOOK_ID,
    fetch: fake.fetch,
    sleep: async () => {},
    ...config,
  });
  return { adapter, fake };
}

const sessionInput = { amount: 2000, currency: "USD", idempotencyKey: "k-sess" };

describe("PayPal OAuth token lifecycle", () => {
  it("caches the access token across calls — one mint for many requests", async () => {
    const { adapter, fake } = makePair();
    await adapter.createPaymentSession({ ...sessionInput, idempotencyKey: "k1" });
    await adapter.createPaymentSession({ ...sessionInput, idempotencyKey: "k2" });
    await adapter.retrievePayment((await adapter.createPaymentSession({ ...sessionInput, idempotencyKey: "k3" })).pspSessionId);
    expect(fake.tokenMints).toBe(1);
  });

  it("single-flights the mint — concurrent cold-cache calls share one token POST", async () => {
    const { adapter, fake } = makePair();
    await Promise.all([
      adapter.createPaymentSession({ ...sessionInput, idempotencyKey: "k1" }),
      adapter.createPaymentSession({ ...sessionInput, idempotencyKey: "k2" }),
    ]);
    expect(fake.tokenMints).toBe(1);
  });

  it("a failed mint clears the in-flight slot so the transport retry mints fresh", async () => {
    const { adapter, fake } = makePair();
    fake.failNextWith(500, { name: "INTERNAL_SERVICE_ERROR" });
    await expect(adapter.createPaymentSession(sessionInput)).resolves.toMatchObject({
      status: "requires_action",
    });
    expect(fake.tokenMints).toBe(1); // the 500 died pre-mint; only the retry minted
  });

  it("re-mints when the cached token expires (injected clock)", async () => {
    let now = Date.parse("2026-07-07T12:00:00Z");
    const { adapter, fake } = makePair({ now: () => now }, { now: () => now, tokenTtlSeconds: 900 });
    await adapter.createPaymentSession({ ...sessionInput, idempotencyKey: "k1" });
    expect(fake.tokenMints).toBe(1);
    now += 899_000; // inside the 60s early-refresh margin of the 900s TTL
    await adapter.createPaymentSession({ ...sessionInput, idempotencyKey: "k2" });
    expect(fake.tokenMints).toBe(2);
  });

  it("retries exactly once with a fresh token when PayPal answers 401", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession(sessionInput);
    expect(fake.tokenMints).toBe(1);
    fake.revokeTokens(); // server-side revocation the cache cannot see
    const retrieved = await adapter.retrievePayment(session.pspSessionId);
    expect(retrieved.pspPaymentId).toBe(session.pspSessionId);
    expect(fake.tokenMints).toBe(2);
  });

  it("maps invalid credentials to an actionable invalid_request", async () => {
    const { adapter } = makePair({ clientSecret: "wrong-secret" });
    await expect(adapter.createPaymentSession(sessionInput)).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/credentials/),
    });
  });
});

describe("PayPal verifyCredentials (test-connection probe)", () => {
  it("returns { ok: true } when the client-credentials mint succeeds", async () => {
    const { adapter } = makePair();
    await expect(adapter.verifyCredentials()).resolves.toEqual({ ok: true });
  });

  it("classifies a rejected client id/secret as auth, and never retries it", async () => {
    const { adapter, fake } = makePair({ clientSecret: "wrong-secret" });
    const before = fake.requestCount;
    await expect(adapter.verifyCredentials()).resolves.toEqual({
      ok: false,
      category: "auth",
      message: "Authentication failed — check the PayPal client id and secret.",
    });
    expect(fake.requestCount - before).toBe(1); // one probe — an auth rejection is never replayed

    // A 403 is an authorization problem too, not a transient outage.
    const forbidden = makePair();
    forbidden.fake.failNextWith(403, { name: "NOT_AUTHORIZED", message: "no access" });
    await expect(forbidden.adapter.verifyCredentials()).resolves.toMatchObject({ ok: false, category: "auth" });
  });

  it("classifies a dropped connection, 429, or 5xx as a network failure", async () => {
    const dropped = makePair();
    dropped.fake.failNextWithNetworkError();
    await expect(dropped.adapter.verifyCredentials()).resolves.toEqual({
      ok: false,
      category: "network",
      message: "Could not reach PayPal — try again.",
    });

    for (const status of [429, 500, 503]) {
      const { adapter, fake } = makePair();
      fake.failNextWith(status, { name: "TRANSIENT" });
      await expect(adapter.verifyCredentials(), `HTTP ${status}`).resolves.toMatchObject({
        ok: false,
        category: "network",
      });
    }
  });

  it("classifies an unexpected response as internal without leaking secrets", async () => {
    // A 2xx that carries no token is neither an auth nor a transient failure.
    const noToken = makePair();
    noToken.fake.failNextWith(200, { scope: "https://uri.paypal.com/services/payments/payment" });
    await expect(noToken.adapter.verifyCredentials()).resolves.toMatchObject({ ok: false, category: "internal" });

    const { adapter, fake } = makePair();
    fake.failNextWith(400, { error: "invalid_request", error_description: "malformed" });
    const result = await adapter.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe("internal");
      expect(result.message).not.toMatch(/secret/i); // never echoes credential material
    }
  });
});

describe("PayPal-Request-Id derivation", () => {
  it("passes keys of at most 38 bytes through untouched", async () => {
    await expect(derivePayPalRequestId("order-1234")).resolves.toBe("order-1234");
    const exactly38 = "x".repeat(38);
    await expect(derivePayPalRequestId(exactly38)).resolves.toBe(exactly38);
  });

  it("hashes longer keys deterministically to 36 hex chars — never randomly", async () => {
    const long = `payfanout-${"y".repeat(64)}`;
    const first = await derivePayPalRequestId(long);
    const second = await derivePayPalRequestId(long);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{36}$/);
    expect(await derivePayPalRequestId(`${long}-other`)).not.toBe(first);
  });

  it("measures bytes, not chars — multibyte keys at the boundary are hashed", async () => {
    const multibyte = "€".repeat(13); // 13 chars, 39 UTF-8 bytes
    await expect(derivePayPalRequestId(multibyte)).resolves.toMatch(/^[0-9a-f]{36}$/);
  });

  it("the adapter forwards derived ids on the wire", async () => {
    const { adapter, fake } = makePair();
    const longKey = `k-${"z".repeat(60)}`;
    await adapter.createPaymentSession({ ...sessionInput, idempotencyKey: longKey });
    expect(fake.lastRequestHeaders["paypal-request-id"]).toBe(await derivePayPalRequestId(longKey));
  });
});

describe("PayPal manual capture (intent AUTHORIZE)", () => {
  async function authorizedPayment(pair = makePair()): Promise<{
    adapter: PayPalServerAdapter;
    fake: FakePayPalApi;
    orderId: string;
  }> {
    const { adapter, fake } = pair;
    const session = await adapter.createPaymentSession({
      amount: 2000,
      currency: "USD",
      captureMethod: "manual",
      idempotencyKey: `k-${Math.random()}`,
    });
    fake.approveOrder(session.pspSessionId);
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: session.pspSessionId,
      idempotencyKey: `k-auth-${Math.random()}`,
    });
    expect(info.status).toBe("requires_capture");
    // Pre-capture the ORDER id stays canonical: capture/cancel resolve from it.
    expect(info.pspPaymentId).toBe(session.pspSessionId);
    expect(info.capturedAt).toBeUndefined();
    expect(info.amountCaptured).toBe(0);
    expect(info.amountCapturable).toBe(2000); // the full authorization is still open
    return { adapter, fake, orderId: session.pspSessionId };
  }

  it("authorizes on completePayment, then captures via the authorization", async () => {
    const { adapter, fake, orderId } = await authorizedPayment();
    const captured = await adapter.capturePayment(orderId, undefined, "k-cap");
    expect(captured.status).toBe("succeeded");
    expect(captured.amount).toBe(2000);
    expect(captured.amountCaptured).toBe(2000);
    expect(captured.amountCapturable).toBe(0); // fully captured — nothing left to take
    expect(captured.pspPaymentId).toMatch(/^2GG/);
    expect(fake.lastRequestBody).toBeDefined();
  });

  it("supports multiple partial captures (final_capture stays false)", async () => {
    const { adapter, fake, orderId } = await authorizedPayment();
    const first = await adapter.capturePayment(orderId, 700, "k-cap-1");
    expect(first.status).toBe("succeeded");
    expect(first.amount).toBe(700);
    expect(first.amountCaptured).toBe(700);
    expect(first.amountCapturable).toBe(1300);

    const second = await adapter.capturePayment(orderId, 500, "k-cap-2");
    expect(second.amount).toBe(1200); // cumulative captured funds
    expect(second.amountCaptured).toBe(1200);
    expect(second.amountCapturable).toBe(800);

    // The wire request kept the authorization open for the next capture.
    const lastCaptureBody = fake.lastRequestBody as Record<string, unknown>;
    expect(lastCaptureBody["final_capture"]).toBe(false);
    expect(lastCaptureBody["amount"]).toEqual({ currency_code: "USD", value: "5.00" });
    expect(adapter.getCapabilities().supportsMultiCapture).toBe(true);
  });

  it("refuses to refund by order id once several captures exist — names the capture ids", async () => {
    const { adapter, orderId } = await authorizedPayment();
    const first = await adapter.capturePayment(orderId, 700, "k-cap-1");
    const second = await adapter.capturePayment(orderId, 500, "k-cap-2");
    const captureIds = (second.raw as { purchase_units: Array<{ payments?: { captures?: Array<{ id: string }> } }> })
      .purchase_units[0]!.payments!.captures!.map((c) => c.id);
    expect(captureIds).toHaveLength(2);

    await expect(adapter.refundPayment({ pspPaymentId: orderId, idempotencyKey: "r-order" })).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining(captureIds.join(", ")),
    });

    // Addressing the specific capture id keeps working.
    const refund = await adapter.refundPayment({
      pspPaymentId: first.pspPaymentId,
      amount: 300,
      idempotencyKey: "r-cap",
    });
    expect(refund.status).toBe("succeeded");
    expect(refund.amount).toBe(300);
  });

  it("replaying a capture key answers the original capture — no new money moves", async () => {
    const { adapter, orderId } = await authorizedPayment();
    const first = await adapter.capturePayment(orderId, 500, "k-cap-replay");
    expect(first.amountCaptured).toBe(500);

    // Same key, same amount: PayPal-Request-Id replay answers the original
    // 201 — a retried capture can never double-charge.
    const replayed = await adapter.capturePayment(orderId, 500, "k-cap-replay");
    expect(replayed.amountCaptured).toBe(500);

    // A distinct key is a distinct charge — multi-capture demands per-capture keys.
    const second = await adapter.capturePayment(orderId, 500, "k-cap-fresh");
    expect(second.amountCaptured).toBe(1000);
  });

  it("rejects captures beyond the authorized amount via the PSP error", async () => {
    const { adapter, orderId } = await authorizedPayment();
    await adapter.capturePayment(orderId, 1800, "k-cap-1");
    await expect(adapter.capturePayment(orderId, 300, "k-cap-2")).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("cancelPayment voids an uncaptured authorization and is idempotent-friendly", async () => {
    const { adapter, orderId } = await authorizedPayment();
    const canceled = await adapter.cancelPayment(orderId, "k-void");
    expect(canceled.status).toBe("canceled");
    expect(canceled.amountCapturable).toBe(0); // a voided authorization holds nothing
    // A second cancel finds the VOIDED authorization and reports state without a second void.
    const again = await adapter.cancelPayment(orderId, "k-void-2");
    expect(again.status).toBe("canceled");
  });

  it("refuses to cancel once captured — refunds are the only way back", async () => {
    const { adapter, orderId } = await authorizedPayment();
    await adapter.capturePayment(orderId, 700, "k-cap");
    await expect(adapter.cancelPayment(orderId, "k-void")).rejects.toThrowError(/already captured/);
  });

  it("capturePayment on a CAPTURE-intent order names the missing authorization", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession(sessionInput);
    fake.approveOrder(session.pspSessionId);
    await expect(adapter.capturePayment(session.pspSessionId, 500, "k-cap")).rejects.toThrowError(
      /no authorization/,
    );
  });

  it("cancelPayment on a CAPTURE-intent order explains that orders expire instead", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession(sessionInput);
    await expect(adapter.cancelPayment(session.pspSessionId, "k-void")).rejects.toThrowError(/expires/);
  });

  it("cancelPayment on an unknown/captured id points to refunds", async () => {
    const { adapter } = makePair();
    await expect(adapter.cancelPayment("2GGCAPTUREID", "k-void")).rejects.toThrowError(/refund/);
  });
});

describe("PayPal updatePaymentSession (PATCH order)", () => {
  it("replaces the amount in place and returns the refreshed session", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ ...sessionInput, id: "order-9" });
    const updated = await adapter.updatePaymentSession({
      pspSessionId: session.pspSessionId,
      amount: 3500,
      idempotencyKey: "k-upd",
    });
    expect(updated.pspSessionId).toBe(session.pspSessionId); // amended in place, same order
    expect(updated.amount).toBe(3500);
    expect(updated.currency).toBe("USD");
    expect(updated.id).toBe("order-9"); // custom_id survives
    expect(updated.status).toBe("requires_action");
  });

  it("patches descriptor and shipping alongside the amount", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession(sessionInput);
    await adapter.updatePaymentSession({
      pspSessionId: session.pspSessionId,
      amount: 2100,
      statementDescriptor: "NEW DESCRIPTOR",
      shippingDetails: { name: "Ann", address: { line1: "2 Way", city: "Berlin", postalCode: "10115", country: "DE" } },
      idempotencyKey: "k-upd",
    });
    const refreshed = await adapter.retrievePayment(session.pspSessionId);
    const unit = (refreshed.raw as { purchase_units: Array<Record<string, unknown>> }).purchase_units[0]!;
    expect(unit["soft_descriptor"]).toBe("NEW DESCRIPTOR");
    expect(unit["shipping"]).toMatchObject({ name: { full_name: "Ann" } });
    expect(unit["amount"]).toEqual({ currency_code: "USD", value: "21.00" });
  });

  it("changing the currency requires an explicit amount", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession(sessionInput);
    await expect(
      adapter.updatePaymentSession({ pspSessionId: session.pspSessionId, currency: "EUR", idempotencyKey: "k" }),
    ).rejects.toThrowError(/explicit amount/);
    const updated = await adapter.updatePaymentSession({
      pspSessionId: session.pspSessionId,
      currency: "eur",
      amount: 4200,
      idempotencyKey: "k2",
    });
    expect(updated.currency).toBe("EUR");
    expect(updated.amount).toBe(4200);
  });

  it("metadata-only updates skip the PATCH entirely and carry the metadata", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession(sessionInput);
    const before = fake.requestCount;
    const updated = await adapter.updatePaymentSession({
      pspSessionId: session.pspSessionId,
      metadata: { cart: "v2" },
      idempotencyKey: "k",
    });
    expect(fake.requestCount - before).toBe(1); // one GET, no PATCH, no re-GET
    expect(updated.metadata).toEqual({ cart: "v2" });
  });

  it("rejects updates to completed orders", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession(sessionInput);
    fake.approveOrder(session.pspSessionId);
    await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: session.pspSessionId,
      idempotencyKey: "k-c",
    });
    await expect(
      adapter.updatePaymentSession({ pspSessionId: session.pspSessionId, amount: 9999, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("PayPal fetchEvents", () => {
  const seeded = [
    {
      id: "WH-1",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      create_time: "2026-07-01T10:00:00Z",
      resource: { id: "2GG001" },
    },
    {
      id: "WH-2",
      event_type: "PAYMENT.CAPTURE.DENIED",
      create_time: "2026-07-02T10:00:00Z",
      resource: { id: "2GG002" },
    },
    {
      id: "WH-3",
      event_type: "CHECKOUT.ORDER.APPROVED",
      create_time: "2026-07-03T10:00:00Z",
      resource: { id: "5O003" },
    },
  ];

  it("pages through events with the next-link cursor and normalizes them", async () => {
    const { adapter, fake } = makePair();
    fake.seedEvents(seeded);
    const first = await adapter.fetchEvents({ limit: 2 });
    expect(first.events.map((e) => e.id)).toEqual(["WH-1", "WH-2"]);
    expect(first.events[0]).toMatchObject({
      pspName: "paypal",
      type: "payment.succeeded",
      pspPaymentId: "2GG001",
      occurredAt: "2026-07-01T10:00:00.000Z",
    });
    expect(first.events[1]!.type).toBe("payment.failed");
    expect(first.nextCursor).toBeDefined();

    const second = await adapter.fetchEvents({ cursor: first.nextCursor });
    expect(second.events.map((e) => e.id)).toEqual(["WH-3"]);
    expect(second.events[0]!.type).toBe("unknown"); // CHECKOUT.ORDER.* stays unknown
    expect(second.nextCursor).toBeUndefined();
  });

  it("passes `since` through as start_time", async () => {
    const { adapter, fake } = makePair();
    fake.seedEvents(seeded);
    const result = await adapter.fetchEvents({ since: new Date("2026-07-02T00:00:00Z") });
    expect(result.events.map((e) => e.id)).toEqual(["WH-2", "WH-3"]);
  });

  it("rejects foreign cursors and garbage timestamps", async () => {
    const { adapter } = makePair();
    await expect(adapter.fetchEvents({ cursor: "/v2/checkout/orders/evil" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(adapter.fetchEvents({ since: "not-a-date" })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("normalizes page_size to a whole number >= 1 (PayPal documents no maximum)", async () => {
    const seen: string[] = [];
    const fetchSpy: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/v1/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    };
    const adapter = new PayPalServerAdapter({
      clientId: "id",
      clientSecret: "secret",
      environment: "sandbox",
      fetch: fetchSpy,
    });
    await adapter.fetchEvents({ limit: 0.4 });
    await adapter.fetchEvents({ limit: 2.9 });
    await adapter.fetchEvents({ limit: 500 });
    const pageSizes = seen
      .filter((url) => url.includes("/v1/notifications/webhooks-events"))
      .map((url) => new URL(url).searchParams.get("page_size"));
    expect(pageSizes).toEqual(["1", "2", "500"]);
  });
});

describe("PayPal webhook verification (postback)", () => {
  const rawBody = JSON.stringify({ id: "WH-X", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "2GG9" } });
  const headers = {
    "paypal-transmission-id": "t-1",
    "paypal-transmission-time": "2026-07-07T10:00:00Z",
    "paypal-transmission-sig": "c2ln",
    "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-auth-algo": "SHA256withRSA",
  };

  it("verifies genuine deliveries through PayPal's endpoint", async () => {
    const { adapter, fake } = makePair();
    fake.registerWebhookFixture(rawBody, headers);
    await expect(adapter.verifyWebhookSignature(rawBody, headers)).resolves.toBe(true);
    expect(fake.verifyCalls).toBe(1);
  });

  it("uppercase header names still verify (lowercased before use)", async () => {
    const { adapter, fake } = makePair();
    fake.registerWebhookFixture(rawBody, headers);
    const upper = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toUpperCase(), v]));
    await expect(adapter.verifyWebhookSignature(rawBody, upper)).resolves.toBe(true);
  });

  it("answers false locally — zero network — on missing headers, empty body, or no webhookId", async () => {
    const { adapter, fake } = makePair();
    fake.registerWebhookFixture(rawBody, headers);
    const { "paypal-transmission-sig": _sig, ...missingSig } = headers;
    await expect(adapter.verifyWebhookSignature(rawBody, missingSig)).resolves.toBe(false);
    await expect(adapter.verifyWebhookSignature("", headers)).resolves.toBe(false);
    expect(fake.verifyCalls).toBe(0);

    const noWebhookId = makePair({ webhookId: undefined });
    noWebhookId.fake.registerWebhookFixture(rawBody, headers);
    await expect(noWebhookId.adapter.verifyWebhookSignature(rawBody, headers)).resolves.toBe(false);
    expect(noWebhookId.fake.verifyCalls).toBe(0);
  });

  it("fails closed when the verification endpoint is unreachable", async () => {
    const { adapter, fake } = makePair();
    fake.registerWebhookFixture(rawBody, headers);
    fake.failNextWith(500, { name: "INTERNAL_SERVICE_ERROR" }, 3);
    await expect(adapter.verifyWebhookSignature(rawBody, headers)).resolves.toBe(false);
  });

  it("rejects a wrong configured webhook id", async () => {
    const { adapter, fake } = makePair({ webhookId: "SOME-OTHER-ID" });
    fake.registerWebhookFixture(rawBody, headers);
    await expect(adapter.verifyWebhookSignature(rawBody, headers)).resolves.toBe(false);
  });
});

describe("PayPal transport", () => {
  function adapterWithResponses(
    responses: Array<() => Response | Promise<Response>>,
    config: Partial<PayPalServerAdapterConfig> = {},
  ): { adapter: PayPalServerAdapter; calls: () => number; sleeps: number[] } {
    let call = 0;
    const sleeps: number[] = [];
    const adapter = new PayPalServerAdapter({
      clientId: "id",
      clientSecret: "secret",
      environment: "sandbox",
      fetch: (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/v1/oauth2/token")) {
          return new Response(JSON.stringify({ access_token: "tok", token_type: "Bearer", expires_in: 3600 }), {
            status: 200,
          });
        }
        const responder = responses[Math.min(call, responses.length - 1)]!;
        call += 1;
        return responder();
      }) as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...config,
    });
    return { adapter, calls: () => call, sleeps };
  }

  const http = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });
  const okRefund = http(200, { id: "1JU1", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } });

  it("retries 5xx and network failures with backoff, then succeeds", async () => {
    const { adapter, calls, sleeps } = adapterWithResponses([
      http(503, { name: "INTERNAL_SERVICE_ERROR" }),
      () => Promise.reject(new TypeError("fetch failed")),
      okRefund,
    ]);
    const refund = await adapter.retrieveRefund("1JU1");
    expect(refund.status).toBe("succeeded");
    expect(refund.amount).toBe(100);
    expect(calls()).toBe(3);
    expect(sleeps).toEqual([250, 500]);
  });

  it("gives up after maxNetworkRetries and surfaces the transport error", async () => {
    const { adapter, calls } = adapterWithResponses([http(500, { name: "INTERNAL_SERVICE_ERROR" })], {
      maxNetworkRetries: 1,
    });
    await expect(adapter.retrieveRefund("1JU1")).rejects.toMatchObject({ code: "psp_unavailable", retryable: true });
    expect(calls()).toBe(2);
  });

  it("never retries business errors — one API call per decline/422", async () => {
    const declined = adapterWithResponses([
      http(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] }),
      okRefund,
    ]);
    await expect(declined.adapter.retrieveRefund("1JU1")).rejects.toMatchObject({ code: "card_declined" });
    expect(declined.calls()).toBe(1);
  });

  it("retries rate limiting (429), and maxNetworkRetries: 0 disables the loop", async () => {
    const limited = adapterWithResponses([http(429, { name: "RATE_LIMIT_REACHED" }), okRefund]);
    await expect(limited.adapter.retrieveRefund("1JU1")).resolves.toMatchObject({ status: "succeeded" });
    expect(limited.calls()).toBe(2);

    const noRetry = adapterWithResponses([http(503, { name: "x" }), okRefund], { maxNetworkRetries: 0 });
    await expect(noRetry.adapter.retrieveRefund("1JU1")).rejects.toMatchObject({ code: "psp_unavailable" });
    expect(noRetry.calls()).toBe(1);
  });

  it("survives non-JSON error bodies from proxies/load balancers", async () => {
    const { adapter } = adapterWithResponses([() => new Response("<html>502 Bad Gateway</html>", { status: 502 })]);
    await expect(adapter.retrieveRefund("1JU1")).rejects.toMatchObject({ code: "psp_unavailable", retryable: true });
  });

  it("aborts a hung request and surfaces a retryable psp_unavailable", async () => {
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    const adapter = new PayPalServerAdapter({
      clientId: "id",
      clientSecret: "secret",
      environment: "sandbox",
      fetch: hangingFetch,
      requestTimeoutMs: 30,
      maxNetworkRetries: 0,
    });
    const started = Date.now();
    try {
      await adapter.retrievePayment("5O1");
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("psp_unavailable");
        expect(err.retryable).toBe(true);
        expect(err.message).toMatch(/did not respond within 30ms/);
      }
    }
  });

  it("bounds the response BODY read with the timeout — headers alone do not disarm it", async () => {
    // Headers arrive immediately but the body stream never closes: without
    // the timer surviving until text(), this call would hang forever.
    const { adapter } = adapterWithResponses(
      [() => new Response(new ReadableStream({ start() {} }))],
      { requestTimeoutMs: 5, maxNetworkRetries: 0 },
    );
    await expect(adapter.retrieveRefund("1JU1")).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
      message: expect.stringMatching(/did not respond within 5ms/),
    });
  });

  it("still times out when a response lands only after the abort already fired", async () => {
    // An injected transport may ignore the signal and resolve late — the
    // body read must refuse to start on an already-aborted request.
    const { adapter } = adapterWithResponses(
      [() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("{}")), 40))],
      { requestTimeoutMs: 5, maxNetworkRetries: 0 },
    );
    await expect(adapter.retrieveRefund("1JU1")).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
      message: expect.stringMatching(/did not respond within 5ms/),
    });
  });

  it("bounds the OAuth token mint's body read with the timeout too", async () => {
    // Every API call mints first, so a stalled token body would hang everything.
    const adapter = new PayPalServerAdapter({
      clientId: "id",
      clientSecret: "secret",
      environment: "sandbox",
      fetch: async () => new Response(new ReadableStream({ start() {} })),
      requestTimeoutMs: 5,
      maxNetworkRetries: 0,
    });
    await expect(adapter.retrieveRefund("1JU1")).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
      message: expect.stringMatching(/did not respond within 5ms/),
    });
  });
});

describe("PayPal config validation", () => {
  const base: PayPalServerAdapterConfig = {
    clientId: "id",
    clientSecret: "secret",
    environment: "sandbox",
  };

  it("requires clientId, clientSecret, and an explicit environment", () => {
    expect(() => new PayPalServerAdapter({ ...base, clientId: "" })).toThrowError(/clientId/);
    expect(() => new PayPalServerAdapter({ ...base, clientSecret: "" })).toThrowError(/clientSecret/);
    expect(() => new PayPalServerAdapter({ ...base, environment: "prod" as never })).toThrowError(/sandbox.*live/);
  });

  it("rejects nonsensical tuning values eagerly", () => {
    expect(() => new PayPalServerAdapter({ ...base, requestTimeoutMs: 0 })).toThrowError(/requestTimeoutMs/);
    expect(() => new PayPalServerAdapter({ ...base, maxNetworkRetries: -1 })).toThrowError(/maxNetworkRetries/);
    expect(() => new PayPalServerAdapter({ ...base, maxNetworkRetries: 1.5 })).toThrowError(/maxNetworkRetries/);
    expect(() => new PayPalServerAdapter({ ...base, userAction: "BUY" as never })).toThrowError(/userAction/);
  });

  it("selects the API host from the environment", async () => {
    const urls: string[] = [];
    const record: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    };
    const live = new PayPalServerAdapter({ ...base, environment: "live", fetch: record, maxNetworkRetries: 0 });
    await live.retrievePayment("5O1").catch(() => undefined);
    expect(urls[0]).toContain("https://api-m.paypal.com/v1/oauth2/token");

    urls.length = 0;
    const sandbox = new PayPalServerAdapter({ ...base, fetch: record, maxNetworkRetries: 0 });
    await sandbox.retrievePayment("5O1").catch(() => undefined);
    expect(urls[0]).toContain("https://api-m.sandbox.paypal.com/v1/oauth2/token");
  });
});

describe("edge-runtime compatibility", () => {
  it("the adapter's runtime sources use no Node-only builtins (WebCrypto only)", async () => {
    // Static guard: node:crypto/Buffer sneaking back in would silently break
    // Cloudflare Workers / Next.js edge deployments.
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const offenders: string[] = [];
    for (const file of await readdir(srcDir)) {
      const content = await readFile(join(srcDir, file), "utf8");
      if (/from "node:|require\("node:|Buffer\./.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
