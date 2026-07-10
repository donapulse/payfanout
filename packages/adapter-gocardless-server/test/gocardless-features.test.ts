import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isPayFanoutError, type UnifiedWebhookEventType } from "@payfanout/core";
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

    const fulfilling = await make();
    fake.setBillingRequestStatus(fulfilling, "fulfilling");
    expect((await adapter.retrievePayment(fulfilling)).status).toBe("requires_action");
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
      ["pay_to", "other"],
      ["becs", "other"],
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
    const cases: Array<[string, string, UnifiedWebhookEventType]> = [
      ["payments", "created", "payment.processing"],
      ["payments", "submitted", "payment.processing"],
      ["payments", "customer_approval_granted", "payment.processing"],
      ["payments", "resubmission_requested", "payment.processing"],
      ["payments", "confirmed", "payment.succeeded"],
      ["payments", "paid_out", "unknown"],
      ["payments", "failed", "payment.failed"],
      ["payments", "customer_approval_denied", "payment.failed"],
      ["payments", "late_failure_settled", "payment.failed"],
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
      // fulfilled = hosted flow completed, payment exists — money is underway.
      ["billing_requests", "fulfilled", "payment.processing"],
      ["billing_requests", "created", "unknown"],
      ["billing_requests", "cancelled", "unknown"],
      ["subscriptions", "created", "unknown"],
    ];
    for (const [resourceType, action, expected] of cases) {
      const [event] = parseGoCardlessWebhookEvents(
        JSON.stringify({
          events: [{ id: "EV1", created_at: "2026-07-07T10:00:00.000Z", resource_type: resourceType, action, links: {} }],
        }),
      );
      expect(event!.type, `${resourceType}/${action}`).toBe(expected);
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

  it("takes pspPaymentId from links.payment, else links.payment_request_payment", () => {
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
    const [bare] = parseGoCardlessWebhookEvents(
      JSON.stringify({ events: [{ id: "EV2", resource_type: "mandates", action: "created" }] }),
    );
    expect(bare!.pspPaymentId).toBeUndefined();
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

    const all = await adapter.listPayments({ limit: 1 });
    expect(all.payments).toHaveLength(1);
    expect(all.payments[0]!.pspPaymentId).toBe(early.id);
    expect(all.nextCursor).toBe(early.id);
    const rest = await adapter.listPayments({ limit: 1, cursor: all.nextCursor! });
    expect(rest.payments[0]!.pspPaymentId).toBe(late.id);
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
