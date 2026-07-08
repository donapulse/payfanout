import { describe, expect, it } from "vitest";
import { isPayFanoutError, PayFanoutError } from "@payfanout/core";
import { PaymentService } from "@payfanout/server";
import { FakeAdapter } from "./fake-adapter.js";

const baseInput = {
  amount: 1000,
  currency: "USD",
  idempotencyKey: "idem-1",
};

async function expectGuard(
  promise: Promise<unknown>,
  pattern: RegExp,
  code: "invalid_request" | "unsupported_operation",
): Promise<void> {
  try {
    await promise;
    expect.unreachable("expected rejection");
  } catch (err) {
    expect(isPayFanoutError(err)).toBe(true);
    if (isPayFanoutError(err)) {
      expect(err.code).toBe(code);
      expect(err.message).toMatch(pattern);
    }
  }
}

const expectInvalidRequest = (p: Promise<unknown>, r: RegExp) => expectGuard(p, r, "invalid_request");
const expectUnsupported = (p: Promise<unknown>, r: RegExp) => expectGuard(p, r, "unsupported_operation");

describe("PaymentService registry", () => {
  it("routes to the named adapter and lists psps", async () => {
    const a = new FakeAdapter({ pspName: "stripe" });
    const b = new FakeAdapter({ pspName: "paysafe", capabilities: { requiresServerCompletion: true } });
    const service = new PaymentService({ adapters: [a, b] });
    expect(service.listPsps()).toEqual(["stripe", "paysafe"]);
    const session = await service.createPaymentSession("stripe", baseInput);
    expect(session.pspName).toBe("stripe");
    expect(a.calls.some((c) => c.method === "createPaymentSession")).toBe(true);
    expect(b.calls.length).toBe(0);
  });

  it("rejects duplicate and unknown psps", async () => {
    expect(
      () => new PaymentService({ adapters: [new FakeAdapter(), new FakeAdapter()] }),
    ).toThrowError(/Duplicate adapter/);
    const service = new PaymentService({ adapters: [new FakeAdapter({ pspName: "stripe" })] });
    await expectInvalidRequest(service.retrievePayment("nope", "x"), /No adapter registered/);
  });

  it("rejects incoherent capability flags at registration", () => {
    expect(
      () =>
        new PaymentService({
          adapters: [
            new FakeAdapter({ capabilities: { requiresServerCompletion: true }, omitOptionalMethods: true }),
          ],
        }),
    ).toThrowError(/does not implement completePayment/);
    // Vaulting is allowed — but claiming
    // it without the implemented surface is still incoherent.
    expect(
      () =>
        new PaymentService({
          adapters: [
            new FakeAdapter({
              capabilities: { supportsSavedPaymentMethods: true },
              omitOptionalMethods: true,
            }),
          ],
        }),
    ).toThrowError(/does not implement/);
    // A fully-implemented vaulting adapter registers cleanly.
    expect(
      () =>
        new PaymentService({
          adapters: [new FakeAdapter({ capabilities: { supportsSavedPaymentMethods: true } })],
        }),
    ).not.toThrowError();
  });
});

describe("PaymentService guards", () => {
  it("requires idempotency keys on mutating operations", async () => {
    const service = new PaymentService({ adapters: [new FakeAdapter()] });
    await expectInvalidRequest(
      service.createPaymentSession("fake", { ...baseInput, idempotencyKey: " " }),
      /idempotencyKey/,
    );
    await expectInvalidRequest(
      service.refundPayment("fake", { pspPaymentId: "p1", idempotencyKey: "" }),
      /idempotencyKey/,
    );
  });

  it("rejects non-integer amounts before touching the adapter", async () => {
    const adapter = new FakeAdapter();
    const service = new PaymentService({ adapters: [adapter] });
    await expectInvalidRequest(
      service.createPaymentSession("fake", { ...baseInput, amount: 10.99 }),
      /minor units/,
    );
    expect(adapter.calls.length).toBe(0);
  });

  it("enforces manual-capture / verification / partial-refund capabilities", async () => {
    // Capability-driven omission: FakeAdapter only implements methods whose
    // flags are on, so this stays coherent (refunds on -> retrieveRefund on).
    const limited = new FakeAdapter({
      pspName: "limited",
      capabilities: {
        supportsManualCapture: false,
        supportsMultiCapture: false,
        supportsPaymentMethodVerification: false,
        supportsPartialRefunds: false,
      },
    });
    const service = new PaymentService({ adapters: [limited] });
    await expectUnsupported(
      service.createPaymentSession("limited", { ...baseInput, captureMethod: "manual" }),
      /manual capture/,
    );
    await expectUnsupported(service.capturePayment("limited", "p1", 500, "k"), /manual capture/);
    await expectUnsupported(
      service.createPaymentSession("limited", { ...baseInput, amount: 0 }),
      /verification/,
    );
    await expectUnsupported(
      service.verifyPaymentMethod("limited", { pspSessionId: "s1", idempotencyKey: "k" }),
      /verification/,
    );
    await expectUnsupported(
      service.refundPayment("limited", { pspPaymentId: "p1", amount: 100, idempotencyKey: "k" }),
      /partial refunds/,
    );
    // Full refund (no amount) is still allowed.
    const refund = await service.refundPayment("limited", { pspPaymentId: "p1", idempotencyKey: "k" });
    expect(refund.status).toBe("succeeded");
  });

  it("rejects completePayment for confirm-on-client adapters and routes it for tokenize-first ones", async () => {
    const stripeish = new FakeAdapter({ pspName: "stripeish" });
    const paysafeish = new FakeAdapter({
      pspName: "paysafeish",
      capabilities: { requiresServerCompletion: true },
    });
    const service = new PaymentService({ adapters: [stripeish, paysafeish] });
    await expectUnsupported(
      service.completePayment("stripeish", { pspSessionId: "s", clientToken: "t", idempotencyKey: "k" }),
      /completes payments on the client/,
    );
    const info = await service.completePayment("paysafeish", {
      pspSessionId: "s1",
      clientToken: "tok",
      idempotencyKey: "k",
    });
    expect(info.pspPaymentId).toBe("s1");
  });
});

describe("PaymentService error normalization", () => {
  it("wraps adapter rejections into PayFanoutError with pspName, preserving raw", async () => {
    const adapter = new FakeAdapter({ pspName: "flaky" });
    const boom = new Error("socket hangup");
    adapter.retrievePayment = async () => {
      throw boom;
    };
    const service = new PaymentService({ adapters: [adapter] });
    try {
      await service.retrievePayment("flaky", "p1");
      expect.unreachable();
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.pspName).toBe("flaky");
        expect(err.raw).toBe(boom);
      }
    }
  });

  it("backfills pspName when an adapter throws a PayFanoutError without one", async () => {
    const adapter = new FakeAdapter({ pspName: "flaky" });
    const anonymous = new PayFanoutError({
      code: "card_declined",
      message: "Declined",
      retryable: false,
      raw: { decline_code: "do_not_honor" },
    });
    adapter.retrievePayment = async () => {
      throw anonymous;
    };
    const service = new PaymentService({ adapters: [adapter] });
    try {
      await service.retrievePayment("flaky", "p1");
      expect.unreachable();
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.pspName).toBe("flaky");
        expect(err.code).toBe("card_declined");
        expect(err.message).toBe("Declined");
        expect(err.retryable).toBe(false);
        expect(err.raw).toBe(anonymous.raw);
        expect(err.stack).toBe(anonymous.stack);
        expect(err.toJSON()).toEqual({
          name: "PayFanoutError",
          code: "card_declined",
          message: "Declined",
          retryable: false,
          pspName: "flaky",
        });
      }
    }
  });

  it("lets adapter-produced PayFanoutErrors pass through untouched", async () => {
    const adapter = new FakeAdapter({ pspName: "flaky" });
    const declined = new PayFanoutError({
      code: "card_declined",
      message: "Declined",
      retryable: false,
      raw: { decline_code: "generic_decline" },
      pspName: "flaky",
    });
    adapter.retrievePayment = async () => {
      throw declined;
    };
    const service = new PaymentService({ adapters: [adapter] });
    await expect(service.retrievePayment("flaky", "p1")).rejects.toBe(declined);
  });
});

describe("PaymentService session screening (shared predicate with PaymentRouter)", () => {
  it("rejects sessions restricted to method types the adapter does not support, before any PSP call", async () => {
    const adapter = new FakeAdapter({});
    const service = new PaymentService({ adapters: [adapter] });
    await expect(
      service.createPaymentSession("fake", {
        amount: 1000,
        currency: "USD",
        idempotencyKey: "k",
        paymentMethodTypes: ["ideal"],
      }),
    ).rejects.toMatchObject({ code: "unsupported_operation", pspName: "fake" });
    expect(adapter.calls.filter((c) => c.method === "createPaymentSession")).toHaveLength(0);
  });
});
