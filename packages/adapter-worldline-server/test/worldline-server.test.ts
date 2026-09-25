import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  getRefundState,
  getUserMessage,
  isPayFanoutError,
  type PayFanoutError,
  type ServerPaymentAdapter,
  type UnifiedErrorCode,
} from "@payfanout/core";
import { runServerAdapterConformanceTests } from "@payfanout/conformance";
import {
  encodeSessionContext,
  worldlineOnboarding,
  WorldlineServerAdapter,
  type WorldlineApiError,
  type WorldlineServerAdapterConfig,
} from "../src/index.js";
import { FakeWorldlineApi } from "./fake-worldline-api.js";

const SIGNING_KEY = "session-signing-key";
const WEBHOOK_KEY_ID = "wh-key-1";
const WEBHOOK_SECRET = "webhook-secret";

function makePair(config: Partial<WorldlineServerAdapterConfig> = {}): {
  adapter: WorldlineServerAdapter;
  fake: FakeWorldlineApi;
} {
  const fake = new FakeWorldlineApi();
  const adapter = new WorldlineServerAdapter({
    apiKeyId: "api-key-id",
    secretApiKey: "secret-api-key",
    merchantId: "mid-1",
    environment: "sandbox",
    sessionSigningKey: SIGNING_KEY,
    webhookKeys: [{ keyId: WEBHOOK_KEY_ID, secretKey: WEBHOOK_SECRET }],
    defaultReturnUrl: "https://host.example/default-return",
    fetch: fake.fetch,
    ...config,
  });
  return { adapter, fake };
}

function signedWebhook(body: object): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify(body);
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf8").digest("base64");
  return { rawBody, headers: { "x-gcs-signature": signature, "x-gcs-keyid": WEBHOOK_KEY_ID } };
}

const webhookFixture = signedWebhook({
  apiVersion: "v1",
  id: "evt_wl_1",
  created: "2026-07-14T10:00:00Z",
  merchantId: "mid-1",
  type: "payment.captured",
  payment: {
    id: "pay_wl_42",
    status: "CAPTURED",
    statusOutput: { statusCode: 9, statusCategory: "COMPLETED" },
    paymentOutput: { amountOfMoney: { amount: 1099, currencyCode: "EUR" } },
  },
});

// A real-but-unmapped Worldline event type (payment links are out of scope).
const unknownWebhookFixture = signedWebhook({
  apiVersion: "v1",
  id: "evt_wl_pl",
  created: "2026-07-14T10:00:01Z",
  merchantId: "mid-1",
  type: "paymentlink.created",
  paymentLink: { paymentLinkId: "pl_1" },
});

/** Tokenize-first completion of a fresh session — how every "money moved" fixture starts. */
async function completedPayment(
  adapter: ServerPaymentAdapter,
  input: { amount: number; id?: string; metadata?: Record<string, string>; captureMethod?: "automatic" | "manual" },
): Promise<string> {
  const key = `money-${Math.random().toString(36).slice(2)}`;
  const session = await adapter.createPaymentSession({
    amount: input.amount,
    currency: "EUR",
    ...(input.id ? { id: input.id } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.captureMethod ? { captureMethod: input.captureMethod } : {}),
    idempotencyKey: `${key}-session`,
  });
  const info = await adapter.completePayment!({
    pspSessionId: session.pspSessionId,
    clientToken: `htp_${key}`,
    idempotencyKey: `${key}-complete`,
  });
  return info.pspPaymentId;
}

// ---------------------------------------------------------------------------
// The same conformance contract every adapter passes.
// ---------------------------------------------------------------------------
let lastFake: FakeWorldlineApi;
runServerAdapterConformanceTests(
  "worldline",
  () => {
    const { adapter, fake } = makePair();
    lastFake = fake;
    return adapter;
  },
  {
    onboarding: worldlineOnboarding,
    createSessionInput: () => ({ amount: 1099, currency: "EUR", idempotencyKey: `key-${Math.random()}` }),
    zeroDecimalSessionInput: () => ({ amount: 500, currency: "JPY", idempotencyKey: `key-${Math.random()}` }),
    threeDecimalSessionInput: () => ({ amount: 1234, currency: "BHD", idempotencyKey: `key-${Math.random()}` }),
    webhook: {
      validRawBody: webhookFixture.rawBody,
      validHeaders: webhookFixture.headers,
      expectedType: "payment.succeeded",
      expectedEventId: "worldline:payment.captured:pay_wl_42",
      expectedAmount: 1099,
      unknownEvent: { rawBody: unknownWebhookFixture.rawBody, headers: unknownWebhookFixture.headers },
    },
    money: {
      completedPayment: (adapter, input) => completedPayment(adapter, input),
      authorizedPayment: (adapter, input) => completedPayment(adapter, { amount: input.amount, captureMethod: "manual" }),
      cancelablePayment: (adapter) => completedPayment(adapter, { amount: 1500, captureMethod: "manual" }),
      // The host id round-trips via order.references.merchantReference (idRoundTrip),
      // but Worldline has no arbitrary metadata map (metadataEcho false).
      expectations: { idRoundTrip: true, metadataEcho: false },
    },
    failingCalls: [
      {
        name: "retrievePayment on a missing id",
        invoke: (a) => a.retrievePayment!("pay_missing"),
        expectedCode: "invalid_request",
      },
      {
        name: "completePayment with no clientToken",
        invoke: async (a) => {
          const session = await a.createPaymentSession({ amount: 100, currency: "EUR", idempotencyKey: "k" });
          return a.completePayment!({ pspSessionId: session.pspSessionId, clientToken: "", idempotencyKey: "k2" });
        },
        expectedCode: "invalid_request",
      },
      {
        name: "completePayment with a tampered session context",
        invoke: async (a) => {
          const session = await a.createPaymentSession({ amount: 100, currency: "EUR", idempotencyKey: "k" });
          const [payload, signature] = session.pspSessionId.split(".");
          const inflated = Buffer.from(
            JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), amount: 1 }),
          ).toString("base64url");
          return a.completePayment!({
            pspSessionId: `${inflated}.${signature}`,
            clientToken: "htp_ok",
            idempotencyKey: "k2",
          });
        },
        expectedCode: "invalid_request",
      },
      {
        name: "completePayment when the card is declined",
        invoke: async (a) => {
          const session = await a.createPaymentSession({ amount: 1302, currency: "EUR", idempotencyKey: "k" });
          return a.completePayment!({ pspSessionId: session.pspSessionId, clientToken: "htp_ok", idempotencyKey: "k3" });
        },
        expectedCode: "card_declined",
      },
      {
        name: "completePayment with an expired session context",
        invoke: async (a) => {
          const expired = await encodeSessionContext(
            { v: 1, amount: 100, currency: "EUR", captureMethod: "automatic", hostedTokenizationId: "htp_x", expiresAt: Date.now() - 1 },
            SIGNING_KEY,
          );
          return a.completePayment!({ pspSessionId: expired, clientToken: "htp_ok", idempotencyKey: "k4" });
        },
        expectedCode: "session_expired",
      },
    ],
    idempotency: {
      run: async (adapter, key) => {
        const session = await adapter.createPaymentSession({ amount: 555, currency: "EUR", idempotencyKey: `${key}-s` });
        const input = { pspSessionId: session.pspSessionId, clientToken: "htp_ok", idempotencyKey: key };
        const first = await adapter.completePayment!(input);
        const second = await adapter.completePayment!(input);
        return [first, second];
      },
      sideEffectCount: () => lastFake.uniquePaymentCreations,
    },
    completePayment: {
      input: (session) => ({
        pspSessionId: session.pspSessionId,
        clientToken: "htp_ok",
        idempotencyKey: "conf-complete-1",
      }),
    },
  },
);

// ---------------------------------------------------------------------------
// Worldline-specific behavior.
// ---------------------------------------------------------------------------
describe("WorldlineServerAdapter specifics", () => {
  it("creates a session against Hosted Tokenization and carries a signed self-contained context", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      id: "order-9",
      amount: 2500,
      currency: "EUR",
      captureMethod: "manual",
      metadata: { plan: "pro" },
      idempotencyKey: "k",
    });
    expect(fake.uniquePaymentCreations).toBe(0); // tokenize-first: no payment exists yet
    expect(session.clientSecret).toMatch(/hostedtokenization/);
    expect(session.status).toBe("requires_payment_method");
    expect(session.metadata).toEqual({ plan: "pro" });
    expect(session.pspSessionId).not.toBe(session.clientSecret); // the token is not the iframe URL
  });

  it("completePayment sends the SALE/PRE_AUTHORIZATION shape /payments accepts and round-trips the host id", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      id: "order-77",
      amount: 2500,
      currency: "EUR",
      returnUrl: "https://host.example/return",
      billingDetails: { address: { line1: "1 Way", city: "Brussels", postalCode: "1000", country: "BE" } },
      idempotencyKey: "k",
    });
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "htp_handle_1",
      idempotencyKey: "complete-1",
    });
    expect(info.status).toBe("succeeded"); // SALE -> captured
    expect(info.id).toBe("order-77"); // via order.references.merchantReference
    expect(info.amountCaptured).toBe(2500);
    expect(info.paymentMethodDetails).toMatchObject({ brand: "visa", last4: "4675" });
    const body = fake.lastCreatePaymentBody as Record<string, Record<string, unknown>>;
    // hostedTokenizationId is a ROOT CreatePayment property; the return URL is
    // sent in both documented forms.
    expect(body["hostedTokenizationId"]).toBe("htp_handle_1");
    expect(body["cardPaymentMethodSpecificInput"]).toMatchObject({
      authorizationMode: "SALE",
      returnUrl: "https://host.example/return",
      threeDSecure: { redirectionData: { returnUrl: "https://host.example/return" } },
    });
    expect(body["cardPaymentMethodSpecificInput"]).not.toHaveProperty("hostedTokenizationId");
    expect(body["order"]).toMatchObject({
      amountOfMoney: { amount: 2500, currencyCode: "EUR" },
      references: { merchantReference: "order-77" },
      customer: { billingAddress: { street: "1 Way", city: "Brussels", zip: "1000", countryCode: "BE" } },
    });
  });

  it("runs the manual flow: authorize -> requires_capture -> capture -> succeeded", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ amount: 4000, currency: "EUR", captureMethod: "manual", idempotencyKey: "k" });
    const authorized = await adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: "htp_1", idempotencyKey: "c1" });
    expect(authorized.status).toBe("requires_capture");
    expect(authorized.amountCaptured).toBe(0);
    expect(authorized.amountCapturable).toBe(4000);

    const captured = await adapter.capturePayment(authorized.pspPaymentId, 4000, "cap-1");
    expect(captured.status).toBe("succeeded");
    expect(captured.amountCaptured).toBe(4000);
    expect(captured.amountCapturable).toBe(0);
  });

  it("finalizes a partial capture, releases the remainder, and refunds the captured amount", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ amount: 5000, currency: "EUR", captureMethod: "manual", idempotencyKey: "k" });
    const authorized = await adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: "htp_1", idempotencyKey: "c1" });
    const captured = await adapter.capturePayment(authorized.pspPaymentId, 2000, "cap-1");
    expect(captured.status).toBe("succeeded");
    expect(captured.amountCaptured).toBe(2000);
    expect(captured.amountCapturable).toBe(0); // the uncaptured remainder is released
    // Referenced refunds are accepted once the capture is finalized.
    const refund = await adapter.refundPayment({ pspPaymentId: authorized.pspPaymentId, amount: 2000, idempotencyKey: "r1" });
    expect(refund.status).toBe("succeeded");
    const info = await adapter.retrievePayment(authorized.pspPaymentId);
    expect(info.amountRefunded).toBe(2000);
    expect(info.amountCapturable).toBe(0);
  });

  it("surfaces a 3-D Secure challenge as requires_action with the redirect URL on raw", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 3200,
      currency: "EUR",
      returnUrl: "https://host.example/return",
      idempotencyKey: "k",
    });
    const info = await adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: "htp_3ds", idempotencyKey: "c1" });
    expect(info.status).toBe("requires_action");
    const raw = info.raw as { merchantAction?: { redirectData?: { redirectURL?: string } } };
    expect(raw.merchantAction?.redirectData?.redirectURL).toContain("3ds");
  });

  it("cancels an authorized-but-uncaptured payment", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ amount: 4000, currency: "EUR", captureMethod: "manual", idempotencyKey: "k" });
    const authorized = await adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: "htp_1", idempotencyKey: "c1" });
    const canceled = await adapter.cancelPayment(authorized.pspPaymentId, "void-1");
    expect(canceled.status).toBe("canceled");
  });

  it("refunds partially then fully and derives refund state", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ amount: 5000, currency: "EUR", idempotencyKey: "k" });
    const paid = await adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: "htp_1", idempotencyKey: "c1" });

    const partial = await adapter.refundPayment({ pspPaymentId: paid.pspPaymentId, amount: 1500, idempotencyKey: "r1" });
    expect(partial.status).toBe("succeeded");
    let info = await adapter.retrievePayment(paid.pspPaymentId);
    expect(info.amountRefunded).toBe(1500);
    expect(getRefundState(info)).toBe("partial");

    await adapter.refundPayment({ pspPaymentId: paid.pspPaymentId, idempotencyKey: "r2" });
    info = await adapter.retrievePayment(paid.pspPaymentId);
    expect(getRefundState(info)).toBe("full");
  });

  it("polls a pending refund through the per-payment refund list via the composite id", async () => {
    const { adapter, fake } = makePair();
    fake.seedRefund("pay_seeded", { id: "ref_pending", status: "REFUND_REQUESTED", refundOutput: { amountOfMoney: { amount: 2500, currencyCode: "EUR" } } });
    const info = await adapter.retrieveRefund("pay_seeded:ref_pending");
    expect(info.refundId).toBe("pay_seeded:ref_pending"); // stable for re-polling
    expect(info.pspPaymentId).toBe("pay_seeded");
    expect(info.status).toBe("pending");
    expect(info.amount).toBe(2500);
  });

  it("returns a composite refund id that retrieveRefund resolves, and rejects a bare Worldline id", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ amount: 3000, currency: "EUR", idempotencyKey: "k" });
    const paid = await adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: "htp_1", idempotencyKey: "c1" });
    const refund = await adapter.refundPayment({ pspPaymentId: paid.pspPaymentId, amount: 1000, idempotencyKey: "r1" });
    expect(refund.refundId).toBe(`${paid.pspPaymentId}:${(refund.raw as { id: string }).id}`);
    const polled = await adapter.retrieveRefund(refund.refundId);
    expect(polled.status).toBe("succeeded");
    expect(polled.amount).toBe(1000);
    expect(polled.pspPaymentId).toBe(paid.pspPaymentId);
    // A raw Worldline refund id (e.g. straight off a webhook) is not resolvable
    // without its payment — the composite format is required and documented.
    await expect(adapter.retrieveRefund("ref_1")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("self-heals a 409 idempotence replay (original still in flight) by retrying", async () => {
    const fake = new FakeWorldlineApi();
    let conflicts = 1;
    const adapter = new WorldlineServerAdapter({
      apiKeyId: "api-key-id",
      secretApiKey: "secret-api-key",
      merchantId: "mid-1",
      environment: "sandbox",
      sessionSigningKey: SIGNING_KEY,
      webhookKeys: [{ keyId: WEBHOOK_KEY_ID, secretKey: WEBHOOK_SECRET }],
      defaultReturnUrl: "https://host.example/default-return",
      sleep: async () => {},
      fetch: async (input, init) => {
        if (conflicts > 0 && init?.method === "POST" && String(input).endsWith("/payments")) {
          conflicts--;
          return new Response(JSON.stringify({ errorId: "dup", errors: [{ code: "1409", message: "request in progress", httpStatusCode: 409 }] }), { status: 409 });
        }
        return fake.fetch(input, init);
      },
    });
    const session = await adapter.createPaymentSession({ amount: 2000, currency: "EUR", idempotencyKey: "k" });
    const info = await adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: "htp_1", idempotencyKey: "c1" });
    expect(info.status).toBe("succeeded");
    expect(conflicts).toBe(0);
  });

  it("verifyCredentials classifies auth, network, and success", async () => {
    const ok = makePair();
    await expect(ok.adapter.verifyCredentials!()).resolves.toEqual({ ok: true });

    const bad = makePair();
    bad.fake.authFailure = true;
    await expect(bad.adapter.verifyCredentials!()).resolves.toMatchObject({ ok: false, category: "auth" });

    const down = makePair();
    down.fake.networkFailure = true;
    await expect(down.adapter.verifyCredentials!()).resolves.toMatchObject({ ok: false, category: "network" });
  });

  it("maps HTTP 5xx unavailability onto the retryable taxonomy", async () => {
    const { adapter } = makePair({
      fetch: async () =>
        new Response(JSON.stringify({ errorId: "x", errors: [{ code: "9999", message: "boom" }] }), { status: 503 }),
    });
    try {
      await adapter.retrievePayment("pay_1");
      expect.unreachable();
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("psp_unavailable");
        expect(err.retryable).toBe(true);
        expect(err.pspName).toBe("worldline");
      }
    }
  });

  it("retries a 5xx or a 429 as transport trouble even when it carries a decline code", async () => {
    const cases: Array<[number, UnifiedErrorCode]> = [
      [503, "psp_unavailable"],
      [429, "rate_limited"],
    ];
    for (const [status, expected] of cases) {
      let calls = 0;
      const { adapter } = makePair({
        sleep: async () => {},
        fetch: async () => {
          calls++;
          const errors = [{ errorCode: "30511001", httpStatusCode: status, message: "x" }];
          return new Response(JSON.stringify({ errorId: "x", errors }), { status });
        },
      });
      await expect(adapter.retrievePayment("pay_1")).rejects.toMatchObject({ code: expected, retryable: true });
      expect(calls).toBe(3); // the first attempt and both transport retries
    }
  });
});

describe("a 2xx CreatePayment carrying a REJECTED payment", () => {
  function apiError(fields: Partial<WorldlineApiError>): WorldlineApiError {
    return { category: "PAYMENT_PLATFORM_ERROR", httpStatusCode: 402, message: "Authorisation declined", retriable: false, ...fields };
  }

  async function rejectedCompletion(
    rejection: { errors?: WorldlineApiError[] },
  ): Promise<{ error: PayFanoutError | undefined; fake: FakeWorldlineApi }> {
    const { adapter, fake } = makePair();
    fake.rejectPayment = rejection;
    const session = await adapter.createPaymentSession({ amount: 2500, currency: "EUR", idempotencyKey: "session-rejected" });
    const error = await adapter
      .completePayment({ pspSessionId: session.pspSessionId, clientToken: "htp_rejected", idempotencyKey: "complete-rejected" })
      .then(() => undefined, (err: unknown) => err as PayFanoutError);
    return { error, fake };
  }

  const cases: Array<[string, UnifiedErrorCode]> = [
    ["30431001", "fraud_suspected"],
    ["30001140", "fraud_suspected"],
    ["30141001", "invalid_card_data"],
    ["30331001", "expired_card"],
    ["30511001", "insufficient_funds"],
    ["40001139", "authentication_required"],
    ["40001135", "processing_error"],
    ["50001087", "invalid_request"],
    ["30051001", "card_declined"],
    ["99999999", "card_declined"],
  ];
  for (const [errorCode, expected] of cases) {
    it(`maps statusOutput error ${errorCode} -> ${expected}, never retryable, with the whole response on raw`, async () => {
      const errors = [apiError({ errorCode })];
      const { error, fake } = await rejectedCompletion({ errors });
      expect(isPayFanoutError(error)).toBe(true);
      expect(error).toMatchObject({ code: expected, retryable: false, pspName: "worldline" });
      expect(error?.message).toBe(getUserMessage(expected));
      expect(error?.raw).toEqual({
        creationOutput: { tokens: "" },
        payment: expect.objectContaining({
          status: "REJECTED",
          statusOutput: { statusCode: 2, statusCategory: "UNSUCCESSFUL", errors },
        }),
      });
      expect(fake.uniquePaymentCreations).toBe(1);
    });
  }

  it("reads an undocumented code with a 4xx other than 402 as a refused request, not a decline", async () => {
    const invalidValue = { errorCode: "50001066", id: "INVALID_VALUE", category: "PAYMENT_PLATFORM_ERROR", httpStatusCode: 400 };
    const refused = await rejectedCompletion({ errors: [invalidValue] });
    expect(refused.error).toMatchObject({ code: "invalid_request", retryable: false });
    const declined = await rejectedCompletion({ errors: [{ ...invalidValue, httpStatusCode: 402 }] });
    expect(declined.error).toMatchObject({ code: "card_declined", retryable: false });
  });

  it("falls back to the deprecated code when the error carries no errorCode", async () => {
    const { error } = await rejectedCompletion({ errors: [{ code: "30411001", httpStatusCode: 402 }] });
    expect(error).toMatchObject({ code: "fraud_suspected", retryable: false });
  });

  it("is a plain decline when the payment reports no error, or an empty list", async () => {
    for (const rejection of [{}, { errors: [] }]) {
      const { error } = await rejectedCompletion(rejection);
      expect(error).toMatchObject({ code: "card_declined", retryable: false, message: getUserMessage("card_declined") });
      expect(error?.raw).toMatchObject({ payment: { status: "REJECTED" } });
    }
  });

  it("answers a completion replayed under its key with the same rejection, however the card would fare now", async () => {
    const { adapter, fake } = makePair();
    fake.rejectPayment = { errors: [apiError({ errorCode: "30431001" })] };
    const session = await adapter.createPaymentSession({ amount: 2500, currency: "EUR", idempotencyKey: "session-stolen" });
    const input = { pspSessionId: session.pspSessionId, clientToken: "htp_stolen", idempotencyKey: "complete-stolen" };
    const first = await adapter.completePayment(input).then(() => undefined, (err: unknown) => err);
    fake.rejectPayment = undefined;
    const second = await adapter.completePayment(input).then(() => undefined, (err: unknown) => err);
    expect(first).toMatchObject({ code: "fraud_suspected", retryable: false });
    expect(second).toMatchObject({ code: "fraud_suspected", retryable: false });
    expect(fake.uniquePaymentCreations).toBe(1);
  });
});
