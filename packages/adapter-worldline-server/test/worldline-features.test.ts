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
    // The PENDING_CONNECT_OR_3RD_PARTY band: only REDIRECTED is a customer action;
    // the async downstream members are processing.
    ["REDIRECTED", 46, "PENDING_CONNECT_OR_3RD_PARTY", "requires_action"],
    ["AUTHORIZATION_REQUESTED", undefined, "PENDING_CONNECT_OR_3RD_PARTY", "processing"],
    ["CAPTURE_REQUESTED", undefined, "PENDING_CONNECT_OR_3RD_PARTY", "processing"],
    // CANCELLED sits in the UNSUCCESSFUL band but must map to canceled, not failed.
    ["CANCELLED", undefined, "UNSUCCESSFUL", "canceled"],
    ["REJECTED", 2, "UNSUCCESSFUL", "failed"],
    ["CREATED", 0, "CREATED", "processing"],
    ["REFUNDED", undefined, "REFUNDED", "succeeded"],
    [undefined, undefined, "PENDING_PAYMENT", "processing"],
    // statusCode fallback when no category is present.
    [undefined, 9, undefined, "succeeded"],
    [undefined, 5, undefined, "requires_capture"],
    [undefined, 2, undefined, "failed"],
    [undefined, 46, undefined, "requires_action"],
    // status-string fallback.
    ["REJECTED_CAPTURE", undefined, undefined, "failed"],
    ["PENDING_CAPTURE", undefined, undefined, "requires_capture"],
    // CAPTURE_REQUESTED is async downstream, not a terminal success.
    ["CAPTURE_REQUESTED", undefined, undefined, "processing"],
    // genuinely unknown -> processing (never a fabricated terminal state).
    ["SOMETHING_NEW", undefined, undefined, "processing"],
  ];
  for (const [status, code, category, expected] of cases) {
    it(`maps ${status ?? "-"}/${code ?? "-"}/${category ?? "-"} -> ${expected}`, () => {
      expect(mapWorldlineStatus(status, code, category)).toBe(expected);
    });
  }
});

describe("mapWorldlineError", () => {
  const cases: Array<[number, string | undefined, UnifiedErrorCode, boolean]> = [
    [402, "30511001", "insufficient_funds", false],
    [402, "30591001", "fraud_suspected", false],
    [402, "40001134", "authentication_required", false],
    [402, "30171001", "card_declined", false],
    [402, "30041001", "card_declined", false],
    [402, "99999999", "card_declined", false], // unknown code on a 402 is still a decline
    [402, undefined, "card_declined", false],
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
      expect(mapped.raw).toBe(body);
      expect(mapped.pspName).toBe("worldline");
    });
  }

  it("reads the decline code from either errorCode or code", () => {
    expect(mapWorldlineError(402, { errors: [{ code: "30511001" }] }).code).toBe("insufficient_funds");
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
    ["payment.rejected_capture", "payment.failed"],
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
    expect(event).toMatchObject({ id: "e1", pspPaymentId: "pay_9", amount: 1099, currency: "EUR", type: "payment.succeeded" });
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
    const raw = JSON.stringify({ type: "payment.captured", payment: { id: "pay_1" } });
    const first = await parseWorldlineWebhookEvent(raw);
    const second = await parseWorldlineWebhookEvent(raw);
    expect(first.id).toMatch(/^worldline_[0-9a-f]{64}$/);
    expect(second.id).toBe(first.id);
  });

  it("unwraps a single-element array delivery (the docs example wraps one event in an array)", async () => {
    const event = await parseWorldlineWebhookEvent(
      JSON.stringify([{ id: "e9", created: "2026-07-14T10:00:00Z", type: "payment.captured", payment: { id: "pay_1", ...money } }]),
    );
    expect(event).toMatchObject({ id: "e9", pspPaymentId: "pay_1", type: "payment.succeeded" });
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
