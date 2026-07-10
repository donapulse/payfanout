import { describe, expect, it } from "vitest";
import {
  getRefundState,
  isPayFanoutError,
  isUnifiedPaymentStatus,
  PAYMENT_METHOD_FLOWS,
  PAYMENT_METHOD_TYPES,
  REFUND_STATUSES,
  WEBHOOK_EVENT_TYPES,
  type AdapterOnboardingDescriptor,
  type CompletePaymentInput,
  type CreatePaymentSessionInput,
  type MinorUnitAmount,
  type PaymentSession,
  type ServerPaymentAdapter,
  type UnifiedErrorCode,
  type UnifiedWebhookEventType,
  validateAdapterCapabilities,
  validateOnboardingDescriptor,
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
    /** Asserted against the parsed event's normalized `amount`, when the payload carries one. */
    expectedAmount?: MinorUnitAmount;
    /** A correctly SIGNED delivery of an event type the adapter does not recognize. */
    unknownEvent?: { rawBody: string; headers: Record<string, string> };
  };

  /**
   * Money-path fixtures against the adapter's fake backend. REQUIRED —
   * refunds, capture, and cancel are where broken adapters cost real money,
   * so they are proven at the contract level, not left to per-adapter
   * discipline: `completedPayment` whenever supportsRefunds,
   * `authorizedPayment` whenever supportsManualCapture, `cancelablePayment`
   * always (every PSP has a pre-completion state).
   */
  money?: {
    /**
     * Creates a COMPLETED payment (money moved) of `input.amount`, carrying
     * the host `input.id` and `input.metadata`; resolves its pspPaymentId.
     */
    completedPayment?(
      adapter: ServerPaymentAdapter,
      input: { amount: MinorUnitAmount; id: string; metadata: Record<string, string> },
    ): Promise<string>;
    /** An authorized, NOT yet captured payment of `input.amount` (manual capture PSPs). */
    authorizedPayment?(adapter: ServerPaymentAdapter, input: { amount: MinorUnitAmount }): Promise<string>;
    /** A payment in a cancelable (pre-completion / pre-capture) state. */
    cancelablePayment?(adapter: ServerPaymentAdapter): Promise<string>;
    /**
     * Honesty flags for documented PSP limitations (default true): set
     * idRoundTrip false when the PSP has no field to carry the host id,
     * metadataEcho false when metadata cannot be read back on retrieve.
     */
    expectations?: { idRoundTrip?: boolean; metadataEcho?: boolean };
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
   * The adapter's exported onboarding descriptor. When provided, the suite
   * asserts it is well-formed and consistent with the adapter (pspName match,
   * credential fields, webhook events, CSP hosts) via validateOnboardingDescriptor.
   */
  onboarding?: AdapterOnboardingDescriptor;

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
      // The full flag/surface rule table lives in core — the same one
      // @payfanout/server enforces at registration, so the two cannot drift.
      expect(validateAdapterCapabilities(adapter)).toEqual([]);
      expect(adapter.pspName.length).toBeGreaterThan(0);
      expect(caps.paymentMethods.length).toBeGreaterThan(0);
      for (const method of caps.paymentMethods) {
        expect(PAYMENT_METHOD_TYPES).toContain(method.type);
        expect(PAYMENT_METHOD_FLOWS).toContain(method.flow);
        expect(typeof method.supported).toBe("boolean");
      }
      // supportedCurrencies is a router pre-screen input — malformed codes
      // would silently disable a PSP for every payment.
      for (const currency of caps.supportedCurrencies ?? []) {
        expect(currency).toMatch(/^[A-Z]{3}$/);
      }
    });

    if (fixtures.onboarding) {
      const onboarding = fixtures.onboarding;
      it("ships a valid onboarding descriptor consistent with its config", () => {
        expect(validateOnboardingDescriptor(onboarding, makeAdapter())).toEqual([]);
      });
    }

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

    it("supplies money fixtures for its money capabilities", () => {
      const caps = makeAdapter().getCapabilities();
      expect(fixtures.money, "every adapter must supply money fixtures").toBeDefined();
      expect(fixtures.money!.cancelablePayment, "cancelPayment is a required method — supply cancelablePayment").toBeDefined();
      if (caps.supportsRefunds) expect(fixtures.money!.completedPayment).toBeDefined();
      if (caps.supportsManualCapture) expect(fixtures.money!.authorizedPayment).toBeDefined();
    });

    describe.skipIf(!fixtures.money)("money paths", () => {
      it.skipIf(!fixtures.money?.completedPayment)(
        "retrievePayment reports the normalized money truth",
        async () => {
          const adapter = makeAdapter();
          const id = `conformance-${name}-retrieve`;
          const pspPaymentId = await fixtures.money!.completedPayment!(adapter, {
            amount: 3000,
            id,
            metadata: { conformance_key: "v1" },
          });
          const info = await adapter.retrievePayment(pspPaymentId);
          expect(info.pspName).toBe(adapter.pspName);
          expect(isUnifiedPaymentStatus(info.status)).toBe(true);
          expect(info.amount).toBe(3000);
          expect(Number.isSafeInteger(info.amountRefunded)).toBe(true);
          expect(info.amountRefunded).toBe(0);
          expect(PAYMENT_METHOD_TYPES).toContain(info.paymentMethodType);
          expect(Number.isNaN(Date.parse(info.createdAt))).toBe(false);
          expect(info.raw).toBeDefined();
          if (fixtures.money!.expectations?.idRoundTrip !== false) expect(info.id).toBe(id);
          if (fixtures.money!.expectations?.metadataEcho !== false) {
            expect(info.metadata).toMatchObject({ conformance_key: "v1" });
          }
        },
      );

      it.skipIf(!fixtures.money?.completedPayment)("refunds the full amount and reports it", async () => {
        const adapter = makeAdapter();
        if (!adapter.getCapabilities().supportsRefunds) return;
        const pspPaymentId = await fixtures.money!.completedPayment!(adapter, {
          amount: 2500,
          id: `conformance-${name}-refund-full`,
          metadata: {},
        });
        const refund = await adapter.refundPayment({
          pspPaymentId,
          idempotencyKey: `conformance-${name}-refund-full-key`,
        });
        expect(REFUND_STATUSES).toContain(refund.status);
        expect(refund.status).not.toBe("failed");
        expect(refund.refundId.length).toBeGreaterThan(0);
        expect(refund.amount).toBe(2500);
        expect(refund.raw).toBeDefined();
        if (refund.status === "pending") {
          // Async rails: the refund must be pollable to a terminal state.
          const polled = await adapter.retrieveRefund!(refund.refundId);
          expect(polled.refundId).toBe(refund.refundId);
          expect(REFUND_STATUSES).toContain(polled.status);
          expect(polled.amount).toBe(2500);
        } else {
          const info = await adapter.retrievePayment(pspPaymentId);
          expect(info.amountRefunded).toBe(2500);
          expect(getRefundState(info)).toBe("full");
        }
      });

      it.skipIf(!fixtures.money?.completedPayment)(
        "partial refunds accumulate and over-refunds reject",
        async () => {
          const adapter = makeAdapter();
          if (!adapter.getCapabilities().supportsPartialRefunds) return;
          const pspPaymentId = await fixtures.money!.completedPayment!(adapter, {
            amount: 3000,
            id: `conformance-${name}-refund-partial`,
            metadata: {},
          });
          const first = await adapter.refundPayment({
            pspPaymentId,
            amount: 1000,
            idempotencyKey: `conformance-${name}-refund-p1`,
          });
          expect(first.amount).toBe(1000);
          expect(first.status).not.toBe("failed");
          if (first.status === "succeeded") {
            const info = await adapter.retrievePayment(pspPaymentId);
            expect(info.amountRefunded).toBe(1000);
            expect(getRefundState(info)).toBe("partial");
          }
          // More than the remainder must reject — money out can never exceed money in.
          try {
            await adapter.refundPayment({
              pspPaymentId,
              amount: 2500,
              idempotencyKey: `conformance-${name}-refund-over`,
            });
            expect.unreachable("expected over-refund rejection");
          } catch (err) {
            expect(isPayFanoutError(err), `expected PayFanoutError, got ${String(err)}`).toBe(true);
            if (isPayFanoutError(err)) expect(err.raw).toBeDefined();
          }
        },
      );

      it.skipIf(!fixtures.money?.authorizedPayment)(
        "captures an authorization and reports amountCaptured",
        async () => {
          const adapter = makeAdapter();
          if (!adapter.getCapabilities().supportsManualCapture) return;
          const pspPaymentId = await fixtures.money!.authorizedPayment!(adapter, { amount: 4000 });
          const captured = await adapter.capturePayment!(
            pspPaymentId,
            4000,
            `conformance-${name}-capture`,
          );
          expect(isUnifiedPaymentStatus(captured.status)).toBe(true);
          expect(captured.status).not.toBe("failed");
          expect(captured.amountCaptured).toBe(4000);
        },
      );

      it.skipIf(!fixtures.money?.authorizedPayment)(
        "multi-capture settles partial amounts under distinct keys",
        async () => {
          const adapter = makeAdapter();
          if (!adapter.getCapabilities().supportsMultiCapture) return;
          const pspPaymentId = await fixtures.money!.authorizedPayment!(adapter, { amount: 5000 });
          await adapter.capturePayment!(pspPaymentId, 2000, `conformance-${name}-mcap-1`);
          await adapter.capturePayment!(pspPaymentId, 1500, `conformance-${name}-mcap-2`);
          const info = await adapter.retrievePayment(pspPaymentId);
          expect(info.amountCaptured).toBe(3500);
        },
      );

      it.skipIf(!fixtures.money?.cancelablePayment)(
        "cancels an uncompleted payment cleanly",
        async () => {
          const adapter = makeAdapter();
          const pspPaymentId = await fixtures.money!.cancelablePayment!(adapter);
          const info = await adapter.cancelPayment(pspPaymentId, `conformance-${name}-cancel`);
          expect(info.pspName).toBe(adapter.pspName);
          expect(info.status).toBe("canceled");
        },
      );
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
        if (fixtures.webhook.expectedAmount !== undefined) {
          expect(first.amount).toBe(fixtures.webhook.expectedAmount);
        }
      });

      it.skipIf(!fixtures.webhook.unknownEvent)(
        'maps unknown-but-valid event types to "unknown" instead of throwing',
        async () => {
          const adapter = makeAdapter();
          const { rawBody, headers } = fixtures.webhook.unknownEvent!;
          await expect(adapter.verifyWebhookSignature(rawBody, headers)).resolves.toBe(true);
          const event = await adapter.parseWebhookEvent(rawBody, headers);
          expect(event.type).toBe("unknown");
          expect(event.id.length).toBeGreaterThan(0);
          expect(event.raw).toBeDefined();
        },
      );

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
              // The documented retryable semantics — the router's cascade and
              // withRetry both act on this flag, so per-PSP drift breaks them.
              if (err.code === "authentication_required") {
                expect(err.retryable, "authentication_required is resolved on-session, never by replay").toBe(false);
              }
              if (err.code === "rate_limited" || err.code === "psp_unavailable") {
                expect(err.retryable, `${err.code} must be retryable`).toBe(true);
              }
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
