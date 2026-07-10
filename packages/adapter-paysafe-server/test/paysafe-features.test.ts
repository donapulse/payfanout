import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import {
  decodeSessionContext,
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

const sessionInput = { amount: 2000, currency: "USD", country: "US", idempotencyKey: "k-sess" };

describe("Paysafe session TTL", () => {
  it("stamps expiresAt from sessionTtlSeconds and the injected clock", async () => {
    const t0 = Date.parse("2026-07-04T12:00:00Z");
    const { adapter } = makePair({ now: () => t0, sessionTtlSeconds: 900 });
    const session = await adapter.createPaymentSession(sessionInput);
    const context = await decodeSessionContext(session.pspSessionId, SIGNING_KEY, { now: t0 });
    expect(context.expiresAt).toBe(t0 + 900_000);
  });

  it("completePayment rejects an expired session with session_expired (host: create a fresh session)", async () => {
    let now = Date.parse("2026-07-04T12:00:00Z");
    const { adapter } = makePair({ now: () => now, sessionTtlSeconds: 60 });
    const session = await adapter.createPaymentSession(sessionInput);
    now += 61_000; // one minute and one second later
    try {
      await adapter.completePayment({
        pspSessionId: session.pspSessionId,
        clientToken: "tok_ok",
        idempotencyKey: "k-complete",
      });
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("session_expired");
        expect(err.retryable).toBe(false); // recovered by a new session, not by replay
        expect(err.message).toMatch(/expired/);
      }
    }
  });

  it("verifyPaymentMethod enforces the same expiry", async () => {
    let now = Date.parse("2026-07-04T12:00:00Z");
    const { adapter } = makePair({ now: () => now });
    const session = await adapter.createPaymentSession(sessionInput);
    now += 3600_000 + 1; // default TTL is one hour
    await expect(
      adapter.verifyPaymentMethod({ pspSessionId: session.pspSessionId, clientToken: "tok_ok", idempotencyKey: "k-v" }),
    ).rejects.toMatchObject({ code: "session_expired" });
  });

  it("a session completed within its TTL still works", async () => {
    let now = Date.parse("2026-07-04T12:00:00Z");
    const { adapter } = makePair({ now: () => now, sessionTtlSeconds: 60 });
    const session = await adapter.createPaymentSession(sessionInput);
    now += 59_000;
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_ok",
      idempotencyKey: "k-complete",
    });
    expect(info.status).toBe("succeeded");
  });

  it("rejects nonsensical TTL/timeout/retry configs eagerly", () => {
    expect(() => makePair({ sessionTtlSeconds: 0 })).toThrowError(/sessionTtlSeconds/);
    expect(() => makePair({ requestTimeoutMs: -5 })).toThrowError(/requestTimeoutMs/);
    expect(() => makePair({ maxNetworkRetries: -1 })).toThrowError(/maxNetworkRetries/);
    expect(() => makePair({ maxNetworkRetries: 1.5 })).toThrowError(/maxNetworkRetries/);
  });
});

describe("Paysafe updatePaymentSession (stateless re-issue)", () => {
  it("re-signs the context with the new amount and a fresh TTL", async () => {
    let now = Date.parse("2026-07-04T12:00:00Z");
    const { adapter } = makePair({ now: () => now, sessionTtlSeconds: 600 });
    const session = await adapter.createPaymentSession({ ...sessionInput, id: "order-9" });
    now += 300_000; // 5 minutes into the 10-minute TTL

    const updated = await adapter.updatePaymentSession({
      pspSessionId: session.pspSessionId,
      amount: 3500,
      metadata: { cart: "v2" },
      idempotencyKey: "k-upd",
    });
    expect(updated.pspSessionId).not.toBe(session.pspSessionId); // re-issued, not amended
    expect(updated.amount).toBe(3500);
    expect(updated.id).toBe("order-9");
    expect(updated.metadata).toEqual({ cart: "v2" });

    const context = await decodeSessionContext(updated.pspSessionId, SIGNING_KEY, { now });
    expect(context.amount).toBe(3500);
    expect(context.expiresAt).toBe(now + 600_000); // fresh TTL from update time
    expect(context.captureMethod).toBe("automatic"); // untouched fields carry over
    expect(context.country).toBe("US");
  });

  it("completing with the updated token charges the updated amount", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession(sessionInput);
    const updated = await adapter.updatePaymentSession({
      pspSessionId: session.pspSessionId,
      amount: 4200,
      idempotencyKey: "k-upd",
    });
    const info = await adapter.completePayment({
      pspSessionId: updated.pspSessionId,
      clientToken: "tok_ok",
      idempotencyKey: "k-complete",
    });
    expect(info.amount).toBe(4200);
    expect(fake.lastRequestBody?.["amount"]).toBe(4200);
  });

  it("re-resolves the merchant account when the currency changes", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession(sessionInput);
    const updated = await adapter.updatePaymentSession({
      pspSessionId: session.pspSessionId,
      currency: "cad",
      idempotencyKey: "k-upd",
    });
    const context = await decodeSessionContext(updated.pspSessionId, SIGNING_KEY);
    expect(context.currency).toBe("CAD");
    expect(context.merchantAccountId).toBe("acct-CAD-US"); // resolver re-ran with the session's country
  });

  it("rejects updates to expired or tampered sessions", async () => {
    let now = Date.parse("2026-07-04T12:00:00Z");
    const { adapter } = makePair({ now: () => now, sessionTtlSeconds: 60 });
    const session = await adapter.createPaymentSession(sessionInput);
    now += 61_000;
    await expect(
      adapter.updatePaymentSession({ pspSessionId: session.pspSessionId, amount: 100, idempotencyKey: "k" }),
    ).rejects.toThrowError(/expired/);
    await expect(
      adapter.updatePaymentSession({ pspSessionId: "AAAA.BBBB", amount: 100, idempotencyKey: "k" }),
    ).rejects.toThrowError(/signature mismatch/);
  });
});

describe("Paysafe checkout fields on POST /payments", () => {
  it("sends merchantDescriptor/profile; shippingDetails is withheld (handle-level field, sandbox-verified 5023)", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      ...sessionInput,
      statementDescriptor: "SHOP ORDER9",
      receiptEmail: "buyer@example.com",
      shippingDetails: {
        name: "Ann Buyer",
        address: { line1: "1 Way", line2: "Apt 2", city: "NYC", state: "NY", postalCode: "10001", country: "US" },
      },
      billingDetails: { address: { line1: "9 Bill St", city: "NYC", postalCode: "10001", country: "US" } },
    });
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_ok",
      idempotencyKey: "k-complete",
    });
    expect(info.status).toBe("succeeded"); // the fake 5023-rejects shippingDetails like the real API
    expect(fake.lastRequestBody).toMatchObject({
      merchantDescriptor: { dynamicDescriptor: "SHOP ORDER9" },
      profile: { email: "buyer@example.com" },
      billingDetails: { street: "9 Bill St", city: "NYC", zip: "10001", country: "US" },
    });
    expect(fake.lastRequestBody).not.toHaveProperty("shippingDetails");
    // Shipping still rides the signed context for handle-level flows.
    const context = await decodeSessionContext(session.pspSessionId, SIGNING_KEY);
    expect(context.shippingDetails?.address?.city).toBe("NYC");
  });

  it("merges completion-time billingDetails into /payments when the session carried none (AVS zip on the payment step)", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession(sessionInput); // no billingDetails on the session
    await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_ok",
      idempotencyKey: "k-complete",
      billingDetails: { address: { postalCode: "90210", country: "US" } },
    });
    expect(fake.lastRequestBody).toMatchObject({ billingDetails: { zip: "90210", country: "US" } });
  });

  it("merges completion-time billingDetails over the session's, field by field (completion wins)", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      ...sessionInput,
      billingDetails: { address: { line1: "9 Bill St", city: "NYC" } }, // session has street/city but no zip
    });
    await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_ok",
      idempotencyKey: "k-complete",
      billingDetails: { address: { postalCode: "90210" } }, // completion supplies the AVS zip
    });
    expect(fake.lastRequestBody).toMatchObject({ billingDetails: { street: "9 Bill St", city: "NYC", zip: "90210" } });
  });

  it("keeps the session's billing field when completion passes an explicit undefined (no clobber, no preventable 3004)", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      ...sessionInput,
      billingDetails: { address: { postalCode: "10001", country: "US" } },
    });
    await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_ok",
      idempotencyKey: "k-complete",
      billingDetails: { address: { postalCode: undefined, line1: "9 Bill St" } }, // zip left explicitly undefined
    });
    expect(fake.lastRequestBody).toMatchObject({ billingDetails: { zip: "10001", street: "9 Bill St", country: "US" } });
  });

  it("omits the hashes entirely when the fields were not provided", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession(sessionInput);
    await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_ok",
      idempotencyKey: "k-complete",
    });
    expect(fake.lastRequestBody).not.toHaveProperty("merchantDescriptor");
    expect(fake.lastRequestBody).not.toHaveProperty("profile");
    expect(fake.lastRequestBody).not.toHaveProperty("shippingDetails");
  });
});

describe("Paysafe refund lifecycle", () => {
  it("retrieveRefund polls a pending refund to a terminal state", async () => {
    const { adapter, fake } = makePair();
    const pending = fake.seedRefund({ status: "PENDING", amount: 800 });
    const first = await adapter.retrieveRefund(pending.id);
    expect(first).toMatchObject({ refundId: pending.id, status: "pending", amount: 800 });
    expect(first.createdAt).toBe("2026-07-04T10:10:00Z");

    fake.seedRefund({ id: pending.id, status: "COMPLETED", amount: 800 });
    expect((await adapter.retrieveRefund(pending.id)).status).toBe("succeeded");
    fake.seedRefund({ id: pending.id, status: "FAILED", amount: 800 });
    expect((await adapter.retrieveRefund(pending.id)).status).toBe("failed");
    fake.seedRefund({ id: pending.id, status: "CANCELLED", amount: 800 });
    expect((await adapter.retrieveRefund(pending.id)).status).toBe("failed");
  });

  it("a real refund's id is retrievable end-to-end", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession(sessionInput);
    const paid = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_ok",
      idempotencyKey: "k-complete",
    });
    const refund = await adapter.refundPayment({
      pspPaymentId: paid.pspPaymentId,
      amount: 500,
      idempotencyKey: "k-refund",
    });
    const polled = await adapter.retrieveRefund(refund.refundId);
    expect(polled.refundId).toBe(refund.refundId);
    expect(polled.status).toBe("succeeded");
    expect(polled.amount).toBe(500);
  });

  it("maps a missing refund id to PayFanoutError with raw preserved", async () => {
    const { adapter } = makePair();
    try {
      await adapter.retrieveRefund("ref_missing");
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) expect(err.raw).toBeDefined();
    }
  });
});

describe("Paysafe multi-capture (partial settlements)", () => {
  it("two captures with distinct keys settle cumulatively up to the authorization", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ ...sessionInput, captureMethod: "manual" });
    const authorized = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_ok",
      idempotencyKey: "k-auth",
    });
    expect(authorized.status).toBe("requires_capture");

    const first = await adapter.capturePayment(authorized.pspPaymentId, 700, "k-cap-1");
    expect(first.status).toBe("succeeded");
    expect(first.amount).toBe(700);
    expect(first.amountCaptured).toBe(700);
    expect(first.amountCapturable).toBe(1300);

    const second = await adapter.capturePayment(authorized.pspPaymentId, 500, "k-cap-2");
    expect(second.amountCaptured).toBe(1200); // cumulative settled funds
    expect(second.amountCapturable).toBe(800);

    expect(adapter.getCapabilities().supportsMultiCapture).toBe(true);
  });

  it("captures the full remaining authorization when no amount is given, replay-safe per key", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ ...sessionInput, captureMethod: "manual" });
    const authorized = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_ok",
      idempotencyKey: "k-auth",
    });
    const captured = await adapter.capturePayment(authorized.pspPaymentId, undefined, "k-cap-all");
    expect(captured.status).toBe("succeeded");
    expect(captured.amountCaptured).toBe(2000);
    // Same key -> same merchantRefNum -> the PSP replays the settlement, no double charge.
    const replay = await adapter.capturePayment(authorized.pspPaymentId, undefined, "k-cap-all");
    expect(replay.amountCaptured).toBe(2000);
  });

  it("releases the un-captured remainder: partial settle -> cancelPayment voids the rest, settled funds stay", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ ...sessionInput, captureMethod: "manual" });
    const authorized = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_ok",
      idempotencyKey: "k-auth",
    });
    const captured = await adapter.capturePayment(authorized.pspPaymentId, 700, "k-cap");
    expect(captured.amount).toBe(700);

    const released = await adapter.cancelPayment(authorized.pspPaymentId, "k-void");
    // NOT canceled — the settled 700 stands, the 1300 remainder is gone. The
    // returned info derives the split from the pre-void remainder (caller-keyed
    // settlements are not rediscoverable statelessly on later retrieves).
    expect(released.status).toBe("succeeded");
    expect(released.amount).toBe(700);
    expect(released.amountCaptured).toBe(700);
    expect(released.amountCapturable).toBe(0);
    expect((released.raw as { availableToSettle?: number }).availableToSettle).toBe(0);
  });

  it("a capture beyond the remaining authorization is rejected by the PSP", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ ...sessionInput, captureMethod: "manual" });
    const authorized = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_ok",
      idempotencyKey: "k-auth",
    });
    await adapter.capturePayment(authorized.pspPaymentId, 1800, "k-cap-1");
    await expect(adapter.capturePayment(authorized.pspPaymentId, 300, "k-cap-2")).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});

describe("Paysafe network timeouts", () => {
  /** A fetch that never responds but honors AbortSignal like the real one. */
  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      );
    });

  it("aborts a hung request and surfaces a retryable psp_unavailable", async () => {
    const { adapter } = makePair({ fetch: hangingFetch, requestTimeoutMs: 30 });
    const started = Date.now();
    try {
      await adapter.retrievePayment("pay_1");
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(Date.now() - started).toBeLessThan(5_000); // did not hang
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("psp_unavailable");
        expect(err.retryable).toBe(true);
        expect(err.message).toMatch(/did not respond within 30ms/);
      }
    }
  });

  it("keeps plain network failures distinguishable from timeouts", async () => {
    const { adapter } = makePair({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(adapter.retrievePayment("pay_1")).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
      message: "Could not reach Paysafe.",
    });
  });
});

describe("Paysafe verifyCredentials (Test connection probe)", () => {
  it("returns { ok: true } after one read-only customer-vault lookup on good credentials", async () => {
    const { adapter } = makePair();
    await expect(adapter.verifyCredentials()).resolves.toEqual({ ok: true });
  });

  it("classifies a 401 as category 'auth' without leaking the credentials", async () => {
    const { adapter, fake } = makePair();
    fake.authFailure = true;
    const result = await adapter.verifyCredentials();
    expect(result).toEqual({
      ok: false,
      category: "auth",
      message: "Authentication failed — check the Paysafe username and password.",
    });
  });

  it("classifies a 403 as category 'auth'", async () => {
    const { adapter } = makePair({
      fetch: async () => new Response(JSON.stringify({ error: { code: "5279" } }), { status: 403 }),
    });
    const result = await adapter.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe("auth");
  });

  it("classifies a network failure as category 'network'", async () => {
    const { adapter, fake } = makePair();
    fake.networkFailure = true;
    const result = await adapter.verifyCredentials();
    expect(result).toEqual({
      ok: false,
      category: "network",
      message: "Could not reach Paysafe — try again.",
    });
  });

  it("classifies a 429 and a 5xx as category 'network'", async () => {
    for (const status of [429, 503]) {
      const { adapter } = makePair({
        fetch: async () => new Response(JSON.stringify({ error: { code: "1000" } }), { status }),
      });
      const result = await adapter.verifyCredentials();
      expect(result.ok, `status ${status}`).toBe(false);
      if (!result.ok) expect(result.category).toBe("network");
    }
  });

  it("classifies an unexpected 4xx as category 'internal' without leaking details", async () => {
    const { adapter } = makePair({
      fetch: async () => new Response(JSON.stringify({ error: { code: "5068" } }), { status: 400 }),
    });
    const result = await adapter.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe("internal");
      expect(result.message).not.toMatch(/api_user|api_pass/); // credentials never surface
    }
  });

  it("probes exactly once — an auth rejection is never retried", async () => {
    let calls = 0;
    const { adapter } = makePair({
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: "5279" } }), { status: 401 });
      },
      maxNetworkRetries: 3,
    });
    const result = await adapter.verifyCredentials();
    expect(result.ok).toBe(false);
    expect(calls).toBe(1); // no transport-retry loop around the single probe
  });
});

describe("Paysafe payment method details", () => {
  it("maps card.type/lastDigits/cardExpiry onto brand/last4/expMonth/expYear", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession(sessionInput);
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "tok_ok",
      idempotencyKey: "k-complete",
    });
    expect(info.paymentMethodDetails).toEqual({ brand: "visa", last4: "1111", expMonth: 12, expYear: 2030 });
  });

  it("prefers an explicit cardBrand and tolerates unknown type codes and absent expiry", async () => {
    const withCard = (card: Record<string, unknown>): PaysafeServerAdapterConfig["fetch"] =>
      async () =>
        new Response(JSON.stringify({ id: "pay_1", amount: 100, currencyCode: "USD", status: "COMPLETED", settleWithAuth: true, card }), { status: 200 });

    const branded = new PaysafeServerAdapter({
      username: "u", password: "p", environment: "sandbox",
      merchantAccountResolver: () => undefined,
      sessionSigningKey: SIGNING_KEY, webhookHmacKey: WEBHOOK_KEY,
      fetch: withCard({ cardBrand: "Mastercard", lastDigits: "5100", cardExpiry: { month: 3, year: 2031 } }),
    });
    expect((await branded.retrievePayment("pay_1")).paymentMethodDetails).toEqual({
      brand: "mastercard",
      last4: "5100",
      expMonth: 3,
      expYear: 2031,
    });

    const unknownType = new PaysafeServerAdapter({
      username: "u", password: "p", environment: "sandbox",
      merchantAccountResolver: () => undefined,
      sessionSigningKey: SIGNING_KEY, webhookHmacKey: WEBHOOK_KEY,
      fetch: withCard({ cardType: "ZZ", lastDigits: "0001" }),
    });
    expect((await unknownType.retrievePayment("pay_1")).paymentMethodDetails).toEqual({ last4: "0001" });
  });
});

describe("Paysafe transport retries", () => {
  const makeRetryingAdapter = (
    responses: Array<() => Promise<Response>>,
    config: Partial<PaysafeServerAdapterConfig> = {},
  ): { adapter: PaysafeServerAdapter; calls: () => number; sleeps: number[] } => {
    let call = 0;
    const sleeps: number[] = [];
    const adapter = new PaysafeServerAdapter({
      username: "u",
      password: "p",
      environment: "sandbox",
      merchantAccountResolver: () => undefined,
      sessionSigningKey: SIGNING_KEY,
      webhookHmacKey: WEBHOOK_KEY,
      fetch: (async () => {
        const responder = responses[Math.min(call, responses.length - 1)]!;
        call += 1;
        return responder();
      }) as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...config,
    });
    return { adapter, calls: () => call, sleeps };
  };

  // retrieveRefund is the one-request surface — call counts stay attempt counts
  // (retrievePayment would add its settlements lookup to the arithmetic).
  const ok = () =>
    Promise.resolve(
      new Response(JSON.stringify({ id: "ref_1", amount: 100, status: "COMPLETED" }), { status: 200 }),
    );
  const http = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it("retries 5xx and network failures with backoff, then succeeds", async () => {
    const { adapter, calls, sleeps } = makeRetryingAdapter([
      () => http(503, { error: { code: "1000", message: "down" } }),
      () => Promise.reject(new TypeError("fetch failed")),
      ok,
    ]);
    const refund = await adapter.retrieveRefund("ref_1");
    expect(refund.status).toBe("succeeded");
    expect(calls()).toBe(3);
    expect(sleeps).toEqual([250, 500]);
  });

  it("gives up after maxNetworkRetries and surfaces the transport error", async () => {
    const { adapter, calls } = makeRetryingAdapter(
      [() => http(500, { error: { code: "1000", message: "down" } })],
      { maxNetworkRetries: 1 },
    );
    await expect(adapter.retrieveRefund("ref_1")).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
    });
    expect(calls()).toBe(2);
  });

  it("never retries business errors — a decline is one API call, 3406 is one API call", async () => {
    const declined = makeRetryingAdapter([() => http(402, { error: { code: "3009", message: "declined" } })]);
    await expect(declined.adapter.retrieveRefund("ref_1")).rejects.toMatchObject({ code: "card_declined" });
    expect(declined.calls()).toBe(1);

    const unbatched = makeRetryingAdapter([() => http(400, { error: { code: "3406", message: "not batched" } })]);
    await expect(unbatched.adapter.retrieveRefund("ref_1")).rejects.toMatchObject({
      code: "processing_error",
      retryable: true, // retryable HOURS later — the transport loop must not spin on it
    });
    expect(unbatched.calls()).toBe(1);
  });

  it("retries rate limiting (429)", async () => {
    const { adapter, calls } = makeRetryingAdapter([
      () => http(429, { error: { code: "1200", message: "slow down" } }),
      ok,
    ]);
    await expect(adapter.retrieveRefund("ref_1")).resolves.toMatchObject({ status: "succeeded" });
    expect(calls()).toBe(2);
  });

  it("maxNetworkRetries: 0 disables the retry loop entirely", async () => {
    const { adapter, calls } = makeRetryingAdapter(
      [() => http(503, { error: { code: "1000", message: "down" } }), ok],
      { maxNetworkRetries: 0 },
    );
    await expect(adapter.retrieveRefund("ref_1")).rejects.toMatchObject({ code: "psp_unavailable" });
    expect(calls()).toBe(1);
  });

  it("bounds the response BODY read with the timeout — headers alone do not disarm it", async () => {
    // Headers arrive immediately but the body stream never closes: without
    // the timer surviving until text(), this call would hang forever.
    const { adapter } = makeRetryingAdapter(
      [() => Promise.resolve(new Response(new ReadableStream({ start() {} })))],
      { requestTimeoutMs: 5, maxNetworkRetries: 0 },
    );
    await expect(adapter.retrieveRefund("ref_1")).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
      message: expect.stringMatching(/did not respond within 5ms/),
    });
  });

  it("still times out when a response lands only after the abort already fired", async () => {
    // An injected transport may ignore the signal and resolve late — the
    // body read must refuse to start on an already-aborted request.
    const { adapter } = makeRetryingAdapter(
      [() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("{}")), 40))],
      { requestTimeoutMs: 5, maxNetworkRetries: 0 },
    );
    await expect(adapter.retrieveRefund("ref_1")).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
      message: expect.stringMatching(/did not respond within 5ms/),
    });
  });
});

describe("edge-runtime compatibility", () => {
  it("the adapter's runtime sources use no Node-only builtins (WebCrypto only)", async () => {
    // Static guard: node:crypto/Buffer sneaking back in would silently break
    // Cloudflare Workers / Next.js edge deployments. Functional equivalence
    // with node:crypto is asserted in the session-context/webhook tests.
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const offenders: string[] = [];
    for (const file of await readdir(srcDir)) {
      const content = await readFile(join(srcDir, file), "utf8");
      if (/from "node:|require\("node:|Buffer\./.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("Paysafe Customer Vault", () => {
  it("full lifecycle: customer -> convert single-use -> list -> charge INITIAL/SUBSEQUENT -> delete", async () => {
    const { adapter, fake } = makePair();
    const customer = await adapter.createCustomer({
      id: "user-9",
      name: "Ann Buyer",
      email: "ann@example.com",
      idempotencyKey: "k-cust",
    });
    expect(customer.pspCustomerId).toMatch(/^cust_/);

    const saved = await adapter.savePaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      clientToken: "tok_single_use_1",
      idempotencyKey: "k-save",
    });
    expect(saved.token).toMatch(/^MU/);
    expect(saved.details).toEqual({ brand: "visa", last4: "1111", expMonth: 12, expYear: 2030 });

    const listed = await adapter.listSavedPaymentMethods(customer.pspCustomerId);
    expect(listed.map((m) => m.token)).toEqual([saved.token]);

    const initial = await adapter.chargeSavedPaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      savedPaymentMethodToken: saved.token,
      amount: 2500,
      currency: "USD",
      occurrence: "initial",
      idempotencyKey: "k-c1",
    });
    expect(initial.status).toBe("succeeded");
    expect(fake.lastRequestBody).toMatchObject({
      storedCredential: { type: "RECURRING", occurrence: "INITIAL" },
      settleWithAuth: true,
    });

    const recurring = await adapter.chargeSavedPaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      savedPaymentMethodToken: saved.token,
      amount: 2500,
      currency: "USD",
      idempotencyKey: "k-c2",
    });
    expect(recurring.status).toBe("succeeded");
    expect(fake.lastRequestBody).toMatchObject({
      storedCredential: { type: "RECURRING", occurrence: "SUBSEQUENT" },
    });
    expect(recurring.pspPaymentId).not.toBe(initial.pspPaymentId);

    await adapter.deleteSavedPaymentMethod(customer.pspCustomerId, saved.token);
    expect(await adapter.listSavedPaymentMethods(customer.pspCustomerId)).toEqual([]);
    // A deleted MULTI_USE token dies at the payments endpoint.
    await expect(
      adapter.chargeSavedPaymentMethod({
        pspCustomerId: customer.pspCustomerId,
        savedPaymentMethodToken: saved.token,
        amount: 500,
        currency: "USD",
        idempotencyKey: "k-c3",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("forwards billingDetails on customer-present charges (3004 without a zip, sandbox-verified)", async () => {
    const { adapter, fake } = makePair();
    const customer = await adapter.createCustomer({ idempotencyKey: "k-cust" });
    const saved = await adapter.savePaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      clientToken: "tok_single_use_avs",
      idempotencyKey: "k-save",
    });
    await adapter.chargeSavedPaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      savedPaymentMethodToken: saved.token,
      amount: 1099,
      currency: "USD",
      occurrence: "initial",
      billingDetails: { address: { line1: "1 Way", city: "NYC", postalCode: "10001", country: "US" } },
      idempotencyKey: "k-c",
    });
    expect(fake.lastRequestBody).toMatchObject({
      storedCredential: { type: "RECURRING", occurrence: "INITIAL" },
      billingDetails: { street: "1 Way", city: "NYC", zip: "10001", country: "US" },
    });
  });

  it("maps 'unscheduled' onto ADHOC stored-credential semantics", async () => {
    const { adapter, fake } = makePair();
    const customer = await adapter.createCustomer({ idempotencyKey: "k-cust" });
    const saved = await adapter.savePaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      clientToken: "tok_single_use_2",
      idempotencyKey: "k-save",
    });
    await adapter.chargeSavedPaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      savedPaymentMethodToken: saved.token,
      amount: 700,
      currency: "USD",
      occurrence: "unscheduled",
      idempotencyKey: "k-c",
    });
    expect(fake.lastRequestBody).toMatchObject({
      storedCredential: { type: "ADHOC", occurrence: "SUBSEQUENT" },
    });
  });

  it("deleting an unknown token and saving under an unknown customer both reject cleanly", async () => {
    const { adapter } = makePair();
    const customer = await adapter.createCustomer({ idempotencyKey: "k-cust" });
    await expect(adapter.deleteSavedPaymentMethod(customer.pspCustomerId, "MUghost")).rejects.toThrowError(
      /No stored payment method/,
    );
    await expect(
      adapter.savePaymentMethod({ pspCustomerId: "cust_ghost", clientToken: "tok_x", idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("re-saving a card the customer already holds recovers the existing token (7503)", async () => {
    const { adapter } = makePair();
    const customer = await adapter.createCustomer({ id: "user-dup", idempotencyKey: "k-cust" });
    const first = await adapter.savePaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      clientToken: "tok_single_use_1",
      idempotencyKey: "k-save-1",
    });
    // Customer re-checks "save my card" on a later purchase, same card.
    const again = await adapter.savePaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      clientToken: "tok_single_use_dupcard",
      idempotencyKey: "k-save-2",
    });
    expect(again.token).toBe(first.token);
    expect(await adapter.listSavedPaymentMethods(customer.pspCustomerId)).toHaveLength(1);
  });

  it("createCustomer is idempotent per host user id — a duplicate recovers the existing profile (7505)", async () => {
    const { adapter, fake } = makePair();
    const first = await adapter.createCustomer({ id: "user-42", idempotencyKey: "k-1" });
    // Host restarted, cache gone, same user id — must return the SAME profile, not fail.
    const second = await adapter.createCustomer({ id: "user-42", idempotencyKey: "k-2" });
    expect(second.pspCustomerId).toBe(first.pspCustomerId);
    expect(fake.uniqueCustomerCreations).toBe(1);
  });

  it("createCustomer falls back to the idempotency key for merchantCustomerId", async () => {
    const { adapter, fake } = makePair();
    await adapter.createCustomer({ idempotencyKey: "k-only" });
    expect(fake.lastRequestBody).toMatchObject({ merchantCustomerId: "k-only" });
    await adapter.createCustomer({ id: "user-3", name: "Ann Marie Buyer", idempotencyKey: "k-2" });
    expect(fake.lastRequestBody).toMatchObject({
      merchantCustomerId: "user-3",
      firstName: "Ann",
      lastName: "Marie Buyer",
    });
  });
});

describe("Paysafe webhook rotation + refund_failed mapping", () => {
  const signWith = (rawBody: string, key: string): Record<string, string> => ({
    signature: createHmac("sha256", key).update(rawBody, "utf8").digest("base64"),
  });

  it("accepts signatures from any configured HMAC key during rotation", async () => {
    const { adapter } = makePair({ webhookHmacKey: ["old-key", "new-key"] });
    const rawBody = JSON.stringify({ id: "evt", eventType: "PAYMENT_COMPLETED" });
    await expect(adapter.verifyWebhookSignature(rawBody, signWith(rawBody, "old-key"))).resolves.toBe(true);
    await expect(adapter.verifyWebhookSignature(rawBody, signWith(rawBody, "new-key"))).resolves.toBe(true);
    await expect(adapter.verifyWebhookSignature(rawBody, signWith(rawBody, "other"))).resolves.toBe(false);
  });

  it("verifies with mixed-case header names (proxies rewrite casing)", async () => {
    const { adapter } = makePair();
    const rawBody = JSON.stringify({ id: "evt", eventType: "PAYMENT_COMPLETED" });
    const value = signWith(rawBody, WEBHOOK_KEY)["signature"]!;
    await expect(adapter.verifyWebhookSignature(rawBody, { Signature: value })).resolves.toBe(true);
    await expect(
      adapter.verifyWebhookSignature(rawBody, { "X-Paysafe-Signature": value }),
    ).resolves.toBe(true);
  });

  it("rejects configs with no usable HMAC key", () => {
    expect(() => makePair({ webhookHmacKey: [] })).toThrowError(/webhookHmacKey/);
  });

  it("maps refund failure events to payment.refund_failed, carrying the refund's money facts", async () => {
    const { adapter } = makePair();
    for (const eventType of ["REFUND_FAILED", "REFUND.DECLINED", "refund_error"]) {
      const event = await adapter.parseWebhookEvent(
        JSON.stringify({ id: `evt-${eventType}`, eventType, payload: { id: "ref_1", amount: 450, currencyCode: "usd" } }),
      );
      expect(event.type, eventType).toBe("payment.refund_failed");
      expect(event.pspPaymentId).toBe("ref_1");
      expect(event.refundId).toBe("ref_1");
      expect(event.amount).toBe(450);
      expect(event.currency).toBe("USD");
    }
    const completed = await adapter.parseWebhookEvent(
      JSON.stringify({ id: "evt-ok", eventType: "REFUND_COMPLETED", payload: { id: "ref_1", amount: 450 } }),
    );
    expect(completed.type).toBe("payment.refunded");
    expect(completed.refundId).toBe("ref_1");
    expect(completed.amount).toBe(450);
  });

  it("keeps money facts off events whose payloads do not carry them (never fabricated)", async () => {
    const { adapter } = makePair();
    const event = await adapter.parseWebhookEvent(
      JSON.stringify({ id: "evt-bare", eventType: "PAYMENT_COMPLETED", payload: { id: "pay_1", amount: 10.5 } }),
    );
    expect(event.amount).toBeUndefined(); // non-integer amounts are dropped, not rounded
    expect(event.currency).toBeUndefined();
    expect(event.refundId).toBeUndefined(); // not a refund-shaped event
  });
});
