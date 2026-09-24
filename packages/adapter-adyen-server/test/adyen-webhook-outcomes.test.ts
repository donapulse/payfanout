import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  adyenOnboarding,
  AdyenServerAdapter,
  buildAdyenHmacPayload,
  mapAdyenEventType,
  parseAdyenWebhookEvent,
  parseAdyenWebhookEvents,
  verifyAdyenWebhook,
  type AdyenNotificationItem,
} from "../src/index.js";

/** Key, signing string and signature of the example on Adyen's HMAC verification page. */
const HMAC_KEY = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056";
const PUBLISHED_SIGNING_STRING =
  "7914073381342284::TestMerchant:TestPayment-1407325143704:1130:EUR:AUTHORISATION:true";
const PUBLISHED_SIGNATURE = "coqCmt/IZ4E3CzPvMY8zTjQVL5hYJUiBRg8UU+iCWo0=";

const BASIC_AUTH = { username: "webhook-user", password: "webhook-password" };
const OPTIONS = { hmacKeys: [HMAC_KEY], basicAuth: [BASIC_AUTH] };
const HEADERS = {
  authorization: `Basic ${Buffer.from(`${BASIC_AUTH.username}:${BASIC_AUTH.password}`, "utf8").toString("base64")}`,
};

/** The sample webhook event from the same page, every field as published. */
const publishedItem = {
  additionalData: { hmacSignature: PUBLISHED_SIGNATURE },
  amount: { value: 1130, currency: "EUR" },
  pspReference: "7914073381342284",
  eventCode: "AUTHORISATION",
  eventDate: "2019-05-06T17:15:34.121+02:00",
  merchantAccountCode: "TestMerchant",
  operations: ["CANCEL", "CAPTURE", "REFUND"],
  merchantReference: "TestPayment-1407325143704",
  paymentMethod: "visa",
  success: "true",
};

function envelope(item: object): string {
  return JSON.stringify({ live: "false", notificationItems: [{ NotificationRequestItem: item }] });
}

/** Adyen's construction, written independently of the adapter: the eight values joined with ":", nothing escaped. */
function plainJoin(item: AdyenNotificationItem): string {
  return [
    item.pspReference,
    item.originalReference,
    item.merchantAccountCode,
    item.merchantReference,
    item.amount?.value,
    item.amount?.currency,
    item.eventCode,
    item.success,
  ]
    .map((value) => (value === undefined ? "" : String(value)))
    .join(":");
}

/** What a reader that coerces values instead of checking their types would sign. */
function coercedJoin(item: Record<string, unknown>): string {
  const amount = (item["amount"] ?? {}) as Record<string, unknown>;
  return [
    item["pspReference"],
    item["originalReference"],
    item["merchantAccountCode"],
    item["merchantReference"],
    amount["value"],
    amount["currency"],
    item["eventCode"],
    item["success"],
  ]
    .map((value) => (value === undefined || value === null ? "" : String(value)))
    .join(":");
}

function sign(data: string): string {
  return createHmac("sha256", Buffer.from(HMAC_KEY, "hex")).update(data, "utf8").digest("base64");
}

function signed(item: AdyenNotificationItem): AdyenNotificationItem {
  return { ...item, additionalData: { ...item.additionalData, hmacSignature: sign(plainJoin(item)) } };
}

function verify(item: object) {
  return verifyAdyenWebhook(envelope(item), HEADERS, OPTIONS);
}

function parse(item: object) {
  return parseAdyenWebhookEvent(envelope(item));
}

/** A capture outcome, shaped like the capture guide's CAPTURE webhook example. */
function capture(success: string, reason = ""): AdyenNotificationItem {
  return {
    amount: { currency: "EUR", value: 500 },
    eventCode: "CAPTURE",
    eventDate: "2026-09-23T10:00:00+02:00",
    merchantAccountCode: "TestMerchant",
    originalReference: "WNS7WQ756L2GWR82",
    paymentMethod: "mc",
    pspReference: "JDD6LKT8MBLZNN84",
    reason,
    success,
  };
}

/**
 * A dispute event shaped like the dispute webhooks page's examples: the dispute's own
 * pspReference, and the disputed payment's on originalReference.
 */
function disputeEvent(eventCode: string, extra: Partial<AdyenNotificationItem> = {}): AdyenNotificationItem {
  return {
    amount: { currency: "EUR", value: 1000 },
    eventCode,
    eventDate: "2026-09-23T10:00:00+02:00",
    merchantAccountCode: "TestMerchant",
    merchantReference: "order-1",
    originalReference: "9913333333333333",
    paymentMethod: "visa",
    pspReference: "9915555555555555",
    reason: "Other Fraud-Card Absent Environment",
    success: "true",
    ...extra,
  };
}

describe("Adyen webhook outcomes", () => {
  it("leaves a refused capture request unknown, since Adyen says to fix it and resubmit the capture", async () => {
    const refused = await parse(signed(capture("false", "Insufficient balance on payment")));
    expect(refused).toMatchObject({ type: "unknown", pspPaymentId: "WNS7WQ756L2GWR82", amount: 500 });
    expect(refused.refundId).toBeUndefined();
    expect(mapAdyenEventType("CAPTURE", false)).toBe("unknown");

    const accepted = await parse(signed(capture("true")));
    expect(accepted).toMatchObject({ type: "payment.succeeded", pspPaymentId: "WNS7WQ756L2GWR82" });
  });

  it("maps a technical cancel like a cancellation of the original payment", async () => {
    // The cancel guide's TECHNICAL_CANCEL example: the outcome of a cancel requested by merchant reference.
    const technicalCancel = (success: string): AdyenNotificationItem => ({
      additionalData: { paymentMethodVariant: "visa" },
      amount: { currency: "EUR", value: 5000 },
      eventCode: "TECHNICAL_CANCEL",
      eventDate: "2026-09-23T10:00:00+02:00",
      merchantAccountCode: "TestMerchant",
      merchantReference: "yourPaymentReference123",
      originalReference: "XB7XNCQ8HXSKGK82",
      paymentMethod: "visa",
      pspReference: "JDD6LKT8MBLZNN84",
      reason: "",
      success,
    });
    await expect(parse(signed(technicalCancel("true")))).resolves.toMatchObject({
      id: "TECHNICAL_CANCEL:JDD6LKT8MBLZNN84",
      type: "payment.canceled",
      pspPaymentId: "XB7XNCQ8HXSKGK82",
    });
    // A cancel that failed says nothing about the payment.
    await expect(parse(signed(technicalCancel("false")))).resolves.toMatchObject({ type: "unknown" });
  });

  it("closes a dispute only on the codes Adyen documents as won or lost", async () => {
    const outcomes: Array<[string, string]> = [
      ["ISSUER_RESPONSE_TIMEFRAME_EXPIRED", "payment.chargeback_won"],
      ["PREARBITRATION_WON", "payment.chargeback_won"],
      ["SCHEME_ARBITRATION_WON", "payment.chargeback_won"],
      ["SECOND_CHARGEBACK", "payment.chargeback_lost"],
      ["PREARBITRATION_LOST", "payment.chargeback_lost"],
      ["SCHEME_ARBITRATION_LOST", "payment.chargeback_lost"],
      ["DISPUTE_DEFENSE_PERIOD_ENDED", "payment.chargeback_lost"],
    ];
    for (const [eventCode, expected] of outcomes) {
      const event = await parse(signed(disputeEvent(eventCode)));
      expect(event.type, eventCode).toBe(expected);
      expect(event.pspPaymentId, eventCode).toBe("9913333333333333");
      expect(event.id, eventCode).toBe(`${eventCode}:9915555555555555`);
    }
  });

  it("keeps the dispute stages Adyen documents as pending or informational unknown", async () => {
    for (const eventCode of [
      "NOTIFICATION_OF_FRAUD",
      "REQUEST_FOR_INFORMATION",
      "INFORMATION_SUPPLIED",
      "PREARBITRATION_OPEN",
      // Pending on the dispute webhooks page, Lost on the dispute flow page; the
      // second chargeback that follows it reports the loss either way.
      "PREARBITRATION_ACCEPTED",
      "PREARBITRATION_DECLINED",
      // The issuer can reopen pre-arbitration after withdrawing.
      "PREARBITRATION_ISSUER_WITHDRAWN",
      "SCHEME_ARBITRATION",
      "ISSUER_COMMENTS",
    ]) {
      const event = await parse(signed(disputeEvent(eventCode)));
      expect(event.type, eventCode).toBe("unknown");
    }
  });

  it("lets a later loss override the provisional win of a reversed chargeback", async () => {
    const reversed = await parse(
      signed(disputeEvent("CHARGEBACK_REVERSED", { additionalData: { disputeStatus: "Pending" } })),
    );
    const lost = await parse(
      signed(
        disputeEvent("PREARBITRATION_LOST", {
          additionalData: { disputeStatus: "Lost" },
          eventDate: "2026-10-20T10:00:00+02:00",
        }),
      ),
    );
    expect(reversed.type).toBe("payment.chargeback_won");
    expect(lost.type).toBe("payment.chargeback_lost");
    // Both carry the dispute's pspReference, so only the pair keeps them apart.
    expect(reversed.id).not.toBe(lost.id);
    expect(lost.pspPaymentId).toBe(reversed.pspPaymentId);
    // Delivery order is not guaranteed; the later eventDate is the dispute's standing.
    const latest = [lost, reversed].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).at(-1);
    expect(latest?.type).toBe("payment.chargeback_lost");
  });

  it("reads pspReference as the payment's on the four dispute codes whose originalReference needs a setting", async () => {
    // "Include the originalReference for CHARGEBACK_REVERSED events" puts the
    // payment's reference in originalReference on these codes. Adyen's wording
    // implies pspReference carries it without the setting, which no page
    // states; a globally unique reference read wrongly only makes a lookup miss.
    for (const eventCode of ["CHARGEBACK_REVERSED", "SECOND_CHARGEBACK", "PREARBITRATION_WON", "PREARBITRATION_LOST"]) {
      const { originalReference: _originalReference, ...withoutSetting } = disputeEvent(eventCode, {
        pspReference: "9913333333333333",
      });
      const event = await parse(signed(withoutSetting));
      expect(event.pspPaymentId, eventCode).toBe("9913333333333333");
      expect(event.id, eventCode).toBe(`${eventCode}:9913333333333333`);
      // An empty originalReference reads like an absent one.
      await expect(parse(signed({ ...withoutSetting, originalReference: "" })), eventCode).resolves.toMatchObject({
        pspPaymentId: "9913333333333333",
      });
      // With the setting on, originalReference names the payment and pspReference is the dispute's.
      await expect(parse(signed(disputeEvent(eventCode))), eventCode).resolves.toMatchObject({
        id: `${eventCode}:9915555555555555`,
        pspPaymentId: "9913333333333333",
      });
    }
  });

  it("names no payment on any other dispute event without originalReference", async () => {
    // The dispute webhooks page's PREARBITRATION_OPEN example carries none.
    for (const eventCode of ["NOTIFICATION_OF_CHARGEBACK", "CHARGEBACK", "PREARBITRATION_OPEN", "SCHEME_ARBITRATION_LOST"]) {
      const { originalReference: _originalReference, ...orphan } = disputeEvent(eventCode);
      const event = await parse(signed(orphan));
      expect(event.pspPaymentId, eventCode).toBeUndefined();
      expect((event.raw as AdyenNotificationItem).pspReference, eventCode).toBe("9915555555555555");
    }
  });

  it("keeps an event's own pspReference as the payment's on exactly seven codes", async () => {
    const ownReference = new Set([
      "AUTHORISATION",
      "EXPIRE",
      "OFFER_CLOSED",
      "CHARGEBACK_REVERSED",
      "SECOND_CHARGEBACK",
      "PREARBITRATION_WON",
      "PREARBITRATION_LOST",
    ]);
    const codes = [...(adyenOnboarding.webhook.events ?? []), "REPORT_AVAILABLE", "PREARBITRATION_OPEN"];
    for (const code of ownReference) expect(codes, code).toContain(code);
    for (const eventCode of codes) {
      const { originalReference: _originalReference, ...orphan } = disputeEvent(eventCode);
      const event = await parse(signed(orphan));
      expect(event.pspPaymentId, eventCode).toBe(ownReference.has(eventCode) ? "9915555555555555" : undefined);
    }
  });

  it("reports a lost arbitration and the second chargeback that follows it as two losses", async () => {
    // Adyen follows SCHEME_ARBITRATION_LOST with a second chargeback that adds
    // the arbitration fees to the dispute amount.
    const ruling = await parse(signed(disputeEvent("SCHEME_ARBITRATION_LOST")));
    const secondChargeback = await parse(
      signed(disputeEvent("SECOND_CHARGEBACK", { amount: { currency: "EUR", value: 1500 } })),
    );
    expect([ruling.type, secondChargeback.type]).toEqual(["payment.chargeback_lost", "payment.chargeback_lost"]);
    expect(ruling.id).not.toBe(secondChargeback.id);
    expect(secondChargeback.pspPaymentId).toBe(ruling.pspPaymentId);
    // One loss, reported twice with different amounts: a state, not two sums.
    expect([ruling.amount, secondChargeback.amount]).toEqual([1000, 1500]);
  });

  it("takes the payment of an expiry or a closed offer from its own pspReference", async () => {
    // The webhook reference's EXPIRE and OFFER_CLOSED examples carry no originalReference.
    const expired = await parse(
      signed({
        amount: { currency: "EUR", value: 1000 },
        eventCode: "EXPIRE",
        eventDate: "2024-02-09T11:19:48+01:00",
        merchantAccountCode: "TestMerchant",
        merchantReference: "order-1",
        pspReference: "QFQTPCQ8HXSKGK82",
        reason: "",
        success: "true",
      }),
    );
    // The remaining uncaptured amount lapsed; the amount is the one originally authorised.
    expect(expired).toMatchObject({ type: "payment.canceled", pspPaymentId: "QFQTPCQ8HXSKGK82", amount: 1000 });
    expect(expired.refundId).toBeUndefined();

    const offerClosed = await parse(
      signed({
        additionalData: { paymentMethodVariant: "ideal" },
        amount: { currency: "EUR", value: 1000 },
        eventCode: "OFFER_CLOSED",
        eventDate: "2021-01-01T01:00:00+01:00",
        merchantAccountCode: "TestMerchant",
        merchantReference: "order-1",
        paymentMethod: "ideal",
        pspReference: "QFQTPCQ8HXSKGK82",
        reason: "",
        success: "true",
      }),
    );
    expect(offerClosed).toMatchObject({ type: "payment.canceled", pspPaymentId: "QFQTPCQ8HXSKGK82" });
  });

  it("keeps a reversal unknown whichever operation its unsigned action names", async () => {
    // The reversal guide's CANCEL_OR_REFUND example states the operation in additionalData.
    const reversal = signed({
      additionalData: { "modification.action": "refund" },
      amount: { currency: "EUR", value: 1025 },
      eventCode: "CANCEL_OR_REFUND",
      eventDate: "2026-09-23T10:00:00+02:00",
      merchantAccountCode: "TestMerchant",
      originalReference: "VK9DRSLLRCQ2WN82",
      paymentMethod: "mc",
      pspReference: "TF995R5G6L2GWR82",
      reason: "",
      success: "true",
    });
    const rewritten = { ...reversal, additionalData: { ...reversal.additionalData, "modification.action": "cancel" } };
    // The signature holds either way: the action is not one of the signed values.
    await expect(verify(reversal)).resolves.toEqual({ verified: true });
    await expect(verify(rewritten)).resolves.toEqual({ verified: true });
    for (const item of [reversal, rewritten]) {
      await expect(parse(item)).resolves.toMatchObject({
        type: "unknown",
        pspPaymentId: "VK9DRSLLRCQ2WN82",
        refundId: "TF995R5G6L2GWR82",
      });
    }
  });

  it("keeps the settlement adjustments unknown", async () => {
    for (const eventCode of ["REFUND_NOT_CLEARED", "SETTLED_REVERSED"]) {
      const event = await parse(
        signed({
          amount: { currency: "EUR", value: 1000 },
          eventCode,
          eventDate: "2026-09-23T10:00:00+02:00",
          merchantAccountCode: "TestMerchant",
          merchantReference: "order-1",
          originalReference: "9913140798220028",
          pspReference: "QFQTPCQ8HXSKGK82",
          success: "true",
        }),
      );
      expect(event.type, eventCode).toBe("unknown");
      expect(event.pspPaymentId, eventCode).toBe("9913140798220028");
    }
  });

  it("names no payment on a report notification, whose pspReference is a file name", async () => {
    // The reporting guide's REPORT_AVAILABLE example.
    const report = signed({
      amount: { currency: "EUR", value: 0 },
      eventCode: "REPORT_AVAILABLE",
      eventDate: "2026-09-23T10:03:08+02:00",
      merchantAccountCode: "TestMerchant",
      merchantReference: "",
      pspReference: "settlement_detail_report_batch_12.csv",
      reason: "https://ca-test.adyen.com/reports/download/MerchantAccount/TestMerchant/settlement_detail_report_batch_12.csv",
      success: "true",
    });
    await expect(verify(report)).resolves.toEqual({ verified: true });
    const event = await parse(report);
    expect(event).toMatchObject({ id: "REPORT_AVAILABLE:settlement_detail_report_batch_12.csv", type: "unknown" });
    expect(event.pspPaymentId).toBeUndefined();
  });

  it("never reports a modification's own reference as the payment's", async () => {
    const { originalReference: _originalReference, ...orphan } = capture("true");
    await expect(parse(signed(orphan))).resolves.not.toHaveProperty("pspPaymentId");
    await expect(parse(signed({ ...capture("true"), originalReference: "" }))).resolves.not.toHaveProperty(
      "pspPaymentId",
    );
    // An authorisation's own pspReference is the payment's.
    await expect(parse(signed({ ...publishedItem, additionalData: {} }))).resolves.toMatchObject({
      pspPaymentId: "7914073381342284",
    });
  });

  it("takes occurredAt only from a string eventDate, never from a coerced one", async () => {
    // eventDate is unsigned and an ISO 8601 string in Adyen's schema; a number
    // would otherwise be read as a year.
    const item = signed({ ...publishedItem, additionalData: {} });
    await expect(parse({ ...item, eventDate: 2026 })).resolves.toMatchObject({
      occurredAt: "1970-01-01T00:00:00.000Z",
    });
  });

  it("reports the epoch, meaning no known time, for an eventDate that does not parse", async () => {
    // The capture guide's own CAPTURE example carries this date.
    const item = signed({ ...capture("true"), eventDate: "2018-22T15:54:01+02:00" });
    await expect(verify(item)).resolves.toEqual({ verified: true });
    await expect(parse(item)).resolves.toMatchObject({
      type: "payment.succeeded",
      occurredAt: "1970-01-01T00:00:00.000Z",
    });
  });

  it("reports no outcome for a success value Adyen does not document", async () => {
    for (const success of ["TRUE", ""]) {
      const item = signed({ ...publishedItem, additionalData: {}, success });
      // A string is the documented type, so the signature is checked and holds.
      await expect(verify(item)).resolves.toEqual({ verified: true });
      await expect(parse(item)).resolves.toMatchObject({ type: "unknown" });
    }
  });
});

describe("Adyen signed values", () => {
  it("verifies Adyen's published example exactly as published, operations list included", async () => {
    const rawBody = JSON.stringify({ live: "false", notificationItems: [{ NotificationRequestItem: publishedItem }] }, null, 3);
    await expect(verifyAdyenWebhook(rawBody, HEADERS, OPTIONS)).resolves.toEqual({ verified: true });
    expect(buildAdyenHmacPayload(publishedItem)).toBe(PUBLISHED_SIGNING_STRING);

    const adapter = new AdyenServerAdapter({
      apiKey: "checkout-api-key",
      merchantAccount: "TestMerchant",
      environment: "sandbox",
      sessionSigningKey: "session-signing-key",
      hmacKeys: [HMAC_KEY],
      webhookBasicAuth: BASIC_AUTH,
    });
    await expect(adapter.verifyWebhookSignature(rawBody, HEADERS)).resolves.toBe(true);
    await expect(adapter.parseWebhookEvent(rawBody)).resolves.toMatchObject({
      id: "AUTHORISATION:7914073381342284",
      type: "payment.succeeded",
      pspPaymentId: "7914073381342284",
      amount: 1130,
      currency: "EUR",
      occurredAt: "2019-05-06T15:15:34.121Z",
    });
  });

  it("refuses signed values without their documented type, even when they join to the signed string", async () => {
    const retyped: Array<[string, Record<string, unknown>]> = [
      ["pspReference as a number", { pspReference: 7914073381342284 }],
      ["success as a boolean", { success: true }],
      ["eventCode as an array", { eventCode: ["AUTHORISATION"] }],
      ["merchantAccountCode as an array", { merchantAccountCode: ["TestMerchant"] }],
      ["merchantReference as an array", { merchantReference: ["TestPayment-1407325143704"] }],
      ["originalReference as an empty array", { originalReference: [] }],
      ["amount.value as a string", { amount: { value: "1130", currency: "EUR" } }],
      ["amount.currency as an array", { amount: { value: 1130, currency: ["EUR"] } }],
    ];
    for (const [label, change] of retyped) {
      const item = { ...publishedItem, ...change };
      // Coerced into strings, every one of these reproduces what Adyen signed.
      expect(coercedJoin(item), label).toBe(PUBLISHED_SIGNING_STRING);
      await expect(verify(item), label).resolves.toEqual({ verified: false, reason: "malformed_payload" });
      expect(buildAdyenHmacPayload(item as AdyenNotificationItem), label).toBeUndefined();
      // Parsing reads the same way, so no path interprets a value the signature did not cover.
      await expect(parse(item), label).rejects.toMatchObject({ code: "invalid_request" });
    }
  });

  it("reads a null originalReference or merchantReference as absent, as Adyen's validators sign it", async () => {
    // Adyen's validators render a null value as an empty string, which is how an absent one joins.
    const nullOriginal = { ...publishedItem, originalReference: null };
    expect(buildAdyenHmacPayload(nullOriginal as unknown as AdyenNotificationItem)).toBe(PUBLISHED_SIGNING_STRING);
    await expect(verify(nullOriginal)).resolves.toEqual({ verified: true });
    await expect(parse(nullOriginal)).resolves.toMatchObject({
      type: "payment.succeeded",
      pspPaymentId: "7914073381342284",
    });

    const nullMerchantReference = { ...signed({ ...capture("true"), merchantReference: "" }), merchantReference: null };
    await expect(verify(nullMerchantReference)).resolves.toEqual({ verified: true });
    await expect(parse(nullMerchantReference)).resolves.toMatchObject({
      type: "payment.succeeded",
      pspPaymentId: "WNS7WQ756L2GWR82",
    });
  });

  it("still refuses null in a value the webhook schema requires", async () => {
    const nulled: Array<[string, Record<string, unknown>]> = [
      ["pspReference", { pspReference: null }],
      ["merchantAccountCode", { merchantAccountCode: null }],
      ["eventCode", { eventCode: null }],
      ["success", { success: null }],
      ["amount", { amount: null }],
      ["amount.value", { amount: { value: null, currency: "EUR" } }],
      ["amount.currency", { amount: { value: 1130, currency: null } }],
    ];
    for (const [label, change] of nulled) {
      const item: Record<string, unknown> = { ...publishedItem, ...change };
      // Signed as a reader that turns null into "" would sign it, so only the schema check refuses it.
      const forged = { ...item, additionalData: { hmacSignature: sign(coercedJoin(item)) } };
      await expect(verify(forged), label).resolves.toEqual({ verified: false, reason: "malformed_payload" });
      await expect(parse(forged), label).rejects.toMatchObject({ code: "invalid_request" });
    }
  });

  it("refuses an amount that is not a safe integer in minor units", async () => {
    for (const amount of [
      { value: 1130.5, currency: "EUR" },
      { value: 2 ** 53, currency: "EUR" },
      null,
      [1130, "EUR"],
    ]) {
      const item = { ...publishedItem, amount };
      await expect(verify(item), JSON.stringify(amount)).resolves.toEqual({
        verified: false,
        reason: "malformed_payload",
      });
    }
  });

  it("refuses an item missing a value the webhook schema requires, and accepts the optional two absent", async () => {
    const base = signed({ ...publishedItem, additionalData: {} });
    for (const field of ["pspReference", "merchantAccountCode", "eventCode", "success", "amount"]) {
      const rest: Record<string, unknown> = { ...base };
      delete rest[field];
      // Signed over what remains, so it is the schema that refuses it, not the signature.
      await expect(verify(signed(rest as AdyenNotificationItem)), field).resolves.toEqual({
        verified: false,
        reason: "malformed_payload",
      });
    }
    await expect(verify(signed({ ...base, amount: { value: 1130 } }))).resolves.toEqual({
      verified: false,
      reason: "malformed_payload",
    });
    // The capture and cancel guides' examples carry no merchantReference.
    const { merchantReference: _merchantReference, ...noMerchantReference } = capture("true");
    await expect(verify(signed(noMerchantReference))).resolves.toEqual({ verified: true });
    // Both optional values absent: the published authorisation without its merchantReference.
    const { merchantReference: _reference, ...neither } = base;
    await expect(verify(signed(neither))).resolves.toEqual({ verified: true });
    expect(buildAdyenHmacPayload(neither)).toBe("7914073381342284::TestMerchant::1130:EUR:AUTHORISATION:true");
  });

  it("refuses an envelope carrying anything but notification items", async () => {
    const item = signed({ ...publishedItem, additionalData: {} });
    for (const extra of [42, { NotificationRequestItem: "text" }, { NotificationRequestItem: null }]) {
      const rawBody = JSON.stringify({ live: "false", notificationItems: [{ NotificationRequestItem: item }, extra] });
      await expect(verifyAdyenWebhook(rawBody, HEADERS, OPTIONS)).resolves.toEqual({
        verified: false,
        reason: "malformed_payload",
      });
      await expect(parseAdyenWebhookEvents(rawBody)).rejects.toMatchObject({ code: "invalid_request" });
    }
  });

  it("refuses a SOAP delivery, which is not JSON", async () => {
    // The webhook-types page's SOAP example: a JSON-only reader must not half-read it.
    const soap = [
      '<?xml version="1.0"?>',
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
      "  <soap:Body>",
      '    <ns1:sendNotification xmlns:ns1="http://notification.services.adyen.com">',
      "      <ns1:Notification>",
      "        <live>false</live>",
      "        <notificationItems><NotificationRequestItem>",
      "          <eventCode>AUTHORISATION</eventCode>",
      "          <pspReference>7914073381342284</pspReference>",
      "          <success>true</success>",
      "        </NotificationRequestItem></notificationItems>",
      "      </ns1:Notification>",
      "    </ns1:sendNotification>",
      "  </soap:Body>",
      "</soap:Envelope>",
    ].join("\n");
    await expect(verifyAdyenWebhook(soap, HEADERS, OPTIONS)).resolves.toEqual({
      verified: false,
      reason: "malformed_payload",
    });
  });
});

describe("Adyen signed-value delimiter", () => {
  /** The published example with a ":" in its merchant reference, signed as Adyen joins it. */
  const colonInReference = signed({
    ...publishedItem,
    additionalData: {},
    merchantReference: "TestPayment:1407325143704",
  });
  const colonJoin = "7914073381342284::TestMerchant:TestPayment:1407325143704:1130:EUR:AUTHORISATION:true";

  it("verifies a merchantReference carrying ':' and '\\', joined without escaping", async () => {
    expect(buildAdyenHmacPayload(colonInReference)).toBe(colonJoin);
    await expect(verify(colonInReference)).resolves.toEqual({ verified: true });
    await expect(parse(colonInReference)).resolves.toMatchObject({ type: "payment.succeeded" });

    const backslashes = signed({
      ...publishedItem,
      additionalData: {},
      merchantAccountCode: "Test\\Merchant",
      merchantReference: "order:2026\\09:7",
    });
    expect(buildAdyenHmacPayload(backslashes)).toBe(
      "7914073381342284::Test\\Merchant:order:2026\\09:7:1130:EUR:AUTHORISATION:true",
    );
    await expect(verify(backslashes)).resolves.toEqual({ verified: true });
  });

  it("refuses the same signature once a ':' moves into any other signed value", async () => {
    const signature = colonInReference.additionalData!["hmacSignature"];
    const moved: Array<[string, Partial<AdyenNotificationItem>]> = [
      [
        "pspReference",
        {
          pspReference: "7914073381342284:",
          originalReference: "TestMerchant",
          merchantAccountCode: "TestPayment",
          merchantReference: "1407325143704",
        },
      ],
      [
        "originalReference",
        { originalReference: ":TestMerchant", merchantAccountCode: "TestPayment", merchantReference: "1407325143704" },
      ],
      ["merchantAccountCode", { merchantAccountCode: "TestMerchant:TestPayment", merchantReference: "1407325143704" }],
      ["currency", { merchantReference: "TestPayment", amount: { value: 1407325143704, currency: "1130:EUR" } }],
      [
        "eventCode",
        {
          merchantReference: "TestPayment",
          amount: { value: 1407325143704, currency: "1130" },
          eventCode: "EUR:AUTHORISATION",
        },
      ],
      [
        "success",
        {
          merchantReference: "TestPayment",
          amount: { value: 1407325143704, currency: "1130" },
          eventCode: "EUR",
          success: "AUTHORISATION:true",
        },
      ],
    ];
    for (const [field, change] of moved) {
      const forged: AdyenNotificationItem = { ...colonInReference, ...change };
      // Different values, the same joined string, so the delivered signature matches it.
      expect(plainJoin(forged), field).toBe(colonJoin);
      expect(forged.additionalData?.["hmacSignature"], field).toBe(signature);
      await expect(verify(forged), field).resolves.toEqual({ verified: false, reason: "ambiguous_signed_value" });
      expect(buildAdyenHmacPayload(forged), field).toBeUndefined();
    }
  });
});

describe("Adyen webhook event identity", () => {
  it("gives duplicate deliveries one id whatever else differs, so the latest can replace the first", async () => {
    const first = await parse(signed({ ...capture("true"), eventDate: "2026-09-23T10:00:00+02:00" }));
    const redelivered = await parse(
      signed({ ...capture("true"), eventDate: "2026-09-25T09:00:00+02:00", reason: "Transaction Recaptured" }),
    );
    expect(redelivered.id).toBe(first.id);
    expect(redelivered.occurredAt > first.occurredAt).toBe(true);
    expect((redelivered.raw as AdyenNotificationItem).reason).toBe("Transaction Recaptured");
  });

  it("keeps a capture apart from its authorisation, since the capture carries its own pspReference", async () => {
    const authorisation = await parse(
      signed({ ...publishedItem, additionalData: {}, pspReference: "WNS7WQ756L2GWR82" }),
    );
    const captured = await parse(signed(capture("true")));
    expect(authorisation.id).toBe("AUTHORISATION:WNS7WQ756L2GWR82");
    expect(captured.id).toBe("CAPTURE:JDD6LKT8MBLZNN84");
    expect(captured.pspPaymentId).toBe(authorisation.pspPaymentId);
  });
});

describe("Adyen onboarding events", () => {
  it("lists every event code the parser maps, OFFER_CLOSED included", () => {
    const events = adyenOnboarding.webhook.events ?? [];
    const mapped = (eventCode: string) =>
      mapAdyenEventType(eventCode, true) !== "unknown" || mapAdyenEventType(eventCode, false) !== "unknown";
    for (const eventCode of events) {
      // CANCEL_OR_REFUND is handled deliberately as unknown; every other listed code maps.
      if (eventCode !== "CANCEL_OR_REFUND") expect(mapped(eventCode), eventCode).toBe(true);
    }
    for (const eventCode of [
      "TECHNICAL_CANCEL",
      "PREARBITRATION_WON",
      "PREARBITRATION_LOST",
      "SCHEME_ARBITRATION_WON",
      "SCHEME_ARBITRATION_LOST",
      "ISSUER_RESPONSE_TIMEFRAME_EXPIRED",
      "DISPUTE_DEFENSE_PERIOD_ENDED",
      "OFFER_CLOSED",
    ]) {
      expect(events, eventCode).toContain(eventCode);
    }
    expect(new Set(events).size).toBe(events.length);
  });
});
