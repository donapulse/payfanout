import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseWorldlineWebhookEvent, WorldlineServerAdapter } from "../src/index.js";

const WEBHOOK_KEY_ID = "wh-key-1";
const WEBHOOK_SECRET = "webhook-secret";

function payment(id: string, amount = 1099): Record<string, unknown> {
  return {
    id,
    status: "CAPTURED",
    statusOutput: { statusCode: 9, statusCategory: "COMPLETED" },
    paymentOutput: { amountOfMoney: { amount, currencyCode: "EUR" }, references: { merchantReference: "order-1" } },
  };
}

function delivery(envelopeId: string, type: string, resource: Record<string, unknown>): Record<string, unknown> {
  return { apiVersion: "v1", id: envelopeId, created: "2026-09-23T10:00:00Z", merchantId: "mid-1", type, ...resource };
}

async function eventId(body: unknown): Promise<string> {
  return (await parseWorldlineWebhookEvent(JSON.stringify(body))).id;
}

describe("webhook event identity", () => {
  it("gives two deliveries of one event the same id even when their envelope ids differ", async () => {
    const first = await eventId(delivery("env-1", "payment.captured", { payment: payment("pay_1") }));
    const second = await eventId(delivery("env-2", "payment.captured", { payment: payment("pay_1") }));
    expect(first).toBe("worldline:payment.captured:pay_1");
    expect(second).toBe(first);
  });

  it("separates events of different types about the same payment", async () => {
    // A capture's request and its confirmation share the capture's payment.id.
    const requested = await eventId(delivery("env-1", "payment.capture_requested", { payment: payment("pay_2") }));
    const captured = await eventId(delivery("env-2", "payment.captured", { payment: payment("pay_2") }));
    expect(requested).toBe("worldline:payment.capture_requested:pay_2");
    expect(captured).toBe("worldline:payment.captured:pay_2");
  });

  it("separates two partial refunds, which each report a payment.id of their own", async () => {
    const first = await eventId(delivery("env-1", "payment.refunded", { payment: payment("pay_3", 400) }));
    const second = await eventId(delivery("env-2", "payment.refunded", { payment: payment("pay_4", 600) }));
    expect(first).toBe("worldline:payment.refunded:pay_3");
    expect(second).toBe("worldline:payment.refunded:pay_4");
  });

  it("keys a refund-resource event on refund.id", async () => {
    const id = await eventId(delivery("env-1", "refund.refund_requested", { refund: { id: "ref_1", status: "REFUND_REQUESTED" } }));
    expect(id).toBe("worldline:refund.refund_requested:ref_1");
  });

  it("prefers payment.id when a delivery carries both resources", async () => {
    const id = await eventId(delivery("env-1", "refund.refund_requested", { payment: payment("pay_5"), refund: { id: "ref_2" } }));
    expect(id).toBe("worldline:refund.refund_requested:pay_5");
  });

  it("keeps the envelope id for payment-link events, whose link id repeats across distinct events", async () => {
    // Two payments on one reusable link: same type, same paymentLinkId, different events.
    const link = { paymentLinkId: "pl_1", isReusableLink: true, status: "ACTIVE" };
    const first = await eventId(delivery("env-pl-1", "paymentlink.paid", { paymentLink: link }));
    const second = await eventId(delivery("env-pl-2", "paymentlink.paid", { paymentLink: link }));
    expect(first).toBe("env-pl-1");
    expect(second).toBe("env-pl-2");
  });

  it("falls back to the envelope id when the delivery names no resource", async () => {
    expect(await eventId(delivery("env-1", "payment.captured", {}))).toBe("env-1");
  });

  it("falls back to the envelope id when the delivery carries no type", async () => {
    expect(await eventId({ id: "env-1", payment: payment("pay_1") })).toBe("env-1");
  });

  it("hashes the exact raw bytes when there is nothing to key on, stable across parses", async () => {
    const raw = JSON.stringify({ created: "2026-09-23T10:00:00Z", payment: { status: "CAPTURED" } });
    const first = await parseWorldlineWebhookEvent(raw);
    const second = await parseWorldlineWebhookEvent(raw);
    expect(first.id).toMatch(/^worldline_[0-9a-f]{64}$/);
    expect(second.id).toBe(first.id);
  });

  it("skips empty or non-string ids at every step", async () => {
    expect(await eventId({ id: "env-1", type: "payment.captured", payment: { id: "" }, refund: { id: "ref_3" } })).toBe(
      "worldline:payment.captured:ref_3",
    );
    expect(await eventId({ id: "env-1", type: "payment.captured", payment: { id: 42 } })).toBe("env-1");
    expect(await eventId({ id: "", type: "payment.captured", payment: { id: "" } })).toMatch(/^worldline_[0-9a-f]{64}$/);
    expect(await eventId({ id: 7, type: "payment.captured" })).toMatch(/^worldline_[0-9a-f]{64}$/);
  });

  it("lower-cases the event type in the id", async () => {
    const event = await parseWorldlineWebhookEvent(JSON.stringify(delivery("env-1", "Payment.Captured", { payment: payment("pay_1") })));
    expect(event.id).toBe("worldline:payment.captured:pay_1");
    expect(event.type).toBe("payment.succeeded");
  });

  it("derives the same id from a one-element array delivery as from the bare object", async () => {
    const body = delivery("env-1", "payment.captured", { payment: payment("pay_1") });
    expect(await eventId([body])).toBe(await eventId(body));
  });

  it("lets a store keyed on event.id drop a redelivery but keep both partial refunds", async () => {
    const adapter = new WorldlineServerAdapter({
      apiKeyId: "api-key-id",
      secretApiKey: "secret-api-key",
      merchantId: "mid-1",
      environment: "sandbox",
      sessionSigningKey: "session-signing-key",
      webhookKeys: [{ keyId: WEBHOOK_KEY_ID, secretKey: WEBHOOK_SECRET }],
      fetch: async () => {
        throw new Error("webhook handling makes no API call");
      },
    });
    const deliveries = [
      delivery("env-1", "payment.captured", { payment: payment("pay_6") }),
      delivery("env-2", "payment.captured", { payment: payment("pay_6") }), // Worldline redelivers the capture
      delivery("env-3", "payment.refunded", { payment: payment("pay_7", 400) }),
      delivery("env-4", "payment.refunded", { payment: payment("pay_8", 600) }),
    ];
    const seen = new Set<string>();
    const processed: string[] = [];
    for (const body of deliveries) {
      const rawBody = JSON.stringify(body);
      const headers = {
        "x-gcs-signature": createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf8").digest("base64"),
        "x-gcs-keyid": WEBHOOK_KEY_ID,
      };
      await expect(adapter.verifyWebhookSignature(rawBody, headers)).resolves.toBe(true);
      const event = await adapter.parseWebhookEvent(rawBody);
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      processed.push(`${event.type}:${event.pspPaymentId}`);
    }
    expect(processed).toEqual(["payment.succeeded:pay_6", "payment.refunded:pay_7", "payment.refunded:pay_8"]);
  });
});
