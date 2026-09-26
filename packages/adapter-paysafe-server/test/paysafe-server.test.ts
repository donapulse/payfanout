import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getRefundState, isPayFanoutError, utf8ToBase64Url, type ServerPaymentAdapter } from "@payfanout/core";
import { runServerAdapterConformanceTests } from "@payfanout/conformance";
import {
  decodeSessionContext,
  encodeSessionContext,
  paysafeOnboarding,
  PaysafeServerAdapter,
  type PaysafeServerAdapterConfig,
} from "../src/index.js";
import { FakePaysafeApi, SEEDED_MULTI_USE_TOKEN } from "./fake-paysafe-api.js";

const SIGNING_KEY = "session-signing-key";
const WEBHOOK_KEY = "webhook-hmac-key";

function makePair(config: Partial<PaysafeServerAdapterConfig> = {}): {
  adapter: PaysafeServerAdapter;
  fake: FakePaysafeApi;
} {
  const fake = new FakePaysafeApi();
  const adapter = new PaysafeServerAdapter({
    username: "api_user",
    password: "api_pass",
    environment: "sandbox",
    merchantAccountResolver: (currency, country) => `acct-${currency}-${country ?? "any"}`,
    sessionSigningKey: SIGNING_KEY,
    webhookHmacKey: WEBHOOK_KEY,
    fetch: fake.fetch,
    ...config,
  });
  return { adapter, fake };
}

function signedWebhook(body: object): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify(body);
  const signature = createHmac("sha256", WEBHOOK_KEY).update(rawBody, "utf8").digest("base64");
  return { rawBody, headers: { Signature: signature } };
}

// The documented delivery envelope: no event id, an attempt counter, the resource
// category in `type` and the event in `eventName`. Values are made up.
const WEBHOOK_PAYMENT_ID = "3f6c2a1e-7b4d-4c21-9a8e-2d5f0b6c9e14";
const webhookFixture = signedWebhook({
  payload: {
    accountId: "1001234567",
    id: WEBHOOK_PAYMENT_ID,
    merchantRefNum: "order-1",
    amount: 1099,
    currencyCode: "USD",
    status: "COMPLETED",
    txnTime: "2026-07-04T10:00:02Z",
    settleWithAuth: true,
  },
  attemptNumber: "1",
  type: "PAYMENT",
  resourceId: WEBHOOK_PAYMENT_ID,
  eventDate: "2026-07-04T10:00:02Z",
  eventName: "PAYMENT_COMPLETED",
});
// Paysafe sends no event id; the adapter derives one (see webhook.ts), recomputed here.
const webhookFixtureEventId = `paysafe_${createHash("sha256")
  .update(JSON.stringify(["PAYMENT_COMPLETED", WEBHOOK_PAYMENT_ID, "COMPLETED", "2026-07-04T10:00:02Z"]), "utf8")
  .digest("hex")}`;

// A documented event the adapter leaves unmapped: settlements are not payments.
const unknownWebhookFixture = signedWebhook({
  payload: {
    accountId: "1001234567",
    id: WEBHOOK_PAYMENT_ID,
    merchantRefNum: "order-1",
    amount: 1099,
    currencyCode: "USD",
    status: "COMPLETED",
    statusTime: "2026-07-05T02:00:00Z",
    txnTime: "2026-07-04T10:00:02Z",
  },
  attemptNumber: "1",
  type: "SETTLEMENT",
  eventDate: "2026-07-04T10:00:02Z",
  eventName: "SETTLEMENT_COMPLETED",
});

/** Tokenize-first completion of a fresh session — how every "money moved" fixture starts. */
async function completedPayment(
  adapter: ServerPaymentAdapter,
  input: { amount: number; id?: string; metadata?: Record<string, string>; captureMethod?: "automatic" | "manual" },
): Promise<string> {
  const key = `money-${Math.random().toString(36).slice(2)}`;
  const session = await adapter.createPaymentSession({
    amount: input.amount,
    currency: "USD",
    country: "US",
    ...(input.id ? { id: input.id } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.captureMethod ? { captureMethod: input.captureMethod } : {}),
    idempotencyKey: `${key}-session`,
  });
  const info = await adapter.completePayment!({
    pspSessionId: session.pspSessionId,
    clientToken: `tok_${key}`,
    idempotencyKey: `${key}-complete`,
  });
  return info.pspPaymentId;
}

// ---------------------------------------------------------------------------
// The exact same conformance contract the Stripe adapter passes.
// ---------------------------------------------------------------------------
let lastFake: FakePaysafeApi;
runServerAdapterConformanceTests(
  "paysafe",
  () => {
    const { adapter, fake } = makePair();
    lastFake = fake;
    return adapter;
  },
  {
    onboarding: paysafeOnboarding,
    createSessionInput: () => ({
      amount: 1099,
      currency: "USD",
      country: "US",
      idempotencyKey: `key-${Math.random()}`,
    }),
    zeroDecimalSessionInput: () => ({
      amount: 500,
      currency: "JPY",
      country: "JP",
      idempotencyKey: `key-${Math.random()}`,
    }),
    threeDecimalSessionInput: () => ({
      amount: 1234, // BHD 1.234 — Paysafe has no multiple-of-10 quirk; adapters differ, core does not
      currency: "BHD",
      country: "BH",
      idempotencyKey: `key-${Math.random()}`,
    }),
    webhook: {
      validRawBody: webhookFixture.rawBody,
      validHeaders: webhookFixture.headers,
      expectedType: "payment.succeeded",
      expectedEventId: webhookFixtureEventId,
      expectedAmount: 1099,
      unknownEvent: { rawBody: unknownWebhookFixture.rawBody, headers: unknownWebhookFixture.headers },
    },
    vault: {
      // Tokenize-first PSP: the client's single-use handle converts server-side.
      clientToken: () => `tok_single_${Math.random().toString(36).slice(2)}`,
    },
    nativeSubscriptions: {
      // The Payment Scheduler bills MULTI_USE tokens only; the fake pre-vaults
      // one so the fixture needs no customer/save round-trip of its own.
      createInput: () => ({
        savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
        amount: 1499,
        currency: "USD",
        interval: "month",
        idempotencyKey: `nsub-${Math.random().toString(36).slice(2)}`,
      }),
    },
    money: {
      completedPayment: (adapter, input) => completedPayment(adapter, input),
      authorizedPayment: (adapter, input) =>
        completedPayment(adapter, { amount: input.amount, captureMethod: "manual" }),
      cancelablePayment: (adapter) => completedPayment(adapter, { amount: 1500, captureMethod: "manual" }),
      // Documented Paysafe limitations: POST /payments strict-rejects extra
      // fields, so the host id and metadata live in the signed session token
      // only — neither survives onto the PSP object for retrievePayment.
      expectations: { idRoundTrip: false, metadataEcho: false },
    },
    failingCalls: [
      {
        name: "retrievePayment on a missing id",
        invoke: (a) => a.retrievePayment!("pay_missing"),
        expectedCode: "invalid_request",
      },
      {
        name: "completePayment with a tampered session context",
        invoke: async (a) => {
          const session = await a.createPaymentSession({ amount: 100, currency: "USD", idempotencyKey: "k" });
          const [payload] = session.pspSessionId.split(".");
          const inflated = Buffer.from(
            JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), amount: 1 }),
          ).toString("base64url");
          return a.completePayment!({
            pspSessionId: `${inflated}.${session.pspSessionId.split(".")[1]}`,
            clientToken: "tok_ok",
            idempotencyKey: "k2",
          });
        },
        expectedCode: "invalid_request",
      },
      {
        name: "completePayment when the card is declined",
        invoke: async (a) => {
          const session = await a.createPaymentSession({ amount: 100, currency: "USD", idempotencyKey: "k" });
          return a.completePayment!({ pspSessionId: session.pspSessionId, clientToken: "tok_declined", idempotencyKey: "k3" });
        },
        expectedCode: "insufficient_funds",
      },
      {
        name: "completePayment when the issuer requires Strong Customer Authentication (3060)",
        invoke: async (a) => {
          lastFake.recordFailure(
            { method: "POST", path: "/paymenthub/v1/payments" },
            {
              status: 402,
              code: "3060",
              message: "Your request has been declined because Strong Customer Authentication is required.",
            },
          );
          const session = await a.createPaymentSession({ amount: 100, currency: "USD", idempotencyKey: "k" });
          return a.completePayment!({ pspSessionId: session.pspSessionId, clientToken: "tok_sca", idempotencyKey: "k-sca" });
        },
        expectedCode: "authentication_required",
      },
      {
        name: "refundPayment of a SEPA Direct Debit, which Paysafe does not refund",
        invoke: async (a) => {
          const session = await a.createPaymentSession({
            amount: 1250,
            currency: "EUR",
            paymentMethodTypes: ["sepa_debit"],
            idempotencyKey: "k-sepa",
          });
          const paid = await a.completePayment!({
            pspSessionId: session.pspSessionId,
            clientToken: `paysafe-bank.${utf8ToBase64Url(
              JSON.stringify({
                v: 1,
                paymentType: "SEPA",
                accountHolderName: "Erik van Houten",
                iban: "NL77ABNA0492122466", // Paysafe's documented SEPA test IBAN
                mandateConsent: true,
              }),
            )}`,
            idempotencyKey: "k-sepa-complete",
          });
          return a.refundPayment({ pspPaymentId: paid.pspPaymentId, idempotencyKey: "k-sepa-refund" });
        },
        expectedCode: "unsupported_operation",
      },
      {
        name: "completePayment with an expired session context",
        invoke: async (a) => {
          const expired = await encodeSessionContext(
            { v: 1, amount: 100, currency: "USD", captureMethod: "automatic", expiresAt: Date.now() - 1 },
            SIGNING_KEY,
          );
          return a.completePayment!({ pspSessionId: expired, clientToken: "tok_ok", idempotencyKey: "k4" });
        },
        expectedCode: "session_expired",
      },
    ],
    idempotency: {
      run: async (adapter, key) => {
        const session = await adapter.createPaymentSession({ amount: 555, currency: "USD", idempotencyKey: `${key}-s` });
        const input = { pspSessionId: session.pspSessionId, clientToken: "tok_ok", idempotencyKey: key };
        const first = await adapter.completePayment!(input);
        const second = await adapter.completePayment!(input);
        return [first, second];
      },
      sideEffectCount: () => lastFake.uniquePaymentCreations,
    },
    completePayment: {
      input: (session) => ({
        pspSessionId: session.pspSessionId,
        clientToken: "tok_ok",
        idempotencyKey: "conf-complete-1",
      }),
    },
  },
);

// ---------------------------------------------------------------------------
// Paysafe-specific behavior.
// ---------------------------------------------------------------------------
describe("PaysafeServerAdapter specifics", () => {
  it("creates sessions without touching the PSP, carrying a signed self-contained context", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      id: "order-9",
      amount: 2500,
      currency: "EUR",
      country: "DE",
      captureMethod: "manual",
      webhookUrl: "https://host.example/webhooks/paysafe",
      metadata: { plan: "pro" },
      idempotencyKey: "k",
    });
    expect(fake.uniquePaymentCreations).toBe(0); // tokenize-first: nothing exists server-side yet
    const context = await decodeSessionContext(session.pspSessionId, SIGNING_KEY);
    expect(context).toMatchObject({
      amount: 2500,
      currency: "EUR",
      merchantAccountId: "acct-EUR-DE",
      captureMethod: "manual",
      webhookUrl: "https://host.example/webhooks/paysafe",
      id: "order-9",
    });
    expect(session.clientSecret).toBe(session.pspSessionId);
  });

  it("completePayment trusts only the signed context and sends exactly what /payments accepts", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 2500,
      currency: "EUR",
      country: "DE",
      webhookUrl: "https://host.example/webhooks/paysafe",
      returnUrl: "https://host.example/return",
      billingDetails: { address: { line1: "1 Way", city: "Berlin", postalCode: "10115", country: "DE" } },
      idempotencyKey: "k",
    });
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_handle_1",
      idempotencyKey: "complete-1",
    });
    expect(info.status).toBe("succeeded"); // settleWithAuth: automatic capture
    expect(info.amountCaptured).toBe(2500); // settled with the auth — fully captured
    expect(fake.lastRequestBody).toMatchObject({
      merchantRefNum: "complete-1",
      amount: 2500,
      currencyCode: "EUR",
      paymentHandleToken: "tok_handle_1",
      settleWithAuth: true,
      accountId: "acct-EUR-DE",
      // Zip rides the signed context onto /payments (Paysafe 3004 without it).
      billingDetails: { street: "1 Way", city: "Berlin", zip: "10115", country: "DE" },
    });
    // /payments strict-parses and rejects these two fields —
    // they live on the payment handle / in the portal, never on the payment.
    expect(fake.lastRequestBody).not.toHaveProperty("webhook");
    expect(fake.lastRequestBody).not.toHaveProperty("returnLinks");
  });

  it("runs the manual flow: authorize -> requires_capture -> capture -> succeeded", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 4000,
      currency: "USD",
      captureMethod: "manual",
      idempotencyKey: "k",
    });
    const authorized = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_1",
      idempotencyKey: "c1",
    });
    expect(authorized.status).toBe("requires_capture");
    expect(authorized.amountCaptured).toBe(0);
    expect(authorized.amountCapturable).toBe(4000);

    const captured = await adapter.capturePayment(authorized.pspPaymentId, 4000, "cap-1");
    expect(captured.status).toBe("succeeded");
    expect(captured.amountCaptured).toBe(4000);
    expect(captured.amountCapturable).toBe(0);
  });

  it("cancels an authorized-but-uncaptured payment via voidauths", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 4000,
      currency: "USD",
      captureMethod: "manual",
      idempotencyKey: "k",
    });
    const authorized = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_1",
      idempotencyKey: "c1",
    });
    const canceled = await adapter.cancelPayment(authorized.pspPaymentId, "void-1");
    expect(canceled.status).toBe("canceled");
  });

  it("resolves the settlement for refunds and derives partial/full refund state", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ amount: 5000, currency: "USD", idempotencyKey: "k" });
    const paid = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_1",
      idempotencyKey: "c1",
    });

    const partial = await adapter.refundPayment({ pspPaymentId: paid.pspPaymentId, amount: 1500, idempotencyKey: "r1" });
    expect(partial.status).toBe("succeeded");
    let info = await adapter.retrievePayment(paid.pspPaymentId);
    expect(info.amountRefunded).toBe(1500);
    expect(getRefundState(info)).toBe("partial");

    await adapter.refundPayment({ pspPaymentId: paid.pspPaymentId, idempotencyKey: "r2" });
    info = await adapter.retrievePayment(paid.pspPaymentId);
    expect(getRefundState(info)).toBe("full");
  });

  it("rejects refunds on authorized-but-unsettled payments with guidance", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 5000,
      currency: "USD",
      captureMethod: "manual",
      idempotencyKey: "k",
    });
    const authorized = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_1",
      idempotencyKey: "c1",
    });
    await expect(
      adapter.refundPayment({ pspPaymentId: authorized.pspPaymentId, idempotencyKey: "r1" }),
    ).rejects.toThrowError(/no refundable settlement/);
  });

  it("verifyPaymentMethod requires the clientToken (tokenize-first) and returns a zero-amount result", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 0, currency: "USD", idempotencyKey: "k" });
    await expect(
      adapter.verifyPaymentMethod({ pspSessionId: session.pspSessionId, idempotencyKey: "v1" }),
    ).rejects.toThrowError(/tokenize-first/);
    const info = await adapter.verifyPaymentMethod({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_verify",
      idempotencyKey: "v2",
    });
    // Paysafe 409s on verification refNum reuse — the caller key is the refNum.
    expect(fake.lastRequestBody).toMatchObject({ merchantRefNum: "v2" });
    expect(info.status).toBe("succeeded");
    expect(info.amount).toBe(0);
    expect(info.amountRefunded).toBe(0);
  });

  it("omits accountId entirely when the resolver has none (single-account API keys)", async () => {
    const { adapter, fake } = makePair({ merchantAccountResolver: () => undefined });
    const session = await adapter.createPaymentSession({ amount: 100, currency: "USD", idempotencyKey: "k" });
    await adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: "tok_1", idempotencyKey: "c1" });
    expect(fake.lastRequestBody).not.toHaveProperty("accountId"); // Paysafe routes by key + currency
  });

  it("tolerates undocumented dispute spellings and keeps unknown events, each with a stable id", async () => {
    // No Paysafe page documents a dispute webhook for the Payments API; these legacy
    // spellings (dotted, `eventType`) are parsed rather than dropped.
    const { adapter } = makePair();
    const body = JSON.stringify({ eventType: "PAYMENT.CHARGEBACK.OPENED", payload: { id: "pay_9" } });
    const chargeback = await adapter.parseWebhookEvent(body);
    expect(chargeback.type).toBe("payment.chargeback");
    expect(chargeback.pspPaymentId).toBe("pay_9");
    expect(chargeback.id).toMatch(/^paysafe_[0-9a-f]{64}$/);
    expect((await adapter.parseWebhookEvent(body)).id).toBe(chargeback.id);

    const exotic = await adapter.parseWebhookEvent(JSON.stringify({ eventType: "WALLET.SOMETHING.NEW" }));
    expect(exotic.type).toBe("unknown");
  });

  it("maps HTTP 402 declines and 5xx unavailability onto the taxonomy", async () => {
    const { adapter } = makePair({
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: "9999", message: "boom" } }), { status: 503 }),
    });
    try {
      await adapter.retrievePayment("pay_1");
      expect.unreachable();
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("psp_unavailable");
        expect(err.retryable).toBe(true);
        expect(err.pspName).toBe("paysafe");
      }
    }
  });
});
