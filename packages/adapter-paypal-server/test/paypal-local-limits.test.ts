import { describe, expect, it } from "vitest";
import { PayPalServerAdapter, type PayPalServerAdapterConfig } from "../src/index.js";
import { FakePayPalApi } from "./fake-paypal-api.js";

function makePair(config: Partial<PayPalServerAdapterConfig> = {}): { adapter: PayPalServerAdapter; fake: FakePayPalApi } {
  const fake = new FakePayPalApi();
  const adapter = new PayPalServerAdapter({
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    environment: "sandbox",
    fetch: fake.fetch,
    sleep: async () => {},
    ...config,
  });
  return { adapter, fake };
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

  it("refuses a session id longer than the 255-character custom_id before creating the order", async () => {
    const { adapter, fake } = makePair();
    const before = fake.requestCount;
    await expect(
      adapter.createPaymentSession({ amount: 2000, currency: "USD", id: "x".repeat(256), idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/255/) });
    expect(fake.requestCount).toBe(before);
    const session = await adapter.createPaymentSession({
      amount: 2000,
      currency: "USD",
      id: "x".repeat(255),
      idempotencyKey: "k2",
    });
    expect(session.id).toBe("x".repeat(255));
  });

  it("refuses a brand name outside 1–127 characters at construction", () => {
    expect(() => makePair({ brandName: "" })).toThrowError(/brandName must be 1–127 characters/);
    expect(() => makePair({ brandName: "B".repeat(128) })).toThrowError(/brandName must be 1–127 characters/);
    expect(() => makePair({ brandName: "B".repeat(127) })).not.toThrow();
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
});
