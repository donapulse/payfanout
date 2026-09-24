import { describe, expect, it } from "vitest";
import {
  buildWebhookVerificationBody,
  parsePayPalWebhookEvent,
  PayPalServerAdapter,
  paypalOnboarding,
} from "../src/index.js";
import { FakePayPalApi } from "./fake-paypal-api.js";

const HEADERS = {
  "paypal-transmission-id": "t-1",
  "paypal-transmission-time": "2026-09-24T10:00:00Z",
  "paypal-transmission-sig": "c2ln",
  "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-auth-algo": "SHA256withRSA",
};

function adapterWithFake(): { adapter: PayPalServerAdapter; fake: FakePayPalApi } {
  const fake = new FakePayPalApi({ webhookId: "WHID" });
  const adapter = new PayPalServerAdapter({
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    environment: "sandbox",
    webhookId: "WHID",
    fetch: fake.fetch,
    sleep: async () => {},
  });
  return { adapter, fake };
}

describe("webhook verification body shape", () => {
  it("refuses a body that is not exactly one JSON object", () => {
    const refused = [
      '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED"},"extra":1',
      '{"id":"WH-1"} {"id":"WH-2"}',
      '[{"id":"WH-1"}]',
      '"WH-1"',
      "42",
      "null",
      "{not json",
    ];
    for (const rawBody of refused) {
      expect(buildWebhookVerificationBody(rawBody, HEADERS, "WHID"), rawBody).toBeUndefined();
    }
  });

  it("still carries an object body's delivered bytes unchanged", () => {
    const rawBody = '{\n  "id" : "WH-1",\t"event_type":"PAYMENT.CAPTURE.COMPLETED"\n}\n';
    expect(buildWebhookVerificationBody(rawBody, HEADERS, "WHID")).toContain(`"webhook_event":${rawBody}}`);
  });

  it("answers false for such a body without calling PayPal", async () => {
    const { adapter, fake } = adapterWithFake();
    await expect(adapter.verifyWebhookSignature('{"id":"WH-1"},"extra":1', HEADERS)).resolves.toBe(false);
    await expect(adapter.verifyWebhookSignature('[{"id":"WH-1"}]', HEADERS)).resolves.toBe(false);
    expect(fake.requestCount).toBe(0);
    // An object body still goes to PayPal for the verdict.
    await adapter.verifyWebhookSignature('{"id":"WH-1"}', HEADERS);
    expect(fake.requestCount).toBeGreaterThan(0);
  });
});

describe("CHECKOUT.PAYMENT-APPROVAL.REVERSED", () => {
  it("takes the order id from resource.order_id, where PayPal's sample event carries it", async () => {
    const event = await parsePayPalWebhookEvent(
      JSON.stringify({
        id: "WH-TEST-APPROVAL-REVERSED",
        create_time: "2026-09-24T10:00:00.000Z",
        event_type: "CHECKOUT.PAYMENT-APPROVAL.REVERSED",
        summary: "A payment has been reversed after approval.",
        resource: {
          order_id: "ORDER-TEST-1",
          purchase_units: [{ reference_id: "ref-1", custom_id: "custom-1", invoice_id: "invoice-1" }],
          payment_source: { ideal: { name: "Test Buyer", country_code: "NL" } },
        },
        event_version: "1.0",
      }),
    );
    expect(event).toMatchObject({ type: "payment.canceled", pspName: "paypal", pspPaymentId: "ORDER-TEST-1" });
  });
});

describe("paypalOnboarding.csp", () => {
  it("lists the host sources PayPal recommends for scripts, frames and connections", () => {
    const hosts = ["https://*.paypal.com", "https://*.paypalobjects.com", "https://*.venmo.com"];
    expect(paypalOnboarding.csp).toEqual({
      script: ["https://www.paypal.com", ...hosts],
      frame: hosts,
      connect: hosts,
    });
  });
});
