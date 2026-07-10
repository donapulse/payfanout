import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getRefundState, isPayFanoutError, type ServerPaymentAdapter } from "@payfanout/core";
import { runServerAdapterConformanceTests } from "@payfanout/conformance";
import {
  decodeSessionContext,
  encodeSessionContext,
  paysafeOnboarding,
  PaysafeServerAdapter,
  type PaysafeServerAdapterConfig,
} from "../src/index.js";
import { FakePaysafeApi } from "./fake-paysafe-api.js";

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
  return { rawBody, headers: { signature } };
}

const webhookFixture = signedWebhook({
  id: "psf_evt_1",
  eventType: "PAYMENT.COMPLETED",
  txnTime: "2026-07-04T10:00:02Z",
  payload: { id: "pay_42", status: "COMPLETED", merchantRefNum: "order-1", amount: 1099, currencyCode: "USD" },
});

const unknownWebhookFixture = signedWebhook({
  id: "psf_evt_new",
  eventType: "WALLET.SOMETHING.NEW",
  txnTime: "2026-07-04T10:00:03Z",
  payload: { id: "obj_1" },
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
      expectedEventId: "psf_evt_1",
      expectedAmount: 1099,
      unknownEvent: { rawBody: unknownWebhookFixture.rawBody, headers: unknownWebhookFixture.headers },
    },
    vault: {
      // Tokenize-first PSP: the client's single-use handle converts server-side.
      clientToken: () => `tok_single_${Math.random().toString(36).slice(2)}`,
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
        invoke: (a) => a.retrievePayment("pay_missing"),
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

  it("maps chargeback-ish and exotic webhook events, hashing a stable id when Paysafe omits one", async () => {
    const { adapter } = makePair();
    const chargeback = await adapter.parseWebhookEvent(
      JSON.stringify({ eventType: "PAYMENT.CHARGEBACK.OPENED", payload: { id: "pay_9" } }),
    );
    expect(chargeback.type).toBe("payment.chargeback");
    expect(chargeback.pspPaymentId).toBe("pay_9");
    expect(chargeback.id).toMatch(/^paysafe_[0-9a-f]{64}$/);

    const again = await adapter.parseWebhookEvent(
      JSON.stringify({ eventType: "PAYMENT.CHARGEBACK.OPENED", payload: { id: "pay_9" } }),
    );
    expect(again.id).toBe(chargeback.id); // stable dedupe key from raw bytes

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
