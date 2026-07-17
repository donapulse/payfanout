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
    const noNativeSubscriptions = { list: false, retrieve: false, create: false, cancel: false };
    const allOff = {
      supportsManualCapture: false,
      supportsMultiCapture: false,
      supportsPaymentMethodVerification: false,
      supportsRefunds: false,
      supportsPartialRefunds: false,
      supportsSessionUpdate: false,
      supportsEventPolling: false,
      supportsListing: false,
      nativeSubscriptions: noNativeSubscriptions,
    };
    for (const [claim, message] of [
      [{ supportsSessionUpdate: true }, /does not implement updatePaymentSession/],
      [{ supportsEventPolling: true }, /does not implement fetchEvents/],
      [{ supportsListing: true }, /does not implement listPayments/],
      [{ supportsRefunds: true }, /does not implement retrieveRefund/],
      [
        { nativeSubscriptions: { ...noNativeSubscriptions, list: true } },
        /does not implement listNativeSubscriptions/,
      ],
      [
        { nativeSubscriptions: { ...noNativeSubscriptions, retrieve: true } },
        /does not implement retrieveNativeSubscription/,
      ],
      [
        { nativeSubscriptions: { ...noNativeSubscriptions, create: true } },
        /does not implement createNativeSubscription/,
      ],
      [
        { nativeSubscriptions: { ...noNativeSubscriptions, cancel: true } },
        /does not implement cancelNativeSubscription/,
      ],
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

describe("PaymentService native-subscription surface", () => {
  const NO_NATIVE = { list: false, retrieve: false, create: false, cancel: false };

  it("routes create -> retrieve -> list (paged) -> cancel to the adapter", async () => {
    const adapter = new FakeAdapter();
    const service = new PaymentService({ adapters: [adapter] });

    const created = await service.createNativeSubscription("fake", {
      savedPaymentMethodToken: "tok_1",
      amount: 1500,
      currency: "usd",
      interval: "month",
      intervalCount: 3,
      idempotencyKey: "k1",
    });
    expect(created.status).toBe("active");
    expect(created.currency).toBe("USD");
    expect(created.interval).toBe("month");

    const second = await service.createNativeSubscription("fake", {
      savedPaymentMethodToken: "tok_2",
      amount: 900,
      currency: "USD",
      schedule: "FREQ=MONTHLY;BYMONTHDAY=15",
      idempotencyKey: "k2",
    });
    expect(second.schedule).toBe("FREQ=MONTHLY;BYMONTHDAY=15");

    const retrieved = await service.retrieveNativeSubscription("fake", { subscriptionId: created.id });
    expect(retrieved.id).toBe(created.id);

    const page1 = await service.listNativeSubscriptions("fake", { limit: 1 });
    expect(page1.subscriptions).toHaveLength(1);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await service.listNativeSubscriptions("fake", { limit: 1, cursor: page1.nextCursor! });
    expect(page2.subscriptions[0]!.id).not.toBe(page1.subscriptions[0]!.id);

    const canceled = await service.cancelNativeSubscription("fake", {
      subscriptionId: created.id,
      idempotencyKey: "k3",
    });
    expect(canceled.status).toBe("canceled");
    // Verified-idempotent: a replayed cancel resolves as success, still terminal.
    const replayed = await service.cancelNativeSubscription("fake", {
      subscriptionId: created.id,
      idempotencyKey: "k4",
    });
    expect(replayed.status).toBe("canceled");
  });

  it("guards each operation behind its own capability flag", async () => {
    const none = new FakeAdapter({ pspName: "none", capabilities: { nativeSubscriptions: NO_NATIVE } });
    // PayZen-shaped: everything but list.
    const noList = new FakeAdapter({
      pspName: "no-list",
      capabilities: { nativeSubscriptions: { ...NO_NATIVE, retrieve: true, create: true, cancel: true } },
    });
    const service = new PaymentService({ adapters: [none, noList] });

    await expectUnsupported(service.listNativeSubscriptions("none"), /listing native subscriptions/);
    await expectUnsupported(
      service.retrieveNativeSubscription("none", { subscriptionId: "s1" }),
      /retrieving native subscriptions/,
    );
    await expectUnsupported(
      service.createNativeSubscription("none", {
        savedPaymentMethodToken: "t",
        amount: 100,
        currency: "USD",
        interval: "month",
        idempotencyKey: "k",
      }),
      /creating native subscriptions/,
    );
    await expectUnsupported(
      service.cancelNativeSubscription("none", { subscriptionId: "s1", idempotencyKey: "k" }),
      /canceling native subscriptions/,
    );

    await expectUnsupported(service.listNativeSubscriptions("no-list"), /listing native subscriptions/);
    const record = await service.createNativeSubscription("no-list", {
      savedPaymentMethodToken: "t",
      amount: 100,
      currency: "USD",
      interval: "month",
      idempotencyKey: "k",
    });
    expect(record.status).toBe("active");
  });

  it("validates create input: amount, cadence exclusivity, intervalCount, startAt, key", async () => {
    const service = new PaymentService({ adapters: [new FakeAdapter()] });
    const base = {
      savedPaymentMethodToken: "t",
      amount: 100,
      currency: "USD",
      interval: "month",
      idempotencyKey: "k",
    } as const;

    await expectInvalidRequest(
      service.createNativeSubscription("fake", { ...base, amount: 10.5 }),
      /minor units/,
    );
    await expectInvalidRequest(
      service.createNativeSubscription("fake", { ...base, amount: 0 }),
      /positive amount/,
    );
    await expectInvalidRequest(
      service.createNativeSubscription("fake", { ...base, interval: undefined }),
      /requires a billing cadence/,
    );
    await expectInvalidRequest(
      service.createNativeSubscription("fake", { ...base, schedule: "FREQ=MONTHLY" }),
      /not both/,
    );
    await expectInvalidRequest(
      service.createNativeSubscription("fake", {
        ...base,
        interval: undefined,
        schedule: "FREQ=MONTHLY",
        intervalCount: 2,
      }),
      /intervalCount requires interval/,
    );
    await expectInvalidRequest(
      service.createNativeSubscription("fake", { ...base, intervalCount: 0 }),
      /positive integer/,
    );
    await expectInvalidRequest(
      service.createNativeSubscription("fake", { ...base, intervalCount: 1.5 }),
      /positive integer/,
    );
    await expectInvalidRequest(
      service.createNativeSubscription("fake", { ...base, startAt: "not-a-date" }),
      /ISO 8601/,
    );
    await expectInvalidRequest(
      service.createNativeSubscription("fake", { ...base, idempotencyKey: " " }),
      /idempotencyKey/,
    );
    await expectInvalidRequest(
      service.cancelNativeSubscription("fake", { subscriptionId: "s", idempotencyKey: "" }),
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
