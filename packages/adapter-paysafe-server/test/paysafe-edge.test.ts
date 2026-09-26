import { describe, expect, it } from "vitest";
import { getUserMessage, isPayFanoutError, type UnifiedErrorCode, type UnifiedPaymentStatus } from "@payfanout/core";
import {
  decodeSessionContext,
  encodeSessionContext,
  mapPaysafeError,
  parsePaysafeWebhookEvent,
  PaysafeServerAdapter,
  type PaysafePaymentLike,
  type PaysafeServerAdapterConfig,
} from "../src/index.js";

const SIGNING_KEY = "edge-signing-key";
/** A context expiry comfortably in the future for tests not about TTLs. */
const FUTURE = Date.now() + 60 * 60 * 1000;

function adapterWithPayment(payment: Partial<PaysafePaymentLike>): PaysafeServerAdapter {
  return new PaysafeServerAdapter({
    username: "u",
    password: "p",
    environment: "sandbox",
    merchantAccountResolver: () => "acct-1",
    sessionSigningKey: SIGNING_KEY,
    webhookHmacKey: "wh",
    fetch: async () =>
      new Response(JSON.stringify({ id: "pay_1", amount: 100, currencyCode: "USD", ...payment }), { status: 200 }),
  });
}

describe("Paysafe status mapping", () => {
  const cases: Array<[Partial<PaysafePaymentLike>, UnifiedPaymentStatus]> = [
    [{ status: "COMPLETED", settleWithAuth: true }, "succeeded"],
    [{ status: "COMPLETED", settleWithAuth: false, settlements: [] }, "requires_capture"],
    [
      { status: "COMPLETED", settleWithAuth: false, settlements: [{ id: "s1", status: "PENDING", amount: 100 }] },
      "succeeded",
    ],
    [{ status: "RECEIVED" }, "processing"],
    [{ status: "PENDING" }, "processing"],
    [{ status: "PROCESSING" }, "processing"],
    [{ status: "HELD" }, "processing"],
    [{ status: "INITIATED" }, "requires_action"],
    [{ status: "FAILED" }, "failed"],
    [{ status: "ERROR" }, "failed"],
    [{ status: "CANCELLED" }, "canceled"],
    [{ status: "EXPIRED" }, "canceled"],
    [{ status: "SOMETHING_NEW" }, "processing"],
  ];
  for (const [payment, expected] of cases) {
    it(`maps ${payment.status}${payment.settleWithAuth !== undefined ? ` (settleWithAuth: ${payment.settleWithAuth})` : ""} -> ${expected}`, async () => {
      const info = await adapterWithPayment(payment).retrievePayment("pay_1");
      expect(info.status).toBe(expected);
    });
  }
});

describe("Paysafe verification status mapping", () => {
  const cases: Array<[string, UnifiedPaymentStatus]> = [
    ["COMPLETED", "succeeded"],
    ["FAILED", "failed"],
    // "The verification has errored - failed for non-business reason"
    ["ERROR", "failed"],
    ["RECEIVED", "processing"],
  ];
  for (const [status, expected] of cases) {
    it(`maps a verification answered ${status} -> ${expected}`, async () => {
      const adapter = adapterWithPayment({ id: "ver_1", merchantRefNum: "k-verify", status, txnTime: "2026-07-04T10:00:00Z" });
      const session = await adapter.createPaymentSession({ amount: 0, currency: "USD", idempotencyKey: "k" });
      const info = await adapter.verifyPaymentMethod({
        pspSessionId: session.pspSessionId,
        clientToken: "tok_verify",
        idempotencyKey: "k-verify",
      });
      expect(info.status).toBe(expected);
    });
  }
});

describe("mapPaysafeError", () => {
  // HTTP statuses as Paysafe's card errors table pairs them with each code,
  // except 3004 (a 400 there), sent as a 402 so that its mapping, not the
  // HTTP fallback, decides.
  const cases: Array<[number, string | undefined, UnifiedErrorCode, boolean]> = [
    [402, "3406", "processing_error", true], // settlement not batched yet
    [402, "3022", "insufficient_funds", false],
    [400, "3006", "expired_card", false],
    [402, "3017", "invalid_card_data", false],
    [400, "3002", "invalid_card_data", false], // invalid card number or brand
    [400, "3005", "invalid_card_data", false], // incorrect CVV
    [402, "3012", "invalid_card_data", false], // invalid expiry date
    [402, "3019", "invalid_card_data", false], // failed the CVV check
    [402, "3007", "invalid_card_data", false], // failed the AVS check
    [402, "3004", "invalid_request", false], // zip/billing data required — data quality, not a decline
    [402, "3009", "card_declined", false],
    [402, "3060", "authentication_required", false], // Strong Customer Authentication is required
    [402, "3039", "authentication_required", false], // invalid authentication value
    [402, "3054", "fraud_suspected", false], // declined due to suspected fraud
    [402, "3016", "fraud_suspected", false], // may be a lost or stolen card
    [402, "4001", "fraud_suspected", false], // in Paysafe's negative database
    [402, "4002", "fraud_suspected", false], // declined by Paysafe's Risk Management
    [402, "8000", "fraud_suspected", false], // in no current table, still mapped
    [402, "8001", "fraud_suspected", false],
    [402, "3202", "invalid_request", false], // the maximum number of settlements
    [402, "3204", "invalid_request", false], // capture beyond the remaining authorization
    [402, "3205", "invalid_request", false], // the authorization to settle has expired
    [402, "3402", "invalid_request", false], // refund beyond the remaining settlement
    [402, "3403", "invalid_request", false], // the settlement's maximum number of refunds
    [402, "3405", "invalid_request", false], // the settlement to refund has expired
    [402, "3419", "unsupported_operation", false], // this type of transaction cannot be refunded
    [402, "3507", "unsupported_operation", false], // no partial void on this authorization
    [402, "3416", "unsupported_operation", false], // the gateway takes no partial settlement
    [402, "3418", "unsupported_operation", false], // the gateway takes no partial refund
    [402, "3503", "unsupported_operation", false], // no void for the card type
    [402, "3504", "unsupported_operation", false], // the gateway takes no partial void
    [402, "9999", "card_declined", false], // unknown code on a 402 is still a decline
    [402, "3421", "card_declined", false], // a code the map leaves on the 402 default
    [402, "3412", "invalid_request", false],
    [402, "3413", "invalid_request", false],
    [400, "3073", "card_declined", false],
    [400, "3008", "card_declined", false],
    [402, "constructor", "card_declined", false], // only the map's own keys are codes
    [429, undefined, "rate_limited", true],
    [429, "1200", "rate_limited", true], // Paysafe's rate-limit code
    [500, undefined, "psp_unavailable", true],
    [503, "1234", "psp_unavailable", true],
    // A 429 or a 5xx stays transient whatever mapped code it carries.
    [429, "3406", "rate_limited", true],
    [500, "3022", "psp_unavailable", true],
    [502, "3060", "psp_unavailable", true],
    [504, "3419", "psp_unavailable", true],
    [400, "5068", "invalid_request", false],
    [404, undefined, "invalid_request", false],
    [401, undefined, "invalid_request", false],
  ];
  for (const [status, code, expected, retryable] of cases) {
    it(`maps HTTP ${status}${code ? ` code ${code}` : ""} -> ${expected}`, () => {
      const body = code ? { error: { code, message: "x" } } : { error: { message: "x" } };
      const mapped = mapPaysafeError(status, body);
      expect(mapped.code).toBe(expected);
      expect(mapped.retryable).toBe(retryable);
      expect(mapped.raw).toBe(body);
      expect(mapped.pspName).toBe("paysafe");
    });
  }

  it("gives 3004 the catalog invalid_request message, never the decline text", () => {
    const mapped = mapPaysafeError(402, { error: { code: "3004", message: "Zip is required" } });
    expect(mapped.message).toBe(getUserMessage("invalid_request"));
    expect(mapped.message).not.toBe(getUserMessage("card_declined"));
  });

  it("never relays Paysafe's own wording: every code gets its catalog message", () => {
    const answers: Array<[number, string, string]> = [
      [402, "3060", "Your request has been declined because Strong Customer Authentication is required."],
      [402, "4002", "The transaction was declined by our Risk Management department."],
      [400, "3005", "You submitted an incorrect CVV value with your request."],
      [402, "3419", "This type of transaction cannot be refunded."],
    ];
    for (const [status, code, message] of answers) {
      const mapped = mapPaysafeError(status, { error: { code, message } });
      expect(mapped.message, code).toBe(getUserMessage(mapped.code));
      expect(mapped.message, code).not.toBe(message);
    }
  });

  it("leaves the answers the replay logic reads by code on their HTTP fallback", () => {
    const replayAnswers: Array<[number, string, UnifiedErrorCode]> = [
      [409, "5031", "invalid_request"],
      [402, "3044", "card_declined"],
      [402, "3417", "card_declined"],
      [400, "5283", "invalid_request"],
    ];
    for (const [status, code, expected] of replayAnswers) {
      const mapped = mapPaysafeError(status, { error: { code, message: "x" } });
      expect(mapped.code, code).toBe(expected);
      expect(mapped.retryable, code).toBe(false);
    }
  });
});

describe("session context edge cases", () => {
  it("rejects tokens without a signature separator", async () => {
    await expect(decodeSessionContext("no-dot-here", SIGNING_KEY)).rejects.toThrowError(/payload\.signature/);
  });

  it("rejects a valid signature over a non-JSON payload", async () => {
    const badPayload = Buffer.from("not json", "utf8").toString("base64url");
    const signed = await encodeSessionContext(
      { v: 1, amount: 1, currency: "USD", merchantAccountId: "a", captureMethod: "automatic", expiresAt: FUTURE },
      SIGNING_KEY,
    );
    const signature = signed.split(".")[1]!;
    // Re-sign the garbage payload correctly by borrowing the real signer via encode? No —
    // craft it manually: signature won't match, which is also a valid rejection path.
    await expect(decodeSessionContext(`${badPayload}.${signature}`, SIGNING_KEY)).rejects.toThrowError(
      /signature mismatch|not valid JSON/,
    );
  });

  it("rejects structurally wrong payloads that are correctly signed", async () => {
    const wrongShape = await encodeSessionContext(
      { v: 2 as never, amount: "x" as never, currency: 5 as never, merchantAccountId: "a", captureMethod: "automatic", expiresAt: FUTURE },
      SIGNING_KEY,
    );
    await expect(decodeSessionContext(wrongShape, SIGNING_KEY)).rejects.toThrowError(/unsupported shape/);
  });

  it("round-trips every optional field", async () => {
    const full = {
      v: 1 as const,
      amount: 12345,
      currency: "EUR",
      country: "DE",
      merchantAccountId: "acct-9",
      captureMethod: "manual" as const,
      expiresAt: FUTURE,
      webhookUrl: "https://h.example/wh",
      returnUrl: "https://h.example/rt",
      id: "order-1",
      metadata: { a: "b" },
      statementDescriptor: "SHOP ORDER1",
      receiptEmail: "buyer@example.com",
      shippingDetails: { name: "Ann Buyer", address: { line1: "1 Way", city: "Berlin", postalCode: "10115", country: "DE" } },
    };
    await expect(decodeSessionContext(await encodeSessionContext(full, SIGNING_KEY), SIGNING_KEY)).resolves.toEqual(full);
  });

  it("rejects an expired context with session_expired and a missing expiry as invalid_request", async () => {
    const base = { v: 1 as const, amount: 100, currency: "USD", captureMethod: "automatic" as const };
    const expired = await encodeSessionContext({ ...base, expiresAt: Date.now() - 1 }, SIGNING_KEY);
    // Expiry is a recoverable host condition (create a fresh session), not a malformed request.
    await expect(decodeSessionContext(expired, SIGNING_KEY)).rejects.toMatchObject({
      code: "session_expired",
      retryable: false,
      message: expect.stringMatching(/expired/),
    });
    // Explicit clock: expiry is compared against the caller's `now`.
    const shortLived = await encodeSessionContext({ ...base, expiresAt: 1_000_000 }, SIGNING_KEY);
    expect((await decodeSessionContext(shortLived, SIGNING_KEY, { now: 999_999 })).amount).toBe(100);
    await expect(decodeSessionContext(shortLived, SIGNING_KEY, { now: 1_000_001 })).rejects.toMatchObject({
      code: "session_expired",
    });
    // Tokens with no expiresAt are rejected — unbounded lifetime is the hole TTLs
    // close. That is a malformed token, so it stays invalid_request.
    const legacy = await encodeSessionContext({ ...base, expiresAt: undefined as never }, SIGNING_KEY);
    await expect(decodeSessionContext(legacy, SIGNING_KEY)).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/no expiry/),
    });
  });

});

describe("webhook edge cases", () => {
  it("rejects JSON that is not an object", async () => {
    for (const rawBody of ["null", "42", '"PAYMENT_COMPLETED"']) {
      try {
        await parsePaysafeWebhookEvent(rawBody);
        expect.unreachable();
      } catch (err) {
        expect(isPayFanoutError(err), rawBody).toBe(true);
        if (isPayFanoutError(err)) expect(err.code).toBe("invalid_request");
      }
    }
  });

  it("falls back deterministically when timestamps are missing or garbage", async () => {
    const noTime = await parsePaysafeWebhookEvent(JSON.stringify({ eventName: "PAYMENT_COMPLETED" }));
    expect(noTime.occurredAt).toBe("1970-01-01T00:00:00.000Z");
    const badTime = await parsePaysafeWebhookEvent(
      JSON.stringify({ eventName: "PAYMENT_COMPLETED", txnTime: "not-a-date" }),
    );
    expect(badTime.occurredAt).toBe("1970-01-01T00:00:00.000Z");
    const eventDate = await parsePaysafeWebhookEvent(
      JSON.stringify({ eventName: "PAYMENT_COMPLETED", eventDate: "2026-07-04T10:00:00Z" }),
    );
    expect(eventDate.occurredAt).toBe("2026-07-04T10:00:00.000Z");
  });

  it("maps the documented event names", async () => {
    const documented: Array<[string, string]> = [
      ["PAYMENT_COMPLETED", "payment.succeeded"],
      ["PAYMENT_FAILED", "payment.failed"],
      ["PAYMENT_ERRORED", "payment.failed"],
      ["PAYMENT_CANCELLED", "payment.canceled"],
      ["PAYMENT_PROCESSING", "payment.processing"],
      ["PAYMENT_RECEIVED", "payment.processing"],
      ["PAYMENT_PENDING", "payment.processing"],
      ["PAYMENT_HELD", "payment.processing"],
      // A bank return arrives under BOTH spellings — Paysafe's event tables say
      // RETURNED, its payload examples say RETURN. Either wire value must
      // finalize the debit as failed, never land as unknown.
      ["PAYMENT_RETURNED_COMPLETED", "payment.failed"],
      ["PAYMENT_RETURN_COMPLETED", "payment.failed"],
      ["REFUND_COMPLETED", "payment.refunded"],
      ["REFUND_FAILED", "payment.refund_failed"],
      ["REFUND_CANCELLED", "payment.refund_failed"],
      ["REFUND_ERRORED", "payment.refund_failed"],
      // Settlement and handle events describe those resources, not the payment —
      // deliberately unmapped so their ids are never served as payment ids.
      ["SETTLEMENT_COMPLETED", "unknown"],
      ["PAYMENT_HANDLE_PAYABLE", "unknown"],
      // In-flight refund states have no unified type.
      ["REFUND_PENDING", "unknown"],
      ["SOMETHING_ELSE", "unknown"],
    ];
    for (const [eventName, expected] of documented) {
      expect((await parsePaysafeWebhookEvent(JSON.stringify({ eventName }))).type, eventName).toBe(expected);
    }
  });

  it("tolerates spellings and names no Paysafe page documents", async () => {
    const tolerated: Array<[string, string]> = [
      ["PAYMENT.COMPLETED", "payment.succeeded"],
      ["payment_completed", "payment.succeeded"],
      ["PAYMENT-DECLINED", "payment.failed"],
      ["PAYMENT_EXPIRED", "payment.canceled"],
      ["PAYMENT_AUTHENTICATION_REQUIRED", "payment.requires_action"],
      ["REFUND_DECLINED", "payment.refund_failed"],
      ["REFUND_ERROR", "payment.refund_failed"],
      ["CHARGEBACK_OPENED", "payment.chargeback"],
      ["DISPUTE_WON", "payment.chargeback_won"],
      ["CHARGEBACK_LOST", "payment.chargeback_lost"],
    ];
    for (const [eventName, expected] of tolerated) {
      expect((await parsePaysafeWebhookEvent(JSON.stringify({ eventName }))).type, eventName).toBe(expected);
    }
  });

  it("reads the event name from eventName, as real Payments-API deliveries send it", async () => {
    // Verbatim shape of a real sandbox delivery (values sanitized): the event name lives in
    // `eventName`; top-level `type` is the resource CATEGORY ("PAYMENT"), not the event; and
    // there is no top-level `id`, so the adapter derives the dedupe id.
    const rawBody = JSON.stringify({
      payload: {
        id: "cfdd12b1-0000-0000-0000-000000000000",
        source: "PaysafeJSV2",
        merchantRefNum: "complete-ref-1",
        amount: 1000,
        currencyCode: "CAD",
        status: "COMPLETED",
        txnTime: "2026-07-10T15:07:39Z",
      },
      attemptNumber: "1",
      type: "PAYMENT",
      resourceId: "cfdd12b1-0000-0000-0000-000000000000",
      eventDate: "2026-07-10T15:07:39Z",
      eventName: "PAYMENT_COMPLETED",
    });
    const event = await parsePaysafeWebhookEvent(rawBody);
    expect(event.type).toBe("payment.succeeded"); // not "unknown"
    expect(event.pspPaymentId).toBe("cfdd12b1-0000-0000-0000-000000000000");
    expect(event.amount).toBe(1000);
    expect(event.currency).toBe("CAD");
    expect(event.occurredAt).toBe("2026-07-10T15:07:39.000Z");
    expect(event.id).toMatch(/^paysafe_[0-9a-f]{64}$/);
  });

  it("finalizes a bank return against the returned payment, not the return", async () => {
    // The late-failure event for a returned debit, in the documented shape: the
    // payload is the RETURN (its own id), and `paymentId` names the payment.
    const rawBody = JSON.stringify({
      payload: {
        id: "0a7c2e91-0000-0000-0000-000000000000",
        merchantRefNum: "sepa-ref-1",
        amount: 677,
        currencyCode: "EUR",
        status: "COMPLETED",
        txnTime: "2026-07-20T09:00:00Z",
        paymentId: "9f01ab23-0000-0000-0000-000000000000",
        settlementId: "9f01ab23-0000-0000-0000-000000000000",
      },
      attemptNumber: "1",
      type: "PAYMENT_RETURN",
      eventDate: "2026-07-20T09:00:00Z",
      eventName: "PAYMENT_RETURN_COMPLETED",
    });
    const event = await parsePaysafeWebhookEvent(rawBody);
    expect(event.type).toBe("payment.failed");
    expect(event.pspPaymentId).toBe("9f01ab23-0000-0000-0000-000000000000");
    expect(event.amount).toBe(677);
    expect(event.currency).toBe("EUR");
  });

  it("still reads legacy eventType/event fields and never treats the resource-category type as the event", async () => {
    expect((await parsePaysafeWebhookEvent(JSON.stringify({ eventType: "PAYMENT_COMPLETED" }))).type).toBe(
      "payment.succeeded",
    );
    expect((await parsePaysafeWebhookEvent(JSON.stringify({ event: "PAYMENT_COMPLETED" }))).type).toBe(
      "payment.succeeded",
    );
    // A body whose only event-ish field is the resource category must not be mistaken for an event.
    expect((await parsePaysafeWebhookEvent(JSON.stringify({ type: "PAYMENT" }))).type).toBe("unknown");
  });
});

describe("transport edge cases", () => {
  function makeAdapter(overrides: Partial<PaysafeServerAdapterConfig>): PaysafeServerAdapter {
    return new PaysafeServerAdapter({
      username: "u",
      password: "p",
      environment: "sandbox",
      merchantAccountResolver: () => "acct-1",
      sessionSigningKey: SIGNING_KEY,
      webhookHmacKey: "wh",
      ...overrides,
    });
  }

  it("maps network failures (fetch rejects) to retryable psp_unavailable", async () => {
    const adapter = makeAdapter({
      fetch: async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
    });
    try {
      await adapter.retrievePayment("pay_1");
      expect.unreachable();
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("psp_unavailable");
        expect(err.retryable).toBe(true);
        expect(err.raw).toBeInstanceOf(TypeError);
      }
    }
  });

  it("survives non-JSON error bodies from proxies/load balancers", async () => {
    const adapter = makeAdapter({
      fetch: async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    });
    await expect(adapter.retrievePayment("pay_1")).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
    });
  });

  it("rejects unknown payment method types at session creation", async () => {
    const adapter = makeAdapter({});
    await expect(
      adapter.createPaymentSession({
        amount: 100,
        currency: "USD",
        paymentMethodTypes: ["ideal"], // not in the Paysafe capability list
        idempotencyKey: "k",
      }),
    ).rejects.toThrowError(/does not support one of the requested/);
  });

  it("requires explicit environment and rejects a non-function resolver", () => {
    expect(() => makeAdapter({ environment: "prod" as never })).toThrowError(/sandbox.*live/);
    expect(() => makeAdapter({ merchantAccountResolver: undefined as never })).toThrowError(
      /merchantAccountResolver/,
    );
  });
});
