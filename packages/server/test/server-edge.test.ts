import { describe, expect, it } from "vitest";
import { createUnifiedWebhookHandler, PaymentService } from "@payfanout/server";
import { FakeAdapter } from "./fake-adapter.js";

describe("PaymentService registration coherence", () => {
  it("rejects a capabilities pspName that contradicts the adapter", () => {
    const impostor = new FakeAdapter({ pspName: "honest" });
    Object.defineProperty(impostor, "pspName", { value: "liar" });
    expect(() => new PaymentService({ adapters: [impostor] })).toThrowError(
      /reports capabilities for "honest"/,
    );
  });

  it("rejects manual-capture and verification claims without implementations", () => {
    const noCapture = new FakeAdapter({
      capabilities: { supportsManualCapture: true, supportsPaymentMethodVerification: false },
      omitOptionalMethods: true,
    });
    expect(() => new PaymentService({ adapters: [noCapture] })).toThrowError(
      /claims manual capture but does not implement/,
    );

    const noVerify = new FakeAdapter({
      capabilities: { supportsManualCapture: false, supportsPaymentMethodVerification: true },
      omitOptionalMethods: true,
    });
    expect(() => new PaymentService({ adapters: [noVerify] })).toThrowError(
      /claims verification but does not implement/,
    );
  });

  it("rejects partial-refund support without refund support", () => {
    const incoherent = new FakeAdapter({
      capabilities: { supportsRefunds: false, supportsPartialRefunds: true },
    });
    expect(() => new PaymentService({ adapters: [incoherent] })).toThrowError(
      /partial refunds without refund support/,
    );
  });

  it("exposes registered adapters via getAdapter for advanced host wiring", () => {
    const adapter = new FakeAdapter({ pspName: "stripe" });
    const service = new PaymentService({ adapters: [adapter] });
    expect(service.getAdapter("stripe")).toBe(adapter);
    expect(() => service.getAdapter("ghost")).toThrowError(/No adapter registered/);
  });
});

describe("webhook handler edges", () => {
  it("createUnifiedWebhookHandler refuses an empty adapter list", () => {
    expect(() => createUnifiedWebhookHandler([], { onEvent: () => {} })).toThrowError(
      /at least one adapter/,
    );
  });

  it("returns 400 when a verified payload fails to parse", async () => {
    const adapter = new FakeAdapter({ webhookSecret: "s3cr3t" });
    // Signature passes (header-based fake), but the body is not JSON.
    const handler = createUnifiedWebhookHandler([adapter], { onEvent: () => {} });
    const result = await handler({ rawBody: "not json at all", headers: { "x-fake-signature": "s3cr3t" } });
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.reason).toMatch(/Failed to parse/);
  });
});
