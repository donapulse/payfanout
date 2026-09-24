import { describe, expect, it } from "vitest";
import { PayPalServerAdapter, type PayPalServerAdapterConfig } from "../src/index.js";
import { FakePayPalApi } from "./fake-paypal-api.js";

// One character but two UTF-16 code units: pins counting by characters.
const ASTRAL = String.fromCodePoint(0x1f600);

function makePair(config: Partial<PayPalServerAdapterConfig> = {}): {
  adapter: PayPalServerAdapter;
  fake: FakePayPalApi;
  orderBodies: Array<Record<string, unknown>>;
} {
  const fake = new FakePayPalApi();
  const orderBodies: Array<Record<string, unknown>> = [];
  const adapter = new PayPalServerAdapter({
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    environment: "sandbox",
    fetch: async (input, init) => {
      if (init?.method === "POST" && new URL(String(input)).pathname === "/v2/checkout/orders") {
        orderBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return fake.fetch(input, init);
    },
    sleep: async () => {},
    ...config,
  });
  return { adapter, fake, orderBodies };
}

function experienceContext(body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const source = body?.["payment_source"] as { paypal?: { experience_context?: Record<string, unknown> } } | undefined;
  return source?.paypal?.experience_context;
}

describe("PayPal local limits", () => {
  it("refuses a zero amount on every money call before sending it", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 2000, currency: "USD", idempotencyKey: "k" });
    const before = fake.requestCount;
    const zero = { code: "invalid_request", message: expect.stringMatching(/greater than zero/) };
    await expect(adapter.createPaymentSession({ amount: 0, currency: "USD", idempotencyKey: "k0" })).rejects.toMatchObject(zero);
    await expect(
      adapter.updatePaymentSession({ pspSessionId: session.pspSessionId, amount: 0, idempotencyKey: "k1" }),
    ).rejects.toMatchObject(zero);
    await expect(adapter.capturePayment(session.pspSessionId, 0, "k2")).rejects.toMatchObject(zero);
    await expect(
      adapter.refundPayment({ pspPaymentId: session.pspSessionId, amount: 0, idempotencyKey: "k3" }),
    ).rejects.toMatchObject(zero);
    expect(fake.requestCount).toBe(before);
  });

  it("refuses a session id over the 255-character custom_id before creating the order, counting characters", async () => {
    const { adapter, fake } = makePair();
    const before = fake.requestCount;
    for (const id of ["x".repeat(256), ASTRAL.repeat(256)]) {
      await expect(adapter.createPaymentSession({ amount: 2000, currency: "USD", id, idempotencyKey: "k" })).rejects.toMatchObject({
        code: "invalid_request",
        message: expect.stringMatching(/255 characters; this one has 256/),
      });
    }
    expect(fake.requestCount).toBe(before);
    for (const [n, id] of ["x".repeat(255), ASTRAL.repeat(255)].entries()) {
      const session = await adapter.createPaymentSession({ amount: 2000, currency: "USD", id, idempotencyKey: `ok-${n}` });
      expect(session.id).toBe(id);
    }
  });

  it("still omits an empty or missing session id", async () => {
    const { adapter, orderBodies } = makePair();
    for (const id of ["", null as unknown as string, undefined]) {
      await expect(
        adapter.createPaymentSession({ amount: 2000, currency: "USD", id, idempotencyKey: `k-${String(id)}` }),
      ).resolves.toMatchObject({ amount: 2000 });
    }
    expect(orderBodies).toHaveLength(3);
    for (const body of orderBodies) {
      expect((body["purchase_units"] as Array<Record<string, unknown>>)[0]).not.toHaveProperty("custom_id");
    }
  });

  it("refuses at construction a brand name PayPal would reject; an empty one is still omitted", async () => {
    const tooLong = /brandName must be at most 127 characters on one line/;
    expect(() => makePair({ brandName: "B".repeat(128) })).toThrowError(tooLong);
    expect(() => makePair({ brandName: ASTRAL.repeat(128) })).toThrowError(tooLong);
    expect(() => makePair({ brandName: `Line one${String.fromCharCode(10)}Line two` })).toThrowError(tooLong);
    expect(() => makePair({ brandName: "B".repeat(127) })).not.toThrow();
    expect(() => makePair({ brandName: ASTRAL.repeat(127) })).not.toThrow();

    for (const brandName of ["", null as unknown as string]) {
      const { adapter, orderBodies } = makePair({ brandName });
      await adapter.createPaymentSession({ amount: 2000, currency: "USD", idempotencyKey: "k" });
      expect(experienceContext(orderBodies[0])).not.toHaveProperty("brand_name");
    }
    const { adapter, orderBodies } = makePair({ brandName: "Jane's Gifts" });
    await adapter.createPaymentSession({ amount: 2000, currency: "USD", idempotencyKey: "k" });
    expect(experienceContext(orderBodies[0])).toMatchObject({ brand_name: "Jane's Gifts" });
  });

  it("accepts as a fetchEvents cursor only the events list itself, dot segments resolved", async () => {
    const { adapter, fake } = makePair();
    const before = fake.requestCount;
    for (const cursor of [
      "/v1/notifications/webhooks-events/../../v2/checkout/orders/X",
      "/v1/notifications/webhooks-events/%2e%2e/%2e%2e/v2/checkout/orders/X",
      "/v1/notifications/webhooks-events-other",
      "//elsewhere.example/v1/notifications/webhooks-events",
      "https://api-m.paypal.com/v1/notifications/webhooks-events",
    ]) {
      await expect(adapter.fetchEvents({ cursor }), cursor).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(fake.requestCount).toBe(before);
    await expect(adapter.fetchEvents({ cursor: "/v1/notifications/webhooks-events?page_size=2" })).resolves.toMatchObject({
      events: [],
    });
  });

  it("follows a next link to the events list, trailing slash included, and no other path", async () => {
    const requested: string[] = [];
    const nextLinks = [
      "https://api-m.sandbox.paypal.com/v1/notifications/webhooks-events/?page_size=2&start_index=2",
      "https://api-m.sandbox.paypal.com/v1/notifications/webhooks-events/WH-1",
    ];
    const fetchSpy: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/oauth2/token") {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      requested.push(`${url.pathname}${url.search}`);
      const next = nextLinks.shift();
      return new Response(JSON.stringify({ events: [], links: next ? [{ href: next, rel: "next", method: "GET" }] : [] }), {
        status: 200,
      });
    };
    const adapter = new PayPalServerAdapter({ clientId: "id", clientSecret: "secret", environment: "sandbox", fetch: fetchSpy });
    const first = await adapter.fetchEvents({ limit: 2 });
    expect(first.nextCursor).toBe("/v1/notifications/webhooks-events/?page_size=2&start_index=2");
    const second = await adapter.fetchEvents({ cursor: first.nextCursor });
    expect(second.nextCursor).toBeUndefined();
    expect(requested).toEqual([
      "/v1/notifications/webhooks-events?page_size=2",
      "/v1/notifications/webhooks-events/?page_size=2&start_index=2",
    ]);
  });

  it("requests the resolved cursor path, never the cursor as given", async () => {
    const sent: string[] = [];
    const fetchSpy: typeof fetch = async (input) => {
      const raw = String(input);
      if (new URL(raw).pathname === "/v1/oauth2/token") {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      sent.push(raw);
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    };
    const adapter = new PayPalServerAdapter({ clientId: "id", clientSecret: "secret", environment: "sandbox", fetch: fetchSpy });
    await adapter.fetchEvents({ cursor: "/v1/notifications/webhooks-events/./?page_size=2" });
    expect(sent).toEqual(["https://api-m.sandbox.paypal.com/v1/notifications/webhooks-events/?page_size=2"]);
  });
});
