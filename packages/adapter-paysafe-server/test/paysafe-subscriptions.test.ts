import { describe, expect, it } from "vitest";
import {
  isPayFanoutError,
  type CreateNativeSubscriptionInput,
  type NativeSubscriptionStatus,
} from "@payfanout/core";
import { PaysafeServerAdapter, type PaysafeServerAdapterConfig } from "../src/index.js";
import { FakePaysafeApi, SEEDED_MULTI_USE_TOKEN } from "./fake-paysafe-api.js";

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

/**
 * A sequenced transport that records every exchange — for asserting exact
 * URLs/bodies and for provider answers the stateful fake does not produce.
 * Retries are disabled so each scripted response is consumed exactly once.
 */
function scripted(responses: Array<() => Response>): {
  adapter: PaysafeServerAdapter;
  requests: Array<{ method: string; url: string; body: unknown }>;
} {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  let call = 0;
  const adapter = new PaysafeServerAdapter({
    username: "u",
    password: "p",
    environment: "sandbox",
    merchantAccountResolver: () => "acct-1",
    sessionSigningKey: SIGNING_KEY,
    webhookHmacKey: WEBHOOK_KEY,
    maxNetworkRetries: 0,
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = responses[call++];
      if (!next) throw new Error(`scripted transport exhausted after ${responses.length} responses`);
      return next();
    },
  });
  return { adapter, requests };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const createInput = (
  overrides: Partial<CreateNativeSubscriptionInput> = {},
): CreateNativeSubscriptionInput => ({
  savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
  amount: 1499,
  currency: "USD",
  interval: "month",
  idempotencyKey: `nsub-${Math.random().toString(36).slice(2)}`,
  ...overrides,
});

describe("Paysafe native subscriptions: create", () => {
  it("creates an inline open-ended plan and attaches the subscription to it", async () => {
    const { adapter, fake } = makePair();
    const record = await adapter.createNativeSubscription({
      savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
      amount: 2599,
      currency: "usd",
      interval: "month",
      intervalCount: 3,
      startAt: "2026-08-01T00:00:00Z",
      idempotencyKey: "nsub-key-1",
    });
    // The plan carries the money terms (subscriptions have no amount field):
    // minor units, DAILY/MONTHLY/YEARLY cadence, numberOfCycles 0 = infinite.
    expect(fake.lastPlanRequestBody).toMatchObject({
      name: "payfanout-nsub-key-1",
      amount: 2599,
      currencyCode: "USD",
      billingCycle: { frequency: "MONTHLY", interval: 3, numberOfCycles: 0 },
      status: "ACTIVE",
    });
    expect(record.pspName).toBe("paysafe");
    expect(record.status).toBe("active");
    expect(record.amount).toBe(2599);
    expect(record.currency).toBe("USD");
    expect(record.interval).toBe("month");
    expect(record.intervalCount).toBe(3);
    expect(record.merchantRefNum).toBe("nsub-key-1");
    expect(record.savedPaymentMethodToken).toBe(SEEDED_MULTI_USE_TOKEN);
    expect(record.planId).toMatch(/^plan_/);
    expect(record.pspCustomerId).toMatch(/^cp_/);
    expect(record.customer?.email).toBe("subscriber@example.test");
    // Period bounds come from the scheduler's own previous/next charge times.
    expect(record.currentPeriodStart).toBe("2026-07-04T10:00:00Z");
    expect(record.currentPeriodEnd).toBe("2026-08-04T10:00:00Z");
    expect(fake.uniquePlanCreations).toBe(1);
    expect(fake.uniqueSubscriptionCreations).toBe(1);
  });

  it("sends exactly what the scheduler's create endpoint takes, under the plan path", async () => {
    const { adapter, fake } = makePair();
    await adapter.createNativeSubscription(createInput({ idempotencyKey: "nsub-wire", startAt: "2026-09-01T00:00:00Z" }));
    expect(fake.lastRequestBody).toMatchObject({
      merchantRefNum: "nsub-wire",
      paymentHandleToken: SEEDED_MULTI_USE_TOKEN,
      status: "ACTIVE",
      accountId: "acct-USD-any",
      startTime: "2026-09-01T00:00:00Z",
    });
    // No scheduler channel exists for these: never sent, never faked.
    expect(fake.lastRequestBody).not.toHaveProperty("metadata");
    expect(fake.lastRequestBody).not.toHaveProperty("customerId");
  });

  it("prefers input.merchantRefNum over the idempotencyKey (the refNum IS the dedupe key)", async () => {
    const { adapter, fake } = makePair();
    const record = await adapter.createNativeSubscription(
      createInput({ merchantRefNum: "order-77", idempotencyKey: "nsub-ignored" }),
    );
    expect(record.merchantRefNum).toBe("order-77");
    expect(fake.lastRequestBody).toMatchObject({ merchantRefNum: "order-77" });
  });

  it("replays idempotently on the same key: one subscription, the orphan inline plan tolerated", async () => {
    const { adapter, fake } = makePair();
    const input = createInput({ idempotencyKey: "nsub-replay" });
    const first = await adapter.createNativeSubscription(input);
    const second = await adapter.createNativeSubscription(input);
    expect(second.id).toBe(first.id);
    expect(fake.uniqueSubscriptionCreations).toBe(1);
    // Plans have no refNum channel, so the replay minted a second (orphan)
    // plan — clutter, never billing: the subscription attach deduped.
    expect(fake.uniquePlanCreations).toBe(2);
  });

  it("bills from a host-managed plan when planId matches the stated terms", async () => {
    const { adapter, fake } = makePair();
    const seeded = await adapter.createNativeSubscription(createInput({ idempotencyKey: "nsub-plan-seed" }));
    const record = await adapter.createNativeSubscription(
      createInput({ planId: seeded.planId, idempotencyKey: "nsub-plan-reuse" }),
    );
    expect(record.planId).toBe(seeded.planId);
    expect(record.id).not.toBe(seeded.id);
    expect(fake.uniquePlanCreations).toBe(1); // no inline plan for the second create
  });

  it("rejects a planId whose plan bills different terms, before any subscription exists", async () => {
    const { adapter, fake } = makePair();
    const seeded = await adapter.createNativeSubscription(createInput({ idempotencyKey: "nsub-mismatch-seed" }));
    const cases: Array<Record<string, unknown>> = [
      { amount: 999 },
      { currency: "EUR" },
      { interval: "year" },
      { intervalCount: 6 },
    ];
    for (const overrides of cases) {
      await expect(
        adapter.createNativeSubscription(
          createInput({ planId: seeded.planId, idempotencyKey: `nsub-mm-${JSON.stringify(overrides)}`, ...overrides }),
        ),
      ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/does not match/) });
    }
    expect(fake.uniqueSubscriptionCreations).toBe(1);
  });

  it("rejects cadences the scheduler cannot express — weekly and RRULE schedules, never approximated", async () => {
    const { adapter, fake } = makePair();
    await expect(
      adapter.createNativeSubscription(createInput({ interval: "week" })),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/cannot be expressed faithfully/) });
    await expect(
      adapter.createNativeSubscription(createInput({ interval: undefined, schedule: "FREQ=MONTHLY;BYMONTHDAY=1" })),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/no RRULE/) });
    // Both cadences at once: the schedule is unexpressible either way.
    await expect(
      adapter.createNativeSubscription(createInput({ schedule: "FREQ=DAILY" })),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      adapter.createNativeSubscription(createInput({ interval: undefined })),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/billing interval/) });
    expect(fake.uniquePlanCreations).toBe(0); // all rejected before any PSP call
  });

  it("validates amount, token, and intervalCount locally", async () => {
    const { adapter, fake } = makePair();
    await expect(adapter.createNativeSubscription(createInput({ amount: 0 }))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(adapter.createNativeSubscription(createInput({ amount: 10.5 }))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      adapter.createNativeSubscription(createInput({ savedPaymentMethodToken: "" })),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/MULTI_USE/) });
    for (const intervalCount of [0, -1, 1.5, 366]) {
      await expect(
        adapter.createNativeSubscription(createInput({ intervalCount })),
      ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/between 1 and 365/) });
    }
    expect(fake.uniquePlanCreations).toBe(0);
  });

  it("rejects a token the scheduler does not hold as MULTI_USE (single-use tokens cannot bill)", async () => {
    const { adapter, fake } = makePair();
    await expect(
      adapter.createNativeSubscription(createInput({ savedPaymentMethodToken: "tok_single_use_1" })),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.uniqueSubscriptionCreations).toBe(0);
  });

  it("bills a token vaulted through savePaymentMethod end-to-end", async () => {
    const { adapter } = makePair();
    const customer = await adapter.createCustomer({ id: "sub-user-1", idempotencyKey: "k-cust" });
    const saved = await adapter.savePaymentMethod({
      pspCustomerId: customer.pspCustomerId,
      clientToken: "tok_single_use_1",
      idempotencyKey: "k-save",
    });
    const record = await adapter.createNativeSubscription(
      createInput({ savedPaymentMethodToken: saved.token, idempotencyKey: "nsub-vaulted" }),
    );
    expect(record.status).toBe("active");
    expect(record.savedPaymentMethodToken).toBe(saved.token);
  });

  it("recovers the existing subscription when the scheduler rejects a replayed refNum", async () => {
    const existing = {
      id: "sub_existing",
      merchantRefNum: "nsub-dup",
      paymentHandleToken: "MUxtok",
      status: "ACTIVE",
      plan: { id: "plan_1", amount: 1499, currencyCode: "USD", billingCycle: { frequency: "MONTHLY", interval: 1 } },
    };
    const { adapter, requests } = scripted([
      () => json(201, { id: "plan_1", amount: 1499, currencyCode: "USD", billingCycle: { frequency: "MONTHLY", interval: 1, numberOfCycles: 0 } }),
      // The undocumented duplicate answer: whatever its shape, the refNum
      // lookup decides — an existing subscription means the create happened.
      () => json(409, { error: { code: "7515", message: "merchantRefNum already used" } }),
      () => json(200, { subscriptions: [existing], meta: { numberOfRecords: 1, limit: 10, page: 1 } }),
    ]);
    const record = await adapter.createNativeSubscription(createInput({ idempotencyKey: "nsub-dup" }));
    expect(record.id).toBe("sub_existing");
    expect(record.status).toBe("active");
    expect(record.amount).toBe(1499);
    expect(requests[2]!.url).toContain("merchantRefNum=nsub-dup");
    expect(requests[2]!.url).toContain("fields=plan,customerProfile,paymentsInformation");
  });

  it("rethrows the original rejection when no subscription answers to the refNum", async () => {
    const { adapter } = scripted([
      () => json(201, { id: "plan_1", amount: 1499, currencyCode: "USD", billingCycle: { frequency: "MONTHLY", interval: 1, numberOfCycles: 0 } }),
      () => json(400, { error: { code: "5068", message: "Field error(s)" } }),
      () => json(200, { subscriptions: [], meta: { numberOfRecords: 0, limit: 10, page: 1 } }),
    ]);
    try {
      await adapter.createNativeSubscription(createInput({ idempotencyKey: "nsub-norec" }));
      expect.unreachable();
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("invalid_request");
        expect(err.raw).toMatchObject({ error: { code: "5068" } });
      }
    }
  });
});

describe("Paysafe native subscriptions: list", () => {
  it("walks offset pages behind the opaque cursor and terminates on the short page", async () => {
    const { adapter } = makePair();
    const created: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      created.push((await adapter.createNativeSubscription(createInput({ idempotencyKey: `nsub-page-${i}` }))).id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    const cursors: Array<string | undefined> = [];
    for (let page = 0; page < 6; page += 1) {
      const result = await adapter.listNativeSubscriptions({ limit: 1, ...(cursor ? { cursor } : {}) });
      for (const record of result.subscriptions) seen.push(record.id);
      cursors.push(result.nextCursor);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    // Full pages hand out the next offset; the empty follow-up page ends the walk.
    expect(cursors).toEqual(["1", "2", "3", undefined]);
    expect(seen.sort()).toEqual([...created].sort());
    // Every record on every page carries its money facts (fields requested).
    const first = await adapter.listNativeSubscriptions({ limit: 1 });
    expect(first.subscriptions[0]!.amount).toBe(1499);
    expect(first.subscriptions[0]!.currency).toBe("USD");
  });

  it("asks the scheduler for the documented defaults, sub-components, and clamped limit", async () => {
    const page = (): Response => json(200, { subscriptions: [], meta: { numberOfRecords: 0, limit: 10, page: 1 } });
    const { adapter, requests } = scripted([page, page, page]);
    await adapter.listNativeSubscriptions();
    expect(requests[0]!.url).toContain("/subscriptionsplans/v1/subscriptions?limit=10&offset=0");
    expect(requests[0]!.url).toContain("fields=plan,customerProfile,paymentsInformation");
    await adapter.listNativeSubscriptions({ limit: 100 }); // the PSP max (50) wins
    expect(requests[1]!.url).toContain("limit=50");
    await adapter.listNativeSubscriptions({ limit: 5, cursor: "35" });
    expect(requests[2]!.url).toContain("limit=5&offset=35");
  });

  it("rejects limits and cursors it never issued", async () => {
    const { adapter, fake } = makePair();
    for (const limit of [0, -2, 2.5]) {
      await expect(adapter.listNativeSubscriptions({ limit })).rejects.toMatchObject({
        code: "invalid_request",
        message: expect.stringMatching(/positive integer/),
      });
    }
    for (const cursor of ["abc", "-1", "1e3", "12.5", ""]) {
      await expect(adapter.listNativeSubscriptions({ cursor })).rejects.toMatchObject({
        code: "invalid_request",
        message: expect.stringMatching(/cursor/),
      });
    }
    expect(fake.lastRequestBody).toBeUndefined(); // all rejected before any PSP call
  });
});

describe("Paysafe native subscriptions: retrieve and status mapping", () => {
  const statusCases: Array<[string | undefined, NativeSubscriptionStatus]> = [
    ["ACTIVE", "active"],
    ["CANCELLED", "canceled"], // the wire spelling is double-L
    ["SUSPENDED", "paused"], // reversible at Paysafe -> paused, not canceled
    ["COMPLETED", "completed"],
    ["SOMETHING_NEW", "unknown"],
    [undefined, "unknown"],
  ];
  for (const [wire, expected] of statusCases) {
    it(`maps ${wire ?? "(absent)"} -> ${expected}`, async () => {
      const { adapter } = scripted([
        () =>
          json(200, {
            id: "sub_1",
            status: wire,
            plan: { id: "plan_1", amount: 500, currencyCode: "EUR", billingCycle: { frequency: "YEARLY", interval: 1 } },
          }),
      ]);
      const record = await adapter.retrieveNativeSubscription({ subscriptionId: "sub_1" });
      expect(record.status).toBe(expected);
      expect(record.interval).toBe("year");
    });
  }

  it("retrieves by id with sub-components and maps the full record", async () => {
    const { adapter } = makePair();
    const created = await adapter.createNativeSubscription(createInput({ idempotencyKey: "nsub-get" }));
    const record = await adapter.retrieveNativeSubscription({
      subscriptionId: created.id,
      savedPaymentMethodToken: "ignored-by-paysafe",
    });
    expect(record.id).toBe(created.id);
    expect(record.amount).toBe(1499);
    expect(record.currency).toBe("USD");
    expect(record.interval).toBe("month");
    expect(record.merchantRefNum).toBe("nsub-get");
  });

  it("degrades honestly when the provider omits every sub-component", async () => {
    const { adapter } = scripted([() => json(200, { id: "sub_bare", status: "ACTIVE" })]);
    const record = await adapter.retrieveNativeSubscription({ subscriptionId: "sub_bare" });
    expect(record.amount).toBe(0);
    expect(record.currency).toBe("USD");
    expect(record.interval).toBeUndefined();
    expect(record.intervalCount).toBeUndefined();
    expect(record.currentPeriodStart).toBeUndefined();
    expect(record.currentPeriodEnd).toBeUndefined();
    expect(record.customer).toBeUndefined();
    expect(record.planId).toBeUndefined();
  });

  it("rejects a missing id locally and maps a scheduler 404 to invalid_request", async () => {
    const { adapter } = makePair();
    await expect(adapter.retrieveNativeSubscription({ subscriptionId: "" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(adapter.retrieveNativeSubscription({ subscriptionId: "sub_ghost" })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});

describe("Paysafe native subscriptions: cancel (verified-idempotent)", () => {
  it("PATCHes CANCELLED and re-reads for money facts (PATCH answers carry no sub-components)", async () => {
    const { adapter } = makePair();
    const created = await adapter.createNativeSubscription(createInput({ idempotencyKey: "nsub-cancel" }));
    const canceled = await adapter.cancelNativeSubscription({
      subscriptionId: created.id,
      idempotencyKey: "cancel-1",
    });
    expect(canceled.status).toBe("canceled");
    expect(canceled.amount).toBe(1499); // via the fields re-read, not the bare PATCH echo
    expect(canceled.currency).toBe("USD");
    expect(canceled.currentPeriodEnd).toBeUndefined(); // no next charge anymore
    expect(canceled.currentPeriodStart).toBe("2026-07-04T10:00:00Z");
  });

  it("treats a replayed cancel as success through the re-fetch (the fake rejects the second PATCH)", async () => {
    const { adapter } = makePair();
    const created = await adapter.createNativeSubscription(createInput({ idempotencyKey: "nsub-recancel" }));
    await adapter.cancelNativeSubscription({ subscriptionId: created.id, idempotencyKey: "cancel-1" });
    const replayed = await adapter.cancelNativeSubscription({
      subscriptionId: created.id,
      idempotencyKey: "cancel-2",
    });
    expect(replayed.status).toBe("canceled");
  });

  it("resolves a COMPLETED subscription as success with its honest status", async () => {
    const { adapter, fake } = makePair();
    const seeded = fake.seedSubscription("COMPLETED");
    const record = await adapter.cancelNativeSubscription({
      subscriptionId: seeded.id,
      idempotencyKey: "cancel-completed",
    });
    // Billing already stopped on its own — cancel succeeds, status stays true.
    expect(record.status).toBe("completed");
  });

  it("sends exactly { status: CANCELLED } — never the reversible SUSPENDED", async () => {
    const { adapter, requests } = scripted([
      () => json(200, { id: "sub_1", status: "CANCELLED", plan: { amount: 100, currencyCode: "USD" } }),
    ]);
    await adapter.cancelNativeSubscription({ subscriptionId: "sub_1", idempotencyKey: "k" });
    expect(requests[0]!.method).toBe("PATCH");
    expect(requests[0]!.url).toContain("/subscriptionsplans/v1/subscriptions/sub_1");
    expect(requests[0]!.body).toEqual({ status: "CANCELLED" });
  });

  it("rethrows the PATCH rejection when the re-fetch shows a non-terminal subscription", async () => {
    const { adapter } = scripted([
      () => json(400, { error: { code: "5068", message: "Field error(s)" } }),
      () => json(200, { id: "sub_1", status: "ACTIVE", plan: { amount: 100, currencyCode: "USD" } }),
    ]);
    try {
      await adapter.cancelNativeSubscription({ subscriptionId: "sub_1", idempotencyKey: "k" });
      expect.unreachable();
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("invalid_request");
        expect(err.raw).toMatchObject({ error: { code: "5068" } }); // the PATCH error, not the fetch
      }
    }
  });

  it("rethrows the PATCH rejection when the verification re-fetch itself fails", async () => {
    const { adapter } = scripted([
      () => json(503, { error: { code: "1000", message: "down" } }),
      () => json(404, { error: { code: "5269", message: "No such subscription" } }),
    ]);
    await expect(
      adapter.cancelNativeSubscription({ subscriptionId: "sub_1", idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "psp_unavailable", retryable: true });
  });

  it("rejects a missing id locally", async () => {
    const { adapter } = makePair();
    await expect(
      adapter.cancelNativeSubscription({ subscriptionId: "", idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("Paysafe native subscriptions: error normalization and capabilities", () => {
  it("maps scheduler outages and throttling onto the retryable taxonomy", async () => {
    const outage = makePair({
      fetch: async () => json(503, { error: { code: "1000", message: "down" } }),
    });
    await expect(outage.adapter.listNativeSubscriptions()).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
    });
    const throttled = makePair({
      fetch: async () => json(429, { error: { code: "1200", message: "slow down" } }),
      maxNetworkRetries: 0,
    });
    await expect(
      throttled.adapter.retrieveNativeSubscription({ subscriptionId: "sub_1" }),
    ).rejects.toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("declares the full per-operation capability block the methods back", () => {
    const { adapter } = makePair();
    expect(adapter.getCapabilities().nativeSubscriptions).toEqual({
      list: true,
      retrieve: true,
      create: true,
      cancel: true,
    });
  });
});
