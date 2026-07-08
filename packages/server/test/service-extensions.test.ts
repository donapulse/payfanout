import { describe, expect, it } from "vitest";
import { isPayFanoutError, PayFanoutError } from "@payfanout/core";
import { PaymentService, type PaymentOperationTelemetry } from "../src/index.js";
import { FakeAdapter } from "./fake-adapter.js";

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

describe("PaymentService — refund lifecycle / session update / recovery passthroughs", () => {
  it("routes retrieveRefund and updatePaymentSession to the adapter", async () => {
    const adapter = new FakeAdapter();
    const service = new PaymentService({ adapters: [adapter] });

    const refund = await service.retrieveRefund("fake", "re_9");
    expect(refund.refundId).toBe("re_9");

    const updated = await service.updatePaymentSession("fake", {
      pspSessionId: "sess_1",
      amount: 2500,
      idempotencyKey: "k-upd",
    });
    expect(updated.amount).toBe(2500);
    expect(adapter.calls.map((c) => c.method)).toEqual(["retrieveRefund", "updatePaymentSession"]);
  });

  it("guards updatePaymentSession: capability, amount integrity, idempotency key", async () => {
    const noUpdate = new FakeAdapter({ pspName: "no-upd", capabilities: { supportsSessionUpdate: false } });
    const service = new PaymentService({ adapters: [noUpdate, new FakeAdapter()] });
    await expectUnsupported(
      service.updatePaymentSession("no-upd", { pspSessionId: "s", amount: 1, idempotencyKey: "k" }),
      /does not support updating/,
    );
    await expectInvalidRequest(
      service.updatePaymentSession("fake", { pspSessionId: "s", amount: 10.5, idempotencyKey: "k" }),
      /minor units/,
    );
    await expectInvalidRequest(
      service.updatePaymentSession("fake", { pspSessionId: "s", amount: 100, idempotencyKey: " " }),
      /idempotencyKey/,
    );
  });

  it("guards retrieveRefund behind refund support", async () => {
    const noRefunds = new FakeAdapter({
      pspName: "no-ref",
      capabilities: { supportsRefunds: false, supportsPartialRefunds: false },
    });
    const service = new PaymentService({ adapters: [noRefunds] });
    await expectUnsupported(service.retrieveRefund("no-ref", "re_1"), /refund retrieval/);
  });

  it("routes fetchEvents / listPayments / listRefunds and guards their capabilities", async () => {
    const full = new FakeAdapter();
    const bare = new FakeAdapter({
      pspName: "bare",
      capabilities: { supportsEventPolling: false, supportsListing: false },
    });
    const service = new PaymentService({ adapters: [full, bare] });

    expect((await service.fetchEvents("fake", { limit: 5 })).events).toEqual([]);
    expect((await service.listPayments("fake")).payments).toHaveLength(1);
    expect((await service.listRefunds("fake")).refunds).toEqual([]);

    await expectUnsupported(service.fetchEvents("bare"), /event polling/);
    await expectUnsupported(service.listPayments("bare"), /listing payments/);
    await expectUnsupported(service.listRefunds("bare"), /listing refunds/);
  });

  it("rejects registration when new capability claims lack implementations", () => {
    const allOff = {
      supportsManualCapture: false,
      supportsMultiCapture: false,
      supportsPaymentMethodVerification: false,
      supportsRefunds: false,
      supportsPartialRefunds: false,
      supportsSessionUpdate: false,
      supportsEventPolling: false,
      supportsListing: false,
    };
    for (const [claim, message] of [
      [{ supportsSessionUpdate: true }, /does not implement updatePaymentSession/],
      [{ supportsEventPolling: true }, /does not implement fetchEvents/],
      [{ supportsListing: true }, /does not implement listPayments/],
      [{ supportsRefunds: true }, /does not implement retrieveRefund/],
    ] as const) {
      const adapter = new FakeAdapter({
        capabilities: { ...allOff, ...claim },
        omitOptionalMethods: true,
      });
      expect(() => new PaymentService({ adapters: [adapter] }), JSON.stringify(claim)).toThrowError(message);
    }
  });

  it("rejects multi-capture claims without manual capture", () => {
    const incoherent = new FakeAdapter({
      capabilities: { supportsManualCapture: false, supportsMultiCapture: true },
    });
    expect(() => new PaymentService({ adapters: [incoherent] })).toThrowError(
      /multi-capture without manual capture/,
    );
  });
});

describe("PaymentService vault surface", () => {
  it("routes the full vault lifecycle and guards non-vaulting adapters", async () => {
    const vaulting = new FakeAdapter({
      pspName: "vaulting",
      capabilities: { supportsSavedPaymentMethods: true, requiresServerCompletion: true },
    });
    const plain = new FakeAdapter({ pspName: "plain" });
    const service = new PaymentService({ adapters: [vaulting, plain] });

    const customer = await service.createCustomer("vaulting", { id: "u1", idempotencyKey: "k1" });
    const saved = await service.savePaymentMethod("vaulting", {
      pspCustomerId: customer.pspCustomerId,
      clientToken: "tok_1",
      idempotencyKey: "k2",
    });
    expect((await service.listSavedPaymentMethods("vaulting", customer.pspCustomerId)).map((m) => m.token)).toEqual([
      saved.token,
    ]);
    const charged = await service.chargeSavedPaymentMethod("vaulting", {
      pspCustomerId: customer.pspCustomerId,
      savedPaymentMethodToken: saved.token,
      amount: 2500,
      currency: "USD",
      idempotencyKey: "k3",
    });
    expect(charged.amount).toBe(2500);
    await service.deleteSavedPaymentMethod("vaulting", customer.pspCustomerId, saved.token);
    expect(await service.listSavedPaymentMethods("vaulting", customer.pspCustomerId)).toEqual([]);

    for (const call of [
      () => service.createCustomer("plain", { idempotencyKey: "k" }),
      () => service.listSavedPaymentMethods("plain", "c1"),
      () => service.deleteSavedPaymentMethod("plain", "c1", "t"),
      () =>
        service.chargeSavedPaymentMethod("plain", {
          pspCustomerId: "c1",
          savedPaymentMethodToken: "t",
          amount: 100,
          currency: "USD",
          idempotencyKey: "k",
        }),
    ]) {
      await expectUnsupported(call(), /does not support saved payment methods/);
    }
  });

  it("savePaymentMethod on a confirm-on-client PSP points at the session flag instead", async () => {
    const checkoutVaulting = new FakeAdapter({
      pspName: "checkout-vaulting",
      capabilities: { supportsSavedPaymentMethods: true }, // requiresServerCompletion: false
    });
    // Confirm-on-client adapters have no savePaymentMethod (coherence allows that).
    checkoutVaulting.savePaymentMethod = undefined;
    const service = new PaymentService({ adapters: [checkoutVaulting] });
    await expectUnsupported(
      service.savePaymentMethod("checkout-vaulting", { pspCustomerId: "c", clientToken: "t", idempotencyKey: "k" }),
      /vaults during checkout/,
    );
  });

  it("guards session-level save flags and charge validation", async () => {
    const vaulting = new FakeAdapter({
      pspName: "vaulting",
      capabilities: { supportsSavedPaymentMethods: true },
    });
    const plain = new FakeAdapter({ pspName: "plain" });
    const service = new PaymentService({ adapters: [vaulting, plain] });

    await expectUnsupported(
      service.createPaymentSession("plain", {
        amount: 100,
        currency: "USD",
        savePaymentMethod: true,
        customer: "c1",
        idempotencyKey: "k",
      }),
      /does not support saved payment methods/,
    );
    await expectInvalidRequest(
      service.createPaymentSession("vaulting", {
        amount: 100,
        currency: "USD",
        savePaymentMethod: true,
        idempotencyKey: "k",
      }),
      /requires `customer`/,
    );
    await expectInvalidRequest(
      service.chargeSavedPaymentMethod("vaulting", {
        pspCustomerId: "c",
        savedPaymentMethodToken: "t",
        amount: 0,
        currency: "USD",
        idempotencyKey: "k",
      }),
      /positive amount/,
    );
    await expectInvalidRequest(
      service.chargeSavedPaymentMethod("vaulting", {
        pspCustomerId: "c",
        savedPaymentMethodToken: "t",
        amount: 100,
        currency: "USD",
        idempotencyKey: "  ",
      }),
      /idempotencyKey/,
    );
  });
});

describe("PaymentService telemetry", () => {
  it("emits one metadata-only record per operation, success and failure, with durations from the injected clock", async () => {
    const records: PaymentOperationTelemetry[] = [];
    const adapter = new FakeAdapter();
    let tick = 1000;
    const service = new PaymentService({
      adapters: [adapter],
      telemetry: (record) => records.push(record),
      now: () => (tick += 25),
    });

    await service.createPaymentSession("fake", { amount: 100, currency: "USD", idempotencyKey: "k1" });
    await service.retrievePayment("fake", "p1");

    adapter.refundPayment = async () => {
      throw new Error("psp exploded");
    };
    await service
      .refundPayment("fake", { pspPaymentId: "p1", idempotencyKey: "k2" })
      .catch(() => undefined);

    expect(records).toEqual([
      { pspName: "fake", operation: "createPaymentSession", durationMs: 25, ok: true },
      { pspName: "fake", operation: "retrievePayment", durationMs: 25, ok: true },
      { pspName: "fake", operation: "refundPayment", durationMs: 25, ok: false, errorCode: "unknown" },
    ]);
  });

  it("propagates the unified error code of failed operations", async () => {
    const records: PaymentOperationTelemetry[] = [];
    const adapter = new FakeAdapter();
    adapter.retrievePayment = async () => {
      throw new PayFanoutError({ code: "rate_limited", message: "slow down", retryable: true });
    };
    const service = new PaymentService({ adapters: [adapter], telemetry: (r) => records.push(r) });
    await service.retrievePayment("fake", "p1").catch(() => undefined);
    expect(records[0]).toMatchObject({ operation: "retrievePayment", ok: false, errorCode: "rate_limited" });
  });

  it("a throwing telemetry hook never breaks the payment path", async () => {
    const adapter = new FakeAdapter();
    const service = new PaymentService({
      adapters: [adapter],
      telemetry: () => {
        throw new Error("metrics backend down");
      },
    });
    const session = await service.createPaymentSession("fake", {
      amount: 100,
      currency: "USD",
      idempotencyKey: "k1",
    });
    expect(session.pspSessionId).toBe("psp_sess_1");
  });
});
