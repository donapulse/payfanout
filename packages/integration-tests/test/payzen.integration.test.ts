/**
 * Real PayZen (Lyra) TEST-gateway integration. Skipped (green) unless
 * credentials are set. This suite validates the assumptions the adapter was
 * written from: the always-HTTP-200 envelope, formToken issuance, the
 * no-transaction-before-payment reality, the INT_905 auth envelope, and the
 * currency gates. Card-present flows (the krypton form creating transactions)
 * need a browser and live in the e2e layer, not here.
 *
 *   $env:PAYZEN_SHOP_ID  = "..."     # Back Office "User"
 *   $env:PAYZEN_PASSWORD = "..."     # testpassword_… (production keys are refused)
 *   pnpm run test:integration
 */
import { describe, expect, it } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import { PayZenServerAdapter } from "@payfanout/adapter-payzen-server";

const SHOP_ID = process.env.PAYZEN_SHOP_ID;
const PASSWORD = process.env.PAYZEN_PASSWORD;
const BASE_URL = process.env.PAYZEN_BASE_URL ?? "https://api.payzen.eu/api-payment";
// PayZen selects TEST vs LIVE by the key, not the URL — only test-family
// passwords may ever reach this suite.
if (PASSWORD && !PASSWORD.startsWith("testpassword_")) {
  throw new Error("Integration tests refuse non-test PayZen keys (expected a testpassword_… value)");
}

const describeIf = SHOP_ID && PASSWORD ? describe : describe.skip;

const key = (): string => `payfanout-int-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function makeAdapter(): PayZenServerAdapter {
  return new PayZenServerAdapter({
    shopId: SHOP_ID!,
    password: PASSWORD!,
    environment: "sandbox",
    apiBaseUrl: BASE_URL,
    hmacKey: process.env.PAYZEN_HMAC_KEY ?? "not-used-in-these-tests",
  });
}

describeIf("PayZen TEST gateway integration", () => {
  it("creates a formToken session with the derived orderId (Charge/CreatePayment)", async () => {
    const adapter = makeAdapter();
    const idempotencyKey = key();
    const session = await adapter.createPaymentSession({
      id: "int-pz-order-1",
      amount: 1099,
      currency: "EUR",
      billingDetails: { address: { line1: "1 Integration Way", city: "Paris", postalCode: "75001", country: "FR" } },
      idempotencyKey,
    });
    expect(session.pspName).toBe("payzen");
    expect(session.pspSessionId).toBe(`pf-${idempotencyKey}`);
    expect(session.clientSecret!.length).toBeGreaterThan(20); // the formToken the krypton form mounts
    expect(session.status).toBe("requires_payment_method");
    expect(session.amount).toBe(1099);
  });

  it("a fresh order has NO transaction until a shopper pays (Order/Get -> PSP_010)", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({ amount: 500, currency: "EUR", idempotencyKey: key() });
    try {
      await adapter.retrievePayment(session.pspSessionId);
      expect.unreachable("expected rejection — no payment attempt exists yet");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("invalid_request");
        // Live behavior the adapter encodes: the gateway answers PSP_010 for
        // an order that only ever minted formTokens.
        expect(JSON.stringify(err.raw)).toContain("PSP_010");
      }
    }
  });

  it("replayed session creation mints distinct formTokens (no idempotency exists)", async () => {
    const adapter = makeAdapter();
    const input = { amount: 900, currency: "EUR", idempotencyKey: key() };
    const first = await adapter.createPaymentSession(input);
    const second = await adapter.createPaymentSession(input);
    expect(second.pspSessionId).toBe(first.pspSessionId); // deterministic derivation
    expect(second.clientSecret).not.toBe(first.clientSecret); // the gateway never dedupes
  });

  it("gates unsupported currencies locally (BHD) without an API call", async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.createPaymentSession({ amount: 1234, currency: "BHD", idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("passes 0-decimal amounts through untouched, tolerating shops without a JPY agreement", async () => {
    const adapter = makeAdapter();
    try {
      const session = await adapter.createPaymentSession({ amount: 500, currency: "JPY", idempotencyKey: key() });
      expect(session.amount).toBe(500);
    } catch (err) {
      // Shops without the currency-conversion option answer PSP_610 — the
      // mapping (invalid_request, raw preserved) is what this asserts then.
      if (!isPayFanoutError(err) || err.code !== "invalid_request") throw err;
      expect(JSON.stringify(err.raw)).toContain("PSP_610");
    }
  });

  it("maps the INT_905 auth-failure envelope (HTTP 200) to invalid_request", async () => {
    const adapter = new PayZenServerAdapter({
      shopId: SHOP_ID!,
      password: "testpassword_DefinitelyWrongKey",
      environment: "sandbox",
      apiBaseUrl: BASE_URL,
    });
    try {
      await adapter.createPaymentSession({ amount: 100, currency: "EUR", idempotencyKey: key() });
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("invalid_request");
        expect(err.message).toMatch(/credentials/);
        expect(JSON.stringify(err.raw)).toContain("INT_905");
      }
    }
  });

  it("retrievePayment on an unknown uuid maps PSP_010 to invalid_request", async () => {
    const adapter = makeAdapter();
    await expect(adapter.retrievePayment("f".repeat(32))).rejects.toMatchObject({ code: "invalid_request" });
  });
});
