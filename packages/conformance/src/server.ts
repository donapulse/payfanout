import { describe, expect, it } from "vitest";
import {
  isPayFanoutError,
  isUnifiedPaymentStatus,
  PAYMENT_METHOD_FLOWS,
  PAYMENT_METHOD_TYPES,
  WEBHOOK_EVENT_TYPES,
  type CompletePaymentInput,
  type CreatePaymentSessionInput,
  type PaymentSession,
  type ServerPaymentAdapter,
  type UnifiedErrorCode,
  type UnifiedWebhookEventType,
} from "@payfanout/core";

/**
 * The contract every ServerPaymentAdapter — present or future — must pass.
 * This is what makes "extensible" verifiable rather than aspirational: a new
 * PSP ships by writing an adapter package that passes this suite, with zero
 * changes to core or to consuming applications.
 */
export interface ServerConformanceFixtures {
  /** Fresh, valid input for a 2-decimal-currency session (e.g. USD/EUR). */
  createSessionInput(): CreatePaymentSessionInput;
  /** Proves zero-decimal handling (e.g. JPY). Strongly recommended. */
  zeroDecimalSessionInput?(): CreatePaymentSessionInput;
  /** Proves three-decimal handling (e.g. BHD). Strongly recommended. */
  threeDecimalSessionInput?(): CreatePaymentSessionInput;

  webhook: {
    /** Exact raw body bytes as the PSP would send them, signature-matching validHeaders. */
    validRawBody: string;
    validHeaders: Record<string, string>;
    expectedType: UnifiedWebhookEventType;
    expectedEventId: string;
  };

  /** Failure paths — each must reject with PayFanoutError, raw PSP error preserved. */
  failingCalls: Array<{
    name: string;
    invoke(adapter: ServerPaymentAdapter): Promise<unknown>;
    expectedCode?: UnifiedErrorCode;
  }>;

  /** Idempotency-replay: same key twice -> same result, exactly one side effect. */
  idempotency?: {
    run(adapter: ServerPaymentAdapter, key: string): Promise<[unknown, unknown]>;
    sideEffectCount(): number;
  };

  /** Required when the adapter reports requiresServerCompletion. */
  completePayment?: {
    input(session: PaymentSession): CompletePaymentInput;
  };

  /**
   * Required when the adapter reports supportsSavedPaymentMethods: drives the
   * vault round-trip (create customer -> save -> list -> charge twice -> delete).
   */
  vault?: {
    /** Fresh single-use clientToken for savePaymentMethod (tokenize-first PSPs). */
    clientToken?(): Promise<string> | string;
    /**
     * Confirm-on-client PSPs (no savePaymentMethod method): given a customer
     * id, produce a stored token by whatever save-during-checkout simulation
     * the fake supports.
     */
    storedToken?(adapter: ServerPaymentAdapter, pspCustomerId: string): Promise<string>;
  };
}

export function runServerAdapterConformanceTests(
  name: string,
  makeAdapter: () => ServerPaymentAdapter,
  fixtures: ServerConformanceFixtures,
): void {
  describe(`server adapter conformance: ${name}`, () => {
    it("reports coherent capabilities", () => {
      const adapter = makeAdapter();
      const caps = adapter.getCapabilities();
      expect(caps.pspName).toBe(adapter.pspName);
      expect(adapter.pspName.length).toBeGreaterThan(0);
      // Vaulting is PSP-side only; claiming it demands the full surface.
      if (caps.supportsSavedPaymentMethods) {
        expect(typeof adapter.createCustomer).toBe("function");
        expect(typeof adapter.listSavedPaymentMethods).toBe("function");
        expect(typeof adapter.deleteSavedPaymentMethod).toBe("function");
        expect(typeof adapter.chargeSavedPaymentMethod).toBe("function");
        if (caps.requiresServerCompletion) expect(typeof adapter.savePaymentMethod).toBe("function");
      }
      if (caps.supportsPartialRefunds) expect(caps.supportsRefunds).toBe(true);
      if (caps.requiresServerCompletion) expect(typeof adapter.completePayment).toBe("function");
      if (caps.supportsManualCapture) expect(typeof adapter.capturePayment).toBe("function");
      if (caps.supportsMultiCapture) expect(caps.supportsManualCapture).toBe(true);
      if (caps.supportsPaymentMethodVerification) {
        expect(typeof adapter.verifyPaymentMethod).toBe("function");
      }
      // Pending refunds must be pollable — refund support implies retrieveRefund.
      if (caps.supportsRefunds) expect(typeof adapter.retrieveRefund).toBe("function");
      if (caps.supportsSessionUpdate) expect(typeof adapter.updatePaymentSession).toBe("function");
      if (caps.supportsEventPolling) expect(typeof adapter.fetchEvents).toBe("function");
      if (caps.supportsListing) {
        expect(typeof adapter.listPayments).toBe("function");
        expect(typeof adapter.listRefunds).toBe("function");
      }
      expect(caps.paymentMethods.length).toBeGreaterThan(0);
      for (const method of caps.paymentMethods) {
        expect(PAYMENT_METHOD_TYPES).toContain(method.type);
        expect(PAYMENT_METHOD_FLOWS).toContain(method.flow);
        expect(typeof method.supported).toBe("boolean");
      }
    });

    it("updates a session and hands back a usable session (when supported)", async () => {
      const adapter = makeAdapter();
      if (!adapter.getCapabilities().supportsSessionUpdate) return;
      const input = fixtures.createSessionInput();
      const session = await adapter.createPaymentSession(input);
      const newAmount = input.amount + 100;
      const updated = await adapter.updatePaymentSession!({
        pspSessionId: session.pspSessionId,
        amount: newAmount,
        idempotencyKey: `conformance-${name}-update`,
      });
      expect(updated.pspName).toBe(adapter.pspName);
      expect(updated.amount).toBe(newAmount);
      expect(updated.currency.toUpperCase()).toBe(session.currency.toUpperCase());
      expect(updated.pspSessionId.length).toBeGreaterThan(0);
      expect(isUnifiedPaymentStatus(updated.status)).toBe(true);
    });

    it("vault round-trip: customer -> save -> list -> charge twice -> delete (when supported)", async () => {
      const adapter = makeAdapter();
      if (!adapter.getCapabilities().supportsSavedPaymentMethods) return;
      expect(fixtures.vault, "supportsSavedPaymentMethods adapters must supply vault fixtures").toBeDefined();

      const customer = await adapter.createCustomer!({
        id: `conformance-user-${name}`,
        email: "vault@conformance.test",
        idempotencyKey: `conformance-${name}-cust`,
      });
      expect(customer.pspName).toBe(adapter.pspName);
      expect(customer.pspCustomerId.length).toBeGreaterThan(0);

      // Save: tokenize-first PSPs convert a client token; others use the fixture's simulation.
      let token: string;
      if (adapter.savePaymentMethod && fixtures.vault!.clientToken) {
        const saved = await adapter.savePaymentMethod({
          pspCustomerId: customer.pspCustomerId,
          clientToken: await fixtures.vault!.clientToken(),
          idempotencyKey: `conformance-${name}-save`,
        });
        expect(saved.pspCustomerId).toBe(customer.pspCustomerId);
        expect(saved.token.length).toBeGreaterThan(0);
        token = saved.token;
      } else {
        token = await fixtures.vault!.storedToken!(adapter, customer.pspCustomerId);
      }

      const listed = await adapter.listSavedPaymentMethods!(customer.pspCustomerId);
      expect(listed.map((m) => m.token)).toContain(token);
      for (const method of listed) {
        expect(method.pspName).toBe(adapter.pspName);
        expect(PAYMENT_METHOD_TYPES).toContain(method.paymentMethodType);
      }

      // The recurring proof: two off-session charges, no client involved.
      const first = await adapter.chargeSavedPaymentMethod!({
        pspCustomerId: customer.pspCustomerId,
        savedPaymentMethodToken: token,
        amount: 1200,
        currency: fixtures.createSessionInput().currency,
        occurrence: "initial",
        idempotencyKey: `conformance-${name}-charge1`,
      });
      expect(first.status).toBe("succeeded");
      expect(first.amount).toBe(1200);
      const second = await adapter.chargeSavedPaymentMethod!({
        pspCustomerId: customer.pspCustomerId,
        savedPaymentMethodToken: token,
        amount: 1200,
        currency: fixtures.createSessionInput().currency,
        idempotencyKey: `conformance-${name}-charge2`,
      });
      expect(second.status).toBe("succeeded");
      expect(second.pspPaymentId).not.toBe(first.pspPaymentId);

      await adapter.deleteSavedPaymentMethod!(customer.pspCustomerId, token);
      const afterDelete = await adapter.listSavedPaymentMethods!(customer.pspCustomerId);
      expect(afterDelete.map((m) => m.token)).not.toContain(token);
    });

    it("fetchEvents returns normalized, dedupe-keyed events (when supported)", async () => {
      const adapter = makeAdapter();
      if (!adapter.getCapabilities().supportsEventPolling) return;
      const result = await adapter.fetchEvents!({ limit: 10 });
      expect(Array.isArray(result.events)).toBe(true);
      for (const event of result.events) {
        expect(event.pspName).toBe(adapter.pspName);
        expect(event.id.length).toBeGreaterThan(0);
        expect(WEBHOOK_EVENT_TYPES).toContain(event.type);
        expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
      }
    });

    const sessionCases: Array<[string, (() => CreatePaymentSessionInput) | undefined]> = [
      ["2-decimal currency", fixtures.createSessionInput.bind(fixtures)],
      ["zero-decimal currency (e.g. JPY)", fixtures.zeroDecimalSessionInput?.bind(fixtures)],
      ["three-decimal currency (e.g. BHD)", fixtures.threeDecimalSessionInput?.bind(fixtures)],
    ];
    for (const [label, makeInput] of sessionCases) {
      it.skipIf(!makeInput)(`createPaymentSession keeps integer minor units at the boundary — ${label}`, async () => {
        const adapter = makeAdapter();
        const input = makeInput!();
        const session = await adapter.createPaymentSession(input);
        expect(session.pspName).toBe(adapter.pspName);
        expect(session.pspSessionId.length).toBeGreaterThan(0);
        expect(Number.isSafeInteger(session.amount)).toBe(true);
        expect(session.amount).toBe(input.amount); // adapter converts internally, never at the boundary
        expect(session.currency.toUpperCase()).toBe(input.currency.toUpperCase());
        expect(isUnifiedPaymentStatus(session.status)).toBe(true);
        if (input.id) expect(session.id).toBe(input.id);
        else expect(session.id.length).toBeGreaterThan(0);
      });
    }

    it("completes tokenize-first payments via completePayment", async () => {
      const adapter = makeAdapter();
      const caps = adapter.getCapabilities();
      if (!caps.requiresServerCompletion) return; // confirm-on-client PSP: nothing to do
      expect(fixtures.completePayment, "requiresServerCompletion adapters must supply completePayment fixtures").toBeDefined();
      const session = await adapter.createPaymentSession(fixtures.createSessionInput());
      const info = await adapter.completePayment!(fixtures.completePayment!.input(session));
      expect(info.pspName).toBe(adapter.pspName);
      expect(isUnifiedPaymentStatus(info.status)).toBe(true);
      expect(Number.isSafeInteger(info.amount)).toBe(true);
      expect(Number.isSafeInteger(info.amountRefunded)).toBe(true);
    });

    describe("webhooks operate on the raw body", () => {
      it("accepts the genuine raw body", async () => {
        const adapter = makeAdapter();
        const { validRawBody, validHeaders } = fixtures.webhook;
        await expect(adapter.verifyWebhookSignature(validRawBody, validHeaders)).resolves.toBe(true);
      });

      it("rejects a re-serialized body (same JSON value, different bytes)", async () => {
        // Fails for any adapter that parses then re-serializes before verifying —
        // the exact bug express.json()-style middlewares induce.
        const adapter = makeAdapter();
        const { validRawBody, validHeaders } = fixtures.webhook;
        const reserialized = JSON.stringify(JSON.parse(validRawBody), null, 2);
        expect(reserialized).not.toBe(validRawBody);
        await expect(adapter.verifyWebhookSignature(reserialized, validHeaders)).resolves.toBe(false);
      });

      it("rejects tampered content and missing signature headers", async () => {
        const adapter = makeAdapter();
        const { validRawBody, validHeaders } = fixtures.webhook;
        const tampered = validRawBody.replace(/\d/, (d) => String((Number(d) + 1) % 10));
        await expect(adapter.verifyWebhookSignature(tampered, validHeaders)).resolves.toBe(false);
        await expect(adapter.verifyWebhookSignature(validRawBody, {})).resolves.toBe(false);
      });

      it("parses to a normalized event with a stable dedupe id", async () => {
        const adapter = makeAdapter();
        const { validRawBody, validHeaders, expectedEventId, expectedType } = fixtures.webhook;
        const first = await adapter.parseWebhookEvent(validRawBody, validHeaders);
        const second = await adapter.parseWebhookEvent(validRawBody, validHeaders);
        expect(first.id).toBe(expectedEventId);
        expect(second.id).toBe(first.id); // stable across parses — usable as dedupe key
        expect(first.pspName).toBe(adapter.pspName);
        expect(first.type).toBe(expectedType);
        expect(WEBHOOK_EVENT_TYPES).toContain(first.type);
        expect(Number.isNaN(Date.parse(first.occurredAt))).toBe(false);
        expect(first.raw).toBeDefined();
      });

      it("throws PayFanoutError invalid_request on unparseable payloads", async () => {
        const adapter = makeAdapter();
        try {
          await adapter.parseWebhookEvent("this is not json", fixtures.webhook.validHeaders);
          expect.unreachable("expected rejection");
        } catch (err) {
          expect(isPayFanoutError(err)).toBe(true);
          if (isPayFanoutError(err)) expect(err.code).toBe("invalid_request");
        }
      });
    });

    describe("error normalization", () => {
      for (const failing of fixtures.failingCalls) {
        it(`${failing.name} rejects with PayFanoutError, raw preserved`, async () => {
          const adapter = makeAdapter();
          try {
            await failing.invoke(adapter);
            expect.unreachable("expected rejection");
          } catch (err) {
            expect(isPayFanoutError(err), `expected PayFanoutError, got ${String(err)}`).toBe(true);
            if (isPayFanoutError(err)) {
              expect(err.raw, "raw PSP error must never be dropped").toBeDefined();
              if (failing.expectedCode) expect(err.code).toBe(failing.expectedCode);
            }
          }
        });
      }
    });

    it.skipIf(!fixtures.idempotency)(
      "replays idempotently: same key twice -> same result, one side effect",
      async () => {
        const adapter = makeAdapter();
        const [first, second] = await fixtures.idempotency!.run(adapter, `conformance-${name}-idem`);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        expect(fixtures.idempotency!.sideEffectCount()).toBe(1);
      },
    );
  });
}
