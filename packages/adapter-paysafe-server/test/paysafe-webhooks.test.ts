import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import {
  parsePaysafeWebhookEvent,
  paysafeOnboarding,
  PaysafeServerAdapter,
  verifyPaysafeWebhookSignature,
} from "../src/index.js";

// Envelopes follow the shapes on Paysafe's pages (SEPA and Bacs Direct Debit, EPS
// webhooks, the Java SDK's WebhookEvent): no event id, an `attemptNumber`, the resource
// category in `type`, the event in `eventName`. Ids and values are made up.
const PAYMENT_ID = "7d0e5b52-4f0a-4b8e-9c3a-1f2e3d4c5b6a";
const RETURN_ID = "c41a9f07-2b6d-4e1f-8a35-90d7e6b2c418";
const REFUND_ID = "5b2f8c1d-93e4-4a07-b6d1-2c8e0f4a7b39";
const HANDLE_ID = "e0a4c3b2-1d5f-4e6a-8b7c-9d0e1f2a3b4c";

const sepaPaymentCompleted = {
  payload: {
    accountId: "1001234567",
    id: PAYMENT_ID,
    merchantRefNum: "sepa-order-1",
    amount: 500,
    currencyCode: "EUR",
    status: "COMPLETED",
    paymentType: "SEPA",
    txnTime: "2026-08-03T09:15:00Z",
    statusTime: "2026-08-03T09:15:00Z",
    settleWithAuth: true,
    settlementId: PAYMENT_ID,
    settlementStatus: "PENDING",
  },
  attemptNumber: "1",
  type: "PAYMENT",
  eventDate: "2026-08-03T09:15:00Z",
  eventName: "PAYMENT_COMPLETED",
};

const sepaReturnCompleted = {
  payload: {
    accountId: "1001234567",
    id: RETURN_ID,
    merchantRefNum: "sepa-order-1",
    amount: 500,
    currencyCode: "EUR",
    status: "COMPLETED",
    paymentType: "SEPA",
    txnTime: "2026-08-06T14:02:11Z",
    statusTime: "2026-08-06T14:02:11Z",
    paymentId: PAYMENT_ID,
    settlementId: PAYMENT_ID,
    bankResponse: { scheme: "SEPA", reasonCode: "AC04", message: "Closed account" },
    reason: "Account closed",
  },
  attemptNumber: "1",
  type: "PAYMENT_RETURN",
  eventDate: "2026-08-06T14:02:11Z",
  eventName: "PAYMENT_RETURN_COMPLETED",
};

// The Bacs page nests the envelope under `variables`.
const bacsReturnCompleted = {
  variables: {
    payload: {
      accountId: "1001234568",
      id: RETURN_ID,
      merchantRefNum: "bacs-order-1",
      amount: 25469,
      currencyCode: "GBP",
      status: "COMPLETED",
      paymentType: "BACS",
      txnTime: "2026-08-14T11:03:00Z",
      statusTime: "2026-08-14T11:03:00Z",
      paymentId: PAYMENT_ID,
      settlementId: PAYMENT_ID,
      reason: "No Funds",
    },
    attemptNumber: "1",
    type: "PAYMENT_RETURN",
    eventDate: "2026-08-14T11:03:00Z",
  },
  type: "PAYMENT_RETURN",
  eventName: "PAYMENT_RETURN_COMPLETED",
};

// EPS-style refund envelope: eventType and eventName, `links` instead of `type`.
function refundEvent(eventName: string, status: string): Record<string, unknown> {
  return {
    payload: {
      accountId: "1001234569",
      id: REFUND_ID,
      merchantRefNum: "refund-ref-1",
      amount: 200,
      currencyCode: "eur",
      source: "SingleAPI",
      status,
      paymentType: "EPS",
      txnTime: "2026-08-20T13:10:11Z",
    },
    eventType: eventName,
    attemptNumber: "1",
    resourceId: REFUND_ID,
    eventDate: "2026-08-20T13:10:11Z",
    links: [{ href: `https://api.test.paysafe.com/paymenthub/v1/refunds/${REFUND_ID}`, rel: "refund" }],
    mode: "live",
    eventName,
  };
}

function settlementEvent(eventName: string, statusTime: string): Record<string, unknown> {
  return {
    payload: {
      accountId: "1001234567",
      // Settle-with-auth: the settlement shares the payment's id.
      id: PAYMENT_ID,
      merchantRefNum: "sepa-order-1",
      amount: 500,
      currencyCode: "EUR",
      status: "COMPLETED",
      statusTime,
      paymentType: "SEPA",
      txnTime: "2026-08-03T09:15:00Z",
    },
    attemptNumber: "1",
    type: "SETTLEMENT",
    eventDate: "2026-08-03T09:15:00Z",
    eventName,
  };
}

const parse = (body: unknown) => parsePaysafeWebhookEvent(JSON.stringify(body));

/** The documented derivation, recomputed with node:crypto. */
function expectedEventId(name: string, resourceId: string, status: string | null, time: string | number | null): string {
  const digest = createHash("sha256").update(JSON.stringify([name, resourceId, status, time]), "utf8").digest("hex");
  return `paysafe_${digest}`;
}

describe("Paysafe webhook correlation", () => {
  it("reports a bank return against the returned payment, never the return's own id", async () => {
    const event = await parse(sepaReturnCompleted);
    expect(event.type).toBe("payment.failed");
    expect(event.pspPaymentId).toBe(PAYMENT_ID);
    expect(event.pspPaymentId).not.toBe(RETURN_ID);
    expect(event.refundId).toBeUndefined();
    expect(event.amount).toBe(500);
    expect(event.currency).toBe("EUR");
    expect(event.occurredAt).toBe("2026-08-06T14:02:11.000Z");
    expect(event.raw).toEqual(sepaReturnCompleted);
  });

  it("reads the variables-nested envelope the Bacs page shows", async () => {
    const event = await parse(bacsReturnCompleted);
    expect(event.type).toBe("payment.failed");
    expect(event.pspPaymentId).toBe(PAYMENT_ID);
    expect(event.amount).toBe(25469);
    expect(event.currency).toBe("GBP");
    expect(event.occurredAt).toBe("2026-08-14T11:03:00.000Z");

    const nestedPayment = await parse({
      variables: { payload: sepaPaymentCompleted.payload, attemptNumber: "1", type: "PAYMENT", eventDate: "2026-08-03T09:15:00Z" },
      type: "PAYMENT",
      eventName: "PAYMENT_COMPLETED",
    });
    expect(nestedPayment.type).toBe("payment.succeeded");
    expect(nestedPayment.pspPaymentId).toBe(PAYMENT_ID);
    // Nesting is packaging: the same event keys to the same id either way.
    expect(nestedPayment.id).toBe((await parse(sepaPaymentCompleted)).id);
  });

  it("recognizes a return by its event name alone, in either spelling, or by its type alone", async () => {
    const { type: _category, ...untyped } = sepaReturnCompleted;
    for (const eventName of ["PAYMENT_RETURN_COMPLETED", "PAYMENT_RETURNED_COMPLETED"]) {
      const event = await parse({ ...untyped, eventName });
      expect(event.type, eventName).toBe("payment.failed");
      expect(event.pspPaymentId, eventName).toBe(PAYMENT_ID);
    }
    const { eventName: _eventName, ...unnamed } = sepaReturnCompleted;
    const byType = await parse(unnamed);
    expect(byType.type).toBe("unknown");
    expect(byType.pspPaymentId).toBe(PAYMENT_ID);
  });

  it("leaves pspPaymentId unset on a return that names no payment", async () => {
    const { paymentId: _paymentId, ...payload } = sepaReturnCompleted.payload;
    const event = await parse({ ...sepaReturnCompleted, payload, resourceId: RETURN_ID });
    expect(event.type).toBe("payment.failed");
    expect(event.pspPaymentId).toBeUndefined();
  });

  it("reports refunds by refundId with no pspPaymentId, since the refund payload names no payment", async () => {
    const completed = await parse(refundEvent("REFUND_COMPLETED", "COMPLETED"));
    expect(completed.type).toBe("payment.refunded");
    expect(completed.refundId).toBe(REFUND_ID);
    expect(completed.pspPaymentId).toBeUndefined();
    expect(completed.amount).toBe(200);
    expect(completed.currency).toBe("EUR");

    for (const [eventName, status] of [
      ["REFUND_FAILED", "FAILED"],
      ["REFUND_CANCELLED", "CANCELLED"],
      ["REFUND_ERRORED", "ERROR"],
    ] as const) {
      const event = await parse(refundEvent(eventName, status));
      expect(event.type, eventName).toBe("payment.refund_failed");
      expect(event.refundId, eventName).toBe(REFUND_ID);
      expect(event.pspPaymentId, eventName).toBeUndefined();
    }

    // Underway refund states stay unknown, but still name the refund to poll.
    const pending = await parse(refundEvent("REFUND_PENDING", "PENDING"));
    expect(pending.type).toBe("unknown");
    expect(pending.refundId).toBe(REFUND_ID);
    expect(pending.pspPaymentId).toBeUndefined();
  });

  it("reports a card payment by payload.id, falling back to resourceId", async () => {
    const card = {
      payload: {
        accountId: "1001234567",
        id: PAYMENT_ID,
        merchantRefNum: "card-order-1",
        amount: 1499,
        currencyCode: "USD",
        status: "COMPLETED",
        txnTime: "2026-08-01T08:35:19Z",
        settleWithAuth: true,
        cardType: "VI",
        lastDigits: "1111",
      },
      attemptNumber: "1",
      type: "PAYMENT",
      resourceId: PAYMENT_ID,
      eventDate: "2026-08-01T08:35:19Z",
      settlements: [{ id: PAYMENT_ID, status: "PENDING", amount: 1499 }],
      links: [{ rel: "payment" }],
      eventName: "PAYMENT_COMPLETED",
    };
    const event = await parse(card);
    expect(event.type).toBe("payment.succeeded");
    expect(event.pspPaymentId).toBe(PAYMENT_ID);
    expect(event.refundId).toBeUndefined();

    const { id: _id, ...payloadWithoutId } = card.payload;
    expect((await parse({ ...card, payload: payloadWithoutId })).pspPaymentId).toBe(PAYMENT_ID);
  });

  it("never serves a settlement or handle id as a payment id", async () => {
    for (const eventName of ["SETTLEMENT_PROCESSING", "SETTLEMENT_COMPLETED", "SETTLEMENT_CLEARED", "SETTLEMENT_CANCELLED"]) {
      const event = await parse(settlementEvent(eventName, "2026-08-03T11:30:00Z"));
      expect(event.type, eventName).toBe("unknown");
      expect(event.pspPaymentId, eventName).toBeUndefined();
    }
    const handle = await parse({
      attemptNumber: "1",
      type: "PAYMENT_HANDLE",
      payload: { id: HANDLE_ID, usage: "MULTI_USE", status: "PAYABLE", paymentType: "SEPA", merchantRefNum: "sepa-order-1" },
      resourceId: HANDLE_ID,
      eventName: "PAYMENT_HANDLE_PAYABLE",
    });
    expect(handle.type).toBe("unknown");
    expect(handle.pspPaymentId).toBeUndefined();
    expect(handle.raw).toMatchObject({ payload: { merchantRefNum: "sepa-order-1" } });
  });

  it("maps the payment events documented on the rail pages", async () => {
    const at = (eventName: string, status: string) =>
      parse({ ...sepaPaymentCompleted, payload: { ...sepaPaymentCompleted.payload, status }, eventName });
    // Interac e-Transfer page: "The payment has an error (non http status 402 error)."
    const errored = await at("PAYMENT_ERRORED", "ERROR");
    expect(errored.type).toBe("payment.failed");
    expect(errored.pspPaymentId).toBe(PAYMENT_ID);
    // Pay by Bank (US), PayPal and Rapid Transfer webhook pages.
    expect((await at("PAYMENT_PENDING", "PENDING")).type).toBe("payment.processing");
  });

  it("treats wrongly typed fields as absent instead of throwing", async () => {
    const event = await parse({ eventName: 42, type: ["PAYMENT"], payload: [PAYMENT_ID], resourceId: 7 });
    expect(event.type).toBe("unknown");
    expect(event.pspPaymentId).toBeUndefined();
    expect(event.id).toMatch(/^paysafe_[0-9a-f]{64}$/);
  });

  it("rejects a JSON array as a payload", async () => {
    try {
      await parsePaysafeWebhookEvent("[]");
      expect.unreachable();
    } catch (err) {
      expect(isPayFanoutError(err) && err.code).toBe("invalid_request");
    }
  });
});

describe("Paysafe webhook event ids", () => {
  it("gives every delivery attempt of one notification the same id", async () => {
    const ids = new Set<string>();
    for (const attemptNumber of ["1", "2", "3"]) {
      ids.add((await parse({ ...sepaReturnCompleted, attemptNumber })).id);
      ids.add((await parse({ ...bacsReturnCompleted, variables: { ...bacsReturnCompleted.variables, attemptNumber } })).id);
    }
    // The official PHP SDK's fixture sends the counter as a number.
    ids.add((await parse({ ...sepaReturnCompleted, attemptNumber: 2 })).id);
    expect(ids.size).toBe(2); // one per notification: the SEPA return and the Bacs return
  });

  it("hashes the event name, resource id, status and status time", async () => {
    const event = await parse(sepaReturnCompleted);
    expect(event.id).toBe(expectedEventId("PAYMENT_RETURN_COMPLETED", RETURN_ID, "COMPLETED", "2026-08-06T14:02:11Z"));
    // Pinned: a change here re-keys every Paysafe event a host has deduped.
    expect(event.id).toBe("paysafe_906b3a185b17430fca50c6d044fc0851ff939b4b7dd0614e783b21652fb5a89a");
  });

  it("keeps distinct events apart", async () => {
    const ids = [
      (await parse(settlementEvent("SETTLEMENT_COMPLETED", "2026-08-03T11:30:00Z"))).id,
      // Same resource, status and status time, next lifecycle event (the SEPA page shows this pair).
      (await parse(settlementEvent("SETTLEMENT_CLEARED", "2026-08-03T11:30:00Z"))).id,
      // Same event reported at a later status time.
      (await parse(settlementEvent("SETTLEMENT_COMPLETED", "2026-08-09T18:04:47Z"))).id,
      // Same name, another resource.
      (await parse({ ...sepaReturnCompleted, payload: { ...sepaReturnCompleted.payload, id: HANDLE_ID } })).id,
      // Same name and resource, another status.
      (await parse({ ...sepaReturnCompleted, payload: { ...sepaReturnCompleted.payload, status: "FAILED" } })).id,
      (await parse(sepaReturnCompleted)).id,
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("falls back from statusTime to txnTime, then to the envelope eventDate", async () => {
    const refund = await parse(refundEvent("REFUND_COMPLETED", "COMPLETED"));
    expect(refund.id).toBe(expectedEventId("REFUND_COMPLETED", REFUND_ID, "COMPLETED", "2026-08-20T13:10:11Z"));

    const bare = { resourceId: HANDLE_ID, eventName: "PAYMENT_HANDLE_PAYABLE", eventDate: "2026-08-02T10:00:00Z" };
    expect((await parse(bare)).id).toBe(expectedEventId("PAYMENT_HANDLE_PAYABLE", HANDLE_ID, null, "2026-08-02T10:00:00Z"));
    expect((await parse({ resourceId: HANDLE_ID, eventName: "PAYMENT_HANDLE_PAYABLE" })).id).toBe(
      expectedEventId("PAYMENT_HANDLE_PAYABLE", HANDLE_ID, null, null),
    );

    // The spec's own settlement examples carry txnTime as epoch milliseconds.
    const epoch = settlementEvent("SETTLEMENT_COMPLETED", "");
    const { statusTime: _statusTime, ...payload } = epoch.payload as Record<string, unknown>;
    expect((await parse({ ...epoch, payload: { ...payload, txnTime: 1674814529000 } })).id).toBe(
      expectedEventId("SETTLEMENT_COMPLETED", PAYMENT_ID, "COMPLETED", 1674814529000),
    );
  });

  it("does not take a top-level id as the event id", async () => {
    // Paysafe's webhook page shows the resource's own id at top level; keying on it
    // would merge every event of that resource into one.
    const withId = (body: Record<string, unknown>) => ({ ...body, id: PAYMENT_ID });
    const completed = await parse(withId(settlementEvent("SETTLEMENT_COMPLETED", "2026-08-03T11:30:00Z")));
    const cleared = await parse(withId(settlementEvent("SETTLEMENT_CLEARED", "2026-08-03T11:30:00Z")));
    expect(completed.id).not.toBe(PAYMENT_ID);
    expect(completed.id).not.toBe(cleared.id);
  });

  it("keys a body naming no resource on its content, attempt counter and key order aside", async () => {
    const first = await parsePaysafeWebhookEvent('{"eventName":"SOMETHING_NEW","attemptNumber":"1","detail":{"b":2,"a":1}}');
    const retried = await parsePaysafeWebhookEvent('{"attemptNumber":"3","detail":{"a":1,"b":2},"eventName":"SOMETHING_NEW"}');
    const other = await parsePaysafeWebhookEvent('{"eventName":"SOMETHING_NEW","attemptNumber":"1","detail":{"a":1,"b":3}}');
    const listed = await parsePaysafeWebhookEvent('{"eventName":"SOMETHING_NEW","items":[{"b":1,"a":2}]}');
    expect(first.type).toBe("unknown");
    expect(retried.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    expect(listed.id).toMatch(/^paysafe_[0-9a-f]{64}$/);
  });
});

describe("Paysafe webhook signature header", () => {
  const KEY = "webhook-hmac-key";
  const rawBody = JSON.stringify(sepaPaymentCompleted);
  const sign = (body: string, key = KEY) => createHmac("sha256", key).update(body, "utf8").digest("base64");

  it("verifies the documented Signature header as delivered", async () => {
    await expect(verifyPaysafeWebhookSignature(rawBody, { Signature: sign(rawBody) }, KEY)).resolves.toBe(true);
    await expect(verifyPaysafeWebhookSignature(rawBody, { Signature: sign(rawBody, "other-key") }, KEY)).resolves.toBe(false);
    const adapter = new PaysafeServerAdapter({
      username: "u",
      password: "p",
      environment: "sandbox",
      merchantAccountResolver: () => undefined,
      sessionSigningKey: "session-key",
      webhookHmacKey: KEY,
    });
    await expect(adapter.verifyWebhookSignature(rawBody, { Signature: sign(rawBody) })).resolves.toBe(true);
  });

  it("reads Signature ahead of the tolerated aliases", async () => {
    const good = sign(rawBody);
    const bad = sign(rawBody, "other-key");
    await expect(verifyPaysafeWebhookSignature(rawBody, { Signature: good, "X-Signature": bad }, KEY)).resolves.toBe(true);
    await expect(verifyPaysafeWebhookSignature(rawBody, { Signature: bad, "X-Signature": good }, KEY)).resolves.toBe(false);
    await expect(verifyPaysafeWebhookSignature(rawBody, { "x-signature": good }, KEY)).resolves.toBe(true);
    await expect(verifyPaysafeWebhookSignature(rawBody, { "x-paysafe-signature": good }, KEY)).resolves.toBe(true);
  });

  it("fails closed without a signature or a key", async () => {
    await expect(verifyPaysafeWebhookSignature(rawBody, {}, KEY)).resolves.toBe(false);
    await expect(verifyPaysafeWebhookSignature(rawBody, { Signature: "" }, KEY)).resolves.toBe(false);
    await expect(verifyPaysafeWebhookSignature(rawBody, { Signature: sign(rawBody, "") }, [""])).resolves.toBe(false);
  });
});

describe("Paysafe onboarding webhook events", () => {
  const DOCUMENTED = [
    "PAYMENT_COMPLETED",
    "PAYMENT_FAILED",
    "PAYMENT_ERRORED",
    "PAYMENT_CANCELLED",
    "PAYMENT_PROCESSING",
    "PAYMENT_RECEIVED",
    "PAYMENT_PENDING",
    "PAYMENT_HELD",
    "PAYMENT_RETURN_COMPLETED",
    "PAYMENT_RETURNED_COMPLETED",
    "REFUND_COMPLETED",
    "REFUND_FAILED",
    "REFUND_CANCELLED",
    "REFUND_ERRORED",
  ];
  const UNDOCUMENTED = ["PAYMENT_DECLINED", "PAYMENT_EXPIRED", "PAYMENT_AUTHENTICATION_REQUIRED", "REFUND_DECLINED", "REFUND_ERROR"];

  it("advertises exactly the event names Paysafe documents", () => {
    expect(paysafeOnboarding.webhook.events).toEqual(DOCUMENTED);
  });

  it("maps every advertised name, and still parses the undocumented ones it does not advertise", async () => {
    for (const eventName of DOCUMENTED) {
      expect((await parse({ ...sepaPaymentCompleted, eventName })).type, eventName).not.toBe("unknown");
    }
    for (const eventName of UNDOCUMENTED) {
      expect(paysafeOnboarding.webhook.events).not.toContain(eventName);
      expect((await parse({ ...sepaPaymentCompleted, eventName })).type, eventName).not.toBe("unknown");
    }
  });
});
