import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  getCurrencyExponent,
  isPayFanoutError,
  screenSessionInput,
  utf8ToBase64Url,
  validateAdapterCapabilities,
  type PayFanoutError,
} from "@payfanout/core";
import { currencyRefusal, PAYSAFE_CURRENCY_EXPONENTS } from "../src/currency-exponents.js";
import {
  encodeSessionContext,
  parsePaysafeWebhookEvent,
  PaysafeServerAdapter,
  type PaysafeSessionContextV1,
  type PaysafeServerAdapterConfig,
} from "../src/index.js";
import { FakePaysafeApi, SEEDED_MULTI_USE_TOKEN } from "./fake-paysafe-api.js";

/**
 * Paysafe's amounts are "in minor units" of its Currency Codes table, and
 * PayFanout's are core's getCurrencyExponent. The adapter refuses a currency
 * the table prices with another exponent, or one the table lacks that is not
 * priced in hundredths, since Paysafe's exponent for it is then unknown.
 */

const SIGNING_KEY = "session-signing-key";
const WEBHOOK_KEY = "webhook-hmac-key";
const API = "https://api.test.paysafe.com";

function pairs(entries: string): Array<[string, string]> {
  return entries
    .trim()
    .split(/\s+/)
    .map((entry) => {
      const [code, value] = entry.split(":");
      return [code!, value!];
    });
}

/**
 * The Currency Codes table as Paysafe publishes it, in page order
 * (code:exponent), read 2026-09-26 and again 2026-09-30 from
 * developer.paysafe.com/en/support/reference-information/codes/#currency-codes.
 */
const PAYSAFE_TABLE: ReadonlyArray<[string, number]> = pairs(
  "ARS:2 AUD:2 AZN:2 BHD:3 BYR:0 BOB:2 BAM:2 BRL:2 BGN:2 CAD:2 CLP:2 CNY:2 COP:2 CRC:2 HRK:2 CZK:2 " +
    "DKK:2 DOP:2 XCD:2 EGP:2 ETB:2 EUR:2 FJD:2 GEL:2 GTQ:2 HTG:2 HNL:2 HKD:2 HUF:2 INR:2 IDR:2 JMD:2 " +
    "JPY:0 JOD:3 KZT:2 KES:2 KRW:0 KWD:3 LVL:2 LBP:2 LYD:3 MWK:2 MUR:2 MXN:2 MDL:2 MAD:2 ILS:2 NZD:2 " +
    "NGN:2 NOK:2 OMR:3 PKR:2 PAB:2 PYG:0 PEN:2 PHP:2 PLN:2 GBP:2 QAR:2 RON:2 RUB:2 RWF:0 SAR:2 RSD:2 " +
    "SGD:2 ZAR:2 LKR:2 SEK:2 CHF:2 SYP:2 TWD:2 THB:2 TTD:2 TND:3 TRY:2 UAH:2 AED:2 UYU:2 USD:2 VEF:2 " +
    "VND:0",
).map(([code, exponent]) => [code, Number(exponent)]);

/** ISO 4217 list one as SIX publishes it (2026-09-17): each code's minor units, N.A. where it gives none. */
const ISO_LIST_ONE: ReadonlyArray<[string, string]> = pairs(
  "AED:2 AFN:2 ALL:2 AMD:2 AOA:2 ARS:2 AUD:2 AWG:2 AZN:2 BAM:2 BBD:2 BDT:2 BHD:3 BIF:0 BMD:2 " +
    "BND:2 BOB:2 BOV:2 BRL:2 BSD:2 BTN:2 BWP:2 BYN:2 BZD:2 CAD:2 CDF:2 CHE:2 CHF:2 CHW:2 CLF:4 " +
    "CLP:0 CNY:2 COP:2 COU:2 CRC:2 CUP:2 CVE:2 CZK:2 DJF:0 DKK:2 DOP:2 DZD:2 EGP:2 ERN:2 ETB:2 " +
    "EUR:2 FJD:2 FKP:2 GBP:2 GEL:2 GHS:2 GIP:2 GMD:2 GNF:0 GTQ:2 GYD:2 HKD:2 HNL:2 HTG:2 HUF:2 " +
    "IDR:2 ILS:2 INR:2 IQD:3 IRR:2 ISK:0 JMD:2 JOD:3 JPY:0 KES:2 KGS:2 KHR:2 KMF:0 KPW:2 KRW:0 " +
    "KWD:3 KYD:2 KZT:2 LAK:2 LBP:2 LKR:2 LRD:2 LSL:2 LYD:3 MAD:2 MDL:2 MGA:2 MKD:2 MMK:2 MNT:2 " +
    "MOP:2 MRU:2 MUR:2 MVR:2 MWK:2 MXN:2 MXV:2 MYR:2 MZN:2 NAD:2 NGN:2 NIO:2 NOK:2 NPR:2 NZD:2 " +
    "OMR:3 PAB:2 PEN:2 PGK:2 PHP:2 PKR:2 PLN:2 PYG:0 QAR:2 RON:2 RSD:2 RUB:2 RWF:0 SAR:2 SBD:2 " +
    "SCR:2 SDG:2 SEK:2 SGD:2 SHP:2 SLE:2 SOS:2 SRD:2 SSP:2 STN:2 SVC:2 SYP:2 SZL:2 THB:2 TJS:2 " +
    "TMT:2 TND:3 TOP:2 TRY:2 TTD:2 TWD:2 TZS:2 UAH:2 UGX:0 USD:2 USN:2 UYI:0 UYU:2 UYW:4 UZS:2 " +
    "VED:2 VES:2 VND:0 VUV:0 WST:2 XAD:2 XAF:0 XAG:N.A. XAU:N.A. XBA:N.A. XBB:N.A. XBC:N.A. " +
    "XBD:N.A. XCD:2 XCG:2 XDR:N.A. XOF:0 XPD:N.A. XPF:0 XPT:N.A. XSU:N.A. XTS:N.A. XUA:N.A. " +
    "XXX:N.A. YER:2 ZAR:2 ZMW:2 ZWG:2",
);

const PAYSAFE_ROWS = new Map(PAYSAFE_TABLE);
const ISO_ROWS = new Map(ISO_LIST_ONE);

/**
 * The rule, from the two tables: a row must agree with PayFanout's exponent,
 * and a currency without one must be priced in hundredths. The adapter reads
 * PayFanout's exponent alone; this also asks ISO 4217's, so a code core read
 * against the list would fail here. A code ISO 4217 gives no minor unit
 * (metals, SDR, test codes) is taken at PayFanout's exponent.
 */
function refusedByRule(code: string): boolean {
  const payfanout = getCurrencyExponent(code);
  const paysafe = PAYSAFE_ROWS.get(code);
  if (paysafe !== undefined) return paysafe !== payfanout;
  const iso = ISO_ROWS.get(code);
  return payfanout !== 2 || (iso !== undefined && iso !== "N.A." && Number(iso) !== 2);
}

/** What the rule refuses over both tables, today. */
const REFUSED = ["BIF", "BYR", "CLF", "CLP", "DJF", "GNF", "IQD", "ISK", "KMF", "UGX", "UYI", "UYW", "VUV", "XAF", "XOF", "XPF"];

function makePair(config: Partial<PaysafeServerAdapterConfig> = {}): {
  adapter: PaysafeServerAdapter;
  fake: FakePaysafeApi;
} {
  const fake = new FakePaysafeApi();
  const adapter = new PaysafeServerAdapter({
    username: "api_user",
    password: "api_pass",
    environment: "sandbox",
    merchantAccountResolver: (currency) => `acct-${currency}`,
    sessionSigningKey: SIGNING_KEY,
    webhookHmacKey: WEBHOOK_KEY,
    fetch: fake.fetch,
    sleep: async () => undefined,
    ...config,
  });
  return { adapter, fake };
}

async function rejection(promise: Promise<unknown>): Promise<PayFanoutError> {
  try {
    await promise;
  } catch (err) {
    if (isPayFanoutError(err)) return err;
    throw err;
  }
  throw new Error("expected the call to reject");
}

/** Which of `codes` createPaymentSession refuses, each refusal checked for its shape. */
async function refusedSessions(adapter: PaysafeServerAdapter, codes: Iterable<string>): Promise<string[]> {
  const refused: string[] = [];
  for (const currency of codes) {
    const outcome: unknown = await adapter
      .createPaymentSession({ amount: 1000, currency, idempotencyKey: `k-${currency}` })
      .catch((err: unknown) => err);
    if (isPayFanoutError(outcome)) {
      expect(outcome, currency).toMatchObject({ code: "invalid_request", retryable: false, pspName: "paysafe" });
      refused.push(currency);
    } else {
      expect(outcome, currency).toMatchObject({ amount: 1000, currency });
    }
  }
  return refused.sort();
}

/** A request straight to the fake, as another integration on the account would send it. */
async function paysafeCall<T>(
  fake: FakePaysafeApi,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fake.fetch(`${API}${path}`, {
    method,
    headers: { authorization: "Basic legacy" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return (await response.json()) as T;
}

/** A payment an earlier release, or another integration, made in `currencyCode`. */
async function paymentMadeElsewhere(
  fake: FakePaysafeApi,
  currencyCode: string,
  settleWithAuth: boolean,
): Promise<{ id: string; merchantRefNum: string }> {
  const merchantRefNum = `elsewhere-${currencyCode}-${settleWithAuth ? "auto" : "manual"}`;
  const payment = await paysafeCall<{ id: string }>(fake, "POST", "/paymenthub/v1/payments", {
    merchantRefNum,
    dupCheck: false,
    amount: 1_000_000,
    currencyCode,
    paymentHandleToken: `tok_${merchantRefNum}`,
    settleWithAuth,
  });
  return { id: payment.id, merchantRefNum };
}

/** A refund of a settle-with-auth payment, made outside the adapter. */
async function refundMadeElsewhere(fake: FakePaysafeApi, payment: { merchantRefNum: string }): Promise<string> {
  const lookup = await paysafeCall<{ settlements: Array<{ id: string }> }>(
    fake,
    "GET",
    `/paymenthub/v1/settlements?merchantRefNum=${payment.merchantRefNum}`,
  );
  const refund = await paysafeCall<{ id: string }>(
    fake,
    "POST",
    `/paymenthub/v1/settlements/${lookup.settlements[0]!.id}/refunds`,
    { merchantRefNum: `refund-${payment.merchantRefNum}`, amount: 100_000 },
  );
  return refund.id;
}

/** A scheduler subscription billing in `currencyCode`, created outside the adapter. */
async function subscriptionMadeElsewhere(fake: FakePaysafeApi, currencyCode: string): Promise<string> {
  const plan = await paysafeCall<{ id: string }>(fake, "POST", "/subscriptionsplans/v1/plans", {
    name: `plan in ${currencyCode}`,
    amount: 1_000_000,
    currencyCode,
    billingCycle: { frequency: "MONTHLY", interval: 1, numberOfCycles: 0 },
    status: "ACTIVE",
  });
  const sub = await paysafeCall<{ id: string }>(fake, "POST", `/subscriptionsplans/v1/plans/${plan.id}/subscriptions`, {
    merchantRefNum: `sub-${currencyCode}`,
    paymentHandleToken: SEEDED_MULTI_USE_TOKEN,
    status: "ACTIVE",
  });
  return sub.id;
}

function sentSince(fake: FakePaysafeApi, before: number): string[] {
  return fake.requests.slice(before).map((r) => `${r.method} ${r.path}`);
}

function context(currency: string, extra: Partial<PaysafeSessionContextV1> = {}): Promise<string> {
  return encodeSessionContext(
    { v: 1, amount: 10_000, currency, captureMethod: "automatic", expiresAt: Date.now() + 60_000, ...extra },
    SIGNING_KEY,
  );
}

/** The bank details confirm() sends for an ACH session: "paysafe-bank." + base64url(JSON). */
const ACH_ENVELOPE = `paysafe-bank.${utf8ToBase64Url(
  JSON.stringify({
    v: 1,
    paymentType: "ACH",
    accountHolderName: "Pat Doe",
    routingNumber: "123456789",
    accountNumber: "1234567890",
  }),
)}`;

/** A delivery's raw body in the documented envelope; ids and values are made up. */
function webhookIn(currencyCode: string | undefined, eventName = "PAYMENT_COMPLETED"): string {
  return JSON.stringify({
    payload: {
      accountId: "1001234567",
      id: "0f3a6c1e-5b2d-4e8f-9a7c-3d1e2f4a5b6c",
      merchantRefNum: "order-cur-1",
      amount: 1_000_000,
      ...(currencyCode !== undefined ? { currencyCode } : {}),
      status: "COMPLETED",
      txnTime: "2026-09-26T10:00:02Z",
    },
    attemptNumber: "1",
    type: eventName.startsWith("REFUND") ? "REFUND" : "PAYMENT",
    eventDate: "2026-09-26T10:00:02Z",
    eventName,
  });
}

describe("Paysafe's currency table", () => {
  it("ships the table Paysafe publishes, row for row", () => {
    const byCode = (entries: Iterable<[string, number]>) => [...entries].sort(([a], [b]) => a.localeCompare(b));
    expect(PAYSAFE_TABLE).toHaveLength(81);
    expect(byCode(PAYSAFE_CURRENCY_EXPONENTS)).toEqual(byCode(PAYSAFE_TABLE));
  });
});

describe("the currencies the adapter declares unsupported", () => {
  it("declares exactly the currencies createPaymentSession refuses, over Paysafe's table and ISO 4217 list one", async () => {
    const { adapter } = makePair();
    const declared = adapter.getCapabilities().unsupportedCurrencies;
    expect(declared).toEqual(REFUSED);
    const universe = new Set([...PAYSAFE_ROWS.keys(), ...ISO_ROWS.keys()]);
    expect(await refusedSessions(adapter, universe)).toEqual(declared);
    expect(validateAdapterCapabilities(adapter)).toEqual([]);
  });

  it("declares every code the refusal rule refuses, putting every three-letter code to the rule", () => {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const refused: string[] = [];
    for (const a of letters) {
      for (const b of letters) {
        for (const c of letters) {
          if (currencyRefusal(`${a}${b}${c}`) !== undefined) refused.push(`${a}${b}${c}`);
        }
      }
    }
    expect(makePair().adapter.getCapabilities().unsupportedCurrencies).toEqual(refused);
  });

  it("is refused on every session, zero-amount ones included, by the adapter and by screening alike", async () => {
    const { adapter } = makePair();
    const caps = adapter.getCapabilities();
    for (const currency of REFUSED) {
      const zero = { amount: 0, currency, idempotencyKey: `k-${currency}` };
      await expect(adapter.createPaymentSession(zero), currency).rejects.toMatchObject({ code: "invalid_request" });
      expect(screenSessionInput(caps, zero)).toBe(`"paysafe" does not support currency ${currency}`);
    }
    for (const currency of ["JPY", "KWD", "USD", "GHS"]) {
      expect(screenSessionInput(caps, { amount: 1000, currency, idempotencyKey: "k" }), currency).toBeUndefined();
    }
  });
});

describe("currencies whose Paysafe exponent may not be PayFanout's", () => {
  it("refuses a row of Paysafe's table that gives another exponent than PayFanout, and sends every other row", async () => {
    const { adapter } = makePair();
    const refused = await refusedSessions(adapter, PAYSAFE_ROWS.keys());
    expect(refused).toEqual([...PAYSAFE_ROWS.keys()].filter(refusedByRule).sort());
    expect(refused).toEqual(["BYR", "CLP"]);
  });

  it("refuses a currency the table lacks unless it is priced in hundredths, and sends the ones that are", async () => {
    const { adapter } = makePair();
    const unlisted = [...ISO_ROWS.keys()].filter((code) => !PAYSAFE_ROWS.has(code));
    const refused = await refusedSessions(adapter, unlisted);
    expect(refused).toEqual(unlisted.filter(refusedByRule).sort());
    expect(refused).toEqual(REFUSED.filter((code) => !PAYSAFE_ROWS.has(code)));
    // Priced in hundredths, by ISO 4217 or by PayFanout alone: sent unchanged.
    expect(await refusedSessions(adapter, ["GHS", "MYR", "XAU", "LTL"])).toEqual([]);
  });

  it("refuses exactly the set the rule computes over Paysafe's table and ISO 4217 list one", async () => {
    const { adapter } = makePair();
    const universe = new Set([...PAYSAFE_ROWS.keys(), ...ISO_ROWS.keys()]);
    expect([...universe].filter(refusedByRule).sort()).toEqual(REFUSED);
    expect(await refusedSessions(adapter, universe)).toEqual(REFUSED);
  });

  it("names Paysafe's exponent and PayFanout's, and says why neither converts nor sends", async () => {
    const { adapter } = makePair();
    const clp = await rejection(adapter.createPaymentSession({ amount: 10_000, currency: " clp ", idempotencyKey: "k" }));
    expect(clp.message).toContain("Paysafe's currency table gives CLP the exponent 2");
    expect(clp.message).toContain("PayFanout reads CLP with the exponent 0");
    expect(clp.message).toMatch(/does not convert/);
    expect(clp.raw).toEqual({ currency: "CLP", paysafeExponent: 2, payfanoutExponent: 0 });
    // Nothing was ever sent for a new session, so the refusal is definitive.
    expect(clp.outcomeUnknown).toBeUndefined();

    const isk = await rejection(adapter.createPaymentSession({ amount: 10_000, currency: "ISK", idempotencyKey: "k" }));
    expect(isk.message).toContain("Paysafe's currency table has no row for ISK");
    expect(isk.message).toContain("PayFanout reads ISK with the exponent 0");
    expect(isk.message).toContain("only when its exponent is 2");
    expect(isk.raw).toEqual({ currency: "ISK", payfanoutExponent: 0 });

    // Core reads BYR, which it does not list, with its default 2: not an ISO 4217 exponent.
    const byr = await rejection(adapter.createPaymentSession({ amount: 10_000, currency: "BYR", idempotencyKey: "k" }));
    expect(byr.message).toContain("PayFanout reads BYR, a code ISO 4217 withdrew, with the exponent 2");
    expect(byr.message).not.toMatch(/ISO 4217 minor units/);
    expect(byr.raw).toEqual({ currency: "BYR", paysafeExponent: 0, payfanoutExponent: 2 });

    const iqd = await rejection(adapter.createPaymentSession({ amount: 10_000, currency: "IQD", idempotencyKey: "k" }));
    expect(iqd.raw).toEqual({ currency: "IQD", payfanoutExponent: 3 });
  });

  it("refuses UYI, which PayFanout reads with ISO 4217's 0 and the table lacks", async () => {
    const { adapter } = makePair();
    expect(getCurrencyExponent("UYI")).toBe(0);
    const uyi = await rejection(adapter.createPaymentSession({ amount: 10_000, currency: "UYI", idempotencyKey: "k" }));
    expect(uyi).toMatchObject({ code: "invalid_request", retryable: false });
    expect(uyi.message).toContain("PayFanout reads UYI with the exponent 0");
    expect(uyi.raw).toEqual({ currency: "UYI", payfanoutExponent: 0 });
  });

  it("refuses them on a bank-debit session too, which carries no currency gate of its own", async () => {
    const { adapter } = makePair();
    await expect(
      adapter.createPaymentSession({ amount: 10_000, currency: "CLP", paymentMethodTypes: ["ach"], idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/does not convert/) });
  });

  it("refuses an update into one, and one that keeps a session signed in one, but lets it move out", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ amount: 10_000, currency: "USD", idempotencyKey: "k" });
    await expect(
      adapter.updatePaymentSession({ pspSessionId: session.pspSessionId, currency: "XOF", idempotencyKey: "u1" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/no row for XOF/) });
    await expect(
      adapter.updatePaymentSession({ pspSessionId: await context("ISK"), amount: 5000, idempotencyKey: "u2" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/ISK/) });
    // Moving the session to a currency the adapter sends is allowed: nothing was sent in ISK.
    await expect(
      adapter.updatePaymentSession({ pspSessionId: await context("ISK"), currency: "USD", idempotencyKey: "u3" }),
    ).resolves.toMatchObject({ currency: "USD", amount: 10_000 });
  });

  it("refuses to complete a session signed in one as final once its key holds nothing, on the card and bank-debit paths", async () => {
    const { adapter, fake } = makePair();
    // Only a session signed before the upgrade gets here, so its key is read
    // first; nothing under it means that release never completed it.
    const card = await rejection(
      adapter.completePayment({ pspSessionId: await context("CLP"), clientToken: "tok_clp", idempotencyKey: "c1" }),
    );
    expect(card).toMatchObject({
      code: "invalid_request",
      retryable: false,
      message: expect.stringMatching(/does not convert.*Take CLP payments with another provider/),
      raw: { currency: "CLP", paysafeExponent: 2, payfanoutExponent: 0 },
    });
    expect(card.outcomeUnknown).toBeUndefined();
    const ach = await rejection(
      adapter.completePayment({
        pspSessionId: await context("CLP", { paymentType: "ACH" }),
        clientToken: ACH_ENVELOPE,
        idempotencyKey: "c2",
      }),
    );
    expect(ach).toMatchObject({ code: "invalid_request", retryable: false });
    expect(ach.outcomeUnknown).toBeUndefined();
    // Reads only, three of each key as the lookup can trail a write: the
    // payments under it, and the bank debit's handles.
    const cardRead = ["GET /paymenthub/v1/payments"];
    const achRead = ["GET /paymenthub/v1/payments", "GET /paymenthub/v1/paymenthandles"];
    expect(sentSince(fake, 0)).toEqual([...cardRead, ...cardRead, ...cardRead, ...achRead, ...achRead, ...achRead]);
  });

  it("leaves a completion's refusal open when its key holds a payment an earlier release may have made", async () => {
    const { adapter, fake } = makePair();
    await paysafeCall(fake, "POST", "/paymenthub/v1/payments", {
      merchantRefNum: "c1",
      dupCheck: false,
      amount: 10_000,
      currencyCode: "CLP",
      paymentHandleToken: "tok_clp",
      settleWithAuth: true,
    });
    const before = fake.requests.length;
    const err = await rejection(
      adapter.completePayment({ pspSessionId: await context("CLP"), clientToken: "tok_clp", idempotencyKey: "c1" }),
    );
    expect(err).toMatchObject({
      code: "invalid_request",
      retryable: false,
      outcomeUnknown: true,
      message: expect.stringMatching(/already holds a payment under this key.*check the Paysafe portal/),
      raw: { currency: "CLP", earlier: [expect.objectContaining({ merchantRefNum: "c1", currencyCode: "CLP" })] },
    });
    expect(sentSince(fake, before)).toEqual(["GET /paymenthub/v1/payments"]);
  });

  it("leaves a bank debit's completion refusal open when its key holds a spent handle whose payment the lookup hides", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 10_000,
      currency: "USD",
      paymentMethodTypes: ["ach"],
      idempotencyKey: "s-ach",
    });
    await adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: ACH_ENVELOPE, idempotencyKey: "c2" });
    fake.hideFromLookups("payments", "c2");
    const err = await rejection(
      adapter.completePayment({
        pspSessionId: await context("CLP", { paymentType: "ACH" }),
        clientToken: ACH_ENVELOPE,
        idempotencyKey: "c2",
      }),
    );
    expect(err).toMatchObject({ code: "invalid_request", outcomeUnknown: true });
    expect(err.raw).toMatchObject({ earlier: [expect.objectContaining({ merchantRefNum: "c2", status: "COMPLETED" })] });
  });

  it("refuses a saved-method charge and a native subscription in one as final once their keys hold nothing", async () => {
    const { adapter, fake } = makePair();
    const charge = await rejection(
      adapter.chargeSavedPaymentMethod({
        pspCustomerId: "cust_1",
        savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
        amount: 10_000,
        currency: "CLP",
        idempotencyKey: "charge-1",
      }),
    );
    expect(charge).toMatchObject({ code: "invalid_request", message: expect.stringMatching(/does not convert/) });
    expect(charge.outcomeUnknown).toBeUndefined();
    for (const [currency, extra] of [
      ["ISK", {}],
      ["CLP", { planId: "plan_host_managed" }],
    ] as const) {
      const sub = await rejection(
        adapter.createNativeSubscription({
          savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
          amount: 10_000,
          currency,
          interval: "month",
          idempotencyKey: `sub-${currency}`,
          ...extra,
        }),
      );
      expect(sub, currency).toMatchObject({ code: "invalid_request", message: expect.stringMatching(currency) });
      expect(sub.outcomeUnknown, currency).toBeUndefined();
    }
    // Reads only, three of each key: no plan, payment or subscription was created.
    const payments = Array<string>(3).fill("GET /paymenthub/v1/payments");
    const subscriptions = Array<string>(3).fill("GET /subscriptionsplans/v1/subscriptions");
    expect(sentSince(fake, 0)).toEqual([...payments, ...subscriptions, ...subscriptions]);
  });

  it("leaves a retried charge's refusal open when its key holds a payment that may have moved money", async () => {
    const { adapter, fake } = makePair();
    const charge = (idempotencyKey: string) =>
      adapter.chargeSavedPaymentMethod({
        pspCustomerId: "cust_1",
        savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
        amount: 10_000,
        currency: "CLP",
        idempotencyKey,
      });
    // A renewal an earlier release sent, whose answer was lost.
    await paysafeCall(fake, "POST", "/paymenthub/v1/payments", {
      merchantRefNum: "renewal-a0",
      dupCheck: true,
      amount: 10_000,
      currencyCode: "CLP",
      paymentHandleToken: SEEDED_MULTI_USE_TOKEN,
      settleWithAuth: true,
    });
    const retried = await rejection(charge("renewal-a0"));
    expect(retried).toMatchObject({
      code: "invalid_request",
      retryable: false,
      outcomeUnknown: true,
      raw: { earlier: [expect.objectContaining({ merchantRefNum: "renewal-a0", status: "COMPLETED" })] },
    });
    // A declined earlier attempt moved no money: the refusal stays final.
    const declined = await paysafeCall<{ id: string }>(fake, "POST", "/paymenthub/v1/payments", {
      merchantRefNum: "renewal-a1",
      dupCheck: true,
      amount: 10_000,
      currencyCode: "CLP",
      paymentHandleToken: SEEDED_MULTI_USE_TOKEN,
      settleWithAuth: true,
    });
    fake.failLater(declined.id, { code: "3009", message: "Your request has been declined by the issuing bank." });
    const final = await rejection(charge("renewal-a1"));
    expect(final).toMatchObject({ code: "invalid_request", retryable: false });
    expect(final.outcomeUnknown).toBeUndefined();
    // A lookup that fails leaves it open too.
    fake.networkFailure = true;
    const unreadable = await rejection(charge("renewal-a2"));
    fake.networkFailure = false;
    expect(unreadable).toMatchObject({
      code: "invalid_request",
      outcomeUnknown: true,
      message: expect.stringMatching(/lookup of this key failed/),
      raw: { lookupFailed: true },
    });
    expect(fake.uniqueSettlementCreations).toBe(0);
  });

  it("leaves a bank debit's retry open when its key holds a live payment, whatever its handles say", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 10_000,
      currency: "USD",
      paymentMethodTypes: ["ach"],
      idempotencyKey: "s-ach",
    });
    await adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: ACH_ENVELOPE, idempotencyKey: "c1" });
    const err = await rejection(
      adapter.completePayment({
        pspSessionId: await context("CLP", { paymentType: "ACH" }),
        clientToken: ACH_ENVELOPE,
        idempotencyKey: "c1",
      }),
    );
    expect(err).toMatchObject({ code: "invalid_request", outcomeUnknown: true });
    expect(err.raw).toMatchObject({ earlier: [expect.objectContaining({ merchantRefNum: "c1", paymentType: "ACH" })] });
  });

  it("keeps a bank debit's retry final when a declined payment accounts for its spent handle", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 10_000,
      currency: "USD",
      paymentMethodTypes: ["ach"],
      idempotencyKey: "s-ach",
    });
    fake.recordFailure(
      { method: "POST", path: "/paymenthub/v1/payments" },
      { status: 402, code: "3009", message: "Your request has been declined by the issuing bank." },
    );
    await expect(
      adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: ACH_ENVELOPE, idempotencyKey: "c1" }),
    ).rejects.toMatchObject({ code: "card_declined" });
    const err = await rejection(
      adapter.completePayment({
        pspSessionId: await context("CLP", { paymentType: "ACH" }),
        clientToken: ACH_ENVELOPE,
        idempotencyKey: "c1",
      }),
    );
    expect(err).toMatchObject({ code: "invalid_request", retryable: false });
    expect(err.outcomeUnknown).toBeUndefined();
  });

  it("keeps a retried charge final when its key holds only a voided authorization", async () => {
    const { adapter, fake } = makePair();
    const voided = await paysafeCall<{ id: string }>(fake, "POST", "/paymenthub/v1/payments", {
      merchantRefNum: "renewal-v",
      dupCheck: true,
      amount: 10_000,
      currencyCode: "CLP",
      paymentHandleToken: SEEDED_MULTI_USE_TOKEN,
      settleWithAuth: false,
    });
    await paysafeCall(fake, "POST", `/paymenthub/v1/payments/${voided.id}/voidauths`, {
      merchantRefNum: "renewal-v-void",
      amount: 10_000,
    });
    const err = await rejection(
      adapter.chargeSavedPaymentMethod({
        pspCustomerId: "cust_1",
        savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
        amount: 10_000,
        currency: "CLP",
        idempotencyKey: "renewal-v",
      }),
    );
    expect(err).toMatchObject({ code: "invalid_request", retryable: false });
    expect(err.outcomeUnknown).toBeUndefined();
  });

  it("retries a lookup the transport refuses, and reads a key the index trails again before calling it empty", async () => {
    const sleeps: number[] = [];
    const { adapter, fake } = makePair({
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const charge = (idempotencyKey: string) =>
      adapter.chargeSavedPaymentMethod({
        pspCustomerId: "cust_1",
        savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
        amount: 10_000,
        currency: "CLP",
        idempotencyKey,
      });
    for (const merchantRefNum of ["renewal-503", "renewal-lag"]) {
      await paysafeCall(fake, "POST", "/paymenthub/v1/payments", {
        merchantRefNum,
        dupCheck: true,
        amount: 10_000,
        currencyCode: "CLP",
        paymentHandleToken: SEEDED_MULTI_USE_TOKEN,
        settleWithAuth: true,
      });
    }
    fake.refuse({ method: "GET", path: "/paymenthub/v1/payments" }, 503, 1);
    const afterRetry = await rejection(charge("renewal-503"));
    expect(afterRetry).toMatchObject({ outcomeUnknown: true, raw: { earlier: [expect.anything()] } });
    expect((afterRetry.raw as { earlier: unknown[] }).earlier).toHaveLength(1);
    // The index trails the write twice: the key is read again after 250 ms, then 500 ms.
    sleeps.length = 0;
    fake.hideFromLookups("payments", "renewal-lag", 2);
    const afterLag = await rejection(charge("renewal-lag"));
    expect(afterLag).toMatchObject({ outcomeUnknown: true, raw: { earlier: [expect.anything()] } });
    expect(sleeps).toEqual([250, 500]);
  });

  it("retries a bank debit's handle lookup the transport refuses, and keeps an empty key final", async () => {
    const { adapter, fake } = makePair();
    fake.refuse({ method: "GET", path: "/paymenthub/v1/paymenthandles" }, 503, 1);
    const err = await rejection(
      adapter.completePayment({
        pspSessionId: await context("CLP", { paymentType: "ACH" }),
        clientToken: ACH_ENVELOPE,
        idempotencyKey: "c-503",
      }),
    );
    expect(err).toMatchObject({ code: "invalid_request", retryable: false });
    expect(err.outcomeUnknown).toBeUndefined();
  });

  it("leaves the refusal open when a read of an empty key fails afterwards", async () => {
    const fake = new FakePaysafeApi();
    let paymentReads = 0;
    const flaky: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? "GET") === "GET" && new URL(url).pathname === "/paymenthub/v1/payments") {
        paymentReads += 1;
        if (paymentReads > 1) throw new TypeError("simulated network failure");
      }
      return fake.fetch(input, init);
    };
    const { adapter } = makePair({ fetch: flaky });
    const err = await rejection(
      adapter.chargeSavedPaymentMethod({
        pspCustomerId: "cust_1",
        savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
        amount: 10_000,
        currency: "CLP",
        idempotencyKey: "renewal-y",
      }),
    );
    expect(err).toMatchObject({ code: "invalid_request", outcomeUnknown: true, raw: { lookupFailed: true } });
    expect(paymentReads).toBeGreaterThan(1);
  });

  it("keeps a failed lookup's own error on raw", async () => {
    const { adapter, fake } = makePair();
    fake.networkFailure = true;
    const err = await rejection(
      adapter.chargeSavedPaymentMethod({
        pspCustomerId: "cust_1",
        savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
        amount: 10_000,
        currency: "CLP",
        idempotencyKey: "renewal-x",
      }),
    );
    fake.networkFailure = false;
    expect(err).toMatchObject({
      outcomeUnknown: true,
      raw: { lookupFailed: true, lookupError: expect.objectContaining({ code: "psp_unavailable" }) },
    });
  });

  it("leaves a retried native subscription's refusal open when its key holds a subscription", async () => {
    const { adapter, fake } = makePair();
    await subscriptionMadeElsewhere(fake, "CLP");
    const err = await rejection(
      adapter.createNativeSubscription({
        savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
        amount: 10_000,
        currency: "CLP",
        interval: "month",
        idempotencyKey: "k",
        merchantRefNum: "sub-CLP",
      }),
    );
    expect(err).toMatchObject({
      code: "invalid_request",
      outcomeUnknown: true,
      message: expect.stringMatching(/already holds a subscription under this key/),
      raw: { earlier: [expect.objectContaining({ merchantRefNum: "sub-CLP" })] },
    });
  });

  it("refuses a capture or refund of a stated amount with invalid_request, once the payment is read", async () => {
    const { adapter, fake } = makePair();
    const authorized = await paymentMadeElsewhere(fake, "CLP", false);
    const settled = await paymentMadeElsewhere(fake, "CLP", true);
    const calls: Array<[string, string, () => Promise<unknown>]> = [
      ["capture", authorized.id, () => adapter.capturePayment(authorized.id, 500_000, "cap-1")],
      // The authorized amount is still the caller's, in PayFanout's minor units.
      ["capture", authorized.id, () => adapter.capturePayment(authorized.id, 1_000_000, "cap-2")],
      ["refund", settled.id, () => adapter.refundPayment({ pspPaymentId: settled.id, amount: 100, idempotencyKey: "ref-1" })],
    ];
    for (const [action, id, call] of calls) {
      const before = fake.requests.length;
      const err = await rejection(call());
      expect(err, action).toMatchObject({ code: "invalid_request", retryable: false, pspName: "paysafe" });
      expect(err.message).toContain(`Payment ${id} is in CLP, and a ${action} amount in PayFanout's minor units`);
      expect(err.message).toContain(`${action[0]!.toUpperCase()}${action.slice(1)} it in the Paysafe portal`);
      expect(err.raw).toMatchObject({
        currency: "CLP",
        paysafeExponent: 2,
        payfanoutExponent: 0,
        record: { id, currencyCode: "CLP", amount: 1_000_000 },
      });
      expect(sentSince(fake, before)).toEqual([`GET /paymenthub/v1/payments/${id}`]);
    }
    expect(fake.uniqueSettlementCreations).toBe(0);
    expect(fake.uniqueRefundCreations).toBe(0);
  });

  it("refuses a void, and a capture or refund of no amount, with unsupported_operation once the payment is read", async () => {
    const { adapter, fake } = makePair();
    const authorized = await paymentMadeElsewhere(fake, "CLP", false);
    const settled = await paymentMadeElsewhere(fake, "CLP", true);
    const calls: Array<[string, string, () => Promise<unknown>]> = [
      ["capture", authorized.id, () => adapter.capturePayment(authorized.id, undefined, "cap-1")],
      ["void", authorized.id, () => adapter.cancelPayment(authorized.id, "void-1")],
      ["refund", settled.id, () => adapter.refundPayment({ pspPaymentId: settled.id, idempotencyKey: "ref-1" })],
    ];
    for (const [action, id, call] of calls) {
      const before = fake.requests.length;
      const err = await rejection(call());
      expect(err, action).toMatchObject({ code: "unsupported_operation", retryable: false, pspName: "paysafe" });
      expect(err.message).toContain(
        `Payment ${id} is in CLP, so the amounts a ${action} answers with cannot be reported in PayFanout's minor units`,
      );
      expect(err.message).toContain(`${action[0]!.toUpperCase()}${action.slice(1)} it in the Paysafe portal`);
      expect(sentSince(fake, before)).toEqual([`GET /paymenthub/v1/payments/${id}`]);
    }
    expect(fake.uniqueSettlementCreations).toBe(0);
    expect(fake.uniqueRefundCreations).toBe(0);
  });

  it("refuses to report a payment, or a refund Paysafe reports in one", async () => {
    const { adapter, fake } = makePair();
    const settled = await paymentMadeElsewhere(fake, "CLP", true);
    const before = fake.requests.length;
    const read = await rejection(adapter.retrievePayment(settled.id));
    expect(read).toMatchObject({ code: "unsupported_operation", retryable: false, pspName: "paysafe" });
    expect(read.message).toMatch(/cannot be reported in PayFanout's minor units/);
    expect(read.message).toMatch(/Read it in the Paysafe portal/);
    // No settlement lookup follows: the read stops at the payment.
    expect(sentSince(fake, before)).toEqual([`GET /paymenthub/v1/payments/${settled.id}`]);

    const refundId = await refundMadeElsewhere(fake, settled);
    await expect(adapter.retrieveRefund(refundId)).rejects.toMatchObject({
      code: "unsupported_operation",
      message: expect.stringMatching(/Refund .* is in CLP/),
    });
  });

  it("reports a refund that states no currency as it comes, as Paysafe's card refund example shows one", async () => {
    const { adapter, fake } = makePair();
    fake.cardRefundsWithoutCurrency = true;
    // Paysafe's number, not PayFanout's: the refund names no currency, payment or settlement.
    const clp = await paymentMadeElsewhere(fake, "CLP", true);
    const refundId = await refundMadeElsewhere(fake, clp);
    const read = await adapter.retrieveRefund(refundId);
    expect(read).toMatchObject({ refundId, amount: 100_000 });
    expect(read.raw).not.toHaveProperty("currencyCode");

    const session = await adapter.createPaymentSession({ amount: 1099, currency: "USD", idempotencyKey: "usd-s" });
    const paid = await adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: "tok_usd", idempotencyKey: "usd-c" });
    const refund = await adapter.refundPayment({ pspPaymentId: paid.pspPaymentId, amount: 99, idempotencyKey: "usd-r" });
    expect(refund.raw).not.toHaveProperty("currencyCode");
    await expect(adapter.retrieveRefund(refund.refundId)).resolves.toMatchObject({ amount: 99 });
  });

  it("refuses to report a subscription billing in one", async () => {
    const { adapter, fake } = makePair();
    const subscriptionId = await subscriptionMadeElsewhere(fake, "CLP");
    await expect(adapter.retrieveNativeSubscription({ subscriptionId })).rejects.toMatchObject({
      code: "unsupported_operation",
      message: expect.stringMatching(/cannot be reported in PayFanout's minor units/),
    });
  });

  it("fails a subscription page holding one, naming each and keeping the next page's cursor", async () => {
    const { adapter, fake } = makePair();
    await adapter.createNativeSubscription({
      savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
      amount: 1499,
      currency: "USD",
      interval: "month",
      idempotencyKey: "sub-usd",
    });
    const inClp = await subscriptionMadeElsewhere(fake, "CLP");
    const inIsk = await subscriptionMadeElsewhere(fake, "ISK");

    const whole = await rejection(adapter.listNativeSubscriptions({ limit: 50 }));
    expect(whole).toMatchObject({ code: "unsupported_operation", retryable: false });
    expect(whole.message).toContain(`${inClp} in CLP, ${inIsk} in ISK`);
    expect(whole.message).toContain("Paysafe's currency table gives CLP the exponent 2");
    expect(whole.message).toContain("Paysafe's currency table has no row for ISK");
    // Only the refused records, not the page of customer profiles, and no next page.
    expect(whole.raw).toEqual({
      currencies: [
        { currency: "CLP", paysafeExponent: 2, payfanoutExponent: 0 },
        { currency: "ISK", payfanoutExponent: 0 },
      ],
      records: [
        { id: inClp, currency: "CLP" },
        { id: inIsk, currency: "ISK" },
      ],
    });

    const full = await rejection(adapter.listNativeSubscriptions({ limit: 3 }));
    expect(full.raw).toMatchObject({ nextCursor: "3" });
    expect(full.message).toContain("the next page starts at cursor 3");

    // A limit of 1 steps past each refused subscription.
    const first = await adapter.listNativeSubscriptions({ limit: 1 });
    expect(first).toMatchObject({ subscriptions: [{ currency: "USD" }], nextCursor: "1" });
    await expect(adapter.listNativeSubscriptions({ limit: 1, cursor: "1" })).rejects.toMatchObject({
      raw: { records: [{ id: inClp, currency: "CLP" }], nextCursor: "2" },
    });
    await expect(adapter.listNativeSubscriptions({ limit: 1, cursor: "2" })).rejects.toMatchObject({
      raw: { records: [{ id: inIsk, currency: "ISK" }], nextCursor: "3" },
    });
    await expect(adapter.listNativeSubscriptions({ limit: 1, cursor: "3" })).resolves.toEqual({ subscriptions: [] });
  });

  it("names a currency once on a page holding several subscriptions in it, however each spells it", async () => {
    const { adapter, fake } = makePair();
    const upper = await subscriptionMadeElsewhere(fake, "CLP");
    const lower = await subscriptionMadeElsewhere(fake, "clp");
    const err = await rejection(adapter.listNativeSubscriptions({ limit: 50 }));
    expect(err.raw).toEqual({
      currencies: [{ currency: "CLP", paysafeExponent: 2, payfanoutExponent: 0 }],
      records: [
        { id: upper, currency: "CLP" },
        { id: lower, currency: "CLP" },
      ],
    });
  });

  it("refuses to cancel a subscription billing in one before the PATCH, saying so when it is already stopped", async () => {
    const { adapter, fake } = makePair();
    const active = await subscriptionMadeElsewhere(fake, "CLP");
    let before = fake.requests.length;
    const cancel = await rejection(adapter.cancelNativeSubscription({ subscriptionId: active, idempotencyKey: "cancel-1" }));
    expect(cancel).toMatchObject({ code: "unsupported_operation", retryable: false });
    expect(cancel.message).toContain(
      `Subscription ${active} is in CLP, so the amounts a cancel answers with cannot be reported`,
    );
    expect(cancel.message).toContain("Cancel it in the Paysafe portal");
    expect(sentSince(fake, before)).toEqual([`GET /subscriptionsplans/v1/subscriptions/${active}`]);

    const stopped = await subscriptionMadeElsewhere(fake, "ISK");
    await paysafeCall(fake, "PATCH", `/subscriptionsplans/v1/subscriptions/${stopped}`, { status: "CANCELLED" });
    before = fake.requests.length;
    const again = await rejection(adapter.cancelNativeSubscription({ subscriptionId: stopped, idempotencyKey: "cancel-2" }));
    expect(again).toMatchObject({ code: "unsupported_operation", retryable: false });
    expect(again.message).toContain(`Subscription ${stopped} is already stopped (CANCELLED), and it is in ISK`);
    expect(again.message).toContain("Read it in the Paysafe portal");
    expect(again.message).not.toContain("Cancel it");
    expect(again.raw).toMatchObject({ currency: "ISK", record: { id: stopped, status: "CANCELLED" } });
    expect(sentSince(fake, before)).toEqual([`GET /subscriptionsplans/v1/subscriptions/${stopped}`]);
  });

  it("leaves every other refusal final: only a looked-up key that holds something, or cannot be read, stays open", async () => {
    const { adapter, fake } = makePair();
    const authorized = await paymentMadeElsewhere(fake, "CLP", false);
    const settled = await paymentMadeElsewhere(fake, "CLP", true);
    const refundId = await refundMadeElsewhere(fake, settled);
    const active = await subscriptionMadeElsewhere(fake, "CLP");
    const stopped = await subscriptionMadeElsewhere(fake, "ISK");
    await paysafeCall(fake, "PATCH", `/subscriptionsplans/v1/subscriptions/${stopped}`, { status: "CANCELLED" });
    const session = await adapter.createPaymentSession({ amount: 10_000, currency: "USD", idempotencyKey: "k" });
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["session", () => adapter.createPaymentSession({ amount: 10_000, currency: "CLP", idempotencyKey: "k1" })],
      ["update", () => adapter.updatePaymentSession({ pspSessionId: session.pspSessionId, currency: "XOF", idempotencyKey: "u" })],
      ["capture of an amount", () => adapter.capturePayment(authorized.id, 500_000, "cap-1")],
      ["capture", () => adapter.capturePayment(authorized.id, undefined, "cap-2")],
      ["void", () => adapter.cancelPayment(authorized.id, "void-1")],
      ["refund of an amount", () => adapter.refundPayment({ pspPaymentId: settled.id, amount: 100, idempotencyKey: "r-1" })],
      ["refund", () => adapter.refundPayment({ pspPaymentId: settled.id, idempotencyKey: "r-2" })],
      ["payment read", () => adapter.retrievePayment(settled.id)],
      ["refund read", () => adapter.retrieveRefund(refundId)],
      ["subscription read", () => adapter.retrieveNativeSubscription({ subscriptionId: active })],
      ["subscription cancel", () => adapter.cancelNativeSubscription({ subscriptionId: active, idempotencyKey: "c-1" })],
      ["stopped cancel", () => adapter.cancelNativeSubscription({ subscriptionId: stopped, idempotencyKey: "c-2" })],
      ["subscription page", () => adapter.listNativeSubscriptions({ limit: 10 })],
    ];
    for (const [name, call] of calls) {
      const err = await rejection(call());
      expect(err.retryable, name).toBe(false);
      expect(err.outcomeUnknown, name).toBeUndefined();
    }
  });

  it("reports a webhook in one without its amount, and everything else as it would for any currency", async () => {
    const { adapter } = makePair();
    for (const parse of [(raw: string) => adapter.parseWebhookEvent(raw), parsePaysafeWebhookEvent]) {
      const usd = await parse(webhookIn("USD"));
      expect(usd.amount).toBe(1_000_000);
      for (const currency of ["CLP", "isk", " clp ", "BYR", "UYI", "XOF"]) {
        const event = await parse(webhookIn(currency));
        expect(event, currency).not.toHaveProperty("amount");
        expect(event).toMatchObject({
          id: usd.id,
          type: "payment.succeeded",
          pspPaymentId: usd.pspPaymentId,
          currency: currency.toUpperCase(),
          occurredAt: usd.occurredAt,
        });
      }
      const refund = await parse(webhookIn("CLP", "REFUND_COMPLETED"));
      expect(refund).not.toHaveProperty("amount");
      expect(refund).toMatchObject({ type: "payment.refunded", refundId: "0f3a6c1e-5b2d-4e8f-9a7c-3d1e2f4a5b6c" });
      // No currency stated, as Paysafe does not promise one on card refunds: the amount stays as delivered.
      const bare = await parse(webhookIn(undefined, "REFUND_COMPLETED"));
      expect(bare).toMatchObject({ type: "payment.refunded", amount: 1_000_000 });
      expect(bare).not.toHaveProperty("currency");
    }
    // Verification still runs over the delivered bytes.
    const raw = webhookIn("CLP");
    const signature = createHmac("sha256", WEBHOOK_KEY).update(raw, "utf8").digest("base64");
    await expect(adapter.verifyWebhookSignature(raw, { Signature: signature })).resolves.toBe(true);
  });
});

describe("currencies Paysafe prices as ISO 4217 does", () => {
  const cases: Array<[string, number, number]> = [
    ["JPY", 5000, 1000],
    ["KWD", 1234, 234],
    ["USD", 1099, 99],
  ];
  for (const [currency, amount, partial] of cases) {
    it(`sends and reports ${currency} amounts unchanged, in ISO 4217 minor units`, async () => {
      const { adapter, fake } = makePair();
      const session = await adapter.createPaymentSession({ amount, currency, idempotencyKey: `${currency}-s` });
      const paid = await adapter.completePayment({
        pspSessionId: session.pspSessionId,
        clientToken: `tok_${currency}`,
        idempotencyKey: `${currency}-c`,
      });
      expect(fake.lastRequestBody).toMatchObject({ amount, currencyCode: currency });
      expect(paid).toMatchObject({ amount, currency, amountCaptured: amount });
      await expect(adapter.retrievePayment(paid.pspPaymentId)).resolves.toMatchObject({ amount, currency });

      const refund = await adapter.refundPayment({ pspPaymentId: paid.pspPaymentId, amount: partial, idempotencyKey: `${currency}-r` });
      expect(fake.lastRequestBody).toMatchObject({ amount: partial });
      expect(refund.amount).toBe(partial);
      await expect(adapter.retrieveRefund(refund.refundId)).resolves.toMatchObject({ amount: partial });

      const manual = await adapter.createPaymentSession({ amount, currency, captureMethod: "manual", idempotencyKey: `${currency}-ms` });
      const authorized = await adapter.completePayment({
        pspSessionId: manual.pspSessionId,
        clientToken: `tok_${currency}_manual`,
        idempotencyKey: `${currency}-mc`,
      });
      const captured = await adapter.capturePayment(authorized.pspPaymentId, undefined, `${currency}-cap`);
      expect(fake.requestsTo("POST", `/paymenthub/v1/payments/${authorized.pspPaymentId}/settlements`)[0]!.body).toMatchObject({ amount });
      expect(captured).toMatchObject({ amountCaptured: amount, currency });

      await adapter.chargeSavedPaymentMethod({
        pspCustomerId: "cust_1",
        savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
        amount,
        currency,
        idempotencyKey: `${currency}-charge`,
      });
      expect(fake.lastRequestBody).toMatchObject({ amount, currencyCode: currency });

      const subscription = await adapter.createNativeSubscription({
        savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
        amount,
        currency,
        interval: "month",
        idempotencyKey: `${currency}-sub`,
      });
      expect(fake.lastPlanRequestBody).toMatchObject({ amount, currencyCode: currency });
      expect(subscription).toMatchObject({ amount, currency });

      await expect(adapter.parseWebhookEvent(webhookIn(currency))).resolves.toMatchObject({ amount: 1_000_000, currency });
    });
  }
});
