import { describe, expect, it } from "vitest";
import type { UnifiedWebhookEvent } from "@payfanout/core";
import { createAdapterWebhookHandler, createUnifiedWebhookHandler } from "@payfanout/server";
import { FakeAdapter } from "./fake-adapter.js";

const rawBody = JSON.stringify({ id: "evt_1", paymentId: "psp_pay_1" });

describe("createAdapterWebhookHandler", () => {
  it("verifies, parses, dispatches, and acks 200", async () => {
    const adapter = new FakeAdapter({ pspName: "stripe", webhookSecret: "s3cr3t" });
    const seen: UnifiedWebhookEvent[] = [];
    const handler = createAdapterWebhookHandler(adapter, { onEvent: (e) => void seen.push(e) });
    const result = await handler({ rawBody, headers: { "X-Fake-Signature": "s3cr3t" } });
    expect(result).toMatchObject({ ok: true, status: 200, pspName: "stripe" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe("evt_1");
    expect(seen[0]!.pspPaymentId).toBe("psp_pay_1");
  });

  it("normalizes header casing before handing to the adapter", async () => {
    const adapter = new FakeAdapter({ webhookSecret: "s3cr3t" });
    const handler = createAdapterWebhookHandler(adapter, { onEvent: () => {} });
    const result = await handler({ rawBody, headers: { "X-FAKE-SIGNATURE": "s3cr3t" } });
    expect(result.ok).toBe(true);
  });

  it("returns 401 on bad signature without calling onEvent", async () => {
    const adapter = new FakeAdapter({ webhookSecret: "s3cr3t" });
    let called = 0;
    const handler = createAdapterWebhookHandler(adapter, { onEvent: () => void called++ });
    const result = await handler({ rawBody, headers: { "x-fake-signature": "wrong" } });
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(called).toBe(0);
  });

  it("returns 400 with the raw-body recipe hint when rawBody is missing", async () => {
    const adapter = new FakeAdapter();
    const handler = createAdapterWebhookHandler(adapter, { onEvent: () => {} });
    // Simulates a host that let express.json() consume the body.
    const result = await handler({ rawBody: "" as string, headers: {} });
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.reason).toMatch(/express\.raw/);
  });

  it("returns 500 when the host enqueue fails, so the PSP retries", async () => {
    const adapter = new FakeAdapter({ webhookSecret: "s3cr3t" });
    const handler = createAdapterWebhookHandler(adapter, {
      onEvent: () => {
        throw new Error("queue down");
      },
    });
    const result = await handler({ rawBody, headers: { "x-fake-signature": "s3cr3t" } });
    expect(result).toMatchObject({ ok: false, status: 500 });
  });
});

describe("createUnifiedWebhookHandler", () => {
  it("routes to whichever adapter's signature verification matches and logs it", async () => {
    const stripe = new FakeAdapter({ pspName: "stripe", webhookSecret: "stripe-key" });
    const paysafe = new FakeAdapter({ pspName: "paysafe", webhookSecret: "paysafe-key" });
    const logs: string[] = [];
    const handler = createUnifiedWebhookHandler([stripe, paysafe], {
      onEvent: () => {},
      log: (m) => void logs.push(m),
    });

    const result = await handler({ rawBody, headers: { "x-fake-signature": "paysafe-key" } });
    expect(result).toMatchObject({ ok: true, pspName: "paysafe" });
    expect(logs.some((l) => l.includes('matched adapter "paysafe"'))).toBe(true);
    // The non-matching adapter must never be asked to parse.
    expect(stripe.calls.filter((c) => c.method === "parseWebhookEvent")).toHaveLength(0);
  });

  it("returns 401 when nothing matches, and survives adapters that throw during verification", async () => {
    const broken = new FakeAdapter({ pspName: "broken" });
    broken.verifyWebhookSignature = async () => {
      throw new Error("kaboom");
    };
    const healthy = new FakeAdapter({ pspName: "healthy", webhookSecret: "h-key" });
    const handler = createUnifiedWebhookHandler([broken, healthy], { onEvent: () => {} });

    const miss = await handler({ rawBody, headers: { "x-fake-signature": "nope" } });
    expect(miss).toMatchObject({ ok: false, status: 401 });

    const hit = await handler({ rawBody, headers: { "x-fake-signature": "h-key" } });
    expect(hit).toMatchObject({ ok: true, pspName: "healthy" });
  });
});
