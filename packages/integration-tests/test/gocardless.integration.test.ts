/**
 * Real GoCardless sandbox integration. Skipped (green) unless credentials are
 * set. This suite's main job is validating the assumptions the adapter was
 * written from (REST paths, envelope shapes, billing request + flow chain,
 * Idempotency-Key semantics) — failures here mean "adjust the adapter", which
 * is exactly what we want to learn before production.
 *
 *   $env:GOCARDLESS_ACCESS_TOKEN = "..."   # sandbox read-write token
 *   pnpm run test:integration
 *
 * Completing the hosted bank authorisation needs a browser, so the payment
 * itself stays requires_action here — the create/retrieve/cancel/replay
 * surface is what this suite proves against reality.
 */
import { describe, expect, it } from "vitest";
import { isUnifiedPaymentStatus } from "@payfanout/core";
import { GoCardlessServerAdapter } from "@payfanout/adapter-gocardless-server";

const ACCESS_TOKEN = process.env.GOCARDLESS_ACCESS_TOKEN;
const BASE_URL = process.env.GOCARDLESS_BASE_URL ?? "https://api-sandbox.gocardless.com";
// Hostname equality, never substring matching — a lookalike host must not fool the guard.
if (new URL(BASE_URL).hostname === "api.gocardless.com") {
  throw new Error("Integration tests refuse to run against the live GoCardless API");
}

const describeIf = ACCESS_TOKEN ? describe : describe.skip;

const RETURN_URL = "https://example.com/payfanout/return";

function makeAdapter(): GoCardlessServerAdapter {
  return new GoCardlessServerAdapter({
    accessToken: ACCESS_TOKEN!,
    environment: "sandbox",
    baseUrl: BASE_URL,
    webhookSecret: process.env.GOCARDLESS_WEBHOOK_SECRET ?? "not-used-in-these-tests",
  });
}

const key = (): string => `payfanout-int-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Raw seeding helper: customers/bank accounts/mandates are not adapter surface (vaulting is v1-deferred). */
async function gcPost<T>(path: string, resource: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      "gocardless-version": "2015-07-06",
      "content-type": "application/json",
      "idempotency-key": key(),
    },
    body: JSON.stringify({ [resource]: body }),
  });
  const json = (await res.json()) as Record<string, T>;
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json[resource]!;
}

describeIf("GoCardless sandbox real transaction lifecycle", () => {
  // Billing-request payments only materialize after the customer authorises in
  // the GoCardless-hosted UI (no headless path exists), so this block seeds a
  // mandate the classic way — customer -> bank account (sandbox test details)
  // -> mandate -> payment — then drives the payment to `confirmed` with the
  // sandbox scenario simulator. Everything lands visibly in the dashboard, and
  // the adapter's read/refund surface is asserted against the real objects.
  it("charges a seeded mandate, confirms it via the scenario simulator, and reads it back", async () => {
    const adapter = makeAdapter();
    const customer = await gcPost<{ id: string }>("/customers", "customers", {
      email: "integration@payfanout.test",
      given_name: "Integration",
      family_name: "Test",
      address_line1: "1 Test Street",
      city: "London",
      postal_code: "SW1A 1AA",
      country_code: "GB",
    });
    const bankAccount = await gcPost<{ id: string }>("/customer_bank_accounts", "customer_bank_accounts", {
      account_number: "55779911",
      branch_code: "200000",
      account_holder_name: "INTEGRATION TEST",
      country_code: "GB",
      links: { customer: customer.id },
    });
    const mandate = await gcPost<{ id: string }>("/mandates", "mandates", {
      scheme: "bacs",
      links: { customer_bank_account: bankAccount.id },
    });
    const payment = await gcPost<{ id: string }>("/payments", "payments", {
      amount: 1234,
      currency: "GBP",
      description: "PayFanout integration lifecycle",
      metadata: { payfanout_id: "int-gc-real-1" },
      links: { mandate: mandate.id },
    });

    // A freshly charged mandate is money underway, never instant success.
    const pending = await adapter.retrievePayment(payment.id);
    expect(pending.status).toBe("processing");
    expect(pending.amount).toBe(1234);
    expect(pending.id).toBe("int-gc-real-1"); // metadata round-trip
    expect(pending.mandateReference).toBeTruthy();

    // payment_confirmed requires an activated mandate — activate it first.
    await gcPost("/scenario_simulators/mandate_activated/actions/run", "data", {
      links: { resource: mandate.id },
    });
    await gcPost("/scenario_simulators/payment_confirmed/actions/run", "data", {
      links: { resource: payment.id },
    });

    const confirmed = await adapter.retrievePayment(payment.id);
    expect(confirmed.status).toBe("succeeded");
    expect(confirmed.paymentMethodType).toBe("bacs_debit");

    // Refunds are account-gated: enabled -> a real refund lands; disabled ->
    // the actionable invalid_request. The adapter's contract holds either way.
    try {
      const refund = await adapter.refundPayment({
        pspPaymentId: payment.id,
        amount: 200,
        idempotencyKey: key(),
      });
      expect(["pending", "succeeded"]).toContain(refund.status);
      expect((await adapter.retrievePayment(payment.id)).amountRefunded).toBe(200);
    } catch (err) {
      expect(err).toMatchObject({ code: "invalid_request" });
      expect(String((err as Error).message)).toMatch(/refund/i);
    }
  });
});

describeIf("GoCardless sandbox integration", () => {
  it("creates a billing request + hosted flow and retrieves it via the session id", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      id: "int-gc-order-1",
      amount: 1099,
      currency: "GBP",
      returnUrl: RETURN_URL,
      statementDescriptor: "PayFanout integration",
      idempotencyKey: key(),
    });
    expect(session.pspSessionId).toMatch(/^BRQ/);
    expect(session.clientSecret).toMatch(/^https:\/\/pay(-sandbox)?\.gocardless\.com\//);
    expect(session.status).toBe("requires_action");
    expect(session.amount).toBe(1099);

    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(isUnifiedPaymentStatus(info.status)).toBe(true);
    expect(info.status).toBe("requires_action"); // no browser completed the flow
    expect(info.id).toBe("int-gc-order-1"); // payfanout_id round-trips via metadata
    expect(info.amount).toBe(1099);
    expect(info.currency).toBe("GBP");
  });

  it("replays the same idempotency key onto the same billing request", async () => {
    const adapter = makeAdapter();
    const input = { amount: 2599, currency: "GBP", returnUrl: RETURN_URL, idempotencyKey: key() };
    const first = await adapter.createPaymentSession(input);
    const second = await adapter.createPaymentSession(input);
    expect(second.pspSessionId).toBe(first.pspSessionId);
    // GoCardless re-issues flows per create (sandbox-verified 2026-07-07):
    // the Idempotency-Key dedupes the billing request, but each replay
    // returns a fresh authorisation_url — either URL authorises the same
    // billing request, so both just have to be valid hosted-flow URLs.
    expect(first.clientSecret).toMatch(/^https:\/\/pay(-sandbox)?\.gocardless\.com\//);
    expect(second.clientSecret).toMatch(/^https:\/\/pay(-sandbox)?\.gocardless\.com\//);
  });

  it("listRefunds passes the ?payment= filter server-side", async () => {
    const adapter = makeAdapter();
    // Sandbox-verified: GET /refunds?payment=<id> answers 200 with an empty
    // list for a payment without refunds — the server honors the filter
    // instead of rejecting the parameter.
    const result = await adapter.listRefunds({ pspPaymentId: "PM000000000000" });
    expect(result.refunds).toEqual([]);
  });

  it("cancels a billing request pre-fulfilment", async () => {
    const adapter = makeAdapter();
    const session = await adapter.createPaymentSession({
      amount: 500,
      currency: "GBP",
      returnUrl: RETURN_URL,
      idempotencyKey: key(),
    });
    const canceled = await adapter.cancelPayment(session.pspSessionId);
    expect(canceled.status).toBe("canceled");
    const info = await adapter.retrievePayment(session.pspSessionId);
    expect(info.status).toBe("canceled");
  });

  it("rejects unsupported one-off currencies locally", async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.createPaymentSession({
        amount: 500,
        currency: "USD",
        returnUrl: RETURN_URL,
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("pages events with the same normalizer webhooks use", async () => {
    const adapter = makeAdapter();
    const result = await adapter.fetchEvents({ limit: 5 });
    expect(Array.isArray(result.events)).toBe(true);
    for (const event of result.events) {
      expect(event.pspName).toBe("gocardless");
      expect(event.id).toMatch(/^EV/);
    }
  });
});
