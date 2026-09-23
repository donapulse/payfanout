import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { UnifiedWebhookEvent } from "@payfanout/core";
import { parseWorldlineWebhookEvent, WorldlineServerAdapter } from "../src/index.js";

const WEBHOOK_KEY_ID = "wh-key-1";
const WEBHOOK_SECRET = "webhook-secret";

// Statuses as the platform's statuses reference documents them for each event.
const CAPTURED = { status: "CAPTURED", statusOutput: { statusCode: 9, statusCategory: "COMPLETED" } };
const CAPTURE_REQUESTED = {
  status: "CAPTURE_REQUESTED",
  statusOutput: { statusCode: 91, statusCategory: "PENDING_CONNECT_OR_3RD_PARTY" },
};
const REFUNDED = { status: "REFUNDED", statusOutput: { statusCode: 8, statusCategory: "REFUNDED" } };
const REFUND_REQUESTED = {
  status: "REFUND_REQUESTED",
  statusOutput: { statusCode: 81, statusCategory: "PENDING_CONNECT_OR_3RD_PARTY" },
};

type Status = typeof CAPTURED;

function payment(id: string, status: Status, amount = 1099, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    ...status,
    paymentOutput: { amountOfMoney: { amount, currencyCode: "EUR" }, references: { merchantReference: "order-1" } },
    ...extra,
  };
}

function delivery(envelopeId: string, type: string, resource: Record<string, unknown>): Record<string, unknown> {
  return { apiVersion: "v1", id: envelopeId, created: "2026-09-23T10:00:00Z", merchantId: "mid-1", type, ...resource };
}

async function eventId(body: unknown): Promise<string> {
  return (await parseWorldlineWebhookEvent(JSON.stringify(body))).id;
}

/** The deliveries the setup guide tells hosts to re-read refunds on. */
function isRefundTypeDelivery(event: UnifiedWebhookEvent): boolean {
  if (event.type === "payment.refunded" || event.type === "payment.refund_failed") return true;
  const rawType = (event.raw as { type?: unknown }).type;
  return event.type === "unknown" && typeof rawType === "string" && rawType.toLowerCase().startsWith("refund.");
}

describe("webhook event identity", () => {
  it("gives two deliveries of one event the same id even when their envelope ids differ", async () => {
    const first = await eventId(delivery("env-1", "payment.captured", { payment: payment("pay_1", CAPTURED) }));
    const second = await eventId(delivery("env-2", "payment.captured", { payment: payment("pay_1", CAPTURED) }));
    expect(first).toBe("worldline:payment.captured:pay_1");
    expect(second).toBe(first);
  });

  it("separates events of different types about the same payment", async () => {
    // The Status Changes table lists a capture's request and its confirmation under one payment.id.
    const requested = await eventId(
      delivery("env-1", "payment.capture_requested", { payment: payment("pay_2", CAPTURE_REQUESTED) }),
    );
    const captured = await eventId(delivery("env-2", "payment.captured", { payment: payment("pay_2", CAPTURED) }));
    expect(requested).toBe("worldline:payment.capture_requested:pay_2");
    expect(captured).toBe("worldline:payment.captured:pay_2");
  });

  it("gives payment.refunded events on different payment ids different ids", async () => {
    const first = await eventId(delivery("env-1", "payment.refunded", { payment: payment("pay_3", REFUNDED, 400) }));
    const second = await eventId(delivery("env-2", "payment.refunded", { payment: payment("pay_4", REFUNDED, 600) }));
    expect(first).toBe("worldline:payment.refunded:pay_3");
    expect(second).toBe("worldline:payment.refunded:pay_4");
  });

  it("treats a second event of one type on one payment.id as a duplicate", async () => {
    // Worldline does not guarantee a new payment.id per operation: two refunds
    // confirmed under one payment.id share an event id and a store keyed on it
    // drops the second. Hosts therefore run the refund re-read (retrievePayment,
    // retrieveRefund) on every refund-type delivery whether or not its event.id
    // was already seen, poll retrieveRefund until their refunds leave pending,
    // reconcile captured payments on a schedule, and never sum event.amount.
    const first = await eventId(delivery("env-1", "payment.refunded", { payment: payment("pay_5", REFUNDED, 400) }));
    const second = await eventId(delivery("env-2", "payment.refunded", { payment: payment("pay_5", REFUNDED, 600) }));
    expect(first).toBe("worldline:payment.refunded:pay_5");
    expect(second).toBe(first);
  });

  it("gives a redelivery the same id with, without, or with a different operationOutput", async () => {
    // Only payment.id and type are documented as identical across duplicates;
    // any other field may differ on a redelivery, so none reaches the id.
    const without = await eventId(delivery("env-1", "payment.refunded", { payment: payment("pay_6", REFUNDED, 400) }));
    const withOne = await eventId(
      delivery("env-2", "payment.refunded", { payment: payment("pay_6", REFUNDED, 400, { operationOutput: { id: "op_1" } }) }),
    );
    const withAnother = await eventId(
      delivery("env-3", "payment.refunded", { payment: payment("pay_6", REFUNDED, 400, { operationOutput: { id: "op_2" } }) }),
    );
    expect(without).toBe("worldline:payment.refunded:pay_6");
    expect(withOne).toBe(without);
    expect(withAnother).toBe(without);
  });

  it("keys a refund-resource event on refund.id", async () => {
    const id = await eventId(delivery("env-1", "refund.refund_requested", { refund: { id: "ref_1", ...REFUND_REQUESTED } }));
    expect(id).toBe("worldline:refund.refund_requested:ref_1");
  });

  it("prefers payment.id when a delivery carries both resources", async () => {
    const id = await eventId(
      delivery("env-1", "refund.refund_requested", { payment: payment("pay_9", REFUND_REQUESTED), refund: { id: "ref_2" } }),
    );
    expect(id).toBe("worldline:refund.refund_requested:pay_9");
  });

  it("keeps the envelope id for payment-link events, whose link id repeats across distinct events", async () => {
    // Two payments on one reusable link: same type, same paymentLinkId, different events.
    const link = { paymentLinkId: "pl_1", isReusableLink: true, status: "ACTIVE" };
    const first = await eventId(delivery("env-pl-1", "paymentlink.paid", { paymentLink: link }));
    const second = await eventId(delivery("env-pl-2", "paymentlink.paid", { paymentLink: link }));
    expect(first).toBe("env-pl-1");
    expect(second).toBe("env-pl-2");
  });

  it("keeps the envelope id for payment.test messages, which all carry the same payment.id", async () => {
    // SendTestWebhook's documented message: payment.id "9999_9" on every test.
    const test = {
      payment: {
        id: "9999_9",
        status: "AUTHORIZATION_REQUESTED",
        statusOutput: { statusCode: 0, statusCategory: "PENDING_CONNECT_OR_3RD_PARTY" },
        paymentOutput: { amountOfMoney: { amount: 1234, currencyCode: "EUR" } },
      },
    };
    const first = await parseWorldlineWebhookEvent(JSON.stringify(delivery("env-test-1", "payment.test", test)));
    const second = await parseWorldlineWebhookEvent(JSON.stringify(delivery("env-test-2", "Payment.Test", test)));
    expect(first.id).toBe("env-test-1");
    expect(second.id).toBe("env-test-2");
    expect(first.type).toBe("unknown");
    expect(first.pspPaymentId).toBe("9999_9");

    const withoutEnvelope = JSON.stringify({ type: "payment.test", ...test });
    const hashed = await parseWorldlineWebhookEvent(withoutEnvelope);
    expect(hashed.id).toMatch(/^worldline_[0-9a-f]{64}$/);
    expect((await parseWorldlineWebhookEvent(withoutEnvelope)).id).toBe(hashed.id);
  });

  it("falls back to the envelope id when the delivery names no resource", async () => {
    expect(await eventId(delivery("env-1", "payment.captured", {}))).toBe("env-1");
  });

  it("falls back to the envelope id when the delivery carries no type", async () => {
    expect(await eventId({ id: "env-1", payment: payment("pay_1", CAPTURED) })).toBe("env-1");
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
    const event = await parseWorldlineWebhookEvent(
      JSON.stringify(delivery("env-1", "Payment.Captured", { payment: payment("pay_1", CAPTURED) })),
    );
    expect(event.id).toBe("worldline:payment.captured:pay_1");
    expect(event.type).toBe("payment.succeeded");
  });

  it("derives the same id from a one-element array delivery as from the bare object", async () => {
    const body = delivery("env-1", "payment.captured", { payment: payment("pay_1", CAPTURED) });
    expect(await eventId([body])).toBe(await eventId(body));
  });

  it("lets a store keyed on event.id drop a redelivery while every refund-type delivery still triggers the re-read", async () => {
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
      delivery("env-1", "payment.captured", { payment: payment("pay_10", CAPTURED) }),
      delivery("env-2", "payment.captured", { payment: payment("pay_10", CAPTURED) }), // Worldline redelivers the capture
      delivery("env-3", "refund.refund_requested", { refund: { id: "ref_4", ...REFUND_REQUESTED } }),
      delivery("env-4", "payment.refunded", { payment: payment("pay_11", REFUNDED, 400) }),
      delivery("env-5", "payment.refunded", { payment: payment("pay_12", REFUNDED, 600) }),
      // A second refund confirmed under the same payment.id: the store drops it.
      delivery("env-6", "payment.refunded", { payment: payment("pay_12", REFUNDED, 200) }),
    ];
    const seen = new Set<string>();
    const processed: string[] = [];
    const rereads: string[] = [];
    for (const body of deliveries) {
      const rawBody = JSON.stringify(body);
      const headers = {
        "x-gcs-signature": createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf8").digest("base64"),
        "x-gcs-keyid": WEBHOOK_KEY_ID,
      };
      await expect(adapter.verifyWebhookSignature(rawBody, headers)).resolves.toBe(true);
      const event = await adapter.parseWebhookEvent(rawBody);
      // Ahead of the dedupe check, so a merged refund still triggers its re-read.
      if (isRefundTypeDelivery(event)) rereads.push(`${event.type}:${event.pspPaymentId}`);
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      processed.push(`${event.type}:${event.pspPaymentId}`);
    }
    expect(processed).toEqual([
      "payment.succeeded:pay_10",
      "unknown:ref_4",
      "payment.refunded:pay_11",
      "payment.refunded:pay_12",
    ]);
    expect(rereads).toEqual(["unknown:ref_4", "payment.refunded:pay_11", "payment.refunded:pay_12", "payment.refunded:pay_12"]);
  });
});
