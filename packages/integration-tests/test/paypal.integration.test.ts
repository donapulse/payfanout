/**
 * Real PayPal sandbox integration. Skipped (green) unless credentials are set.
 * This suite validates the assumptions the adapter was written from (OAuth
 * flow, Orders v2 paths, PayPal-Request-Id semantics, PATCH behavior) —
 * failures here mean "adjust the adapter", which is exactly what we want to
 * learn before production.
 *
 *   $env:PAYPAL_CLIENT_ID     = "..."   # sandbox REST app client id
 *   $env:PAYPAL_CLIENT_SECRET = "..."   # sandbox REST app secret
 *   pnpm run test:integration
 *
 * Capturing a real order needs a buyer approval in the popup, which a test
 * process cannot perform — the capture-path negative test below therefore
 * uses PayPal's sandbox negative-testing header (enable Negative Testing on
 * the business sandbox account, then set PAYPAL_NEGATIVE_TESTING=1).
 */
import { describe, expect, it } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import { PayPalServerAdapter } from "@payfanout/adapter-paypal-server";

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
if (process.env.PAYPAL_ENVIRONMENT === "live") {
  throw new Error("Integration tests refuse to run against the live PayPal environment");
}

const describeIf = CLIENT_ID && CLIENT_SECRET ? describe : describe.skip;

const key = (): string => `payfanout-int-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function makeAdapter(fetchImpl?: typeof fetch): PayPalServerAdapter {
  return new PayPalServerAdapter({
    clientId: CLIENT_ID!,
    clientSecret: CLIENT_SECRET!,
    environment: "sandbox",
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

describeIf("PayPal sandbox integration", () => {
  it("mints an OAuth token, creates an order, and reads it back", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      id: "int-pp-order-1",
      amount: 1099,
      currency: "USD",
      returnUrl: "https://example.com/return",
      statementDescriptor: "PAYFANOUT INT",
      idempotencyKey: key(),
    });
    expect(session.pspSessionId.length).toBeGreaterThan(0);
    expect(session.clientSecret).toBe(session.pspSessionId);
    // Sandbox-verified: orders created with payment_source.paypal answer
    // PAYER_ACTION_REQUIRED — the session awaits the buyer's approval.
    expect(session.status).toBe("requires_action");
    expect(session.amount).toBe(1099);

    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.status).toBe("requires_action");
    expect(info.amount).toBe(1099);
    expect(info.currency).toBe("USD");
    expect(info.id).toBe("int-pp-order-1"); // custom_id round-trip
  });

  it("replays createPaymentSession idempotently on the same PayPal-Request-Id", async () => {
    const adapter = makeAdapter();
    const input = { amount: 500, currency: "USD", idempotencyKey: key() };
    const first = await adapter.createPaymentSession(input);
    const second = await adapter.createPaymentSession(input);
    expect(second.pspSessionId).toBe(first.pspSessionId);
  });

  it("PATCHes the amount pre-approval and returns the updated session", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({ amount: 1000, currency: "USD", idempotencyKey: key() });
    const updated = await adapter.updatePaymentSession({
      pspSessionId: session.pspSessionId,
      amount: 1500,
      idempotencyKey: key(),
    });
    expect(updated.pspSessionId).toBe(session.pspSessionId);
    expect(updated.amount).toBe(1500);
  });

  it("creates whole-unit JPY orders and enforces the local currency gates", async () => {
    const adapter = makeAdapter();
    const jpy = await adapter.createPaymentSession({ amount: 500, currency: "JPY", idempotencyKey: key() });
    expect(jpy.amount).toBe(500);

    // Rejected locally — no API call reaches PayPal for these.
    await expect(
      adapter.createPaymentSession({ amount: 1234, currency: "BHD", idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      adapter.createPaymentSession({ amount: 1050, currency: "HUF", idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("maps a nonexistent order/capture id onto invalid_request with raw preserved", async () => {
    const adapter = makeAdapter();
    try {
      await adapter.retrievePayment("5O000000000000000");
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("invalid_request");
        expect(err.raw).toBeDefined();
      }
    }
  });

  // Requires Negative Testing enabled on the business sandbox account.
  const itNegative = process.env.PAYPAL_NEGATIVE_TESTING ? it : it.skip;
  itNegative("negative testing: INSTRUMENT_DECLINED on capture maps to card_declined", async () => {
    // Wrap fetch to force the mock error on the capture call only.
    const mockingFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (/\/capture$/.test(new URL(url).pathname)) {
        init = {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string>),
            "PayPal-Mock-Response": '{"mock_application_codes": "INSTRUMENT_DECLINED"}',
          },
        };
      }
      return fetch(input, init);
    };
    const adapter = makeAdapter(mockingFetch);
    const session = await adapter.createPaymentSession({ amount: 1099, currency: "USD", idempotencyKey: key() });
    try {
      await adapter.completePayment({
        pspSessionId: session.pspSessionId,
        clientToken: session.pspSessionId,
        idempotencyKey: key(),
      });
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("card_declined");
        expect(err.retryable).toBe(false);
      }
    }
  });
});
