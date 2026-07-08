/**
 * Real Paysafe sandbox integration. Skipped (green) unless credentials are set.
 * This suite's main job is validating the assumptions the adapter was written
 * from (REST paths, auth format, merchantRefNum dedupe, settlement model) —
 * failures here mean "adjust the adapter", which is exactly what we want to
 * learn before production.
 *
 *   $env:PAYSAFE_USERNAME   = "..."     # sandbox API key username
 *   $env:PAYSAFE_PASSWORD   = "..."     # sandbox API key password
 *   $env:PAYSAFE_ACCOUNT_ID = "..."     # USD test merchant account id
 *   pnpm run test:integration
 *
 * The payment-handle helper below sends a Paysafe TEST card server-to-server.
 * That is a sandbox-only testing shortcut (production tokenization happens in
 * Paysafe.js hosted fields) — never replicate it in production code paths.
 */
import { describe, expect, it } from "vitest";
import { getRefundState, isPayFanoutError, isUnifiedPaymentStatus } from "@payfanout/core";
import { PaysafeServerAdapter } from "@payfanout/adapter-paysafe-server";

const USERNAME = process.env.PAYSAFE_USERNAME;
const PASSWORD = process.env.PAYSAFE_PASSWORD;
const ACCOUNT_ID = process.env.PAYSAFE_ACCOUNT_ID;
// Unset CI secrets render as EMPTY strings, not undefined — || treats them as absent.
const BASE_URL = process.env.PAYSAFE_BASE_URL || "https://api.test.paysafe.com";
// Hostname equality, never substring matching — a lookalike host must not fool the guard.
if (new URL(BASE_URL).hostname === "api.paysafe.com") {
  throw new Error("Integration tests refuse to run against the live Paysafe API");
}

// ACCOUNT_ID is optional: single-account API keys route by key + currency.
const describeIf = USERNAME && PASSWORD ? describe : describe.skip;

// Sandbox accounts are provisioned for one currency (often CAD) — parameterized
// so the suite matches whatever the account supports.
const CURRENCY = process.env.PAYSAFE_CURRENCY || "USD";
const BILLING: Record<string, { country: string; zip: string }> = {
  CAD: { country: "CA", zip: "M5V 3L9" },
  USD: { country: "US", zip: "10001" },
  EUR: { country: "DE", zip: "10115" },
  GBP: { country: "GB", zip: "SW1A 1AA" },
};
const billing = BILLING[CURRENCY] ?? BILLING["USD"]!;

function makeAdapter(): PaysafeServerAdapter {
  return new PaysafeServerAdapter({
    username: USERNAME!,
    password: PASSWORD!,
    environment: "sandbox",
    baseUrl: BASE_URL,
    merchantAccountResolver: () => ACCOUNT_ID,
    sessionSigningKey: "integration-session-signing-key",
    webhookHmacKey: process.env.PAYSAFE_WEBHOOK_HMAC_KEY || "not-used-in-these-tests",
  });
}

const key = (): string => `payfanout-int-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Sandbox-only: creates a Payment Handle server-to-server with a Paysafe test card. */
async function createTestPaymentHandle(
  amount: number,
  currency: string,
  transactionType: "PAYMENT" | "VERIFICATION" = "PAYMENT",
): Promise<string> {
  const response = await fetch(`${BASE_URL}/paymenthub/v1/paymenthandles`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      merchantRefNum: key(),
      transactionType,
      paymentType: "CARD",
      amount,
      currencyCode: currency,
      ...(ACCOUNT_ID ? { accountId: ACCOUNT_ID } : {}),
      card: {
        cardNum: "4111111111111111", // Paysafe sandbox test card
        cardExpiry: { month: 12, year: 2030 },
        cvv: "111",
        holderName: "PayFanout Integration",
      },
      billingDetails: { country: billing.country, zip: billing.zip },
      returnLinks: [{ rel: "default", href: "https://example.com/return", method: "GET" }],
    }),
  });
  const body = (await response.json()) as { paymentHandleToken?: string; error?: unknown };
  if (!response.ok || !body.paymentHandleToken) {
    throw new Error(
      `Payment handle creation failed (HTTP ${response.status}): ${JSON.stringify(body)} — ` +
        "if the path or shape is wrong, fix packages/adapter-paysafe-server accordingly",
    );
  }
  return body.paymentHandleToken;
}

describeIf("Paysafe sandbox integration", () => {
  it("tokenize-first happy path: session -> handle -> completePayment -> retrieve", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      id: "int-psf-order-1",
      amount: 1099,
      currency: CURRENCY,
      country: billing.country,
      // Exercises Paysafe's per-session webhook registration on the real API.
      webhookUrl: "https://example.com/webhooks/paysafe",
      returnUrl: "https://example.com/return",
      idempotencyKey: key(),
    });
    const token = await createTestPaymentHandle(1099, CURRENCY);

    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: token,
      idempotencyKey: key(),
    });
    expect(isUnifiedPaymentStatus(info.status)).toBe(true);
    expect(["succeeded", "processing", "requires_capture"]).toContain(info.status);
    expect(info.status).not.toBe("failed");
    expect(info.amount).toBe(1099);
    expect(info.id).toBe("int-psf-order-1");
    expect(info.pspPaymentId.length).toBeGreaterThan(0);

    const retrieved = await adapter.retrievePayment(info.pspPaymentId);
    expect(retrieved.pspPaymentId).toBe(info.pspPaymentId);
    expect(retrieved.amount).toBe(1099);
    // Receipt-grade display facts, normalized from the real payment echo.
    expect(retrieved.paymentMethodDetails?.last4).toBe("1111");
    expect(retrieved.paymentMethodDetails?.brand).toBe("visa");
  });

  it("merchantRefNum dedupe = real idempotency: same key twice -> same payment", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      amount: 555,
      currency: CURRENCY,
      country: billing.country,
      idempotencyKey: key(),
    });
    const token = await createTestPaymentHandle(555, CURRENCY);
    const completionKey = key();
    const input = { pspSessionId: session.pspSessionId, clientToken: token, idempotencyKey: completionKey };
    const first = await adapter.completePayment(input);
    const second = await adapter.completePayment(input).catch((err: unknown) => {
      // Some Paysafe products answer a replayed merchantRefNum with a duplicate
      // error instead of echoing the original — both prove no double charge.
      expect(isPayFanoutError(err)).toBe(true);
      return null;
    });
    if (second) expect(second.pspPaymentId).toBe(first.pspPaymentId);
  });

  it("manual flow: authorize -> requires_capture -> capture (settlement)", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      amount: 4000,
      currency: CURRENCY,
      country: billing.country,
      captureMethod: "manual",
      idempotencyKey: key(),
    });
    const token = await createTestPaymentHandle(4000, CURRENCY);
    const authorized = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: token,
      idempotencyKey: key(),
    });
    expect(authorized.status).toBe("requires_capture");

    const captured = await adapter.capturePayment(authorized.pspPaymentId, undefined, key());
    expect(["succeeded", "processing"]).toContain(captured.status);
  });

  it("void: authorize -> cancelPayment -> canceled", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      amount: 2000,
      currency: CURRENCY,
      country: billing.country,
      captureMethod: "manual",
      idempotencyKey: key(),
    });
    const token = await createTestPaymentHandle(2000, CURRENCY);
    const authorized = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: token,
      idempotencyKey: key(),
    });
    const canceled = await adapter.cancelPayment(authorized.pspPaymentId, key());
    expect(canceled.status).toBe("canceled");
  });

  it("refund against the settlement (tolerates sandbox batch-settlement delay)", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      amount: 3000,
      currency: CURRENCY,
      country: billing.country,
      idempotencyKey: key(),
    });
    const token = await createTestPaymentHandle(3000, CURRENCY);
    const paid = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: token,
      idempotencyKey: key(),
    });
    try {
      const refund = await adapter.refundPayment({
        pspPaymentId: paid.pspPaymentId,
        amount: 1000,
        idempotencyKey: key(),
      });
      expect(["succeeded", "pending"]).toContain(refund.status);
      const info = await adapter.retrievePayment(paid.pspPaymentId);
      if (info.amountRefunded > 0) expect(getRefundState(info)).toBe("partial");
    } catch (err) {
      // Sandbox settlements batch overnight; refunding a PENDING settlement
      // yields Paysafe 3406 -> processing_error (retryable). A state issue,
      // not an adapter bug — anything else must surface.
      if (!isPayFanoutError(err) || (err.code !== "processing_error" && err.code !== "invalid_request")) throw err;
      expect(err.retryable || err.code === "invalid_request").toBe(true);
      console.warn("[paysafe-integration] refund deferred — settlement not batched yet:", err.message);
    }
  });

  it("rejects a tampered session context before ever calling Paysafe", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      amount: 100,
      currency: CURRENCY,
      country: billing.country,
      idempotencyKey: key(),
    });
    const [payload] = session.pspSessionId.split(".");
    const inflated = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), amount: 1 }),
    ).toString("base64url");
    await expect(
      adapter.completePayment({
        pspSessionId: `${inflated}.${session.pspSessionId.split(".")[1]}`,
        clientToken: "irrelevant",
        idempotencyKey: key(),
      }),
    ).rejects.toThrowError(/signature mismatch/);
  });

  it("zero-amount verification via the Verifications API", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      amount: 0,
      currency: CURRENCY,
      country: billing.country,
      idempotencyKey: key(),
    });
    const token = await createTestPaymentHandle(0, CURRENCY, "VERIFICATION").catch(async () => {
      // Some sandbox configs reject 0-amount handles; a nominal-amount handle
      // still exercises the verifications endpoint.
      return createTestPaymentHandle(100, CURRENCY);
    });
    const info = await adapter.verifyPaymentMethod({ pspSessionId: session.pspSessionId, clientToken: token, idempotencyKey: key() });
    expect(["succeeded", "failed", "processing"]).toContain(info.status);
    expect(info.amount).toBe(0);
  });

  it("checkout fields are accepted by POST /payments (merchantDescriptor + profile; shipping withheld)", async () => {
    // Reality check for the field mapping — /payments strict-rejects unknown
    // fields (5023), so acceptance here proves the names are right.
    // shippingDetails is handle-level (5023 on /payments);
    // the adapter must withhold it even when the session carries it.
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      amount: 1450,
      currency: CURRENCY,
      country: billing.country,
      statementDescriptor: "PAYFANOUT TEST",
      receiptEmail: "receipts@payfanout.example",
      shippingDetails: {
        name: "Integration Buyer",
        address: { line1: "1 Integration Way", city: "Toronto", state: "ON", postalCode: billing.zip, country: billing.country },
      },
      billingDetails: { address: { line1: "9 Billing St", city: "Toronto", postalCode: billing.zip, country: billing.country } },
      idempotencyKey: key(),
    });
    const token = await createTestPaymentHandle(1450, CURRENCY);
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: token,
      idempotencyKey: key(),
    });
    expect(info.status).not.toBe("failed");
    expect(info.amount).toBe(1450);
  });

  it("updatePaymentSession re-issues the signed context; completion charges the new amount", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      amount: 1000,
      currency: CURRENCY,
      country: billing.country,
      idempotencyKey: key(),
    });
    const updated = await adapter.updatePaymentSession({
      pspSessionId: session.pspSessionId,
      amount: 1300,
      idempotencyKey: key(),
    });
    expect(updated.pspSessionId).not.toBe(session.pspSessionId); // stateless re-issue
    expect(updated.amount).toBe(1300);

    const token = await createTestPaymentHandle(1300, CURRENCY);
    const info = await adapter.completePayment({
      pspSessionId: updated.pspSessionId,
      clientToken: token,
      idempotencyKey: key(),
    });
    expect(info.amount).toBe(1300);
    expect(info.status).not.toBe("failed");
  });

  it("retrieveRefund polls a real refund id (tolerates unbatched settlements)", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      amount: 2200,
      currency: CURRENCY,
      country: billing.country,
      idempotencyKey: key(),
    });
    const token = await createTestPaymentHandle(2200, CURRENCY);
    const paid = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: token,
      idempotencyKey: key(),
    });
    try {
      const refund = await adapter.refundPayment({
        pspPaymentId: paid.pspPaymentId,
        amount: 700,
        idempotencyKey: key(),
      });
      const polled = await adapter.retrieveRefund(refund.refundId);
      expect(polled.refundId).toBe(refund.refundId);
      expect(["succeeded", "pending"]).toContain(polled.status);
      expect(polled.amount).toBe(700);
    } catch (err) {
      // Same sandbox timing reality as the refund test above: settlements
      // batch overnight -> 3406 processing_error (retryable). Not an adapter bug.
      if (!isPayFanoutError(err) || (err.code !== "processing_error" && err.code !== "invalid_request")) throw err;
      console.warn("[paysafe-integration] retrieveRefund deferred — settlement not batched yet:", err.message);
    }
  });

  it("multi-capture: two partial settlements with distinct keys are both accepted", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      amount: 4000,
      currency: CURRENCY,
      country: billing.country,
      captureMethod: "manual",
      idempotencyKey: key(),
    });
    const token = await createTestPaymentHandle(4000, CURRENCY);
    const authorized = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: token,
      idempotencyKey: key(),
    });
    expect(authorized.status).toBe("requires_capture");

    const first = await adapter.capturePayment(authorized.pspPaymentId, 1500, key());
    expect(["succeeded", "processing"]).toContain(first.status);
    const second = await adapter.capturePayment(authorized.pspPaymentId, 1000, key());
    expect(["succeeded", "processing"]).toContain(second.status);
    // Settled funds are cumulative; tolerate reporting lag in the sandbox.
    expect(second.amount).toBeGreaterThanOrEqual(first.amount);
    expect(second.amount).toBeLessThanOrEqual(2500);
  });

  it("releases the remainder after a partial capture (sandbox-verified void-after-partial-settle)", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      amount: 3000,
      currency: CURRENCY,
      country: billing.country,
      captureMethod: "manual",
      idempotencyKey: key(),
    });
    const token = await createTestPaymentHandle(3000, CURRENCY);
    const authorized = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: token,
      idempotencyKey: key(),
    });
    // Default capture key keeps the settlement statelessly rediscoverable.
    const captured = await adapter.capturePayment(authorized.pspPaymentId, 1000, key());
    expect(["succeeded", "processing"]).toContain(captured.status);

    const released = await adapter.cancelPayment(authorized.pspPaymentId, key());
    // Settled funds stand; only the 2000 remainder is voided.
    expect(released.status).not.toBe("failed");
    expect(released.amount).toBe(1000);
    expect((released.raw as { availableToSettle?: number }).availableToSettle).toBe(0);
  });

  it("vault + recurring: single-use handle -> MULTI_USE token, INITIAL + SUBSEQUENT charges, list, delete", async () => {
    const adapter = makeAdapter();
    const customer = await adapter.createCustomer({
      id: key(), // merchantCustomerId must be unique per customer
      name: "Vault Integration",
      email: "vault-int@payfanout.example",
      idempotencyKey: key(),
    });
    expect(customer.pspCustomerId.length).toBeGreaterThan(0);

    // The client's tokenize() stand-in: a single-use handle, converted server-side.
    const singleUse = await createTestPaymentHandle(2500, CURRENCY);
    const saved = await adapter.savePaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      clientToken: singleUse,
      idempotencyKey: key(),
    });
    expect(saved.token.length).toBeGreaterThan(0);
    expect(saved.details?.last4).toBe("1111");

    // Credential-on-file agreement: INITIAL while the customer is present…
    const initial = await adapter.chargeSavedPaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      savedPaymentMethodToken: saved.token,
      amount: 2500,
      currency: CURRENCY,
      occurrence: "initial",
      idempotencyKey: key(),
    });
    expect(initial.status).toBe("succeeded");
    // …then SUBSEQUENT with nobody present — the recurring proof on Paysafe.
    const recurring = await adapter.chargeSavedPaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      savedPaymentMethodToken: saved.token,
      amount: 2500,
      currency: CURRENCY,
      idempotencyKey: key(),
    });
    expect(recurring.status).toBe("succeeded");
    expect(recurring.pspPaymentId).not.toBe(initial.pspPaymentId);

    const listed = await adapter.listSavedPaymentMethods(customer.pspCustomerId);
    expect(listed.map((m) => m.token)).toContain(saved.token);

    await adapter.deleteSavedPaymentMethod(customer.pspCustomerId, saved.token);
    expect((await adapter.listSavedPaymentMethods(customer.pspCustomerId)).map((m) => m.token)).not.toContain(
      saved.token,
    );
    // The deleted token is dead at the payments endpoint.
    await expect(
      adapter.chargeSavedPaymentMethod({
        pspCustomerId: customer.pspCustomerId,
        savedPaymentMethodToken: saved.token,
        amount: 500,
        currency: CURRENCY,
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("expired sessions are rejected locally, without any Paysafe call", async () => {
    let now = Date.now();
    const adapter = new PaysafeServerAdapter({
      username: USERNAME!,
      password: PASSWORD!,
      environment: "sandbox",
      baseUrl: BASE_URL,
      merchantAccountResolver: () => ACCOUNT_ID,
      sessionSigningKey: "integration-session-signing-key",
      webhookHmacKey: "not-used-in-these-tests",
      sessionTtlSeconds: 1,
      now: () => now,
    });
    const session = await adapter.createPaymentSession({
      amount: 100,
      currency: CURRENCY,
      country: billing.country,
      idempotencyKey: key(),
    });
    now += 1_001;
    await expect(
      adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: "irrelevant", idempotencyKey: key() }),
    ).rejects.toThrowError(/expired/);
  });
});
