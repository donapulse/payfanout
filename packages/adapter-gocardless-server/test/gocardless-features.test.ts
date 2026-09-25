import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  isPayFanoutError,
  type CreatePaymentSessionInput,
  type RefundResult,
  type UnifiedWebhookEventType,
} from "@payfanout/core";
import {
  GoCardlessServerAdapter,
  mapGoCardlessError,
  parseGoCardlessWebhookEvents,
  verifyGoCardlessWebhookSignature,
  type GoCardlessServerAdapterConfig,
} from "../src/index.js";
import { FakeGoCardlessApi } from "./fake-gocardless-api.js";

const WEBHOOK_SECRET = "fake-webhook-endpoint-secret";
const RETURN_URL = "https://merchant.example/return";

function makePair(config: Partial<GoCardlessServerAdapterConfig> = {}): {
  adapter: GoCardlessServerAdapter;
  fake: FakeGoCardlessApi;
} {
  const fake = new FakeGoCardlessApi();
  const adapter = new GoCardlessServerAdapter({
    accessToken: "fake-sandbox-access-token",
    environment: "sandbox",
    webhookSecret: WEBHOOK_SECRET,
    fetch: fake.fetch,
    sleep: async () => {},
    ...config,
  });
  return { adapter, fake };
}

// Byte-exact fixtures from the GoCardless docs (single event) and a
// deterministic two-event batch; signatures independently computed with
// openssl. They pin our WebCrypto HMAC-hex to the reference output.
const TWO_EVENT_BODY =
  '{"events":[{"id":"EV0001TESTBATCH1","created_at":"2026-07-07T10:00:00.000Z","resource_type":"payments","action":"confirmed","links":{"payment":"PM123"},"details":{"origin":"gocardless","cause":"payment_confirmed","description":"Enough time has passed since the payment was submitted for the banks to return an error, so this payment is now confirmed."}},{"id":"EV0002TESTBATCH2","created_at":"2026-07-07T10:00:00.000Z","resource_type":"payments","action":"failed","links":{"payment":"PM456"},"details":{"origin":"bank","cause":"insufficient_funds","description":"The customer\'s account had insufficient funds to make this payment.","scheme":"bacs","reason_code":"ARUDD-0","will_attempt_retry":false}}]}';
const TWO_EVENT_SIG_SECRET_1 = "c758f9c26e9bf429e93891e4bbf75894fe669b6f81fcc765d74585171ae44f3f";
const TWO_EVENT_SIG_SECRET_2 = "0021d24d52247c0db15a40171864c36d25c085cf58f4d5a9a238c137e0cf84a2";
const SINGLE_EVENT_BODY =
  '{"events":[{"id":"EV123","created_at":"2014-08-04T12:00:00.000Z","action":"cancelled","resource_type":"mandates","links":{"mandate":"MD123","organisation":"OR123"},"details":{"origin":"bank","cause":"bank_account_disabled","description":"Your customer closed their bank account.","scheme":"bacs","reason_code":"ADDACS-B"}}]}';
const SINGLE_EVENT_SIG = "d62f67f03929fa7fb6dc8449336a5967471532ae6acf50072061cdb8e5beaab2";

describe("GoCardless config validation", () => {
  it("rejects missing/invalid config eagerly", () => {
    expect(() => makePair({ accessToken: "" })).toThrowError(/accessToken/);
    expect(() => makePair({ environment: "production" as never })).toThrowError(/sandbox.*live/);
    expect(() => makePair({ webhookSecret: [] })).toThrowError(/webhookSecret/);
    expect(() => makePair({ webhookSecret: ["", ""] })).toThrowError(/webhookSecret/);
    expect(() => makePair({ requestTimeoutMs: 0 })).toThrowError(/requestTimeoutMs/);
    expect(() => makePair({ maxNetworkRetries: -1 })).toThrowError(/maxNetworkRetries/);
    expect(() => makePair({ maxNetworkRetries: 1.5 })).toThrowError(/maxNetworkRetries/);
  });

  it("selects the host from the explicit environment, never from the credential", async () => {
    const seen: string[] = [];
    const fetchSpy: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ payments: { id: "PM1" } }), { status: 200 });
    };
    const sandbox = new GoCardlessServerAdapter({
      accessToken: "fake-token",
      environment: "sandbox",
      webhookSecret: "s",
      fetch: fetchSpy,
    });
    await sandbox.retrievePayment("PM1");
    const live = new GoCardlessServerAdapter({
      accessToken: "fake-token",
      environment: "live",
      webhookSecret: "s",
      fetch: fetchSpy,
    });
    await live.retrievePayment("PM1");
    expect(seen[0]).toMatch(/^https:\/\/api-sandbox\.gocardless\.com\//);
    expect(seen[1]).toMatch(/^https:\/\/api\.gocardless\.com\//);
  });

  it("pins the GoCardless-Version header and allows overriding it", async () => {
    let headers: Record<string, string> | undefined;
    const fetchSpy: typeof fetch = async (_input, init) => {
      headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ payments: { id: "PM1" } }), { status: 200 });
    };
    const { adapter } = makePair({ fetch: fetchSpy });
    await adapter.retrievePayment("PM1");
    expect(headers?.["gocardless-version"]).toBe("2015-07-06");
    expect(headers?.["authorization"]).toBe("Bearer fake-sandbox-access-token");

    const pinned = new GoCardlessServerAdapter({
      accessToken: "fake-token",
      environment: "sandbox",
      webhookSecret: "s",
      goCardlessVersion: "2030-01-01",
      fetch: fetchSpy,
    });
    await pinned.retrievePayment("PM1");
    expect(headers?.["gocardless-version"]).toBe("2030-01-01");
  });
});

describe("GoCardless status mapping", () => {
  const cases: Array<[string, string]> = [
    ["pending_customer_approval", "requires_action"],
    ["pending_submission", "processing"],
    ["submitted", "processing"],
    ["confirmed", "succeeded"],
    ["paid_out", "succeeded"],
    ["cancelled", "canceled"],
    ["failed", "failed"],
    ["customer_approval_denied", "failed"],
    ["charged_back", "failed"],
    ["something_new", "processing"],
  ];
  for (const [gcStatus, expected] of cases) {
    it(`maps payment status ${gcStatus} -> ${expected}`, async () => {
      const { adapter, fake } = makePair();
      const payment = fake.seedPayment({ status: gcStatus });
      const info = await adapter.retrievePayment(payment.id);
      expect(info.status).toBe(expected);
    });
  }

  it("maps billing request states before a payment exists", async () => {
    const { adapter, fake } = makePair();
    const make = (): Promise<string> =>
      adapter
        .createPaymentSession({
          amount: 100,
          currency: "GBP",
          returnUrl: RETURN_URL,
          idempotencyKey: `k-${Math.random()}`,
        })
        .then((s) => s.pspSessionId);

    const pending = await make();
    expect((await adapter.retrievePayment(pending)).status).toBe("requires_action");

    const cancelled = await make();
    await adapter.cancelPayment(cancelled, "k-cancel-br");
    expect((await adapter.retrievePayment(cancelled)).status).toBe("canceled");

    // Fulfilled with the payment link not landed yet = money is underway.
    const fulfilled = await make();
    fake.setBillingRequestStatus(fulfilled, "fulfilled");
    expect((await adapter.retrievePayment(fulfilled)).status).toBe("processing");

    // Ready to fulfil means every action required to fulfil, bank
    // authorisation on Pay by Bank, is done. Reporting requires_action here
    // would invite the payer to authorise the same payment again.
    for (const status of ["ready_to_fulfil", "fulfilling"]) {
      const id = await make();
      fake.setBillingRequestStatus(id, status);
      expect((await adapter.retrievePayment(id)).status, status).toBe("processing");
    }

    const undocumented = await make();
    fake.setBillingRequestStatus(undocumented, "something_new");
    expect((await adapter.retrievePayment(undocumented)).status).toBe("processing");
  });

  it("maps schemes onto unified payment method types", async () => {
    const { adapter, fake } = makePair();
    const cases: Array<[string | undefined, string]> = [
      ["bacs", "bacs_debit"],
      ["sepa_core", "sepa_debit"],
      ["ach", "ach"],
      ["faster_payments", "bank_redirect_generic"],
      ["sepa_credit_transfer", "bank_redirect_generic"],
      ["sepa_instant_credit_transfer", "bank_redirect_generic"],
      [undefined, "bank_redirect_generic"],
      // Canadian Pre-Authorized Debit has its own unified type.
      ["pad", "pad"],
      ["pay_to", "other"],
      ["becs", "other"],
      ["becs_nz", "other"],
      ["autogiro", "other"],
      ["betalingsservice", "other"],
    ];
    for (const [scheme, expected] of cases) {
      const payment = fake.seedPayment({ scheme });
      const info = await adapter.retrievePayment(payment.id);
      expect(info.paymentMethodType, String(scheme)).toBe(expected);
    }
  });

  it("falls back deterministically when the PSP omits optional payment fields", async () => {
    const { adapter, fake } = makePair();
    const payment = fake.seedPayment({
      amount: undefined,
      amount_refunded: undefined,
      currency: undefined,
      created_at: undefined,
      status: undefined,
    });
    const info = await adapter.retrievePayment(payment.id);
    expect(info).toMatchObject({
      amount: 0,
      amountRefunded: 0,
      currency: "GBP",
      status: "processing",
      createdAt: "1970-01-01T00:00:00.000Z",
    });
  });
});

describe("GoCardless error mapping", () => {
  it("maps the documented failure families onto the taxonomy", () => {
    const rate = mapGoCardlessError(429, { error: { type: "invalid_api_usage" } });
    expect(rate).toMatchObject({ code: "rate_limited", retryable: true });

    const down = mapGoCardlessError(503, { error: { type: "gocardless" } });
    expect(down).toMatchObject({ code: "psp_unavailable", retryable: true });

    // type "gocardless" marks internal errors even off the 5xx family.
    const internal = mapGoCardlessError(200, { error: { type: "gocardless" } });
    expect(internal).toMatchObject({ code: "psp_unavailable", retryable: true });

    const auth = mapGoCardlessError(401, { error: { type: "invalid_api_usage" } });
    expect(auth.code).toBe("invalid_request");
    expect(auth.message).toMatch(/access token/);

    const forbidden = mapGoCardlessError(403, { error: { type: "invalid_api_usage" } }, "/payments/PM1");
    expect(forbidden.message).toMatch(/permission/);

    const refundsOff = mapGoCardlessError(403, { error: { type: "invalid_api_usage" } }, "/refunds");
    expect(refundsOff.message).toMatch(/Refunds are not enabled/);

    for (const status of [400, 404, 409, 422]) {
      const err = mapGoCardlessError(status, { error: { type: "invalid_state" } });
      expect(err, String(status)).toMatchObject({ code: "invalid_request", retryable: false });
    }

    // Non-JSON bodies (gateway HTML, plain text) stay on raw untouched.
    const text = mapGoCardlessError(502, "Bad gateway");
    expect(text.code).toBe("psp_unavailable");
    expect(text.raw).toBe("Bad gateway");
    expect(text.pspName).toBe("gocardless");
  });

  it("preserves the raw envelope on API rejections", async () => {
    const { adapter, fake } = makePair();
    fake.failNextWith(422, {
      error: {
        message: "Validation failed",
        type: "validation_failed",
        code: 422,
        errors: [{ field: "amount", message: "must be greater than 0" }],
      },
    });
    try {
      await adapter.retrievePayment("PM1");
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("invalid_request");
        expect((err.raw as { error: { type: string } }).error.type).toBe("validation_failed");
      }
    }
  });
});

describe("GoCardless verifyCredentials (Test connection probe)", () => {
  it("returns ok from a single read-only probe when the credentials authenticate", async () => {
    const { adapter, fake } = makePair();
    await expect(adapter.verifyCredentials()).resolves.toEqual({ ok: true });
    // A cheap read-only GET, and exactly one HTTP round-trip.
    expect(fake.lastRequestUrl).toContain("/payments?limit=1");
    expect(fake.callCount).toBe(1);
  });

  it("classifies auth from the raw status, even when the error body omits error.code", async () => {
    // The probe reads the HTTP status line, not error.code — so a 401/403 whose
    // body lacks a numeric code (proxy/edge error page, non-JSON) is still auth.
    const cases: Array<{ status: number; body: unknown }> = [
      { status: 401, body: { error: { message: "Access token not found", type: "invalid_api_usage", code: 401 } } },
      { status: 401, body: { error: { message: "Access token not found" } } }, // no numeric error.code
      { status: 401, body: "Unauthorized" }, // a non-JSON proxy/edge body
      { status: 403, body: { error: { message: "forbidden" } } }, // permission, code omitted
    ];
    for (const { status, body } of cases) {
      const { adapter, fake } = makePair();
      fake.failNextWith(status, body);
      const result = await adapter.verifyCredentials();
      expect(result, `${status} ${JSON.stringify(body)}`).toMatchObject({ ok: false, category: "auth" });
      // The token must never leak into the surfaced result.
      expect(JSON.stringify(result)).not.toContain("fake-sandbox-access-token");
      // A bad key is never replayed — one shot, no transport-retry hang.
      expect(fake.callCount).toBe(1);
    }
  });

  it("classifies a transport failure, rate limiting, and 5xx as a network failure", async () => {
    const down = makePair();
    down.fake.failNextWithNetworkError();
    await expect(down.adapter.verifyCredentials()).resolves.toMatchObject({ ok: false, category: "network" });

    const throttled = makePair();
    throttled.fake.failNextWith(429, { error: { message: "slow down", type: "invalid_api_usage", code: 429 } });
    await expect(throttled.adapter.verifyCredentials()).resolves.toMatchObject({ ok: false, category: "network" });

    const outage = makePair();
    outage.fake.failNextWith(503, { error: { message: "down", type: "gocardless", code: 503 } });
    await expect(outage.adapter.verifyCredentials()).resolves.toMatchObject({ ok: false, category: "network" });
    // 5xx is the classic hang case — the single-shot probe must not retry it.
    expect(outage.fake.callCount).toBe(1);
  });
});

describe("GoCardless webhook signature", () => {
  it("verifies the docs fixture byte-exactly against the reference HMAC", async () => {
    const { adapter } = makePair({ webhookSecret: "my_webhook_secret" });
    await expect(
      adapter.verifyWebhookSignature(SINGLE_EVENT_BODY, { "webhook-signature": SINGLE_EVENT_SIG }),
    ).resolves.toBe(true);
    // One flipped byte must fail.
    const tampered = SINGLE_EVENT_BODY.replace("MD123", "MD124");
    await expect(
      adapter.verifyWebhookSignature(tampered, { "webhook-signature": SINGLE_EVENT_SIG }),
    ).resolves.toBe(false);
  });

  it("accepts any active secret during rotation, case-insensitive header lookup", async () => {
    const { adapter } = makePair({ webhookSecret: ["WEBHOOK_SECRET_1", "WEBHOOK_SECRET_2"] });
    await expect(
      adapter.verifyWebhookSignature(TWO_EVENT_BODY, { "Webhook-Signature": TWO_EVENT_SIG_SECRET_1 }),
    ).resolves.toBe(true);
    await expect(
      adapter.verifyWebhookSignature(TWO_EVENT_BODY, { "webhook-signature": TWO_EVENT_SIG_SECRET_2 }),
    ).resolves.toBe(true);
    const wrongKey = createHmac("sha256", "some-other-secret").update(TWO_EVENT_BODY, "utf8").digest("hex");
    await expect(
      adapter.verifyWebhookSignature(TWO_EVENT_BODY, { "webhook-signature": wrongKey }),
    ).resolves.toBe(false);
  });

  it("rejects a reserialized body, a missing header, and an empty body without throwing", async () => {
    const { adapter } = makePair({ webhookSecret: "WEBHOOK_SECRET_1" });
    const reserialized = JSON.stringify(JSON.parse(TWO_EVENT_BODY), null, 2);
    await expect(
      adapter.verifyWebhookSignature(reserialized, { "webhook-signature": TWO_EVENT_SIG_SECRET_1 }),
    ).resolves.toBe(false);
    await expect(adapter.verifyWebhookSignature(TWO_EVENT_BODY, {})).resolves.toBe(false);
    await expect(
      adapter.verifyWebhookSignature("", { "webhook-signature": TWO_EVENT_SIG_SECRET_1 }),
    ).resolves.toBe(false);
  });

  it("ignores empty entries in the secrets list", async () => {
    await expect(
      verifyGoCardlessWebhookSignature(TWO_EVENT_BODY, { "webhook-signature": TWO_EVENT_SIG_SECRET_1 }, [
        "",
        "WEBHOOK_SECRET_1",
      ]),
    ).resolves.toBe(true);
    await expect(
      verifyGoCardlessWebhookSignature(TWO_EVENT_BODY, { "webhook-signature": TWO_EVENT_SIG_SECRET_1 }, [""]),
    ).resolves.toBe(false);
  });
});

describe("GoCardless webhook parsing (batched deliveries)", () => {
  it("fans a batched delivery out into N normalized events, order preserved, ids stable", () => {
    const events = parseGoCardlessWebhookEvents(TWO_EVENT_BODY);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: "EV0001TESTBATCH1",
      pspName: "gocardless",
      type: "payment.succeeded",
      pspPaymentId: "PM123",
      occurredAt: "2026-07-07T10:00:00.000Z",
    });
    expect(events[1]).toMatchObject({ id: "EV0002TESTBATCH2", type: "payment.failed", pspPaymentId: "PM456" });
    const again = parseGoCardlessWebhookEvents(TWO_EVENT_BODY);
    expect(again.map((e) => e.id)).toEqual(events.map((e) => e.id));
  });

  it("parseWebhookEvent refuses multi-event deliveries with guidance instead of dropping events", async () => {
    const { adapter } = makePair();
    try {
      await adapter.parseWebhookEvent(TWO_EVENT_BODY);
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("invalid_request");
        expect(err.message).toMatch(/contains 2 events/);
        expect(err.message).toMatch(/parseGoCardlessWebhookEvents/);
        // raw is the untouched PSP payload, per the core error contract.
        expect(err.raw).toBe(TWO_EVENT_BODY);
      }
    }
  });

  it("parseWebhookEvent rejects empty deliveries and non-delivery JSON", async () => {
    const { adapter } = makePair();
    await expect(adapter.parseWebhookEvent(JSON.stringify({ events: [] }))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(adapter.parseWebhookEvent(JSON.stringify({ hello: 1 }))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(adapter.parseWebhookEvent("42")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("maps every documented action family onto the unified vocabulary", () => {
    const cases: Array<[string, string, UnifiedWebhookEventType, Record<string, string>?]> = [
      ["payments", "created", "payment.processing"],
      ["payments", "submitted", "payment.processing"],
      ["payments", "customer_approval_granted", "payment.processing"],
      ["payments", "resubmission_requested", "payment.processing"],
      ["payments", "confirmed", "payment.succeeded"],
      ["payments", "paid_out", "unknown"],
      ["payments", "failed", "payment.failed"],
      ["payments", "customer_approval_denied", "payment.failed"],
      // The failure itself arrived as payments/failed; this is the payout debit.
      ["payments", "late_failure_settled", "unknown"],
      ["payments", "cancelled", "payment.canceled"],
      ["payments", "charged_back", "payment.chargeback"],
      ["payments", "chargeback_cancelled", "payment.chargeback_won"],
      ["payments", "chargeback_settled", "unknown"],
      ["payments", "surcharge_fee_debited", "unknown"],
      ["refunds", "created", "unknown"],
      ["refunds", "paid", "payment.refunded"],
      ["refunds", "refund_settled", "unknown"],
      ["refunds", "failed", "payment.refund_failed"],
      ["refunds", "bounced", "payment.refund_failed"],
      ["refunds", "funds_returned", "payment.refund_failed"],
      ["mandates", "cancelled", "unknown"],
      // Pay by Bank: the hosted flow completed and the event names the new payment.
      [
        "billing_requests",
        "fulfilled",
        "payment.processing",
        { billing_request: "BRQ1", payment_request_payment: "PM1" },
      ],
      // A mandate-only billing request fulfils into a mandate, not a payment.
      ["billing_requests", "fulfilled", "unknown", { billing_request: "BRQ1", mandate_request_mandate: "MD1" }],
      ["billing_requests", "created", "unknown"],
      ["billing_requests", "cancelled", "payment.canceled"],
      // The payer can return to the flow and authorise again.
      ["billing_requests", "bank_authorisation_denied", "unknown"],
      ["billing_requests", "failed", "unknown"],
      ["subscriptions", "created", "unknown"],
    ];
    for (const [resourceType, action, expected, links = {}] of cases) {
      const [event] = parseGoCardlessWebhookEvents(
        JSON.stringify({
          events: [{ id: "EV1", created_at: "2026-07-07T10:00:00.000Z", resource_type: resourceType, action, links }],
        }),
      );
      expect(event!.type, `${resourceType}/${action} ${JSON.stringify(links)}`).toBe(expected);
    }
  });

  it("carries the refund id on refund events and never invents money facts", () => {
    const [paid] = parseGoCardlessWebhookEvents(
      JSON.stringify({
        events: [
          {
            id: "EV_R1",
            created_at: "2026-07-07T10:00:00.000Z",
            resource_type: "refunds",
            action: "paid",
            links: { refund: "RF77", payment: "PM77" },
          },
        ],
      }),
    );
    expect(paid).toMatchObject({ type: "payment.refunded", refundId: "RF77", pspPaymentId: "PM77" });
    // GoCardless events carry no amount/currency — the normalizer must not guess.
    expect(paid!.amount).toBeUndefined();
    expect(paid!.currency).toBeUndefined();

    const [confirmed] = parseGoCardlessWebhookEvents(
      JSON.stringify({
        events: [{ id: "EV_P1", resource_type: "payments", action: "confirmed", links: { payment: "PM1" } }],
      }),
    );
    expect(confirmed!.refundId).toBeUndefined();
  });

  it("takes pspPaymentId from links.payment, then links.payment_request_payment, then the billing request", () => {
    const [fulfilled] = parseGoCardlessWebhookEvents(
      JSON.stringify({
        events: [
          {
            id: "EV1",
            resource_type: "billing_requests",
            action: "fulfilled",
            links: { billing_request: "BRQ1", payment_request_payment: "PM9" },
          },
        ],
      }),
    );
    expect(fulfilled!.pspPaymentId).toBe("PM9");
    // No payment yet: the billing request id, which retrievePayment accepts.
    const [denied] = parseGoCardlessWebhookEvents(
      JSON.stringify({
        events: [
          {
            id: "EV3",
            resource_type: "billing_requests",
            action: "bank_authorisation_denied",
            links: { billing_request: "BRQ7", bank_authorisation: "BAU7" },
          },
        ],
      }),
    );
    expect(denied).toMatchObject({ type: "unknown", pspPaymentId: "BRQ7" });
    // GoCardless's own examples carry payment_request_payment before fulfilment
    // too; a cancelled request created nothing, so it still names the request.
    const [cancelledWithLink] = parseGoCardlessWebhookEvents(
      JSON.stringify({
        events: [
          {
            id: "EV5",
            resource_type: "billing_requests",
            action: "cancelled",
            links: { billing_request: "BRQ5", payment_request_payment: "PM5" },
          },
        ],
      }),
    );
    expect(cancelledWithLink).toMatchObject({ type: "payment.canceled", pspPaymentId: "BRQ5" });
    const [bare] = parseGoCardlessWebhookEvents(
      JSON.stringify({ events: [{ id: "EV2", resource_type: "mandates", action: "created" }] }),
    );
    expect(bare!.pspPaymentId).toBeUndefined();
    // The billing request fallback belongs to billing request events only.
    const [otherResource] = parseGoCardlessWebhookEvents(
      JSON.stringify({
        events: [
          {
            id: "EV4",
            resource_type: "mandates",
            action: "created",
            links: { mandate: "MD8", billing_request: "BRQ8" },
          },
        ],
      }),
    );
    expect(otherResource!.pspPaymentId).toBeUndefined();
  });

  it("hashes a stable fallback id and normalizes missing timestamps", () => {
    const rawBody = JSON.stringify({
      events: [{ resource_type: "payments", action: "confirmed", links: { payment: "PM1" } }],
    });
    const [first] = parseGoCardlessWebhookEvents(rawBody);
    const [second] = parseGoCardlessWebhookEvents(rawBody);
    expect(first!.id).toMatch(/^gocardless_[0-9a-f]{8}$/);
    expect(second!.id).toBe(first!.id);
    expect(first!.occurredAt).toBe("1970-01-01T00:00:00.000Z");

    // Neither resource type nor action: surfaced as unknown, never dropped.
    const [bare] = parseGoCardlessWebhookEvents(JSON.stringify({ events: [{ id: "EV_BARE" }] }));
    expect(bare).toMatchObject({ id: "EV_BARE", type: "unknown" });
    expect(bare!.pspPaymentId).toBeUndefined();
  });

  it("throws invalid_request on unparseable payloads", () => {
    expect(() => parseGoCardlessWebhookEvents("this is not json")).toThrowError(/Unparseable/);
    try {
      parseGoCardlessWebhookEvents("null");
    } catch (err) {
      expect(isPayFanoutError(err) && err.code === "invalid_request").toBe(true);
    }
  });
});

describe("GoCardless billing request and late-failure events", () => {
  // Shapes follow GoCardless's billing request events guide and payment
  // events reference; the ids are local test values.
  const fulfilledPayByBank = {
    id: "EV_BRQ_FULFILLED_PBB",
    created_at: "2026-09-24T10:00:00.000Z",
    resource_type: "billing_requests",
    action: "fulfilled",
    links: {
      customer: "CU_TEST_1",
      customer_bank_account: "BA_TEST_1",
      payment_request_payment: "PM_TEST_1",
      billing_request: "BRQ_TEST_1",
    },
    details: {
      origin: "gocardless",
      cause: "billing_request_fulfilled",
      description: "This billing request has been fulfilled, and the resources have been created.",
    },
    metadata: {},
  };
  const fulfilledMandateOnly = {
    ...fulfilledPayByBank,
    id: "EV_BRQ_FULFILLED_MANDATE",
    links: {
      customer: "CU_TEST_2",
      customer_bank_account: "BA_TEST_2",
      mandate_request: "MRQ_TEST_2",
      mandate_request_mandate: "MD_TEST_2",
      billing_request: "BRQ_TEST_2",
    },
  };

  it("reports a Pay by Bank fulfilment as processing and a mandate-only fulfilment as unknown", async () => {
    const { adapter } = makePair();
    const payByBank = await adapter.parseWebhookEvent(JSON.stringify({ events: [fulfilledPayByBank] }));
    expect(payByBank).toMatchObject({
      id: "EV_BRQ_FULFILLED_PBB",
      type: "payment.processing",
      pspPaymentId: "PM_TEST_1",
    });

    const mandateOnly = await adapter.parseWebhookEvent(JSON.stringify({ events: [fulfilledMandateOnly] }));
    // Surfaced with its billing request, but no payment exists to call processing.
    expect(mandateOnly).toMatchObject({
      id: "EV_BRQ_FULFILLED_MANDATE",
      type: "unknown",
      pspPaymentId: "BRQ_TEST_2",
    });
    expect(mandateOnly.raw).toEqual(fulfilledMandateOnly);
  });

  it("reports a cancelled billing request as payment.canceled, agreeing with retrievePayment", async () => {
    const [cancelled] = parseGoCardlessWebhookEvents(
      JSON.stringify({
        events: [
          {
            id: "EV_BRQ_CANCELLED",
            created_at: "2026-09-24T10:05:00.000Z",
            resource_type: "billing_requests",
            action: "cancelled",
            links: { billing_request: "BRQ_TEST_3" },
            details: {
              origin: "api",
              cause: "billing_request_cancelled",
              description: "This billing request has been cancelled, none of the resources have been created.",
            },
            metadata: {},
          },
        ],
      }),
    );
    expect(cancelled).toMatchObject({ type: "payment.canceled", pspPaymentId: "BRQ_TEST_3" });

    // A session the adapter cancels: the polled event names the session id,
    // and reading that id back reports the same outcome.
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 1000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      idempotencyKey: "k-brq-cancel",
    });
    await adapter.cancelPayment(session.pspSessionId, "k-brq-cancel-action");
    const { events } = await adapter.fetchEvents();
    const canceled = events.filter((event) => event.type === "payment.canceled");
    expect(canceled.map((event) => event.pspPaymentId)).toEqual([session.pspSessionId]);
    expect((await adapter.retrievePayment(session.pspSessionId)).status).toBe("canceled");
  });

  it("reports a late failure once, on payments/failed, and not again on the payout debit", () => {
    const paymentEvent = (id: string, minute: number, action: string, details: Record<string, unknown>) => ({
      id,
      created_at: `2026-09-24T10:0${minute}:00.000Z`,
      resource_type: "payments",
      action,
      links: { payment: "PM_LATE" },
      details,
      metadata: {},
    });
    const events = parseGoCardlessWebhookEvents(
      JSON.stringify({
        events: [
          paymentEvent("EV_LATE_1", 0, "confirmed", { origin: "gocardless", cause: "payment_confirmed" }),
          paymentEvent("EV_LATE_2", 1, "paid_out", { origin: "gocardless", cause: "payment_paid_out" }),
          // Banks can report a failure after confirmed; the payment moves to failed.
          paymentEvent("EV_LATE_3", 2, "failed", {
            origin: "bank",
            cause: "refer_to_payer",
            scheme: "bacs",
            reason_code: "ARUDD-0",
            will_attempt_retry: false,
          }),
          paymentEvent("EV_LATE_4", 3, "late_failure_settled", {
            origin: "gocardless",
            cause: "late_failure_settled",
            description: "This late failed payment has been settled against a payout.",
          }),
        ],
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "payment.succeeded",
      "unknown",
      "payment.failed",
      "unknown",
    ]);
    expect(events.filter((event) => event.type === "payment.failed").map((event) => event.id)).toEqual([
      "EV_LATE_3",
    ]);
    // Still delivered, with its payment, for hosts that reconcile payouts.
    expect(events[3]).toMatchObject({ id: "EV_LATE_4", pspPaymentId: "PM_LATE" });
  });
});

describe("GoCardless event polling + listing", () => {
  it("fetchEvents pages through /events with cursors and the since filter", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 1000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      idempotencyKey: "k",
    });
    const { paymentId } = fake.fulfilBillingRequest(session.pspSessionId);
    fake.confirmPayment(paymentId);
    const failed = fake.seedPayment({ status: "pending_submission" });
    fake.failPayment(failed.id);

    const firstPage = await adapter.fetchEvents({ limit: 2 });
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.nextCursor).toBeDefined();
    const secondPage = await adapter.fetchEvents({ limit: 10, cursor: firstPage.nextCursor! });
    expect(secondPage.events.length).toBeGreaterThan(0);
    const ids = [...firstPage.events, ...secondPage.events].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates across pages

    // Polled events normalize exactly like their webhook twins would.
    const all = [...firstPage.events, ...secondPage.events];
    expect(all.find((e) => e.type === "payment.succeeded")?.pspPaymentId).toBe(paymentId);
    expect(all.find((e) => e.type === "payment.failed")?.pspPaymentId).toBe(failed.id);

    const since = new Date("2027-01-01T00:00:00.000Z");
    const later = await adapter.fetchEvents({ since });
    expect(later.events).toEqual([]);
    expect(later.nextCursor).toBeUndefined();
    expect(fake.lastRequestUrl).toContain("created_at%5Bgte%5D=2027-01-01T00%3A00%3A00.000Z");
  });

  it("listPayments filters by created_at and pages with cursors", async () => {
    const { adapter, fake } = makePair();
    const early = fake.seedPayment({ created_at: "2026-07-07T10:00:01.000Z" });
    const late = fake.seedPayment({ created_at: "2026-07-08T10:00:00.000Z" });

    // GoCardless lists newest first.
    const all = await adapter.listPayments({ limit: 1 });
    expect(all.payments).toHaveLength(1);
    expect(all.payments[0]!.pspPaymentId).toBe(late.id);
    expect(all.nextCursor).toBe(late.id);
    const rest = await adapter.listPayments({ limit: 1, cursor: all.nextCursor! });
    expect(rest.payments[0]!.pspPaymentId).toBe(early.id);
    expect(rest.nextCursor).toBeUndefined();

    const onlyLate = await adapter.listPayments({
      createdAfter: "2026-07-08T00:00:00.000Z",
      createdBefore: new Date("2026-07-09T00:00:00.000Z"),
    });
    expect(onlyLate.payments.map((p) => p.pspPaymentId)).toEqual([late.id]);
  });

  it("listRefunds scopes to one payment with the server-side ?payment= filter", async () => {
    const { adapter, fake } = makePair();
    for (const key of ["a", "b"]) {
      const session = await adapter.createPaymentSession({
        amount: 1000,
        currency: "GBP",
        returnUrl: RETURN_URL,
        idempotencyKey: `k-${key}`,
      });
      const { paymentId } = fake.fulfilBillingRequest(session.pspSessionId);
      fake.confirmPayment(paymentId);
      await adapter.refundPayment({ pspPaymentId: paymentId, amount: 100, idempotencyKey: `r-${key}` });
    }
    const everything = await adapter.listRefunds();
    expect(everything.refunds).toHaveLength(2);
    const targetPayment = everything.refunds[0]!.pspPaymentId!;
    const one = await adapter.listRefunds({ pspPaymentId: targetPayment });
    // The filter rides the query string (sandbox-verified) — GoCardless
    // scopes the list, the adapter no longer pages everything down.
    expect(fake.lastRequestUrl).toContain(`/refunds?payment=${targetPayment}`);
    expect(one.refunds).toHaveLength(1);
    expect(one.refunds[0]!.amount).toBe(100);
    expect(one.refunds[0]!.pspPaymentId).toBe(targetPayment);
  });

  it("clamps page sizes to GoCardless's documented 1-500 limit bounds", async () => {
    const seen: string[] = [];
    const fetchSpy: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response(
        JSON.stringify({ payments: [], refunds: [], events: [], meta: { cursors: {} } }),
        { status: 200 },
      );
    };
    const { adapter } = makePair({ fetch: fetchSpy });
    await adapter.listPayments({ limit: 1234 });
    await adapter.listRefunds({ limit: 0 });
    await adapter.fetchEvents({ limit: 2.9 });
    expect(seen.map((url) => new URL(url).searchParams.get("limit"))).toEqual(["500", "1", "2"]);
  });
});

describe("GoCardless payment request description", () => {
  // Sandbox-verified: GoCardless rejects payment requests without a
  // description ("can't be blank"), so the adapter must always send one.
  it("always sends one: statementDescriptor, then metadata.description, then a derived default", async () => {
    const { adapter, fake } = makePair();
    const descriptionOf = async (brId: string): Promise<string | undefined> => {
      const res = await fake.fetch(`https://api-sandbox.gocardless.com/billing_requests/${brId}`, {
        headers: { authorization: "Bearer fake-sandbox-access-token", "gocardless-version": "2015-07-06" },
      });
      const body = (await res.json()) as { billing_requests: { payment_request?: { description?: string } } };
      return body.billing_requests.payment_request?.description;
    };

    const bare = await adapter.createPaymentSession({
      amount: 1000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      idempotencyKey: "d-bare",
    });
    expect(await descriptionOf(bare.pspSessionId)).toBe("Payment");

    const withId = await adapter.createPaymentSession({
      id: "ord-9",
      amount: 1000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      idempotencyKey: "d-id",
    });
    expect(await descriptionOf(withId.pspSessionId)).toBe("Payment ord-9");

    const viaMetadata = await adapter.createPaymentSession({
      amount: 1000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      metadata: { description: "Invoice 7" },
      idempotencyKey: "d-meta",
    });
    expect(await descriptionOf(viaMetadata.pspSessionId)).toBe("Invoice 7");

    const viaDescriptor = await adapter.createPaymentSession({
      amount: 1000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      statementDescriptor: "ACME Order 42",
      metadata: { description: "Invoice 7" },
      idempotencyKey: "d-desc",
    });
    expect(await descriptionOf(viaDescriptor.pspSessionId)).toBe("ACME Order 42");
  });
});

describe("GoCardless idempotent-replay recovery", () => {
  it("replays a consumed session key onto the same billing request with a fresh flow", async () => {
    const { adapter, fake } = makePair();
    const input = { amount: 2599, currency: "GBP", returnUrl: RETURN_URL, idempotencyKey: "k-replay" };
    const first = await adapter.createPaymentSession(input);
    const second = await adapter.createPaymentSession(input);
    // GoCardless dedupes the billing request on the Idempotency-Key but never
    // flow creates (sandbox-verified) — a replay re-issues a fresh
    // authorisation URL for the SAME billing request, so the payment cannot
    // duplicate even though the clientSecret differs.
    expect(second.pspSessionId).toBe(first.pspSessionId);
    expect(second.clientSecret).not.toBe(first.clientSecret);
    expect(fake.uniqueBillingRequestCreations).toBe(1);
  });

  it("recovers the original refund when the Idempotency-Key was already consumed", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 1000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      idempotencyKey: "k",
    });
    const { paymentId } = fake.fulfilBillingRequest(session.pspSessionId);
    fake.confirmPayment(paymentId);

    const first = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 400, idempotencyKey: "r-same" });
    const replay = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 400, idempotencyKey: "r-same" });
    expect(replay.refundId).toBe(first.refundId);
    expect(fake.uniqueRefundCreations).toBe(1);
    // amount_refunded moved once, not twice.
    expect((await adapter.retrievePayment(paymentId)).amountRefunded).toBe(400);
  });

  it("does not treat other 409/422 invalid_state errors as replays", async () => {
    const { adapter, fake } = makePair();
    fake.failNextWith(409, {
      error: {
        message: "Conflict",
        type: "invalid_state",
        code: 409,
        errors: [{ reason: "some_other_conflict", message: "Conflict" }],
      },
    });
    await expect(
      adapter.createPaymentSession({ amount: 100, currency: "GBP", returnUrl: RETURN_URL, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("fails loudly when the flow response lacks an authorisation URL", async () => {
    let call = 0;
    const responses = [
      { billing_requests: { id: "BRQ1", status: "pending" } },
      { billing_request_flows: { id: "BRF1" } }, // no authorisation_url
    ];
    const { adapter } = makePair({
      fetch: (async () => new Response(JSON.stringify(responses[Math.min(call++, 1)]), { status: 201 })) as typeof fetch,
    });
    await expect(
      adapter.createPaymentSession({ amount: 100, currency: "GBP", returnUrl: RETURN_URL, idempotencyKey: "k" }),
    ).rejects.toThrowError(/authorisation URL/);
  });
});

/** A fake behind a fetch the test can intercept — answers the real API could lose or fail. */
function makeInterceptedPair(
  intercept: (request: { method: string; path: string }, forward: () => Promise<Response>) => Promise<Response>,
): { adapter: GoCardlessServerAdapter; fake: FakeGoCardlessApi } {
  const fake = new FakeGoCardlessApi();
  const adapter = new GoCardlessServerAdapter({
    accessToken: "fake-sandbox-access-token",
    environment: "sandbox",
    webhookSecret: WEBHOOK_SECRET,
    sleep: async () => {},
    fetch: (input, init) =>
      intercept({ method: init?.method ?? "GET", path: new URL(String(input)).pathname }, () =>
        fake.fetch(input, init),
      ),
  });
  return { adapter, fake };
}

const gocardlessDown = (): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify({ error: { message: "down", type: "gocardless", code: 503 } }), { status: 503 }),
  );

async function confirmedPayment(
  adapter: GoCardlessServerAdapter,
  fake: FakeGoCardlessApi,
  amount: number,
): Promise<string> {
  const session = await adapter.createPaymentSession({
    amount,
    currency: "GBP",
    returnUrl: RETURN_URL,
    idempotencyKey: `k-${Math.random()}`,
  });
  const { paymentId } = fake.fulfilBillingRequest(session.pspSessionId);
  fake.confirmPayment(paymentId);
  return paymentId;
}

describe("GoCardless session replays", () => {
  const input = { amount: 2599, currency: "GBP", returnUrl: RETURN_URL } as const;
  const flowCreates = (fake: FakeGoCardlessApi): number => fake.requestsTo("POST", "/billing_request_flows").length;

  it("reports the billing request's own status once the payer has authorised, with no new flow", async () => {
    const { adapter, fake } = makePair();
    for (const status of ["ready_to_fulfil", "fulfilling"]) {
      const request = { ...input, id: `order-${status}`, idempotencyKey: `k-${status}` };
      const first = await adapter.createPaymentSession(request);
      fake.setBillingRequestStatus(first.pspSessionId, status);
      const replay = await adapter.createPaymentSession(request);
      expect(replay, status).toEqual({
        id: `order-${status}`,
        pspName: "gocardless",
        pspSessionId: first.pspSessionId,
        amount: 2599,
        currency: "GBP",
        status: "processing",
      });
    }
    // Each billing request kept the one authorisation URL its first call minted.
    expect(flowCreates(fake)).toBe(2);
    expect(fake.uniqueBillingRequestCreations).toBe(2);
  });

  it("mints no flow when replaying a fulfilled or cancelled billing request", async () => {
    const { adapter, fake } = makePair();
    const paid = { ...input, idempotencyKey: "k-fulfilled" };
    const first = await adapter.createPaymentSession(paid);
    fake.fulfilBillingRequest(first.pspSessionId);
    const afterFulfilment = await adapter.createPaymentSession(paid);
    expect(afterFulfilment).toMatchObject({ pspSessionId: first.pspSessionId, amount: 2599, status: "processing" });
    expect(afterFulfilment.clientSecret).toBeUndefined();

    const dropped = { ...input, idempotencyKey: "k-cancelled" };
    const second = await adapter.createPaymentSession(dropped);
    await adapter.cancelPayment(second.pspSessionId, "k-cancel");
    const afterCancel = await adapter.createPaymentSession(dropped);
    expect(afterCancel).toMatchObject({ pspSessionId: second.pspSessionId, status: "canceled" });
    expect(afterCancel.clientSecret).toBeUndefined();

    expect(flowCreates(fake)).toBe(2);
    expect(fake.uniqueBillingRequestCreations).toBe(2);
  });

  it("reports the status of the payment the billing request created", async () => {
    const { adapter, fake } = makePair();
    const outcomes: Array<[string, (paymentId: string) => void, string]> = [
      ["failed", (paymentId) => fake.failPayment(paymentId), "failed"],
      ["confirmed", (paymentId) => fake.confirmPayment(paymentId), "succeeded"],
      // A replay carries no flow: a payment awaiting the customer's approval is waited on.
      ["awaiting approval", (paymentId) => fake.setPaymentStatus(paymentId, "pending_customer_approval"), "processing"],
    ];
    for (const [label, settle, status] of outcomes) {
      const request = { ...input, id: `order-${label}`, idempotencyKey: `k-${label}` };
      const first = await adapter.createPaymentSession(request);
      const { paymentId } = fake.fulfilBillingRequest(first.pspSessionId);
      settle(paymentId);
      await expect(adapter.createPaymentSession(request), label).resolves.toEqual({
        id: `order-${label}`,
        pspName: "gocardless",
        pspSessionId: first.pspSessionId,
        amount: 2599,
        currency: "GBP",
        status,
      });
      // One read of the payment, made by the replay.
      expect(fake.requestsTo("GET", `/payments/${paymentId}`), label).toHaveLength(1);
    }
    expect(flowCreates(fake)).toBe(3);
  });

  it("falls back to the billing request's status when the payment cannot be read", async () => {
    let paymentsDown = false;
    const { adapter, fake } = makeInterceptedPair((request, forward) =>
      paymentsDown && request.method === "GET" && request.path.startsWith("/payments/") ? gocardlessDown() : forward(),
    );
    const request = { ...input, idempotencyKey: "k-unreadable" };
    const first = await adapter.createPaymentSession(request);
    fake.failPayment(fake.fulfilBillingRequest(first.pspSessionId).paymentId);
    paymentsDown = true;
    const replay = await adapter.createPaymentSession(request);
    // The payment exists either way, so no second authorisation is offered.
    expect(replay).toMatchObject({ pspSessionId: first.pspSessionId, status: "processing" });
    expect(replay.clientSecret).toBeUndefined();
    expect(flowCreates(fake)).toBe(1);
  });

  it("rejects a reused key whose billing request is a different payment", async () => {
    const { adapter, fake } = makePair();
    const original = { ...input, id: "order-1", idempotencyKey: "k-reused" };
    const first = await adapter.createPaymentSession(original);
    const cases: Array<[Partial<CreatePaymentSessionInput>, string[]]> = [
      [{ amount: 2600 }, ["amount"]],
      [{ currency: "EUR" }, ["currency"]],
      [{ id: "order-2" }, ["id"]],
      [{ id: undefined }, ["id"]],
      [{ amount: 100, currency: "EUR" }, ["amount", "currency"]],
    ];
    for (const [change, mismatched] of cases) {
      const rejection = await adapter.createPaymentSession({ ...original, ...change }).catch((err: unknown) => err);
      expect(rejection, JSON.stringify(change)).toMatchObject({
        code: "invalid_request",
        retryable: false,
        pspName: "gocardless",
        message: expect.stringMatching(/^Idempotency key reused for a different payment/),
        raw: { billing_request: { id: first.pspSessionId }, mismatched },
      });
      // Hosts show the message to payers: the other payment's billing request id stays on raw.
      expect((rejection as Error).message).not.toContain(first.pspSessionId);
    }
    await expect(adapter.createPaymentSession({ ...original, amount: 2600 })).rejects.toThrowError(
      "Idempotency key reused for a different payment: the billing request created with it does not match " +
        "this request's amount. Use a fresh key for a new payment.",
    );
    // Nothing was created for the mismatches, and nobody got an authorisation URL for them.
    expect(fake.uniqueBillingRequestCreations).toBe(1);
    expect(flowCreates(fake)).toBe(1);
  });

  it("compares amounts across GoCardless's wire encodings and checks a mandate request's currency", async () => {
    const { adapter, fake } = makePair();
    const request = { ...input, idempotencyKey: "k-wire" };
    const first = await adapter.createPaymentSession(request);
    // The spec types amounts as integer or string.
    fake.setBillingRequestFields(first.pspSessionId, {
      payment_request: { amount: "2599", currency: "gbp", description: "Payment" },
      mandate_request: { currency: "GBP", scheme: "bacs" },
    });
    await expect(adapter.createPaymentSession(request)).resolves.toMatchObject({
      pspSessionId: first.pspSessionId,
      status: "requires_action",
    });

    fake.setBillingRequestFields(first.pspSessionId, { mandate_request: { currency: "EUR", scheme: "sepa_core" } });
    await expect(adapter.createPaymentSession(request)).rejects.toMatchObject({
      raw: { mismatched: ["mandate currency"] },
    });

    fake.setBillingRequestFields(first.pspSessionId, {
      payment_request: { amount: "25.99", currency: "GBP" },
      mandate_request: undefined,
    });
    await expect(adapter.createPaymentSession(request)).rejects.toMatchObject({ raw: { mismatched: ["amount"] } });

    // A mandate-only billing request under the key is not a payment at all.
    fake.setBillingRequestFields(first.pspSessionId, { payment_request: undefined });
    await expect(adapter.createPaymentSession(request)).rejects.toMatchObject({
      raw: { mismatched: ["amount", "currency"] },
    });
  });
});

/** The stamp the adapter writes into refund metadata, computed independently of its WebCrypto path. */
const keyStamp = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");

/** A fake whose GET /refunds answers with `listing.refunds` once it is set. */
function makeListingPair(): {
  adapter: GoCardlessServerAdapter;
  fake: FakeGoCardlessApi;
  listing: { refunds?: unknown[] };
} {
  const listing: { refunds?: unknown[] } = {};
  const { adapter, fake } = makeInterceptedPair((request, forward) =>
    listing.refunds && request.method === "GET" && request.path === "/refunds"
      ? Promise.resolve(new Response(JSON.stringify({ refunds: listing.refunds }), { status: 200 }))
      : forward(),
  );
  return { adapter, fake, listing };
}

describe("GoCardless refund replays", () => {
  const refundCreates = (fake: FakeGoCardlessApi) => fake.requestsTo("POST", "/refunds");

  it("stamps every refund with the SHA-256 of its key, next to the reason", async () => {
    const { adapter, fake } = makePair();
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    await adapter.refundPayment({
      pspPaymentId: paymentId,
      amount: 300,
      reason: "requested_by_customer",
      idempotencyKey: "r-reason",
    });
    await adapter.refundPayment({ pspPaymentId: paymentId, amount: 300, idempotencyKey: "r-bare" });
    expect(refundCreates(fake).map((request) => request.body?.["refunds"])).toMatchObject([
      { metadata: { reason: "requested_by_customer", payfanout_key_sha256: keyStamp("r-reason") } },
      { metadata: { payfanout_key_sha256: keyStamp("r-bare") } },
    ]);
    expect(Object.keys((refundCreates(fake)[1]?.body?.["refunds"] as { metadata: object }).metadata)).toEqual([
      "payfanout_key_sha256",
    ]);
  });

  it("returns the stamped original of a full refund that used up the payment, and sends nothing", async () => {
    const { adapter, fake } = makePair();
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    const request = { pspPaymentId: paymentId, reason: "requested_by_customer", idempotencyKey: "r-full" } as const;
    const first = await adapter.refundPayment(request);
    const replay = await adapter.refundPayment(request);
    expect(first).toMatchObject({ amount: 1000, raw: { metadata: { reason: "requested_by_customer" } } });
    expect(replay).toEqual(first);
    // Read back, never sent again.
    expect(refundCreates(fake)).toHaveLength(1);
    expect(fake.requestsTo("GET", "/refunds")).toHaveLength(1);
    expect(fake.uniqueRefundCreations).toBe(1);
    expect((await adapter.retrievePayment(paymentId)).amountRefunded).toBe(1000);
  });

  it("returns the original when a partial refund that used up the remainder is replayed", async () => {
    const { adapter, fake } = makePair();
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    const first = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 400, idempotencyKey: "r-1" });
    const last = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 600, idempotencyKey: "r-2" });
    await expect(
      adapter.refundPayment({ pspPaymentId: paymentId, amount: 600, idempotencyKey: "r-2" }),
    ).resolves.toEqual(last);
    await expect(
      adapter.refundPayment({ pspPaymentId: paymentId, amount: 400, idempotencyKey: "r-1" }),
    ).resolves.toEqual(first);
    expect(refundCreates(fake)).toHaveLength(2);
    expect(fake.uniqueRefundCreations).toBe(2);
  });

  it("refuses a new over-refund before it reaches GoCardless", async () => {
    const { adapter, fake } = makePair();
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    await expect(
      adapter.refundPayment({ pspPaymentId: paymentId, amount: 1500, idempotencyKey: "r-over" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/exceeds the remaining/) });
    await adapter.refundPayment({ pspPaymentId: paymentId, amount: 600, idempotencyKey: "r-1" });
    // No refund was created with this key for the request to be replaying.
    await expect(
      adapter.refundPayment({ pspPaymentId: paymentId, amount: 500, idempotencyKey: "r-2" }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
      message: expect.stringMatching(/Refund of 500 exceeds the remaining refundable amount/),
      raw: { id: paymentId, amount_refunded: 600 },
    });
    expect(refundCreates(fake)).toHaveLength(1);
    expect(fake.uniqueRefundCreations).toBe(1);
  });

  it("refuses a fresh key that repeats an existing refund, without sending it", async () => {
    const { adapter, fake } = makePair();
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    await adapter.refundPayment({ pspPaymentId: paymentId, amount: 600, idempotencyKey: "r-1" });
    // The same amount as the existing refund: only the stamp tells a replay from a new refund.
    await expect(
      adapter.refundPayment({ pspPaymentId: paymentId, amount: 600, idempotencyKey: "r-2" }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/Refund of 600 exceeds the remaining refundable amount/),
      raw: { id: paymentId, amount_refunded: 600 },
    });
    await adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r-rest" });
    await expect(
      adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r-rest-again" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/nothing left to refund/) });
    expect(refundCreates(fake)).toHaveLength(2);
    expect(fake.uniqueRefundCreations).toBe(2);
  });

  it("creates no second refund for a fresh key once the payment is fully refunded, whatever GoCardless checks", async () => {
    // An account that opted out of total_amount_confirmation, read as GoCardless
    // ignoring a supplied value, and no cap on the amount: the adapter's own
    // check is the only one left.
    const { adapter, fake } = makePair();
    fake.totalAmountConfirmationChecked = false;
    fake.refundCapEnforced = false;
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    await adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r-full" });
    await expect(
      adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r-full-fresh" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/nothing left to refund/) });
    expect(refundCreates(fake)).toHaveLength(1);

    const partlyRefunded = await confirmedPayment(adapter, fake, 1000);
    await adapter.refundPayment({ pspPaymentId: partlyRefunded, amount: 600, idempotencyKey: "r-600" });
    await expect(
      adapter.refundPayment({ pspPaymentId: partlyRefunded, amount: 600, idempotencyKey: "r-600-fresh" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/exceeds the remaining/) });

    expect(refundCreates(fake)).toHaveLength(2);
    expect(fake.uniqueRefundCreations).toBe(2);
    expect((await adapter.retrievePayment(paymentId)).amountRefunded).toBe(1000);
    expect((await adapter.retrievePayment(partlyRefunded)).amountRefunded).toBe(600);
  });

  it("rejects a stamped refund of another amount", async () => {
    const { adapter, fake } = makePair();
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    const original = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 700, idempotencyKey: "r-shared" });
    // 400 more exceeds what is left, so the key's refund is read back: it is for 700.
    const rejection = await adapter
      .refundPayment({ pspPaymentId: paymentId, amount: 400, idempotencyKey: "r-shared" })
      .catch((err: unknown) => err);
    expect(rejection).toMatchObject({
      code: "invalid_request",
      retryable: false,
      pspName: "gocardless",
      message:
        "Idempotency key reused for a different refund: the refund created with it does not match this " +
        "request's amount. Use a fresh key for a new refund.",
      raw: { refund: { id: original.refundId }, mismatched: ["amount"] },
    });
    expect(refundCreates(fake)).toHaveLength(1);
  });

  it("rejects a stamped refund of another payment", async () => {
    const { adapter, fake, listing } = makeListingPair();
    const first = await confirmedPayment(adapter, fake, 1000);
    const second = await confirmedPayment(adapter, fake, 1000);
    const original = await adapter.refundPayment({ pspPaymentId: first, idempotencyKey: "r-shared" });
    await adapter.refundPayment({ pspPaymentId: second, idempotencyKey: "r-second" });
    // The list is scoped to the payment, so the key's refund on the first payment is not there.
    await expect(
      adapter.refundPayment({ pspPaymentId: second, idempotencyKey: "r-shared" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/nothing left to refund/) });
    // An answer that ignored the filter still cannot pass the first payment's refund off as this one's.
    listing.refunds = [original.raw];
    await expect(
      adapter.refundPayment({ pspPaymentId: second, idempotencyKey: "r-shared" }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/^Idempotency key reused for a different refund/),
      raw: { refund: { id: original.refundId }, mismatched: ["payment"] },
    });
    expect(refundCreates(fake)).toHaveLength(2);
  });

  it("refuses a replay whose original carries no stamp, as before the stamp existed", async () => {
    const { adapter, fake } = makePair();
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    const request = { pspPaymentId: paymentId, reason: "duplicate", idempotencyKey: "r-old" } as const;
    const first = await adapter.refundPayment(request);
    // What an earlier adapter version sent: the reason alone.
    fake.setRefundFields(first.refundId, { metadata: { reason: "duplicate" } });
    await expect(adapter.refundPayment(request)).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/nothing left to refund/),
    });
    expect(refundCreates(fake)).toHaveLength(1);

    // Within the remainder the key still reaches GoCardless, which answers with the original.
    const other = await confirmedPayment(adapter, fake, 1000);
    const partial = await adapter.refundPayment({ pspPaymentId: other, amount: 300, idempotencyKey: "r-old-300" });
    fake.setRefundFields(partial.refundId, { metadata: undefined });
    await expect(
      adapter.refundPayment({ pspPaymentId: other, amount: 300, idempotencyKey: "r-old-300" }),
    ).resolves.toMatchObject({ refundId: partial.refundId, amount: 300 });
    expect(fake.uniqueRefundCreations).toBe(2);
  });

  it("matches a refused replay by its stamp alone, never by amount or recency", async () => {
    const { adapter, fake, listing } = makeListingPair();
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    const first = await adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r-full" });
    listing.refunds = [
      {
        id: "RF_NEWER",
        amount: 1000,
        created_at: "2099-01-01T00:00:00.000Z",
        links: { payment: paymentId },
        metadata: { payfanout_key_sha256: keyStamp("r-other") },
      },
      { id: "RF_UNSTAMPED", amount: 1000, created_at: "2098-01-01T00:00:00.000Z", links: { payment: paymentId } },
      // The original, its amount on the wire as a digit string.
      { ...(first.raw as object), amount: "1000" },
    ];
    await expect(adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r-full" })).resolves.toMatchObject({
      refundId: first.refundId,
      amount: 1000,
    });
    await expect(
      adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r-unknown" }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/nothing left to refund/) });
    expect(refundCreates(fake)).toHaveLength(1);
  });

  it("takes the newest refund when several carry the stamp", async () => {
    // A key reused after GoCardless stopped honouring it stamps a second refund.
    const { adapter, fake, listing } = makeListingPair();
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    const first = await adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r-full" });
    const stamped = first.raw as Record<string, unknown>;
    listing.refunds = [
      { ...stamped, id: "RF_UNDATED", created_at: undefined },
      { ...stamped, id: "RF_OLDER", created_at: "2026-01-01T00:00:00.000Z" },
      { ...stamped, id: "RF_NEWEST", created_at: "2026-03-01T00:00:00.000Z" },
      { ...stamped, id: "RF_MIDDLE", created_at: "2026-02-01T00:00:00.000Z" },
      { ...stamped, id: "RF_UNDATED_TOO", created_at: undefined },
    ];
    await expect(adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r-full" })).resolves.toMatchObject({
      refundId: "RF_NEWEST",
    });
  });

  it("rejects a reused refund key that belongs to another payment or amount", async () => {
    const { adapter, fake } = makePair();
    const first = await confirmedPayment(adapter, fake, 1000);
    const second = await confirmedPayment(adapter, fake, 1000);
    const original = await adapter.refundPayment({ pspPaymentId: first, amount: 300, idempotencyKey: "r-shared" });
    const rejection = await adapter
      .refundPayment({ pspPaymentId: second, amount: 300, idempotencyKey: "r-shared" })
      .catch((err: unknown) => err);
    expect(rejection).toMatchObject({
      code: "invalid_request",
      retryable: false,
      message: expect.stringMatching(/^Idempotency key reused for a different refund/),
      raw: { refund: { id: original.refundId }, mismatched: ["payment"] },
    });
    // Hosts show the message to payers: the other request's refund id stays on raw.
    expect((rejection as Error).message).not.toContain(original.refundId);
    await expect(
      adapter.refundPayment({ pspPaymentId: first, amount: 200, idempotencyKey: "r-shared" }),
    ).rejects.toMatchObject({ raw: { mismatched: ["amount"] } });
    // A full refund names no amount to compare, so the original stands.
    await expect(adapter.refundPayment({ pspPaymentId: first, idempotencyKey: "r-shared" })).resolves.toMatchObject({
      refundId: original.refundId,
      amount: 300,
    });
    expect(fake.uniqueRefundCreations).toBe(1);
    expect((await adapter.retrievePayment(second)).amountRefunded).toBe(0);
  });

  it("settles from the stamp a replay GoCardless rejects on its body", async () => {
    // Were GoCardless to validate the body before the key, a replay would come
    // back as a rejection, such as the five-refund limit, instead of a 409.
    const { adapter, fake } = makePair();
    fake.keyCheckedBeforeBody = false;
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    const refunds: RefundResult[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      refunds.push(await adapter.refundPayment({ pspPaymentId: paymentId, amount: 100, idempotencyKey: `r-${n}` }));
    }
    await expect(
      adapter.refundPayment({ pspPaymentId: paymentId, amount: 100, idempotencyKey: "r-3" }),
    ).resolves.toEqual(refunds[2]);
    await expect(
      adapter.refundPayment({ pspPaymentId: paymentId, amount: 100, idempotencyKey: "r-6" }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
      raw: { error: { type: "invalid_state", errors: [{ reason: "number_of_refunds_exceeded" }] } },
    });
    expect(fake.uniqueRefundCreations).toBe(5);
  });

  it("surfaces GoCardless's five-refund limit when the key checks first", async () => {
    const { adapter, fake } = makePair();
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    for (const n of [1, 2, 3, 4, 5]) {
      await adapter.refundPayment({ pspPaymentId: paymentId, amount: 100, idempotencyKey: `r-${n}` });
    }
    await expect(
      adapter.refundPayment({ pspPaymentId: paymentId, amount: 100, idempotencyKey: "r-6" }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      raw: { error: { errors: [{ reason: "number_of_refunds_exceeded" }] } },
    });
    // A payment holding refunds is read before each create (four here, then the sixth), and
    // the rejection was checked against the payment's refunds before it was rethrown.
    expect(fake.requestsTo("GET", "/refunds")).toHaveLength(6);
    expect(fake.uniqueRefundCreations).toBe(5);
  });

  it("rethrows GoCardless's rejection when the stamp lookup after it is refused for good", async () => {
    let listsForbidden = false;
    const { adapter, fake } = makeInterceptedPair((request, forward) =>
      listsForbidden && request.method === "GET" && request.path === "/refunds"
        ? Promise.resolve(
            new Response(JSON.stringify({ error: { message: "Forbidden", type: "invalid_api_usage", code: 403, errors: [] } }), {
              status: 403,
            }),
          )
        : forward(),
    );
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    fake.refundsEnabled = false;
    listsForbidden = true;
    await expect(adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r-off" })).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
      message: expect.stringMatching(/Refunds are not enabled/),
    });
  });

  it("keeps a rejected create retryable while the stamp lookup after it is down", async () => {
    let listsDown = false;
    const { adapter, fake } = makeInterceptedPair((request, forward) =>
      listsDown && request.method === "GET" && request.path === "/refunds" ? gocardlessDown() : forward(),
    );
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    fake.refundsEnabled = false;
    listsDown = true;
    const error = await adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r-off" }).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: "psp_unavailable", retryable: true });
    expect((error as { raw: { rejection: unknown } }).raw.rejection).toBeDefined();
  });

  it("reads back a refund made under a key GoCardless no longer honours, and creates no second one", async () => {
    const { adapter, fake } = makePair();
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    const first = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 300, idempotencyKey: "r-old" });
    fake.forgetIdempotencyKeys();
    const replay = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 300, idempotencyKey: "r-old" });
    expect(replay.refundId).toBe(first.refundId);
    expect(refundCreates(fake)).toHaveLength(1);
  });

  it("returns the refund whose create answer was lost, from its stamp", async () => {
    // Every answer to the create is lost, so the transport retries run out and only the stamp settles it.
    const { adapter, fake } = makeInterceptedPair(async (request, forward) => {
      const response = await forward();
      if (request.method === "POST" && request.path === "/refunds") throw new TypeError("socket hang up");
      return response;
    });
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    const refund = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 400, idempotencyKey: "r-lost" });
    expect(refund).toMatchObject({ amount: 400 });
    expect(fake.uniqueRefundCreations).toBe(1);
  });

  it("refuses an empty idempotency key before any request", async () => {
    const { adapter, fake } = makePair();
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    const before = fake.requestsTo("GET", `/payments/${paymentId}`).length;
    await expect(adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fake.requestsTo("GET", `/payments/${paymentId}`)).toHaveLength(before);
  });

  it("keeps a transient failure retryable when a refused request could be a replay", async () => {
    let listsDown = false;
    const { adapter, fake } = makeInterceptedPair((request, forward) =>
      listsDown && request.method === "GET" && request.path === "/refunds" ? gocardlessDown() : forward(),
    );
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    const first = await adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r-full" });
    listsDown = true;
    await expect(adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r-full" })).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
    });
    listsDown = false;
    await expect(adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r-full" })).resolves.toEqual(first);
    expect(refundCreates(fake)).toHaveLength(1);
  });

  it("keeps the refusal when the lookup is refused for good or lists nothing", async () => {
    let listAnswer: { status: number; body: unknown } | undefined;
    const { adapter, fake } = makeInterceptedPair((request, forward) =>
      listAnswer && request.method === "GET" && request.path === "/refunds"
        ? Promise.resolve(new Response(JSON.stringify(listAnswer.body), { status: listAnswer.status }))
        : forward(),
    );
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    await adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r-full" });
    const answers = [
      {
        status: 403,
        body: { error: { message: "Forbidden", type: "invalid_api_usage", code: 403, errors: [] } },
        raw: { payment: { id: paymentId }, lookup: { error: { code: 403 } } },
      },
      { status: 200, body: { meta: { cursors: {}, limit: 50 } }, raw: { id: paymentId } },
    ];
    for (const answer of answers) {
      listAnswer = answer;
      await expect(
        adapter.refundPayment({ pspPaymentId: paymentId, idempotencyKey: "r-full" }),
        String(answer.status),
      ).rejects.toMatchObject({
        code: "invalid_request",
        retryable: false,
        message: expect.stringMatching(/nothing left to refund/),
        raw: answer.raw,
      });
    }
    expect(refundCreates(fake)).toHaveLength(1);
  });
});

describe("GoCardless refund amounts", () => {
  it("rejects an explicit zero amount before any request", async () => {
    const { adapter, fake } = makePair();
    await expect(
      adapter.refundPayment({ pspPaymentId: "PM_any", amount: 0, idempotencyKey: "r-zero" }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
      message: "A refund amount must be greater than 0 — omit amount to refund what is left",
      raw: { amount: 0 },
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("reads payment amounts GoCardless sends as digit strings, and refuses unreadable ones before sending", async () => {
    let rewrite: ((payment: Record<string, unknown>) => Record<string, unknown>) | undefined;
    const { adapter, fake } = makeInterceptedPair(async (request, forward) => {
      const response = await forward();
      if (!rewrite || request.method !== "GET" || !/^\/payments\/[^/]+$/.test(request.path)) return response;
      const body = (await response.json()) as { payments: Record<string, unknown> };
      return new Response(JSON.stringify({ payments: rewrite(body.payments) }), { status: 200 });
    });
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    // The spec types amounts as integer or string.
    rewrite = (payment) => ({
      ...payment,
      amount: String(payment["amount"]),
      amount_refunded: String(payment["amount_refunded"]),
    });
    const first = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 400, idempotencyKey: "s-1" });
    const second = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 400, idempotencyKey: "s-2" });
    expect([first.amount, second.amount]).toEqual([400, 400]);
    expect(
      fake.requestsTo("POST", "/refunds").map((request) => (request.body?.["refunds"] as Record<string, unknown>)["total_amount_confirmation"]),
    ).toEqual([400, 800]);

    const unreadable: Array<Record<string, unknown>> = [
      { amount_refunded: "8.00" },
      { amount_refunded: -800 },
      { amount_refunded: null },
      { amount: "10.00" },
      { amount: undefined },
    ];
    for (const fields of unreadable) {
      rewrite = (payment) => ({ ...payment, ...fields });
      await expect(
        adapter.refundPayment({ pspPaymentId: paymentId, amount: 100, idempotencyKey: "s-3" }),
        JSON.stringify(fields),
      ).rejects.toMatchObject({ code: "unknown", retryable: false, pspName: "gocardless", raw: { id: paymentId } });
    }
    expect(fake.requestsTo("POST", "/refunds")).toHaveLength(2);
    // Only the second refund, on a payment already holding one, read the refunds first.
    expect(fake.requestsTo("GET", "/refunds")).toHaveLength(1);
  });

  it("reads a refund amount sent as a digit string, and fails closed on one that does not read", async () => {
    let echoedAmount: unknown;
    const { adapter, fake } = makeInterceptedPair(async (request, forward) => {
      const response = await forward();
      if (request.method !== "POST" || request.path !== "/refunds") return response;
      const body = (await response.json()) as { refunds: Record<string, unknown> };
      return new Response(JSON.stringify({ refunds: { ...body.refunds, amount: echoedAmount } }), { status: 201 });
    });
    const paymentId = await confirmedPayment(adapter, fake, 1000);
    echoedAmount = "400";
    await expect(
      adapter.refundPayment({ pspPaymentId: paymentId, amount: 400, idempotencyKey: "r-1" }),
    ).resolves.toMatchObject({ amount: 400 });
    echoedAmount = "4.00";
    await expect(
      adapter.refundPayment({ pspPaymentId: paymentId, amount: 400, idempotencyKey: "r-2" }),
    ).rejects.toMatchObject({ code: "unknown", retryable: false, raw: { amount: "4.00" } });
  });
});

describe("GoCardless cancel verification", () => {
  async function pendingPayment(adapter: GoCardlessServerAdapter, fake: FakeGoCardlessApi): Promise<string> {
    const session = await adapter.createPaymentSession({
      amount: 1000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      idempotencyKey: `k-${Math.random()}`,
    });
    return fake.fulfilBillingRequest(session.pspSessionId).paymentId; // pending_submission
  }

  it("resolves a repeated payment cancel as canceled — idempotency keys are documented for creates only", async () => {
    const { adapter, fake } = makePair();
    const paymentId = await pendingPayment(adapter, fake);
    const first = await adapter.cancelPayment(paymentId, "c-same");
    const second = await adapter.cancelPayment(paymentId, "c-same");
    expect(first.status).toBe("canceled");
    expect(second).toMatchObject({ status: "canceled", pspPaymentId: paymentId });
    // The repeat reached GoCardless and was refused; the re-read decided.
    expect(fake.requestsTo("POST", `/payments/${paymentId}/actions/cancel`)).toHaveLength(2);
    expect(fake.requestsTo("GET", `/payments/${paymentId}`)).toHaveLength(1);
  });

  it("resolves a repeated billing request cancel as canceled", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 1000,
      currency: "GBP",
      returnUrl: RETURN_URL,
      idempotencyKey: "k-brq",
    });
    await adapter.cancelPayment(session.pspSessionId, "c-1");
    await expect(adapter.cancelPayment(session.pspSessionId, "c-2")).resolves.toMatchObject({
      status: "canceled",
      pspPaymentId: session.pspSessionId,
    });
    expect(fake.requestsTo("POST", `/billing_requests/${session.pspSessionId}/actions/cancel`)).toHaveLength(2);
  });

  it("treats a cancel whose response was lost as done", async () => {
    // GoCardless cancelled the payment but the answer never arrived, so the
    // transport retry meets cancellation_failed.
    let dropNextCancelAnswer = true;
    const { adapter, fake } = makeInterceptedPair(async (request, forward) => {
      const response = await forward();
      if (dropNextCancelAnswer && request.method === "POST" && request.path.endsWith("/actions/cancel")) {
        dropNextCancelAnswer = false;
        throw new TypeError("connection reset");
      }
      return response;
    });
    const paymentId = await pendingPayment(adapter, fake);
    await expect(adapter.cancelPayment(paymentId, "c-lost")).resolves.toMatchObject({ status: "canceled" });
    expect(fake.requestsTo("POST", `/payments/${paymentId}/actions/cancel`)).toHaveLength(2);
  });

  it("rethrows the mapped rejection for a payment past cancellation", async () => {
    const { adapter, fake } = makePair();
    const paymentId = await pendingPayment(adapter, fake);
    fake.confirmPayment(paymentId);
    await expect(adapter.cancelPayment(paymentId, "c-late")).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
      raw: { error: { type: "invalid_state", errors: [{ reason: "cancellation_failed" }] } },
    });
    // Re-read, and not cancelled: the refusal stands.
    expect(fake.requestsTo("GET", `/payments/${paymentId}`)).toHaveLength(1);
  });

  it("rethrows the original rejection when the re-read fails", async () => {
    let readsDown = false;
    const { adapter, fake } = makeInterceptedPair((request, forward) =>
      readsDown && request.method === "GET" && request.path.startsWith("/payments/") ? gocardlessDown() : forward(),
    );
    const paymentId = await pendingPayment(adapter, fake);
    fake.confirmPayment(paymentId);
    readsDown = true;
    await expect(adapter.cancelPayment(paymentId, "c")).rejects.toMatchObject({
      code: "invalid_request",
      raw: { error: { errors: [{ reason: "cancellation_failed" }] } },
    });
  });

  it("rethrows a transport failure when the re-read shows the payment still pending", async () => {
    const { adapter, fake } = makePair();
    const paymentId = await pendingPayment(adapter, fake);
    // Three failures exhaust the POST and its two transport retries; nothing was cancelled.
    fake.failNextWith(500, { error: { message: "down", type: "gocardless", code: 500 } }, 3);
    await expect(adapter.cancelPayment(paymentId, "c")).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
    });
    expect((await adapter.retrievePayment(paymentId)).status).toBe("processing");
  });
});

describe("GoCardless transport retries", () => {
  const makeRetryingAdapter = (
    responses: Array<() => Promise<Response>>,
    config: Partial<GoCardlessServerAdapterConfig> = {},
  ): { adapter: GoCardlessServerAdapter; calls: () => number; sleeps: number[] } => {
    let call = 0;
    const sleeps: number[] = [];
    const adapter = new GoCardlessServerAdapter({
      accessToken: "fake-token",
      environment: "sandbox",
      webhookSecret: "s",
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

  // retrieveRefund is the one-request surface — call counts stay attempt counts.
  const ok = () =>
    Promise.resolve(
      new Response(JSON.stringify({ refunds: { id: "RF1", amount: 100, status: "paid" } }), { status: 200 }),
    );
  const http = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it("retries 5xx and network failures with backoff, then succeeds", async () => {
    const { adapter, calls, sleeps } = makeRetryingAdapter([
      () => http(503, { error: { message: "down", type: "gocardless", code: 503 } }),
      () => Promise.reject(new TypeError("fetch failed")),
      ok,
    ]);
    const refund = await adapter.retrieveRefund("RF1");
    expect(refund.status).toBe("succeeded");
    expect(calls()).toBe(3);
    expect(sleeps).toEqual([250, 500]);
  });

  it("gives up after maxNetworkRetries and surfaces the transport error", async () => {
    const { adapter, calls } = makeRetryingAdapter(
      [() => http(500, { error: { message: "down", type: "gocardless", code: 500 } })],
      { maxNetworkRetries: 1 },
    );
    await expect(adapter.retrieveRefund("RF1")).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
    });
    expect(calls()).toBe(2);
  });

  it("retries rate limiting (429) but never business errors", async () => {
    const rateLimited = makeRetryingAdapter([
      () => http(429, { error: { message: "slow down", type: "invalid_api_usage", code: 429 } }),
      ok,
    ]);
    await expect(rateLimited.adapter.retrieveRefund("RF1")).resolves.toMatchObject({ status: "succeeded" });
    expect(rateLimited.calls()).toBe(2);

    const invalid = makeRetryingAdapter([
      () => http(422, { error: { message: "nope", type: "validation_failed", code: 422 } }),
    ]);
    await expect(invalid.adapter.retrieveRefund("RF1")).rejects.toMatchObject({ code: "invalid_request" });
    expect(invalid.calls()).toBe(1);
  });

  it("maxNetworkRetries: 0 disables the retry loop entirely", async () => {
    const { adapter, calls } = makeRetryingAdapter(
      [() => http(503, { error: { message: "down", type: "gocardless", code: 503 } }), ok],
      { maxNetworkRetries: 0 },
    );
    await expect(adapter.retrieveRefund("RF1")).rejects.toMatchObject({ code: "psp_unavailable" });
    expect(calls()).toBe(1);
  });

  it("aborts a hung connection after requestTimeoutMs and reports it retryable", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const adapter = new GoCardlessServerAdapter({
      accessToken: "fake-token",
      environment: "sandbox",
      webhookSecret: "s",
      fetch: hanging,
      requestTimeoutMs: 5,
      maxNetworkRetries: 0,
    });
    await expect(adapter.retrieveRefund("RF1")).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
      message: expect.stringMatching(/did not respond within 5ms/),
    });
  });

  it("bounds the response BODY read with the timeout — headers alone do not disarm it", async () => {
    // Headers arrive immediately but the body stream never closes: without
    // the timer surviving until text(), this call would hang forever.
    const { adapter } = makeRetryingAdapter(
      [() => Promise.resolve(new Response(new ReadableStream({ start() {} })))],
      { requestTimeoutMs: 5, maxNetworkRetries: 0 },
    );
    await expect(adapter.retrieveRefund("RF1")).rejects.toMatchObject({
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
    await expect(adapter.retrieveRefund("RF1")).rejects.toMatchObject({
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
    // with node:crypto is asserted by the byte-exact signature fixtures above.
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
