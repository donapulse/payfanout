import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getUserMessage, isPayFanoutError, type UnifiedErrorCode, type UnifiedPaymentStatus } from "@payfanout/core";
import {
  buildV1HmacAuthorization,
  decodeSessionContext,
  deriveIdempotenceKey,
  encodeSessionContext,
  mapWorldlineError,
  mapWorldlineStatus,
  parseWorldlineWebhookEvent,
  verifyWorldlineWebhookSignature,
  type WorldlineWebhookKey,
} from "../src/index.js";

const FUTURE = Date.now() + 60 * 60 * 1000;

describe("v1HMAC signing", () => {
  it("signs a POST over the canonical string exactly (cross-checked against node:crypto)", async () => {
    const secret = "secret-api-key";
    const date = "Tue, 14 Jul 2026 10:00:00 GMT";
    const idem = await deriveIdempotenceKey("caller-key");
    const auth = await buildV1HmacAuthorization({
      apiKeyId: "kid",
      secretApiKey: secret,
      method: "POST",
      path: "/v2/mid-1/payments",
      date,
      contentType: "application/json",
      gcsHeaders: { "X-GCS-Idempotence-Key": idem },
    });
    const dataToSign = `POST\napplication/json\n${date}\nx-gcs-idempotence-key:${idem}\n/v2/mid-1/payments\n`;
    const expected = createHmac("sha256", secret).update(dataToSign, "utf8").digest("base64");
    expect(auth).toBe(`GCS v1HMAC:kid:${expected}`);
  });

  it("signs a GET with an empty content-type line and no x-gcs headers", async () => {
    const secret = "s";
    const date = "Tue, 14 Jul 2026 10:00:00 GMT";
    const auth = await buildV1HmacAuthorization({
      apiKeyId: "kid",
      secretApiKey: secret,
      method: "GET",
      path: "/v2/mid-1/payments/pay_1",
      date,
    });
    const dataToSign = `GET\n\n${date}\n/v2/mid-1/payments/pay_1\n`;
    const expected = createHmac("sha256", secret).update(dataToSign, "utf8").digest("base64");
    expect(auth).toBe(`GCS v1HMAC:kid:${expected}`);
  });

  it("sorts x-gcs headers alphabetically and collapses whitespace in values", async () => {
    const secret = "s";
    const date = "Tue, 14 Jul 2026 10:00:00 GMT";
    const auth = await buildV1HmacAuthorization({
      apiKeyId: "kid",
      secretApiKey: secret,
      method: "POST",
      path: "/v2/m/payments",
      date,
      contentType: "application/json",
      gcsHeaders: { "X-GCS-Idempotence-Key": "abc", "X-GCS-ClientMetaInfo": "  spaced   value " },
    });
    const dataToSign = `POST\napplication/json\n${date}\nx-gcs-clientmetainfo:spaced value\nx-gcs-idempotence-key:abc\n/v2/m/payments\n`;
    const expected = createHmac("sha256", secret).update(dataToSign, "utf8").digest("base64");
    expect(auth).toBe(`GCS v1HMAC:kid:${expected}`);
  });

  it("derives a deterministic <=40 ASCII idempotence key from an arbitrary key", async () => {
    const long = "some-long-caller-idempotency-key-value-well-over-forty-characters";
    const a = await deriveIdempotenceKey(long);
    const b = await deriveIdempotenceKey(long);
    expect(a).toBe(b);
    expect(a).toHaveLength(40);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(a).toBe(createHash("sha256").update(long).digest("hex").slice(0, 40));
  });
});

describe("mapWorldlineStatus", () => {
  const cases: Array<[string | undefined, number | undefined, string | undefined, UnifiedPaymentStatus]> = [
    ["CAPTURED", 9, "COMPLETED", "succeeded"],
    ["PENDING_CAPTURE", 5, "PENDING_MERCHANT", "requires_capture"],
    ["PENDING_CAPTURE", 56, "PENDING_MERCHANT", "requires_capture"],
    // The PENDING_CONNECT_OR_3RD_PARTY band: only REDIRECTED is a customer action;
    // the async downstream members are processing.
    ["REDIRECTED", 46, "PENDING_CONNECT_OR_3RD_PARTY", "requires_action"],
    ["AUTHORIZATION_REQUESTED", undefined, "PENDING_CONNECT_OR_3RD_PARTY", "processing"],
    ["AUTHORIZATION_REQUESTED", 50, "PENDING_CONNECT_OR_3RD_PARTY", "processing"],
    ["CAPTURE_REQUESTED", undefined, "PENDING_CONNECT_OR_3RD_PARTY", "processing"],
    ["CAPTURE_REQUESTED", 91, "PENDING_CONNECT_OR_3RD_PARTY", "processing"],
    // CANCELLED sits in the UNSUCCESSFUL band but must map to canceled, not failed.
    ["CANCELLED", undefined, "UNSUCCESSFUL", "canceled"],
    ["CANCELLED", 6, "UNSUCCESSFUL", "canceled"],
    ["CANCELLED", 1, "UNSUCCESSFUL", "canceled"],
    // 61/62: the cancellation still awaits the acquirer (CancelPayment answers it
    // as PENDING_MERCHANT, GetPayment lists it under UNSUCCESSFUL).
    ["CANCELLED", 61, "PENDING_MERCHANT", "processing"],
    ["CANCELLED", 62, "PENDING_MERCHANT", "processing"],
    ["CANCELLED", 61, "UNSUCCESSFUL", "processing"],
    // A refused cancellation (63) or capture (93) leaves the authorisation standing,
    // whatever string carries the code (the status enum has no CANCELLATION_REJECTED).
    ["CANCELLATION_REJECTED", 63, "UNSUCCESSFUL", "requires_capture"],
    ["CANCELLED", 63, "UNSUCCESSFUL", "requires_capture"],
    ["REJECTED_CAPTURE", 93, "UNSUCCESSFUL", "requires_capture"],
    ["REJECTED", 2, "UNSUCCESSFUL", "failed"],
    ["REJECTED", 57, "UNSUCCESSFUL", "failed"],
    ["REJECTED", 59, "UNSUCCESSFUL", "failed"],
    // A refused refund (83) or deletion (73) leaves the payment captured, even
    // when the code arrives without the REJECTED string.
    ["REJECTED", 83, "UNSUCCESSFUL", "succeeded"],
    ["REJECTED", 73, "UNSUCCESSFUL", "succeeded"],
    [undefined, 83, "UNSUCCESSFUL", "succeeded"],
    [undefined, 73, "UNSUCCESSFUL", "succeeded"],
    // A captured payment with a refund in flight, in both documented bands.
    ["REFUND_REQUESTED", 81, "REVERSED", "succeeded"],
    ["REFUND_REQUESTED", 82, "REVERSED", "succeeded"],
    ["REFUND_REQUESTED", 81, "PENDING_CONNECT_OR_3RD_PARTY", "succeeded"],
    ["REFUNDED", 8, "REVERSED", "succeeded"],
    [undefined, undefined, "REVERSED", "succeeded"],
    ["CREATED", 0, "CREATED", "processing"],
    ["REFUNDED", undefined, "REFUNDED", "succeeded"],
    [undefined, undefined, "PENDING_PAYMENT", "processing"],
    // statusCode fallback when no category is present.
    [undefined, 9, undefined, "succeeded"],
    [undefined, 5, undefined, "requires_capture"],
    [undefined, 56, undefined, "requires_capture"],
    [undefined, 63, undefined, "requires_capture"],
    [undefined, 93, undefined, "requires_capture"],
    [undefined, 2, undefined, "failed"],
    [undefined, 57, undefined, "failed"],
    [undefined, 59, undefined, "failed"],
    [undefined, 46, undefined, "requires_action"],
    [undefined, 6, undefined, "canceled"],
    [undefined, 1, undefined, "canceled"],
    [undefined, 61, undefined, "processing"],
    [undefined, 62, undefined, "processing"],
    [undefined, 73, undefined, "succeeded"],
    [undefined, 83, undefined, "succeeded"],
    [undefined, 7, undefined, "succeeded"],
    [undefined, 8, undefined, "succeeded"],
    [undefined, 85, undefined, "succeeded"],
    [undefined, 71, undefined, "succeeded"],
    [undefined, 72, undefined, "succeeded"],
    [undefined, 81, undefined, "succeeded"],
    [undefined, 82, undefined, "succeeded"],
    // A code with no fallback of its own stays processing.
    [undefined, 91, undefined, "processing"],
    // status-string fallback.
    ["CAPTURED", undefined, undefined, "succeeded"],
    ["REFUNDED", undefined, undefined, "succeeded"],
    ["REDIRECTED", undefined, undefined, "requires_action"],
    ["REJECTED", undefined, undefined, "failed"],
    ["REJECTED_CAPTURE", undefined, undefined, "requires_capture"],
    ["CANCELLATION_REJECTED", undefined, undefined, "requires_capture"],
    ["REFUND_REQUESTED", undefined, undefined, "succeeded"],
    ["PENDING_CAPTURE", undefined, undefined, "requires_capture"],
    // CAPTURE_REQUESTED is async downstream, not a terminal success.
    ["CAPTURE_REQUESTED", undefined, undefined, "processing"],
    // genuinely unknown -> processing (never a fabricated terminal state).
    ["SOMETHING_NEW", undefined, undefined, "processing"],
    // No status string: the cancellation codes decide before the UNSUCCESSFUL band.
    [undefined, 1, "UNSUCCESSFUL", "canceled"],
    [undefined, 6, "UNSUCCESSFUL", "canceled"],
    [undefined, 61, "UNSUCCESSFUL", "processing"],
    [undefined, 62, "UNSUCCESSFUL", "processing"],
    // ...including under PENDING_MERCHANT, the band CancelPayment gives 61/62.
    [undefined, 61, "PENDING_MERCHANT", "processing"],
    // An unknown status string with no category reaches the code fallback.
    ["SOMETHING_NEW", 6, undefined, "canceled"],
    ["SOMETHING_NEW", 61, undefined, "processing"],
  ];
  for (const [status, code, category, expected] of cases) {
    it(`maps ${status ?? "-"}/${code ?? "-"}/${category ?? "-"} -> ${expected}`, () => {
      expect(mapWorldlineStatus(status, code, category)).toBe(expected);
    });
  }
});

describe("mapWorldlineError", () => {
  const cases: Array<[number, string | undefined, UnifiedErrorCode, boolean]> = [
    // Cards reported stolen or lost, or flagged for fraud.
    [402, "30431001", "fraud_suspected", false],
    [402, "30411001", "fraud_suspected", false],
    [402, "30071001", "fraud_suspected", false],
    [402, "30591001", "fraud_suspected", false],
    // Rejections by the merchant's own Fraud Prevention module.
    [402, "30001100", "fraud_suspected", false],
    [402, "30001101", "fraud_suspected", false],
    [402, "30001102", "fraud_suspected", false],
    [402, "30001104", "fraud_suspected", false],
    [402, "30001105", "fraud_suspected", false],
    [402, "30001106", "fraud_suspected", false],
    [402, "30001120", "fraud_suspected", false],
    [402, "30001130", "fraud_suspected", false],
    [402, "30001140", "fraud_suspected", false],
    [402, "30001141", "fraud_suspected", false],
    [402, "30001142", "fraud_suspected", false],
    [402, "30001143", "fraud_suspected", false],
    [402, "30001158", "fraud_suspected", false],
    [402, "30001180", "fraud_suspected", false],
    [402, "30141001", "invalid_card_data", false],
    [402, "30151001", "invalid_card_data", false],
    [402, "30331001", "expired_card", false],
    [402, "30541001", "expired_card", false],
    [402, "30511001", "insufficient_funds", false],
    [402, "40001134", "authentication_required", false],
    [402, "40001139", "authentication_required", false],
    // 3-D Secure failures outside the customer's control, and an issuer out of reach.
    [402, "40001135", "processing_error", false],
    [402, "50001081", "processing_error", false],
    [402, "40001137", "processing_error", false],
    [402, "40001138", "processing_error", false],
    [402, "40001146", "processing_error", false],
    [402, "30911001", "processing_error", false],
    [402, "30681001", "processing_error", false],
    [402, "30991001", "processing_error", false],
    [402, "30201001", "processing_error", false],
    // The merchant's set-up or request, which the customer cannot fix.
    [402, "30031001", "invalid_request", false],
    [402, "30301001", "invalid_request", false],
    [402, "50001087", "invalid_request", false],
    // Plain declines, named in the map or left to the 402 default.
    [402, "30041001", "card_declined", false],
    [402, "30171001", "card_declined", false],
    [402, "30051001", "card_declined", false],
    [402, "30121001", "card_declined", false],
    [402, "30571001", "card_declined", false],
    [402, "30581001", "card_declined", false],
    [402, "30621001", "card_declined", false],
    [402, "30921001", "card_declined", false],
    [402, "33000972", "card_declined", false],
    [402, "33000973", "card_declined", false],
    [402, "33000975", "card_declined", false],
    [402, "33000833", "card_declined", false],
    [402, "99999999", "card_declined", false], // unknown code on a 402 is still a decline
    [402, undefined, "card_declined", false],
    // A documented code decides on any status that is not transient.
    [400, "30431001", "fraud_suspected", false],
    [429, undefined, "rate_limited", true],
    [500, undefined, "psp_unavailable", true],
    [503, "1234", "psp_unavailable", true],
    // 409 = an idempotent replay raced the still-in-flight original: retryable.
    [409, undefined, "processing_error", true],
    [400, "1", "invalid_request", false],
    [404, undefined, "invalid_request", false],
    [401, undefined, "invalid_request", false],
  ];
  for (const [status, code, expected, retryable] of cases) {
    it(`maps HTTP ${status}${code ? ` code ${code}` : ""} -> ${expected}`, () => {
      const body = code ? { errors: [{ errorCode: code, message: "x" }] } : { errors: [{ message: "x" }] };
      const mapped = mapWorldlineError(status, body);
      expect(mapped.code).toBe(expected);
      expect(mapped.retryable).toBe(retryable);
      expect(mapped.message).toBe(getUserMessage(expected));
      expect(mapped.raw).toBe(body);
      expect(mapped.pspName).toBe("worldline");
    });
  }

  const transient: Array<[number, UnifiedErrorCode]> = [
    [429, "rate_limited"],
    [500, "psp_unavailable"],
    [502, "psp_unavailable"],
    [503, "psp_unavailable"],
  ];
  for (const [status, expected] of transient) {
    it(`keeps HTTP ${status} ${expected} and retryable, whatever code it carries`, () => {
      for (const errorCode of ["30431001", "30511001", "30141001", "40001134", "40001135", "30911001", "30031001", "30301001", "50001087", "30041001"]) {
        const mapped = mapWorldlineError(status, { errors: [{ errorCode, httpStatusCode: status }] });
        expect(mapped).toMatchObject({ code: expected, retryable: true, message: getUserMessage(expected) });
      }
    });
  }

  it("reads the decline code from either errorCode or code", () => {
    expect(mapWorldlineError(402, { errors: [{ code: "30511001" }] }).code).toBe("insufficient_funds");
  });

  it("prefers errorCode over the deprecated code, and falls back to code when errorCode is missing or empty", () => {
    expect(mapWorldlineError(402, { errors: [{ code: "30431001" }] }).code).toBe("fraud_suspected");
    expect(mapWorldlineError(402, { errors: [{ errorCode: "", code: "30141001" }] }).code).toBe("invalid_card_data");
    expect(mapWorldlineError(402, { errors: [{ errorCode: "30331001", code: "1099" }] }).code).toBe("expired_card");
    expect(mapWorldlineError(402, { errors: [{ errorCode: "99999999", code: "30431001" }] }).code).toBe("card_declined");
  });

  it("reads a missing, empty or malformed errors array as carrying no code", () => {
    for (const body of [undefined, null, "Bad Gateway", {}, { errors: [] }, { errors: [null] }, { errors: "30431001" }]) {
      expect(mapWorldlineError(402, body)).toMatchObject({ code: "card_declined", retryable: false });
      expect(mapWorldlineError(400, body)).toMatchObject({ code: "invalid_request", retryable: false });
    }
  });

  it("never reads an inherited property as a mapped code", () => {
    for (const errorCode of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(mapWorldlineError(402, { errors: [{ errorCode }] }).code).toBe("card_declined");
      expect(mapWorldlineError(400, { errors: [{ errorCode }] }).code).toBe("invalid_request");
    }
  });

  it("never relays Worldline's message, which is not meant for customers, and leaves the body untouched", () => {
    const body = {
      errorId: "err-1",
      errors: [{ errorCode: "30431001", category: "PAYMENT_PLATFORM_ERROR", httpStatusCode: 402, message: "Authorisation declined" }],
    };
    const copy = structuredClone(body);
    const mapped = mapWorldlineError(402, body);
    expect(mapped.message).toBe(getUserMessage("fraud_suspected"));
    expect(mapped.message).not.toContain("Authorisation declined");
    expect(mapped.raw).toBe(body);
    expect(body).toEqual(copy);
  });

  it("gives authentication_required the catalog message and never marks it retryable", () => {
    const mapped = mapWorldlineError(402, { errors: [{ errorCode: "40001134" }] });
    expect(mapped.message).toBe(getUserMessage("authentication_required"));
    expect(mapped.retryable).toBe(false);
  });
});

describe("webhook parsing", () => {
  const money = { paymentOutput: { amountOfMoney: { amount: 1099, currencyCode: "EUR" } } };
  const variants: Array<[string, string]> = [
    ["payment.captured", "payment.succeeded"],
    ["payment.paid", "payment.succeeded"],
    ["payment.rejected", "payment.failed"],
    ["payment.rejected_capture", "unknown"],
    ["payment.cancelled", "payment.canceled"],
    ["payment.redirected", "payment.requires_action"],
    ["payment.created", "payment.processing"],
    ["payment.capture_requested", "payment.processing"],
    ["payment.refunded", "payment.refunded"],
    ["paymentlink.created", "unknown"],
  ];
  for (const [type, expected] of variants) {
    it(`maps ${type} -> ${expected}`, async () => {
      const event = await parseWorldlineWebhookEvent(JSON.stringify({ id: "e", created: "2026-07-14T10:00:00Z", type, payment: { id: "pay_1", ...money } }));
      expect(event.type).toBe(expected);
    });
  }

  it("extracts amount/currency/pspPaymentId from the payment resource", async () => {
    const event = await parseWorldlineWebhookEvent(
      JSON.stringify({ id: "e1", created: "2026-07-14T10:00:00Z", type: "payment.captured", payment: { id: "pay_9", ...money } }),
    );
    expect(event).toMatchObject({ id: "worldline:payment.captured:pay_9", pspPaymentId: "pay_9", amount: 1099, currency: "EUR", type: "payment.succeeded" });
    expect(event.occurredAt).toBe("2026-07-14T10:00:00.000Z");
  });

  it("maps discrete refund outcomes and carries the refundId", async () => {
    const refunded = await parseWorldlineWebhookEvent(
      JSON.stringify({ id: "e2", type: "refund.refunded", refund: { id: "ref_1", refundOutput: { amountOfMoney: { amount: 500, currencyCode: "EUR" } } } }),
    );
    expect(refunded.type).toBe("payment.refunded");
    expect(refunded.refundId).toBe("ref_1");
    expect(refunded.amount).toBe(500);
    const failed = await parseWorldlineWebhookEvent(JSON.stringify({ id: "e3", type: "refund.rejected", refund: { id: "ref_2" } }));
    expect(failed.type).toBe("payment.refund_failed");
  });

  it("keeps a non-terminal refund_requested as unknown rather than a fabricated terminal state", async () => {
    const event = await parseWorldlineWebhookEvent(JSON.stringify({ id: "e4", type: "refund.refund_requested", refund: { id: "ref_3" } }));
    expect(event.type).toBe("unknown");
  });

  it("hashes a stable id when Worldline omits one", async () => {
    const raw = JSON.stringify({ type: "payment.captured", payment: { status: "CAPTURED" } });
    const first = await parseWorldlineWebhookEvent(raw);
    const second = await parseWorldlineWebhookEvent(raw);
    expect(first.id).toMatch(/^worldline_[0-9a-f]{64}$/);
    expect(second.id).toBe(first.id);
  });

  it("unwraps a single-element array delivery (the docs example wraps one event in an array)", async () => {
    const event = await parseWorldlineWebhookEvent(
      JSON.stringify([{ id: "e9", created: "2026-07-14T10:00:00Z", type: "payment.captured", payment: { id: "pay_1", ...money } }]),
    );
    expect(event).toMatchObject({ id: "worldline:payment.captured:pay_1", pspPaymentId: "pay_1", type: "payment.succeeded" });
  });

  it("throws invalid_request on a multi-event array, empty array, unparseable, or non-object payload", async () => {
    for (const raw of ["[{},{}]", "[]", "not json", "null"]) {
      try {
        await parseWorldlineWebhookEvent(raw);
        expect.unreachable();
      } catch (err) {
        expect(isPayFanoutError(err)).toBe(true);
        if (isPayFanoutError(err)) expect(err.code).toBe("invalid_request");
      }
    }
  });
});

describe("webhook signature verification", () => {
  const KEYS: WorldlineWebhookKey[] = [
    { keyId: "old-key", secretKey: "old-secret" },
    { keyId: "new-key", secretKey: "new-secret" },
  ];
  function sign(rawBody: string, secret: string, keyId: string): Record<string, string> {
    return {
      "X-GCS-Signature": createHmac("sha256", secret).update(rawBody, "utf8").digest("base64"),
      "X-GCS-KeyId": keyId,
    };
  }

  it("verifies against the key named by X-GCS-KeyId", async () => {
    const raw = JSON.stringify({ id: "e", type: "payment.captured" });
    await expect(verifyWorldlineWebhookSignature(raw, sign(raw, "new-secret", "new-key"), KEYS)).resolves.toBe(true);
  });

  it("still verifies during rotation when the header keyId is unknown (any active key wins)", async () => {
    const raw = JSON.stringify({ id: "e", type: "payment.captured" });
    await expect(verifyWorldlineWebhookSignature(raw, sign(raw, "old-secret", "stale-id"), KEYS)).resolves.toBe(true);
  });

  it("rejects a re-serialized body, a tampered body, and a missing signature", async () => {
    const raw = JSON.stringify({ id: "e", type: "payment.captured", n: 1 });
    const headers = sign(raw, "new-secret", "new-key");
    await expect(verifyWorldlineWebhookSignature(raw, headers, KEYS)).resolves.toBe(true);
    const reserialized = JSON.stringify(JSON.parse(raw), null, 2);
    await expect(verifyWorldlineWebhookSignature(reserialized, headers, KEYS)).resolves.toBe(false);
    await expect(verifyWorldlineWebhookSignature(`${raw} `, headers, KEYS)).resolves.toBe(false);
    await expect(verifyWorldlineWebhookSignature(raw, {}, KEYS)).resolves.toBe(false);
  });
});

describe("session context edge cases", () => {
  it("round-trips every field and reads back the same context", async () => {
    const full = {
      v: 1 as const,
      amount: 4200,
      currency: "EUR",
      captureMethod: "manual" as const,
      hostedTokenizationId: "htp_9",
      expiresAt: FUTURE,
      returnUrl: "https://h.example/return",
      id: "order-1",
      billingDetails: { address: { line1: "1 Way", city: "Brussels", postalCode: "1000", country: "BE" } },
      statementDescriptor: "SHOP ORDER1",
      receiptEmail: "buyer@example.com",
      shippingDetails: { name: "Ann Buyer", address: { line1: "1 Way", city: "Brussels", postalCode: "1000", country: "BE" } },
    };
    await expect(decodeSessionContext(await encodeSessionContext(full, "sk"), "sk")).resolves.toEqual(full);
  });

  it("rejects tampering, a missing separator, a wrong shape, expiry, and a missing expiry", async () => {
    await expect(decodeSessionContext("no-dot", "sk")).rejects.toThrowError(/payload\.signature/);
    const base = { v: 1 as const, amount: 100, currency: "EUR", captureMethod: "automatic" as const, hostedTokenizationId: "htp_1" };
    const good = await encodeSessionContext({ ...base, expiresAt: FUTURE }, "sk");
    await expect(decodeSessionContext(good, "different-key")).rejects.toThrowError(/signature mismatch/);
    const wrongShape = await encodeSessionContext({ ...base, hostedTokenizationId: 5 as never, expiresAt: FUTURE }, "sk");
    await expect(decodeSessionContext(wrongShape, "sk")).rejects.toThrowError(/unsupported shape/);
    const expired = await encodeSessionContext({ ...base, expiresAt: Date.now() - 1 }, "sk");
    await expect(decodeSessionContext(expired, "sk")).rejects.toMatchObject({ code: "session_expired", retryable: false });
    const legacy = await encodeSessionContext({ ...base, expiresAt: undefined as never }, "sk");
    await expect(decodeSessionContext(legacy, "sk")).rejects.toMatchObject({ code: "invalid_request" });
  });
});
