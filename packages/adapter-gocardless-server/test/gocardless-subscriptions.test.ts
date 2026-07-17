import { describe, expect, it } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import { GoCardlessServerAdapter, type GoCardlessServerAdapterConfig } from "../src/index.js";
import { FakeGoCardlessApi } from "./fake-gocardless-api.js";

const WEBHOOK_SECRET = "fake-webhook-endpoint-secret";

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

describe("GoCardless native subscription create", () => {
  it("declares the full per-operation capability block", () => {
    const { adapter } = makePair();
    expect(adapter.getCapabilities().nativeSubscriptions).toEqual({
      list: true,
      retrieve: true,
      create: true,
      cancel: true,
    });
  });

  it("maps the unified input onto POST /subscriptions and normalizes the record", async () => {
    const { adapter, fake } = makePair();
    const mandate = fake.seedMandate();
    const record = await adapter.createNativeSubscription({
      savedPaymentMethodToken: mandate.id,
      amount: 2500,
      currency: "gbp",
      interval: "month",
      intervalCount: 2,
      startAt: "2026-09-01",
      merchantRefNum: "Monthly Magazine",
      metadata: { plan: "pro" },
      idempotencyKey: "k-sub-create",
    });

    // interval week/month/year -> interval_unit weekly/monthly/yearly;
    // intervalCount rides GoCardless's `interval`; merchantRefNum rides `name`.
    expect(fake.lastRequestBody).toEqual({
      subscriptions: {
        amount: 2500,
        currency: "GBP",
        interval_unit: "monthly",
        interval: 2,
        start_date: "2026-09-01",
        name: "Monthly Magazine",
        metadata: { plan: "pro" },
        links: { mandate: mandate.id },
      },
    });
    expect(fake.idempotencyKeysSeen).toContainEqual({ path: "/subscriptions", key: "k-sub-create" });

    expect(record.id).toMatch(/^SB/);
    expect(record).toMatchObject({
      pspName: "gocardless",
      status: "active",
      amount: 2500,
      currency: "GBP",
      interval: "month",
      intervalCount: 2,
      savedPaymentMethodToken: mandate.id,
      merchantRefNum: "Monthly Magazine",
    });
    // The next charge is due on the start date — the earliest upcoming charge.
    expect(record.currentPeriodEnd).toBe("2026-09-01");
    expect(record.raw).toBeDefined();
  });

  it("truncates an ISO instant startAt to its stated calendar date", async () => {
    const { adapter, fake } = makePair();
    await adapter.createNativeSubscription({
      savedPaymentMethodToken: fake.seedMandate().id,
      amount: 1000,
      currency: "GBP",
      interval: "week",
      startAt: "2026-10-05T23:30:00.000+02:00",
      idempotencyKey: "k",
    });
    expect(fake.lastRequestBody).toMatchObject({
      subscriptions: { interval_unit: "weekly", start_date: "2026-10-05" },
    });
  });

  it("stamps metadata capped at GoCardless's 3 keys, withholding overflow", async () => {
    const { adapter, fake } = makePair();
    await adapter.createNativeSubscription({
      savedPaymentMethodToken: fake.seedMandate().id,
      amount: 1000,
      currency: "GBP",
      interval: "month",
      metadata: { plan: "pro", seats: "3", promo: "spring", extra: "overflow" },
      idempotencyKey: "k",
    });
    expect((fake.lastRequestBody as { subscriptions: { metadata: unknown } }).subscriptions.metadata).toEqual({
      plan: "pro",
      seats: "3",
      promo: "spring",
    });
  });

  it("replays a consumed Idempotency-Key onto the original subscription", async () => {
    const { adapter, fake } = makePair();
    const input = {
      savedPaymentMethodToken: fake.seedMandate().id,
      amount: 1500,
      currency: "GBP",
      interval: "month",
      idempotencyKey: "k-sub-replay",
    } as const;
    const first = await adapter.createNativeSubscription(input);
    const second = await adapter.createNativeSubscription(input);
    expect(second.id).toBe(first.id);
    expect(fake.uniqueSubscriptionCreations).toBe(1);
  });

  it("rejects cadences GoCardless cannot express instead of approximating", async () => {
    const { adapter, fake } = makePair();
    const base = {
      savedPaymentMethodToken: fake.seedMandate().id,
      amount: 1000,
      currency: "GBP",
    } as const;
    // No daily billing exists — interval_unit is weekly/monthly/yearly only.
    await expect(
      adapter.createNativeSubscription({ ...base, interval: "day", idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/weekly, monthly, or yearly/) });
    // No RRULE surface exists.
    await expect(
      adapter.createNativeSubscription({ ...base, schedule: "FREQ=MONTHLY;INTERVAL=1", idempotencyKey: "k2" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/RRULE/) });
    await expect(
      adapter.createNativeSubscription({ ...base, idempotencyKey: "k3" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/cadence/) });
    // Local rejections must never reach the API.
    expect(fake.callCount).toBe(0);
  });

  it("rejects invalid local input eagerly with invalid_request", async () => {
    const { adapter, fake } = makePair();
    const mandate = fake.seedMandate();
    const base = {
      savedPaymentMethodToken: mandate.id,
      amount: 1000,
      currency: "GBP",
      interval: "month",
    } as const;
    await expect(
      adapter.createNativeSubscription({ ...base, amount: 0, idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      adapter.createNativeSubscription({ ...base, amount: 10.5, idempotencyKey: "k2" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    // JPY is not a GoCardless debit currency — declared, not discovered at the API.
    await expect(
      adapter.createNativeSubscription({ ...base, currency: "JPY", idempotencyKey: "k3" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      adapter.createNativeSubscription({ ...base, savedPaymentMethodToken: "", idempotencyKey: "k4" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/mandate/) });
    await expect(
      adapter.createNativeSubscription({ ...base, intervalCount: 0, idempotencyKey: "k5" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      adapter.createNativeSubscription({ ...base, intervalCount: 1.5, idempotencyKey: "k6" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      adapter.createNativeSubscription({ ...base, startAt: "not-a-date", idempotencyKey: "k7" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/startAt/) });
    await expect(
      adapter.createNativeSubscription({ ...base, startAt: "2026-13-45", idempotencyKey: "k8" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    // GoCardless subscriptions bill from their own fields, never a plan object.
    await expect(
      adapter.createNativeSubscription({ ...base, planId: "PL123", idempotencyKey: "k9" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/plan/) });
    // name (the merchantRefNum carrier) caps at 255 characters.
    await expect(
      adapter.createNativeSubscription({ ...base, merchantRefNum: "x".repeat(256), idempotencyKey: "k10" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/255/) });
    expect(fake.callCount).toBe(0);
  });

  it("surfaces API validation rejections with the raw envelope preserved", async () => {
    const { adapter } = makePair();
    try {
      await adapter.createNativeSubscription({
        savedPaymentMethodToken: "MD_missing",
        amount: 1000,
        currency: "GBP",
        interval: "month",
        idempotencyKey: "k",
      });
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

describe("GoCardless native subscription status mapping", () => {
  // The six documented statuses; customer_approval_denied is terminal (the
  // customer refused approval, nothing was ever billed) -> "canceled".
  const cases: Array<[string, string]> = [
    ["pending_customer_approval", "pending"],
    ["active", "active"],
    ["paused", "paused"],
    ["finished", "completed"],
    ["cancelled", "canceled"],
    ["customer_approval_denied", "canceled"],
    ["something_new", "unknown"],
  ];
  for (const [gcStatus, expected] of cases) {
    it(`maps subscription status ${gcStatus} -> ${expected}`, async () => {
      const { adapter, fake } = makePair();
      const seeded = fake.seedSubscription({ status: gcStatus });
      const record = await adapter.retrieveNativeSubscription({ subscriptionId: seeded.id });
      expect(record.status).toBe(expected);
    });
  }
});

describe("GoCardless native subscription retrieve", () => {
  it("reports currentPeriodEnd as the EARLIEST upcoming charge_date, even out of order", async () => {
    const { adapter, fake } = makePair();
    const seeded = fake.seedSubscription({
      upcoming_payments: [
        { charge_date: "2026-09-01", amount: 2500 },
        { charge_date: "2026-08-03", amount: 2500 },
        { charge_date: "2026-10-01", amount: 2500 },
      ],
    });
    const record = await adapter.retrieveNativeSubscription({ subscriptionId: seeded.id });
    expect(record.currentPeriodEnd).toBe("2026-08-03");
  });

  it("falls back deterministically when the PSP omits optional fields", async () => {
    const { adapter, fake } = makePair();
    const seeded = fake.seedSubscription({
      amount: undefined,
      currency: undefined,
      status: undefined,
      interval: undefined,
      interval_unit: "fortnightly", // no faithful day/week/month/year projection
      links: undefined,
    });
    const record = await adapter.retrieveNativeSubscription({ subscriptionId: seeded.id });
    expect(record).toMatchObject({ amount: 0, currency: "GBP", status: "unknown" });
    expect(record.interval).toBeUndefined();
    expect(record.intervalCount).toBeUndefined();
    expect(record.savedPaymentMethodToken).toBeUndefined();
    expect(record.merchantRefNum).toBeUndefined();
    expect(record.currentPeriodEnd).toBeUndefined();
  });

  it("defaults intervalCount to 1 when GoCardless omits interval", async () => {
    const { adapter, fake } = makePair();
    const seeded = fake.seedSubscription({ interval: undefined, interval_unit: "yearly" });
    const record = await adapter.retrieveNativeSubscription({ subscriptionId: seeded.id });
    expect(record.interval).toBe("year");
    expect(record.intervalCount).toBe(1);
  });

  it("rejects a missing subscription id as invalid_request", async () => {
    const { adapter } = makePair();
    await expect(
      adapter.retrieveNativeSubscription({ subscriptionId: "SB_missing" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("GoCardless native subscription list", () => {
  it("walks all pages with limit-1 cursors, no duplicates, then exhausts", async () => {
    const { adapter, fake } = makePair();
    const seeded = [fake.seedSubscription(), fake.seedSubscription(), fake.seedSubscription()];
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await adapter.listNativeSubscriptions({ limit: 1, ...(cursor ? { cursor } : {}) });
      expect(result.subscriptions.length).toBeLessThanOrEqual(1);
      seen.push(...result.subscriptions.map((s) => s.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(seeded.map((s) => s.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("clamps the page size to GoCardless's documented 1-500 bounds", async () => {
    const seen: string[] = [];
    const fetchSpy: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ subscriptions: [], meta: { cursors: {} } }), { status: 200 });
    };
    const { adapter } = makePair({ fetch: fetchSpy });
    await adapter.listNativeSubscriptions({ limit: 1234 });
    await adapter.listNativeSubscriptions({ limit: 0 });
    await adapter.listNativeSubscriptions();
    expect(seen.map((url) => new URL(url).searchParams.get("limit"))).toEqual(["500", "1", null]);
  });
});

describe("GoCardless native subscription cancel", () => {
  const create = async (
    adapter: GoCardlessServerAdapter,
    fake: FakeGoCardlessApi,
  ): Promise<string> => {
    const record = await adapter.createNativeSubscription({
      savedPaymentMethodToken: fake.seedMandate().id,
      amount: 2000,
      currency: "GBP",
      interval: "month",
      idempotencyKey: `k-${Math.random()}`,
    });
    return record.id;
  };

  it("cancels via the action POST, threading the Idempotency-Key", async () => {
    const { adapter, fake } = makePair();
    const id = await create(adapter, fake);
    const canceled = await adapter.cancelNativeSubscription({ subscriptionId: id, idempotencyKey: "k-cancel" });
    expect(canceled.status).toBe("canceled");
    // GoCardless clears the schedule — no further charge is due.
    expect(canceled.currentPeriodEnd).toBeUndefined();
    expect(fake.idempotencyKeysSeen).toContainEqual({
      path: `/subscriptions/${id}/actions/cancel`,
      key: "k-cancel",
    });
  });

  it("treats a repeat cancel as success via the re-fetch (cancellation_failed path)", async () => {
    const { adapter, fake } = makePair();
    const id = await create(adapter, fake);
    await adapter.cancelNativeSubscription({ subscriptionId: id, idempotencyKey: "k1" });
    // The fake now rejects the action with invalid_state, like the real API.
    const replayed = await adapter.cancelNativeSubscription({ subscriptionId: id, idempotencyKey: "k2" });
    expect(replayed.status).toBe("canceled");
  });

  it("resolves a finished subscription as success — billing is already stopped", async () => {
    const { adapter, fake } = makePair();
    const id = await create(adapter, fake);
    fake.setSubscriptionStatus(id, "finished");
    const record = await adapter.cancelNativeSubscription({ subscriptionId: id, idempotencyKey: "k" });
    expect(record.status).toBe("completed");
  });

  it("rethrows the original rejection when the re-fetch shows a non-terminal state", async () => {
    const { adapter, fake } = makePair();
    const id = await create(adapter, fake);
    // Only the action POST fails; the verification GET then sees `active`,
    // so the cancel must NOT be reported as success.
    fake.failNextWith(422, {
      error: {
        message: "Cancellation failed",
        type: "invalid_state",
        code: 422,
        errors: [{ reason: "cancellation_failed", message: "Cannot cancel right now" }],
      },
    });
    await expect(
      adapter.cancelNativeSubscription({ subscriptionId: id, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect((await adapter.retrieveNativeSubscription({ subscriptionId: id })).status).toBe("active");
  });

  it("rethrows a transport failure once retries exhaust and the re-fetch shows active", async () => {
    const { adapter, fake } = makePair();
    const id = await create(adapter, fake);
    // 3 failures exhaust the POST attempt + its 2 transport retries; the
    // verification GET then succeeds and sees the still-active subscription.
    fake.failNextWith(500, { error: { message: "down", type: "gocardless", code: 500 } }, 3);
    await expect(
      adapter.cancelNativeSubscription({ subscriptionId: id, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "psp_unavailable", retryable: true });
  });

  it("rethrows the original rejection when the verification re-fetch itself fails", async () => {
    const { adapter, fake } = makePair();
    const id = await create(adapter, fake);
    fake.failNextWith(
      500,
      { error: { message: "down", type: "gocardless", code: 500 } },
      Number.POSITIVE_INFINITY,
    );
    await expect(
      adapter.cancelNativeSubscription({ subscriptionId: id, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "psp_unavailable" });
  });
});
