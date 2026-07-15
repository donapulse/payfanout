import { describe, expect, it } from "vitest";
import {
  isPayFanoutError,
  utf8ToBase64Url,
  type CreatePaymentSessionInput,
  type UnifiedPaymentMethodType,
} from "@payfanout/core";
import {
  decodeSessionContext,
  PaysafeServerAdapter,
  type PaysafeServerAdapterConfig,
} from "../src/index.js";
import { FakePaysafeApi } from "./fake-paysafe-api.js";

const SIGNING_KEY = "session-signing-key";

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
    webhookHmacKey: "webhook-hmac-key",
    fetch: fake.fetch,
    ...config,
  });
  return { adapter, fake };
}

/** The exact wire format confirm() produces: "paysafe-bank." + base64url(JSON). */
const envelope = (details: Record<string, unknown>): string =>
  `paysafe-bank.${utf8ToBase64Url(JSON.stringify(details))}`;

interface RailFixture {
  rail: UnifiedPaymentMethodType;
  paymentType: string;
  currency: string;
  details: Record<string, unknown>;
  /** The bank object completePayment must send, field for field. */
  bankObject: Record<string, string>;
}

const RAILS: RailFixture[] = [
  {
    rail: "sepa_debit",
    paymentType: "SEPA",
    currency: "EUR",
    details: {
      v: 1,
      paymentType: "SEPA",
      accountHolderName: "Erik van Houten",
      iban: "NL77ABNA0492122466", // Paysafe's documented SEPA test IBAN
      bic: "ABNANL2A",
      mandateConsent: true,
    },
    bankObject: { accountHolderName: "Erik van Houten", iban: "NL77ABNA0492122466", bic: "ABNANL2A" },
  },
  {
    rail: "ach",
    paymentType: "ACH",
    currency: "USD",
    details: {
      v: 1,
      paymentType: "ACH",
      accountHolderName: "Pat Doe",
      routingNumber: "123456789",
      accountNumber: "1234567890",
    },
    bankObject: { accountHolderName: "Pat Doe", routingNumber: "123456789", accountNumber: "1234567890" },
  },
  {
    rail: "bacs_debit",
    paymentType: "BACS",
    currency: "GBP",
    details: {
      v: 1,
      paymentType: "BACS",
      accountHolderName: "Alex Smith",
      sortCode: "086081", // Paysafe's documented BACS test values
      accountNumber: "51120177",
      mandateConsent: true,
    },
    bankObject: { accountHolderName: "Alex Smith", sortCode: "086081", accountNumber: "51120177" },
  },
  {
    rail: "pad",
    paymentType: "EFT",
    currency: "CAD",
    details: {
      v: 1,
      paymentType: "EFT",
      accountHolderName: "Jean Tremblay",
      institutionId: "001", // Paysafe's documented EFT simulation values
      transitNumber: "22446",
      accountNumber: "897543213",
    },
    bankObject: {
      accountHolderName: "Jean Tremblay",
      institutionId: "001",
      transitNumber: "22446",
      accountNumber: "897543213",
    },
  },
];

const sessionInput = (fixture: RailFixture): CreatePaymentSessionInput => ({
  amount: 12_50,
  currency: fixture.currency,
  paymentMethodTypes: [fixture.rail],
  idempotencyKey: `k-${fixture.rail}`,
});

describe("Paysafe bank-debit sessions", () => {
  for (const fixture of RAILS) {
    it(`${fixture.rail}: stamps ${fixture.paymentType} into the signed context without calling Paysafe`, async () => {
      const { adapter, fake } = makePair();
      const session = await adapter.createPaymentSession(sessionInput(fixture));
      // Nothing exists to mint yet — the customer has not typed bank details.
      expect(fake.uniqueHandleCreations).toBe(0);
      expect(session.status).toBe("requires_payment_method");
      const context = await decodeSessionContext(session.pspSessionId, SIGNING_KEY);
      expect(context.paymentType).toBe(fixture.paymentType);
      expect(context.paymentHandleToken).toBeUndefined();
      expect(context.redirectUrl).toBeUndefined();
    });

    it(`${fixture.rail}: completion mints the handle and charges it, both keyed on the idempotencyKey`, async () => {
      const { adapter, fake } = makePair();
      const session = await adapter.createPaymentSession(sessionInput(fixture));
      const info = await adapter.completePayment({
        pspSessionId: session.pspSessionId,
        clientToken: envelope(fixture.details),
        idempotencyKey: `complete-${fixture.rail}`,
      });

      expect(fake.uniqueHandleCreations).toBe(1);
      expect(fake.uniquePaymentCreations).toBe(1);
      expect(fake.lastHandleRequestBody).toMatchObject({
        merchantRefNum: `complete-${fixture.rail}`,
        transactionType: "PAYMENT",
        paymentType: fixture.paymentType,
        amount: 12_50,
        currencyCode: fixture.currency,
        accountId: `acct-${fixture.currency}`,
      });
      // The bank object rides under the lowercase paymentType, field for field.
      expect(fake.lastHandleRequestBody?.[fixture.paymentType.toLowerCase()]).toEqual(fixture.bankObject);
      expect(fake.lastRequestBody).toMatchObject({
        merchantRefNum: `complete-${fixture.rail}`,
        amount: 12_50,
        currencyCode: fixture.currency,
        settleWithAuth: true, // debits settle with auth, always
      });
      // The payment charges the handle the first call just minted.
      expect(fake.lastRequestBody?.["paymentHandleToken"]).toMatch(/^PH\d+Token$/);

      expect(info.paymentMethodType).toBe(fixture.rail);
      // Bank debits settle later: the terminal outcome arrives by webhook.
      expect(info.status).toBe("processing");
      expect(info.amount).toBe(12_50);
      expect(info.currency).toBe(fixture.currency);
    });
  }

  it("splits the account holder into the handle's profile, with the session email when present", async () => {
    const { adapter, fake } = makePair();
    const fixture = RAILS[0]!;
    const session = await adapter.createPaymentSession({
      ...sessionInput(fixture),
      receiptEmail: "payer@example.com",
    });
    await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: envelope(fixture.details),
      idempotencyKey: "complete-profile",
    });
    expect(fake.lastHandleRequestBody?.["profile"]).toEqual({
      firstName: "Erik",
      lastName: "van Houten",
      email: "payer@example.com",
    });
  });

  it("keeps the profile to the name alone for single-word holders without an email", async () => {
    const { adapter, fake } = makePair();
    const fixture = RAILS[3]!;
    const session = await adapter.createPaymentSession(sessionInput(fixture));
    await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: envelope({ ...fixture.details, accountHolderName: "Cher" }),
      idempotencyKey: "complete-mononym",
    });
    expect(fake.lastHandleRequestBody?.["profile"]).toEqual({ firstName: "Cher" });
  });

  it("merges completion-time billingDetails over the session's on both calls", async () => {
    const { adapter, fake } = makePair();
    const fixture = RAILS[2]!;
    const session = await adapter.createPaymentSession({
      ...sessionInput(fixture),
      billingDetails: { address: { line1: "1 Way", city: "London", country: "GB" } },
    });
    await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: envelope(fixture.details),
      idempotencyKey: "complete-billing",
      billingDetails: { address: { postalCode: "SW1A 1AA" } },
    });
    const expected = { street: "1 Way", city: "London", zip: "SW1A 1AA", country: "GB" };
    expect(fake.lastHandleRequestBody?.["billingDetails"]).toEqual(expected);
    expect(fake.lastRequestBody?.["billingDetails"]).toEqual(expected);
  });

  it("omits accountId on both calls when the resolver has none (single-account API keys)", async () => {
    const { adapter, fake } = makePair({ merchantAccountResolver: () => undefined });
    const fixture = RAILS[1]!;
    const session = await adapter.createPaymentSession(sessionInput(fixture));
    await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: envelope(fixture.details),
      idempotencyKey: "complete-no-acct",
    });
    expect(fake.lastHandleRequestBody).not.toHaveProperty("accountId");
    expect(fake.lastRequestBody).not.toHaveProperty("accountId");
  });

  it("surfaces the SEPA/BACS mandate reference on the completed payment", async () => {
    for (const fixture of [RAILS[0]!, RAILS[2]!]) {
      const { adapter } = makePair();
      const session = await adapter.createPaymentSession(sessionInput(fixture));
      const info = await adapter.completePayment({
        pspSessionId: session.pspSessionId,
        clientToken: envelope(fixture.details),
        idempotencyKey: `complete-mandate-${fixture.rail}`,
      });
      expect(info.mandateReference).toMatch(/^MND\d+REF$/);
      // Reconciliation reads it straight off the payment's bank object too.
      const retrieved = await adapter.retrievePayment(info.pspPaymentId);
      expect(retrieved.mandateReference).toBe(info.mandateReference);
    }
  });

  it("falls back to the freshly minted handle's mandate when the payment echo omits it", async () => {
    const { adapter } = makePair({
      fetch: (async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.endsWith("/paymenthandles")) {
          return new Response(
            JSON.stringify({
              id: "ph_1",
              paymentHandleToken: "PH1",
              status: "PAYABLE",
              bacs: { mandateReference: "4677MNAO66" },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ id: "pay_1", status: "PROCESSING", amount: 12_50, currencyCode: "GBP", paymentType: "BACS" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    const fixture = RAILS[2]!;
    const session = await adapter.createPaymentSession(sessionInput(fixture));
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: envelope(fixture.details),
      idempotencyKey: "complete-mandate-fallback",
    });
    expect(info.mandateReference).toBe("4677MNAO66");
  });

  it("leaves mandateReference off ACH/EFT payments — the schemes document none", async () => {
    for (const fixture of [RAILS[1]!, RAILS[3]!]) {
      const { adapter } = makePair();
      const session = await adapter.createPaymentSession(sessionInput(fixture));
      const info = await adapter.completePayment({
        pspSessionId: session.pspSessionId,
        clientToken: envelope(fixture.details),
        idempotencyKey: `complete-no-mandate-${fixture.rail}`,
      });
      expect(info.mandateReference).toBeUndefined();
    }
  });

  it("reports an in-flight debit as neither refunded nor captured", async () => {
    const { adapter } = makePair();
    const fixture = RAILS[3]!;
    const session = await adapter.createPaymentSession(sessionInput(fixture));
    const completed = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: envelope(fixture.details),
      idempotencyKey: "complete-inflight",
    });
    // Reconciliation re-reads the payment, which resolves the PROCESSING
    // settlement Paysafe attaches immediately (availableToRefund: 0 there means
    // "not refundable yet" — reading it as a refund would tell the host the
    // customer had been paid back).
    const info = await adapter.retrievePayment(completed.pspPaymentId);
    expect(info.paymentMethodType).toBe("pad");
    expect(info.status).toBe("processing");
    expect(info.amountRefunded).toBe(0);
    expect(info.amountCaptured).toBeUndefined();
    expect(info.capturedAt).toBeUndefined();
    expect(info.amount).toBe(12_50);
  });

  it("dedupes both calls on merchantRefNum, like the real API", async () => {
    const { adapter, fake } = makePair();
    const fixture = RAILS[0]!;
    const session = await adapter.createPaymentSession(sessionInput(fixture));
    const input = {
      pspSessionId: session.pspSessionId,
      clientToken: envelope(fixture.details),
      idempotencyKey: "complete-once",
    };
    const first = await adapter.completePayment(input);
    const second = await adapter.completePayment(input);
    expect(fake.uniqueHandleCreations).toBe(1);
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(second.pspPaymentId).toBe(first.pspPaymentId);
  });

  it("fails with the raw response when the handle does not come back PAYABLE", async () => {
    const { adapter } = makePair({
      fetch: (async () =>
        new Response(
          JSON.stringify({ id: "ph_1", paymentHandleToken: "PH1", status: "FAILED" }),
          { status: 201, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    const fixture = RAILS[1]!;
    const session = await adapter.createPaymentSession(sessionInput(fixture));
    await expect(
      adapter.completePayment({
        pspSessionId: session.pspSessionId,
        clientToken: envelope(fixture.details),
        idempotencyKey: "complete-unpayable",
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isPayFanoutError(err) &&
        err.code === "processing_error" &&
        !err.retryable &&
        (err.raw as { status?: string }).status === "FAILED",
    );
  });

  it("models the rails honestly: embedded flow, off until the account opts in, gates declared", () => {
    const { adapter } = makePair();
    const methods = adapter.getCapabilities().paymentMethods;
    expect(methods.find((m) => m.type === "sepa_debit")).toEqual({
      type: "sepa_debit",
      flow: "embedded",
      supported: false,
      currencies: ["EUR"],
    });
    // ACH and EFT declare no currencies: Paysafe documents none for either.
    expect(methods.find((m) => m.type === "ach")).toEqual({ type: "ach", flow: "embedded", supported: false });
    expect(methods.find((m) => m.type === "bacs_debit")).toEqual({
      type: "bacs_debit",
      flow: "embedded",
      supported: false,
      currencies: ["GBP"],
      countries: ["GB"],
    });
    expect(methods.find((m) => m.type === "pad")).toEqual({
      type: "pad",
      flow: "embedded",
      supported: false,
      countries: ["CA"],
    });
  });

  it("serves accounts that opt a rail in, end to end", async () => {
    const { adapter, fake } = makePair({
      paymentMethods: [
        { type: "bacs_debit", flow: "embedded", supported: true, currencies: ["GBP"], countries: ["GB"] },
      ],
    });
    const fixture = RAILS[2]!;
    const session = await adapter.createPaymentSession(sessionInput(fixture));
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: envelope(fixture.details),
      idempotencyKey: "complete-opted-in",
    });
    expect(info.status).toBe("processing");
    expect(fake.uniquePaymentCreations).toBe(1);
    // The override replaces the list wholesale — every other rail is unknown now.
    await expect(
      adapter.createPaymentSession({ ...sessionInput(RAILS[0]!), idempotencyKey: "k-gone" }),
    ).rejects.toThrow(/does not support one of the requested/);
  });

  it("does not currency-gate ACH or EFT — Paysafe documents no currency for them", async () => {
    const { adapter } = makePair();
    await expect(
      adapter.createPaymentSession({ ...sessionInput(RAILS[1]!), currency: "CAD" }),
    ).resolves.toMatchObject({ status: "requires_payment_method" });
    await expect(
      adapter.createPaymentSession({ ...sessionInput(RAILS[3]!), currency: "USD", idempotencyKey: "k-pad-usd" }),
    ).resolves.toMatchObject({ status: "requires_payment_method" });
  });
});

describe("Paysafe bank-debit session guards", () => {
  const rejects = async (
    input: CreatePaymentSessionInput,
    expected: RegExp,
  ): Promise<void> => {
    const { adapter, fake } = makePair();
    await expect(adapter.createPaymentSession(input)).rejects.toThrow(expected);
    // A rejected session must never have reached Paysafe.
    expect(fake.uniqueHandleCreations).toBe(0);
  };

  it("rejects a non-EUR SEPA session", async () => {
    await rejects({ ...sessionInput(RAILS[0]!), currency: "USD" }, /EUR only/);
  });

  it("rejects a non-GBP Bacs session", async () => {
    await rejects({ ...sessionInput(RAILS[2]!), currency: "EUR" }, /GBP only/);
  });

  it("rejects manual capture — debits settle with auth", async () => {
    for (const fixture of RAILS) {
      await rejects({ ...sessionInput(fixture), captureMethod: "manual" }, /captureMethod/);
    }
  });

  it("rejects mixing a bank rail with any other method in one session", async () => {
    await rejects(
      { ...sessionInput(RAILS[0]!), paymentMethodTypes: ["sepa_debit", "card"] },
      /session of its own/,
    );
    // Two bank rails are just as mixed — one bank-details form per session.
    await rejects(
      { ...sessionInput(RAILS[1]!), paymentMethodTypes: ["ach", "pad"] },
      /session of its own/,
    );
  });
});

describe("Paysafe bank-debit envelope guards", () => {
  const fixture = RAILS[0]!;

  const rejectsCompletion = async (
    clientToken: string,
    expected: RegExp,
    railFixture: RailFixture = fixture,
  ): Promise<void> => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession(sessionInput(railFixture));
    await expect(
      adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken, idempotencyKey: "k-bad" }),
    ).rejects.toThrow(expected);
    // A rejected envelope must never have reached Paysafe.
    expect(fake.uniqueHandleCreations).toBe(0);
  };

  it("rejects a Paysafe.js card token arriving on a bank session", async () => {
    await rejectsCompletion("SChplA0KVDVsF2Cx", /envelope produced by confirm/);
  });

  it("rejects an empty clientToken (the redirect return-trip placeholder shape)", async () => {
    await rejectsCompletion("", /envelope produced by confirm/);
  });

  it("rejects an envelope that is not base64url JSON", async () => {
    await rejectsCompletion("paysafe-bank.not%json", /not base64url-encoded JSON/);
  });

  it("rejects an unsupported envelope version", async () => {
    await rejectsCompletion(
      envelope({ ...fixture.details, v: 2 }),
      /unsupported shape — expected version 1/,
    );
    await rejectsCompletion(envelope(["not-an-object"] as unknown as Record<string, unknown>), /unsupported shape/);
  });

  it("rejects an envelope whose rail does not match the session's", async () => {
    await rejectsCompletion(
      envelope({ v: 1, paymentType: "ACH", accountHolderName: "Pat Doe", routingNumber: "123456789", accountNumber: "1234567890" }),
      /carries "ACH" details but this session was created for SEPA/,
    );
  });

  it("rejects missing per-rail fields, naming the field and never the account number", async () => {
    const cases: Array<[RailFixture, string]> = [
      [RAILS[0]!, "iban"],
      [RAILS[1]!, "routingNumber"],
      [RAILS[2]!, "sortCode"],
      [RAILS[3]!, "transitNumber"],
    ];
    for (const [railFixture, field] of cases) {
      const { adapter } = makePair();
      const session = await adapter.createPaymentSession(sessionInput(railFixture));
      const details = { ...railFixture.details };
      delete details[field];
      try {
        await adapter.completePayment({
          pspSessionId: session.pspSessionId,
          clientToken: envelope(details),
          idempotencyKey: "k-missing",
        });
        expect.unreachable();
      } catch (err) {
        expect(isPayFanoutError(err)).toBe(true);
        if (isPayFanoutError(err)) {
          expect(err.code).toBe("invalid_request");
          expect(err.message).toContain(field);
          // Bank coordinates never leak into error text or raw.
          const accountNumber = railFixture.details["accountNumber"] as string | undefined;
          if (accountNumber) {
            expect(err.message).not.toContain(accountNumber);
            expect(JSON.stringify(err.raw)).not.toContain(accountNumber);
          }
        }
      }
    }
  });

  it("treats blank required values as missing", async () => {
    await rejectsCompletion(envelope({ ...fixture.details, iban: "   " }), /missing required SEPA field/);
  });

  it("requires the customer's mandate agreement on SEPA and BACS", async () => {
    const sepa = { ...fixture.details };
    delete sepa["mandateConsent"];
    await rejectsCompletion(envelope(sepa), /mandateConsent: true/);
    await rejectsCompletion(
      envelope({ ...RAILS[2]!.details, mandateConsent: false }),
      /mandate scheme/,
      RAILS[2]!,
    );
  });

  it("does not demand a mandate on ACH/EFT — the pages state none", async () => {
    // The fixtures already omit mandateConsent; reaching Paysafe proves it.
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession(sessionInput(RAILS[1]!));
    await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: envelope(RAILS[1]!.details),
      idempotencyKey: "k-ach-no-consent",
    });
    expect(fake.uniquePaymentCreations).toBe(1);
  });
});
