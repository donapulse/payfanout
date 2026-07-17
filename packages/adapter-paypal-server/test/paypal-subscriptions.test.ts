import { describe, expect, it } from "vitest";
import { isPayFanoutError, type ServerPaymentAdapter } from "@payfanout/core";
import {
  mapPayPalSubscriptionStatus,
  PAYPAL_SUBSCRIPTION_CANCEL_REASON,
  PayPalServerAdapter,
  paypalSubscriptionToRecord,
  type PayPalServerAdapterConfig,
  type PayPalSubscriptionLike,
} from "../src/index.js";
import { FakePayPalApi } from "./fake-paypal-api.js";

function makePair(config: Partial<PayPalServerAdapterConfig> = {}): {
  adapter: PayPalServerAdapter;
  fake: FakePayPalApi;
} {
  const fake = new FakePayPalApi();
  const adapter = new PayPalServerAdapter({
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    environment: "sandbox",
    fetch: fake.fetch,
    sleep: async () => {},
    ...config,
  });
  return { adapter, fake };
}

/** Wraps the fake's fetch to record every request the adapter puts on the wire. */
function recordingPair(): {
  adapter: PayPalServerAdapter;
  fake: FakePayPalApi;
  requests: Array<{ url: URL; method: string; headers: Record<string, string>; body?: string }>;
} {
  const fake = new FakePayPalApi();
  const requests: Array<{ url: URL; method: string; headers: Record<string, string>; body?: string }> = [];
  const recording: typeof fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    if (!url.pathname.endsWith("/oauth2/token")) {
      requests.push({
        url,
        method: init?.method ?? "GET",
        headers,
        ...(init?.body !== undefined && init?.body !== null ? { body: String(init.body) } : {}),
      });
    }
    return fake.fetch(input, init);
  };
  const adapter = new PayPalServerAdapter({
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    environment: "sandbox",
    fetch: recording,
    sleep: async () => {},
  });
  return { adapter, fake, requests };
}

const OAUTH_OK = JSON.stringify({ access_token: "tok", token_type: "Bearer", expires_in: 3600 });

/** Adapter whose API answers OAuth normally and routes everything else through `respond`. */
function adapterWithResponder(respond: (url: URL) => Response): PayPalServerAdapter {
  return new PayPalServerAdapter({
    clientId: "id",
    clientSecret: "secret",
    environment: "sandbox",
    maxNetworkRetries: 0,
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("/v1/oauth2/token")) return new Response(OAUTH_OK, { status: 200 });
      return respond(url);
    }) as typeof fetch,
  });
}

/** A doc-shaped fields=plan subscription body for route stubs. */
function subscriptionBody(id: string, overrides: Partial<PayPalSubscriptionLike> = {}): PayPalSubscriptionLike {
  return {
    id,
    status: "ACTIVE",
    plan_id: "P-5ML4271244454362WXNWU5NQ",
    subscriber: { email_address: "subscriber@example.com", payer_id: "2J6QB8YJQSJRJ" },
    billing_info: {
      outstanding_balance: { currency_code: "USD", value: "0.0" },
      next_billing_time: "2026-08-01T10:00:00Z",
      failed_payments_count: 0,
    },
    plan: {
      billing_cycles: [
        {
          pricing_scheme: { fixed_price: { currency_code: "USD", value: "15.00" } },
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
        },
      ],
    },
    ...overrides,
  };
}

describe("PayPal native-subscription capabilities", () => {
  it("declares list/retrieve/cancel and, honestly, no server-only create", () => {
    const { adapter } = makePair();
    expect(adapter.getCapabilities().nativeSubscriptions).toEqual({
      list: true,
      retrieve: true,
      create: false,
      cancel: true,
    });
    // The method must be absent, not stubbed — capability validation keys on it.
    const contract: ServerPaymentAdapter = adapter;
    expect(contract.createNativeSubscription).toBeUndefined();
  });
});

describe("PayPal retrieveNativeSubscription", () => {
  it("maps the full record from the fields=plan detail GET", async () => {
    const { adapter, fake, requests } = recordingPair();
    const id = fake.seedSubscription({
      value: "19.90",
      currency: "EUR",
      intervalUnit: "MONTH",
      intervalCount: 3,
      customId: "sub-42",
      vaultId: "93a92571rv649072p",
    });
    const record = await adapter.retrieveNativeSubscription({ subscriptionId: id });
    expect(record).toMatchObject({
      id,
      pspName: "paypal",
      status: "active",
      amount: 1990,
      currency: "EUR",
      interval: "month",
      intervalCount: 3,
      savedPaymentMethodToken: "93a92571rv649072p",
      pspCustomerId: "2J6QB8YJQSJRJ",
      customer: { email: "subscriber@example.com", firstName: "John", lastName: "Doe" },
      merchantRefNum: "sub-42",
      planId: "P-5ML4271244454362WXNWU5NQ",
    });
    expect(record.currentPeriodEnd).toBeDefined();
    expect(record.raw).toBeDefined();
    const detail = requests.find((r) => r.url.pathname === `/v1/billing/subscriptions/${id}`);
    expect(detail?.url.searchParams.get("fields")).toBe("plan"); // the amount source rides the expansion
  });

  it("prices from the REGULAR cycle, never the trial cycle", async () => {
    const { adapter, fake } = makePair();
    const id = fake.seedSubscription({ withTrial: true, value: "25.00", intervalUnit: "YEAR" });
    const record = await adapter.retrieveNativeSubscription({ subscriptionId: id });
    expect(record.amount).toBe(2500);
    expect(record.interval).toBe("year");
  });

  it("supports whole-unit currencies through the shared money helpers", async () => {
    const { adapter, fake } = makePair();
    const id = fake.seedSubscription({ currency: "JPY", value: "500" });
    const record = await adapter.retrieveNativeSubscription({ subscriptionId: id });
    expect(record.amount).toBe(500);
    expect(record.currency).toBe("JPY");
  });

  it("falls back to the last collected payment when the plan prices by tiers", async () => {
    const { adapter, fake } = makePair();
    const id = fake.seedSubscription({ tieredPricing: true, lastPaymentValue: "7.50" });
    const record = await adapter.retrieveNativeSubscription({ subscriptionId: id });
    expect(record.amount).toBe(750);
    expect(record.interval).toBe("month"); // the cycle's frequency still projects
  });

  it("rejects a subscription with no documented amount source instead of inventing one", async () => {
    const { adapter, fake } = makePair();
    const id = fake.seedSubscription({ tieredPricing: true, status: "APPROVAL_PENDING" });
    await expect(adapter.retrieveNativeSubscription({ subscriptionId: id })).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/no recurring amount/),
    });
  });

  it("maps every documented status and normalizes novelties to unknown", async () => {
    const cases: Array<[string, string]> = [
      ["APPROVAL_PENDING", "pending"],
      ["APPROVED", "pending"],
      ["ACTIVE", "active"],
      ["SUSPENDED", "paused"],
      ["CANCELLED", "canceled"],
      ["EXPIRED", "completed"],
      ["SOMETHING_NEW", "unknown"],
    ];
    const { adapter, fake } = makePair();
    for (const [pspStatus, expected] of cases) {
      const id = fake.seedSubscription({ status: pspStatus });
      const record = await adapter.retrieveNativeSubscription({ subscriptionId: id });
      expect(record.status, pspStatus).toBe(expected);
    }
    expect(mapPayPalSubscriptionStatus(undefined)).toBe("unknown");
    expect(mapPayPalSubscriptionStatus("cancelled")).toBe("canceled"); // case-insensitive
  });

  it("rejects an empty subscriptionId before it can route to the list endpoint", async () => {
    const { adapter } = makePair();
    await expect(adapter.retrieveNativeSubscription({ subscriptionId: "" })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("maps an unknown subscription id onto invalid_request with raw preserved", async () => {
    const { adapter } = makePair();
    try {
      await adapter.retrieveNativeSubscription({ subscriptionId: "I-MISSING" });
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("invalid_request");
        expect(err.raw).toBeDefined();
      }
    }
  });

  it("paypalSubscriptionToRecord rejects an id-less subscription", () => {
    expect(() => paypalSubscriptionToRecord({ status: "ACTIVE" })).toThrowError(/without an id/);
  });

  it("omits the interval for cadences with no faithful projection and defaults a bad interval_count", () => {
    const record = paypalSubscriptionToRecord(
      subscriptionBody("I-ODD", {
        plan: {
          billing_cycles: [
            {
              pricing_scheme: { fixed_price: { currency_code: "USD", value: "9.00" } },
              // Not in the documented DAY|WEEK|MONTH|YEAR enum — never approximated.
              frequency: { interval_unit: "SEMI_MONTH", interval_count: 2 },
              tenure_type: "REGULAR",
              sequence: 1,
            },
          ],
        },
      }),
    );
    expect(record.interval).toBeUndefined();
    expect(record.intervalCount).toBeUndefined();

    const badCount = paypalSubscriptionToRecord(
      subscriptionBody("I-BADCOUNT", {
        plan: {
          billing_cycles: [
            {
              pricing_scheme: { fixed_price: { currency_code: "USD", value: "9.00" } },
              frequency: { interval_unit: "MONTH", interval_count: 0 },
              tenure_type: "REGULAR",
              sequence: 1,
            },
          ],
        },
      }),
    );
    expect(badCount.interval).toBe("month");
    expect(badCount.intervalCount).toBe(1); // the documented default
  });

  it("carries the subscriber phone and omits the customer block when no contact fact exists", () => {
    const withPhone = paypalSubscriptionToRecord(
      subscriptionBody("I-PHONE", {
        subscriber: {
          email_address: "subscriber@example.com",
          phone: { phone_number: { national_number: "14082508100" } },
        },
      }),
    );
    expect(withPhone.customer).toEqual({ email: "subscriber@example.com", phone: "14082508100" });

    const contactless = paypalSubscriptionToRecord(subscriptionBody("I-NOBODY", { subscriber: {} }));
    expect(contactless.customer).toBeUndefined();
    expect(contactless.pspCustomerId).toBeUndefined();
  });

  it("treats an amount whose money object lacks a currency as no amount source", () => {
    const body = subscriptionBody("I-NOCUR", {
      plan: {
        billing_cycles: [
          {
            pricing_scheme: { fixed_price: { value: "9.00" } },
            frequency: { interval_unit: "MONTH" },
            tenure_type: "REGULAR",
            sequence: 1,
          },
        ],
      },
    });
    delete body.billing_info;
    expect(() => paypalSubscriptionToRecord(body)).toThrowError(/no recurring amount/);
  });
});

describe("PayPal listNativeSubscriptions", () => {
  it("walks pages with limit 1, deriving the cursor from total_pages", async () => {
    const { adapter, fake, requests } = recordingPair();
    const seeded = [fake.seedSubscription(), fake.seedSubscription(), fake.seedSubscription()];

    const first = await adapter.listNativeSubscriptions({ limit: 1 });
    expect(first.subscriptions.map((s) => s.id)).toEqual([seeded[0]]);
    expect(first.subscriptions[0]!.amount).toBe(1500); // completed by the detail GET
    expect(first.nextCursor).toBe("2");

    const second = await adapter.listNativeSubscriptions({ limit: 1, cursor: first.nextCursor! });
    expect(second.subscriptions.map((s) => s.id)).toEqual([seeded[1]]);
    expect(second.nextCursor).toBe("3");

    const last = await adapter.listNativeSubscriptions({ limit: 1, cursor: second.nextCursor! });
    expect(last.subscriptions.map((s) => s.id)).toEqual([seeded[2]]);
    expect(last.nextCursor).toBeUndefined(); // page 3 of 3

    const listCalls = requests.filter((r) => r.url.pathname === "/v1/billing/subscriptions");
    expect(listCalls.map((r) => r.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(listCalls.every((r) => r.url.searchParams.get("page_size") === "1")).toBe(true);
    expect(listCalls.every((r) => r.url.searchParams.get("total_required") === "true")).toBe(true);
    // Each page costs 1 list call + one fields=plan detail GET per item.
    const detailCalls = requests.filter((r) => /^\/v1\/billing\/subscriptions\/I-/.test(r.url.pathname));
    expect(detailCalls).toHaveLength(3);
    expect(detailCalls.every((r) => r.url.searchParams.get("fields") === "plan")).toBe(true);
  });

  it("omits page_size without a limit (PayPal's default 10) and clamps to the documented 1–20", async () => {
    const { adapter, fake, requests } = recordingPair();
    fake.seedSubscription();
    await adapter.listNativeSubscriptions();
    await adapter.listNativeSubscriptions({ limit: 50 });
    await adapter.listNativeSubscriptions({ limit: 0.4 });
    const sizes = requests
      .filter((r) => r.url.pathname === "/v1/billing/subscriptions")
      .map((r) => r.url.searchParams.get("page_size"));
    expect(sizes).toEqual([null, "20", "1"]);
  });

  it("returns an empty page when nothing is seeded", async () => {
    const { adapter } = makePair();
    const page = await adapter.listNativeSubscriptions();
    expect(page.subscriptions).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("rejects cursors it did not produce", async () => {
    const { adapter } = makePair();
    for (const cursor of ["evil", "-1", "0", "1.5", ""]) {
      await expect(adapter.listNativeSubscriptions({ cursor }), cursor).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
  });

  it("falls back to the next link, then to full-page continuation, when totals are absent", async () => {
    const detail = (id: string) => JSON.stringify(subscriptionBody(id));
    const envelope = (ids: string[], links: Array<{ rel: string }>) =>
      JSON.stringify({ subscriptions: ids.map((id) => ({ id })), links });

    // A next link alone pages on.
    const linked = adapterWithResponder((url) => {
      if (url.pathname === "/v1/billing/subscriptions") {
        return new Response(envelope(["I-A"], [{ rel: "next" }]), { status: 200 });
      }
      return new Response(detail(url.pathname.split("/").pop()!), { status: 200 });
    });
    const linkedPage = await linked.listNativeSubscriptions({ limit: 1 });
    expect(linkedPage.subscriptions.map((s) => s.id)).toEqual(["I-A"]);
    expect(linkedPage.nextCursor).toBe("2");

    // No totals, no links: a full page continues, the following empty page ends the walk.
    const bare = adapterWithResponder((url) => {
      if (url.pathname === "/v1/billing/subscriptions") {
        const page = url.searchParams.get("page");
        return new Response(envelope(page === "1" ? ["I-B"] : [], []), { status: 200 });
      }
      return new Response(detail(url.pathname.split("/").pop()!), { status: 200 });
    });
    const full = await bare.listNativeSubscriptions({ limit: 1 });
    expect(full.subscriptions.map((s) => s.id)).toEqual(["I-B"]);
    expect(full.nextCursor).toBe("2");
    const empty = await bare.listNativeSubscriptions({ limit: 1, cursor: full.nextCursor! });
    expect(empty.subscriptions).toEqual([]);
    expect(empty.nextCursor).toBeUndefined();

    // A short page without totals ends immediately; an id-less item cannot
    // become an addressable record and is skipped, not detail-fetched.
    const short = adapterWithResponder((url) => {
      if (url.pathname === "/v1/billing/subscriptions") {
        return new Response(JSON.stringify({ subscriptions: [{ id: "I-C" }, { status: "ACTIVE" }], links: [] }), {
          status: 200,
        });
      }
      return new Response(detail(url.pathname.split("/").pop()!), { status: 200 });
    });
    const shortPage = await short.listNativeSubscriptions({ limit: 5 });
    expect(shortPage.subscriptions.map((s) => s.id)).toEqual(["I-C"]);
    expect(shortPage.nextCursor).toBeUndefined();
  });
});

describe("PayPal cancelNativeSubscription", () => {
  it("cancels with the required reason body and returns the re-fetched record", async () => {
    const { adapter, fake, requests } = recordingPair();
    const id = fake.seedSubscription();
    const record = await adapter.cancelNativeSubscription({ subscriptionId: id, idempotencyKey: "k-cancel" });
    expect(record.status).toBe("canceled");
    expect(record.id).toBe(id);
    expect(fake.uniqueSubscriptionCancels).toBe(1);
    const cancel = requests.find((r) => r.url.pathname.endsWith("/cancel"));
    expect(cancel?.method).toBe("POST");
    // The cancel schema REQUIRES reason — the adapter supplies its fixed default.
    expect(JSON.parse(cancel!.body!)).toEqual({ reason: PAYPAL_SUBSCRIPTION_CANCEL_REASON });
    expect(cancel?.headers["paypal-request-id"]).toBe("k-cancel");
  });

  it("treats a repeat cancel as success — verified against the re-fetched status", async () => {
    const { adapter, fake } = makePair();
    const id = fake.seedSubscription();
    await adapter.cancelNativeSubscription({ subscriptionId: id, idempotencyKey: "k-1" });
    // PayPal answers 422 SUBSCRIPTION_STATUS_INVALID here; the adapter
    // re-fetches, sees CANCELLED, and resolves instead of failing the replay.
    const replayed = await adapter.cancelNativeSubscription({ subscriptionId: id, idempotencyKey: "k-2" });
    expect(replayed.status).toBe("canceled");
    expect(fake.uniqueSubscriptionCancels).toBe(1); // billing stopped exactly once
  });

  it("resolves cancel of an EXPIRED subscription as success with the honest terminal status", async () => {
    const { adapter, fake } = makePair();
    const id = fake.seedSubscription({ status: "EXPIRED" });
    const record = await adapter.cancelNativeSubscription({ subscriptionId: id, idempotencyKey: "k" });
    expect(record.status).toBe("completed"); // billing already ran its course
    expect(fake.uniqueSubscriptionCancels).toBe(0);
  });

  it("rethrows the cancel rejection when the subscription is not terminal", async () => {
    const { adapter, fake } = makePair();
    const id = fake.seedSubscription({ status: "APPROVAL_PENDING" });
    await expect(
      adapter.cancelNativeSubscription({ subscriptionId: id, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request", retryable: false });
  });

  it("maps an unknown subscription id onto invalid_request, not the re-fetch failure", async () => {
    const { adapter } = makePair();
    try {
      await adapter.cancelNativeSubscription({ subscriptionId: "I-MISSING", idempotencyKey: "k" });
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("invalid_request");
        expect((err.raw as { name?: string }).name).toBe("RESOURCE_NOT_FOUND"); // the cancel error, not the probe's
      }
    }
  });

  it("rejects an empty subscriptionId eagerly", async () => {
    const { adapter } = makePair();
    await expect(
      adapter.cancelNativeSubscription({ subscriptionId: "", idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});
