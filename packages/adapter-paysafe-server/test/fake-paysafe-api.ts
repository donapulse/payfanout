import type {
  PaysafeBankAccountLike,
  PaysafePaymentLike,
  PaysafePlanLike,
  PaysafeStoredHandleLike,
  PaysafeSubscriptionLike,
} from "../src/index.js";

/**
 * A MULTI_USE token the fake pre-vaults at construction, for fixtures
 * (conformance createInput) that cannot run a customer/save round-trip of
 * their own first. The scheduler accepts MULTI_USE tokens only.
 */
export const SEEDED_MULTI_USE_TOKEN = "MUseededfixturetok";

/**
 * In-memory Paysafe Payments API. Dedupes on merchantRefNum exactly like the
 * real API, so the conformance idempotency test proves the adapter forwards
 * idempotency keys as merchantRefNum.
 */
export class FakePaysafeApi {
  private readonly payments = new Map<string, PaysafePaymentLike>();
  private readonly byRefNum = new Map<string, PaysafePaymentLike>();
  private readonly settlementRefs = new Map<string, object>();
  private readonly refundRefs = new Map<string, object>();
  private readonly refundsById = new Map<string, Record<string, unknown>>();
  /** Customer Vault state: customers + MULTI_USE handles. */
  private readonly customers = new Map<string, { id: string; merchantCustomerId?: string; handles: PaysafeStoredHandleLike[] }>();
  private readonly multiUseTokens = new Set<string>();
  private readonly storedHandleRefs = new Map<string, PaysafeStoredHandleLike>();
  /** Redirect/bank-rail handles, keyed by token, so createPayment can echo their paymentType and bank object. */
  private readonly railHandles = new Map<
    string,
    { paymentType: string; sepa?: PaysafeBankAccountLike; bacs?: PaysafeBankAccountLike }
  >();
  private readonly handleRefs = new Map<string, Record<string, unknown>>();
  /** Payment Scheduler state (subscriptionsplans/v1): plans + subscriptions, deduped on merchantRefNum. */
  private readonly plans = new Map<string, PaysafePlanLike>();
  private readonly subscriptions = new Map<string, PaysafeSubscriptionLike>();
  private readonly subscriptionRefs = new Map<string, PaysafeSubscriptionLike>();
  private seq = 0;
  uniqueHandleCreations = 0;
  uniquePaymentCreations = 0;
  uniqueRefundCreations = 0;
  uniqueCustomerCreations = 0;
  uniquePlanCreations = 0;
  uniqueSubscriptionCreations = 0;
  lastRequestBody: Record<string, unknown> | undefined;
  /** Bank completion makes TWO calls; lastRequestBody ends on the payment, this keeps the handle. */
  lastHandleRequestBody: Record<string, unknown> | undefined;
  /** Subscription creation makes plan + subscription calls; this keeps the plan body. */
  lastPlanRequestBody: Record<string, unknown> | undefined;
  /** Test levers for the verifyCredentials probe (bad key / transient outage). */
  authFailure = false;
  networkFailure = false;

  constructor() {
    this.multiUseTokens.add(SEEDED_MULTI_USE_TOKEN);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    if (this.networkFailure) throw new TypeError("simulated network failure");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const parsed = new URL(url);
    const path = parsed.pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    this.lastRequestBody = body;

    if (this.authFailure || !(init?.headers as Record<string, string>)?.["authorization"]?.startsWith("Basic ")) {
      return json(401, { error: { code: "5279", message: "Invalid credentials" } });
    }

    if (method === "POST" && path === "/paymenthub/v1/payments") return this.createPayment(body!);
    if (method === "POST" && path === "/paymenthub/v1/paymenthandles") return this.createPaymentHandle(body!);
    if (method === "POST" && path === "/paymenthub/v1/customers") {
      const merchantCustomerId = body!["merchantCustomerId"] as string;
      // Real API 409s with 7505 on duplicate merchantCustomerId.
      const existing = [...this.customers.values()].find((c) => c.merchantCustomerId === merchantCustomerId);
      if (existing) {
        return json(409, {
          error: {
            code: "7505",
            message: `The merchantCustomerId provided for this profile has already been used for another profile - ${existing.id}`,
          },
        });
      }
      const customer = { id: `cust_${++this.seq}`, merchantCustomerId, handles: [] };
      this.customers.set(customer.id, customer);
      this.uniqueCustomerCreations++;
      return json(201, { id: customer.id, merchantCustomerId: customer.merchantCustomerId, status: "ACTIVE" });
    }
    if (method === "GET" && path === "/paymenthub/v1/customers" && parsed.searchParams.get("merchantCustomerId")) {
      const wanted = parsed.searchParams.get("merchantCustomerId");
      const found = [...this.customers.values()].find((c) => c.merchantCustomerId === wanted);
      if (!found) return json(404, { error: { code: "5269", message: "No such customer" } });
      return json(200, { id: found.id, merchantCustomerId: found.merchantCustomerId, status: "ACTIVE" });
    }
    const custHandlesMatch = /^\/paymenthub\/v1\/customers\/([^/?]+)\/paymenthandles$/.exec(path);
    if (method === "POST" && custHandlesMatch) {
      const customer = this.customers.get(decodeURIComponent(custHandlesMatch[1]!));
      if (!customer) return json(404, { error: { code: "5269", message: "No such customer" } });
      const refNum = body!["merchantRefNum"] as string;
      const existing = this.storedHandleRefs.get(refNum);
      if (existing) return json(200, existing);
      if (typeof body!["paymentHandleTokenFrom"] !== "string") {
        return json(400, {
          error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "paymentHandleTokenFrom", error: "required" }] },
        });
      }
      // Real API 7503s when the card is already vaulted;
      // the special token simulates re-saving a card this customer holds.
      if (body!["paymentHandleTokenFrom"] === "tok_single_use_dupcard" && customer.handles[0]) {
        return json(409, {
          error: {
            code: "7503",
            message: "Card number already in use - some-owner-id",
            details: [`This card is currently associated with Payment Handle Id: ${customer.handles[0].id}`],
          },
        });
      }
      const handle: PaysafeStoredHandleLike = {
        id: `mhdl_${++this.seq}`,
        paymentHandleToken: `MU${++this.seq}tok`,
        merchantRefNum: refNum,
        status: "PAYABLE",
        usage: "MULTI_USE",
        paymentType: "CARD",
        card: { cardType: "VI", lastDigits: "1111", cardExpiry: { month: 12, year: 2030 } },
      };
      customer.handles.push(handle);
      this.multiUseTokens.add(handle.paymentHandleToken);
      this.storedHandleRefs.set(refNum, handle);
      return json(201, handle);
    }
    const custGetMatch = /^\/paymenthub\/v1\/customers\/([^/?]+)$/.exec(path);
    if (method === "GET" && custGetMatch) {
      const customer = this.customers.get(decodeURIComponent(custGetMatch[1]!));
      if (!customer) return json(404, { error: { code: "5269", message: "No such customer" } });
      const withHandles = parsed.searchParams.get("fields") === "paymenthandles";
      return json(200, {
        id: customer.id,
        merchantCustomerId: customer.merchantCustomerId,
        status: "ACTIVE",
        ...(withHandles ? { paymentHandles: customer.handles } : {}),
      });
    }
    const custHandleDeleteMatch = /^\/paymenthub\/v1\/customers\/([^/?]+)\/paymenthandles\/([^/?]+)$/.exec(path);
    if (method === "DELETE" && custHandleDeleteMatch) {
      const customer = this.customers.get(decodeURIComponent(custHandleDeleteMatch[1]!));
      const handleId = decodeURIComponent(custHandleDeleteMatch[2]!);
      const index = customer?.handles.findIndex((h) => h.id === handleId) ?? -1;
      if (!customer || index === -1) return json(404, { error: { code: "5269", message: "No such payment handle" } });
      this.multiUseTokens.delete(customer.handles[index]!.paymentHandleToken);
      customer.handles.splice(index, 1);
      return new Response("", { status: 200 });
    }
    if (method === "GET" && path === "/paymenthub/v1/settlements") {
      // Real API: settlements are query-only, keyed by merchantRefNum.
      const refNum = parsed.searchParams.get("merchantRefNum");
      if (!refNum) {
        return json(400, {
          error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "merchantRefNum", error: "Value is required." }] },
        });
      }
      const settlement = this.settlementRefs.get(refNum);
      return json(200, {
        meta: { numberOfRecords: settlement ? 1 : 0 },
        settlements: settlement ? [settlement] : [],
      });
    }
    const paymentMatch = /^\/paymenthub\/v1\/payments\/([^/]+)$/.exec(path);
    if (method === "GET" && paymentMatch) return this.getPayment(decodeURIComponent(paymentMatch[1]!));
    const refundGetMatch = /^\/paymenthub\/v1\/refunds\/([^/]+)$/.exec(path);
    if (method === "GET" && refundGetMatch) {
      const refund = this.refundsById.get(decodeURIComponent(refundGetMatch[1]!));
      if (!refund) return json(404, { error: { code: "5269", message: "No such refund" } });
      return json(200, refund);
    }
    const settleMatch = /^\/paymenthub\/v1\/payments\/([^/]+)\/settlements$/.exec(path);
    if (method === "POST" && settleMatch) return this.settle(decodeURIComponent(settleMatch[1]!), body!);
    const voidMatch = /^\/paymenthub\/v1\/payments\/([^/]+)\/voidauths$/.exec(path);
    if (method === "POST" && voidMatch) return this.voidAuth(decodeURIComponent(voidMatch[1]!), body!);
    const refundMatch = /^\/paymenthub\/v1\/settlements\/([^/]+)\/refunds$/.exec(path);
    if (method === "POST" && refundMatch) return this.refund(decodeURIComponent(refundMatch[1]!), body!);
    if (method === "POST" && path === "/paymenthub/v1/verifications") {
      if (body!["paymentHandleToken"] === "tok_declined") {
        return json(402, { error: { code: "3022", message: "Insufficient funds" } });
      }
      return json(200, { id: `ver_${++this.seq}`, status: "COMPLETED", txnTime: "2026-07-04T10:00:00Z" });
    }
    if (method === "POST" && path === "/subscriptionsplans/v1/plans") return this.createPlan(body!);
    const planGetMatch = /^\/subscriptionsplans\/v1\/plans\/([^/?]+)$/.exec(path);
    if (method === "GET" && planGetMatch) {
      const plan = this.plans.get(decodeURIComponent(planGetMatch[1]!));
      if (!plan) return json(404, { error: { code: "5269", message: "No such plan" } });
      return json(200, plan);
    }
    const subCreateMatch = /^\/subscriptionsplans\/v1\/plans\/([^/?]+)\/subscriptions$/.exec(path);
    if (method === "POST" && subCreateMatch) {
      return this.createSubscription(decodeURIComponent(subCreateMatch[1]!), body!);
    }
    if (method === "GET" && path === "/subscriptionsplans/v1/subscriptions") {
      return this.listSubscriptions(parsed.searchParams);
    }
    const subMatch = /^\/subscriptionsplans\/v1\/subscriptions\/([^/?]+)$/.exec(path);
    if (method === "GET" && subMatch) {
      const sub = this.subscriptions.get(decodeURIComponent(subMatch[1]!));
      if (!sub) return json(404, { error: { code: "5269", message: "No such subscription" } });
      return json(200, publicSubscription(sub, parsed.searchParams.get("fields")));
    }
    if (method === "PATCH" && subMatch) {
      return this.patchSubscription(decodeURIComponent(subMatch[1]!), body!);
    }
    return json(404, { error: { code: "5269", message: `No route ${method} ${path}` } });
  };

  /**
   * POST /paymenthandles for redirect and bank-debit rails. Redirect (Interac)
   * mirrors the documented response: INITIATED + action REDIRECT + the
   * redirect_payment link. Bank rails come back immediately PAYABLE.
   */
  private createPaymentHandle(body: Record<string, unknown>): Response {
    this.lastHandleRequestBody = body;
    const refNum = body["merchantRefNum"] as string;
    const existing = this.handleRefs.get(refNum);
    if (existing) return json(200, existing);
    const paymentType = body["paymentType"] as string;
    if (["SEPA", "ACH", "BACS", "EFT"].includes(paymentType)) {
      return this.createBankHandle(refNum, paymentType, body);
    }
    const interac = body["interacEtransfer"] as { consumerId?: string } | undefined;
    if (paymentType === "INTERAC_ETRANSFER" && !interac?.consumerId) {
      return json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "interacEtransfer.consumerId", error: "Either invalid or no value provided" }] },
      });
    }
    if (!Array.isArray(body["returnLinks"])) {
      return json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "returnLinks", error: "Either invalid or no value provided" }] },
      });
    }
    const id = `ph_${++this.seq}`;
    const handle = {
      id,
      paymentHandleToken: `PH${this.seq}Token`,
      merchantRefNum: refNum,
      paymentType,
      currencyCode: body["currencyCode"] as string,
      amount: body["amount"] as number,
      status: "INITIATED",
      action: "REDIRECT",
      txnTime: "2026-07-04T10:00:00Z",
      links: [{ rel: "redirect_payment", href: `https://api.test.paysafe.com/alternatepayments/v1/redirect?paymentHandleId=${id}` }],
    };
    this.handleRefs.set(refNum, handle);
    this.railHandles.set(handle.paymentHandleToken, { paymentType });
    this.uniqueHandleCreations++;
    return json(201, handle);
  }

  /**
   * Bank-debit handles: immediately PAYABLE (doc: ACH/EFT handles "should
   * immediately have the status of PAYABLE"), no redirect and no returnLinks.
   * SEPA/BACS echo their bank object with the scheme mandate reference, like
   * the real payloads do; the object is required, as the rail cannot debit an
   * account it was never told about.
   */
  private createBankHandle(refNum: string, paymentType: string, body: Record<string, unknown>): Response {
    const railKey = paymentType.toLowerCase();
    const bank = body[railKey] as Record<string, string> | undefined;
    if (!bank || typeof bank !== "object") {
      return json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: railKey, error: "Either invalid or no value provided" }] },
      });
    }
    const id = `ph_${++this.seq}`;
    const account = bank["iban"] ?? bank["accountNumber"] ?? "";
    const echo: PaysafeBankAccountLike | undefined =
      paymentType === "SEPA" || paymentType === "BACS"
        ? {
            accountHolderName: bank["accountHolderName"],
            lastDigits: account.slice(-4),
            mandateReference: `MND${this.seq}REF`,
          }
        : undefined;
    const handle = {
      id,
      paymentHandleToken: `PH${this.seq}Token`,
      merchantRefNum: refNum,
      paymentType,
      currencyCode: body["currencyCode"] as string,
      amount: body["amount"] as number,
      status: "PAYABLE",
      usage: "SINGLE_USE",
      txnTime: "2026-07-04T10:00:00Z",
      ...(echo ? { [railKey]: echo } : {}),
    };
    this.handleRefs.set(refNum, handle);
    this.railHandles.set(handle.paymentHandleToken, {
      paymentType,
      ...(echo && paymentType === "SEPA" ? { sepa: echo } : {}),
      ...(echo && paymentType === "BACS" ? { bacs: echo } : {}),
    });
    this.uniqueHandleCreations++;
    return json(201, handle);
  }

  private createPayment(body: Record<string, unknown>): Response {
    // Real API strict-parses the body: webhook/returnLinks/shippingDetails are
    // handle-level fields and get rejected here (error 5023).
    for (const field of ["webhook", "returnLinks", "shippingDetails"]) {
      if (field in body) {
        return json(400, {
          error: { code: "5023", message: "Request body not parsable", details: [`field '${field}' not recognized`] },
        });
      }
    }
    const refNum = body["merchantRefNum"] as string;
    if (this.byRefNum.has(refNum)) return json(200, this.publicPayment(this.byRefNum.get(refNum)!));
    const token = body["paymentHandleToken"] as string;
    if (token === "tok_declined") {
      return json(402, { error: { code: "3022", message: "Insufficient funds" } });
    }
    if (!token) return json(400, { error: { code: "5068", message: "Missing paymentHandleToken" } });
    // Deleted/unknown MULTI_USE tokens die exactly like the real API (5068).
    if (token.startsWith("MU") && !this.multiUseTokens.has(token)) {
      return json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "paymentHandleToken", error: "Either invalid or no value provided" }] },
      });
    }
    const settleWithAuth = body["settleWithAuth"] as boolean;
    const amount = body["amount"] as number;
    const payment: PaysafePaymentLike = {
      id: `pay_${++this.seq}`,
      merchantRefNum: refNum,
      status: "COMPLETED",
      amount,
      availableToSettle: settleWithAuth ? 0 : amount,
      currencyCode: body["currencyCode"] as string,
      settleWithAuth,
      txnTime: "2026-07-04T10:00:00Z",
      paymentType: "CARD",
      // Real API echoes masked instrument facts on the payment object (cardType, not type).
      card: { cardType: "VI", lastDigits: "1111", cardExpiry: { month: 12, year: 2030 } },
      settlements: [],
    };
    const railHandle = this.railHandles.get(token);
    if (railHandle) {
      // Bank rails do not authorize on the spot: the real API answers PROCESSING
      // and the outcome lands later by webhook. The settlement exists immediately,
      // in flight, sharing the payment's refNum — and reports availableToRefund: 0,
      // which means "not refundable yet", NOT "already refunded". SEPA/BACS
      // payments echo their bank object (webhook payloads show it there).
      payment.paymentType = railHandle.paymentType;
      payment.status = "PROCESSING";
      payment.availableToSettle = 0;
      delete payment.card;
      if (railHandle.sepa) payment.sepa = railHandle.sepa;
      if (railHandle.bacs) payment.bacs = railHandle.bacs;
      const settlement = {
        id: `stl_${++this.seq}`,
        merchantRefNum: refNum,
        status: "PROCESSING",
        amount,
        availableToRefund: 0,
        txnTime: "2026-07-04T10:00:01Z",
      };
      payment.settlements = [settlement];
      this.settlementRefs.set(refNum, settlement);
    }
    if (settleWithAuth && !railHandle) {
      // Real API: auto-capture creates an implicit settlement sharing the
      // payment's merchantRefNum, discoverable only via the settlements query.
      // Nothing settles while a bank rail is still PROCESSING.
      const settlement = {
        id: `stl_${++this.seq}`,
        merchantRefNum: refNum,
        status: "PENDING",
        amount,
        availableToRefund: amount,
        refundedAmount: 0,
        txnTime: "2026-07-04T10:00:01Z",
      };
      payment.settlements = [settlement];
      this.settlementRefs.set(refNum, settlement);
    }
    this.payments.set(payment.id, payment);
    this.byRefNum.set(refNum, payment);
    this.uniquePaymentCreations++;
    return json(200, this.publicPayment(payment));
  }

  /** Real API responses never embed settlements — they must be queried. */
  private publicPayment(payment: PaysafePaymentLike): PaysafePaymentLike {
    return { ...payment, settlements: undefined };
  }

  private getPayment(id: string): Response {
    const payment = this.payments.get(id);
    if (!payment) return json(404, { error: { code: "5269", message: `No such payment ${id}` } });
    return json(200, this.publicPayment(payment));
  }

  private settle(id: string, body: Record<string, unknown>): Response {
    const payment = this.payments.get(id);
    if (!payment) return json(404, { error: { code: "5269", message: "No such payment" } });
    const refNum = body["merchantRefNum"] as string;
    if (this.settlementRefs.has(refNum)) return json(200, this.settlementRefs.get(refNum)!);
    // Real Paysafe rejects settlements without an explicit amount.
    if (typeof body["amount"] !== "number") {
      return json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "amount", error: "must not be null" }] },
      });
    }
    const settleAmount = body["amount"] as number;
    // Real API allows MULTIPLE partial settlements while availableToSettle covers them.
    const remaining = payment.availableToSettle ?? payment.amount ?? 0;
    if (payment.status !== "COMPLETED" || payment.settleWithAuth || settleAmount > remaining) {
      return json(400, { error: { code: "5050", message: "Payment is not in a settleable state" } });
    }
    const settlement = {
      id: `stl_${++this.seq}`,
      merchantRefNum: refNum,
      status: "PENDING",
      amount: settleAmount,
      availableToRefund: settleAmount,
      refundedAmount: 0,
      txnTime: "2026-07-04T10:05:00Z",
    };
    payment.settlements = [...(payment.settlements ?? []), settlement];
    payment.availableToSettle = remaining - settleAmount;
    this.settlementRefs.set(refNum, settlement);
    return json(200, settlement);
  }

  private voidAuth(id: string, body: Record<string, unknown>): Response {
    const payment = this.payments.get(id);
    if (!payment) return json(404, { error: { code: "5269", message: "No such payment" } });
    // Real Paysafe rejects voidauths without an explicit amount.
    if (typeof body["amount"] !== "number") {
      return json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "amount", error: "must not be null" }] },
      });
    }
    const remaining = payment.availableToSettle ?? 0;
    if (payment.settleWithAuth || remaining <= 0 || (body["amount"] as number) > remaining) {
      return json(400, { error: { code: "5050", message: "Nothing voidable on this payment" } });
    }
    // Voiding the remainder AFTER a partial
    // settlement works — settled funds stay settled, payment stays COMPLETED.
    // Only a payment with no settlements at all flips to CANCELLED.
    payment.availableToSettle = remaining - (body["amount"] as number);
    if ((payment.settlements ?? []).length === 0) payment.status = "CANCELLED";
    return json(200, { id: `void_${++this.seq}`, status: "COMPLETED", amount: body["amount"] });
  }

  private refund(settlementId: string, body: Record<string, unknown>): Response {
    const refNum = body["merchantRefNum"] as string;
    if (this.refundRefs.has(refNum)) return json(200, this.refundRefs.get(refNum)!);
    for (const payment of this.payments.values()) {
      const settlement = (payment.settlements ?? []).find((s) => s.id === settlementId);
      if (settlement) {
        const amount = (body["amount"] as number | undefined) ?? (settlement.amount ?? 0) - (settlement.refundedAmount ?? 0);
        if ((settlement.refundedAmount ?? 0) + amount > (settlement.amount ?? 0)) {
          return json(400, { error: { code: "3407", message: "Refund exceeds settled amount" } });
        }
        settlement.refundedAmount = (settlement.refundedAmount ?? 0) + amount;
        settlement.availableToRefund = (settlement.amount ?? 0) - settlement.refundedAmount;
        const refund = {
          id: `ref_${++this.seq}`,
          merchantRefNum: refNum,
          status: "COMPLETED",
          amount,
          txnTime: "2026-07-04T10:10:00Z",
        };
        this.refundRefs.set(refNum, refund);
        this.refundsById.set(refund.id, refund);
        this.uniqueRefundCreations++;
        return json(200, refund);
      }
    }
    return json(404, { error: { code: "5269", message: "No such settlement" } });
  }

  /**
   * POST /subscriptionsplans/v1/plans. Amounts are minor units; the frequency
   * enum is DAILY/MONTHLY/YEARLY (no WEEKLY) and numberOfCycles is required
   * (0 = infinite) — exactly the documented plan schema, so a cadence the
   * scheduler cannot express dies here like it would at Paysafe.
   */
  private createPlan(body: Record<string, unknown>): Response {
    this.lastPlanRequestBody = body;
    const name = body["name"];
    const amount = body["amount"];
    const cycle = body["billingCycle"] as
      | { frequency?: unknown; interval?: unknown; numberOfCycles?: unknown }
      | undefined;
    const invalid = (field: string): Response =>
      json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field, error: "Either invalid or no value provided" }] },
      });
    if (typeof name !== "string" || name.length < 4 || name.length > 50) return invalid("name");
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1) return invalid("amount");
    if (typeof body["currencyCode"] !== "string") return invalid("currencyCode");
    if (!cycle || !["DAILY", "MONTHLY", "YEARLY"].includes(cycle.frequency as string)) {
      return invalid("billingCycle.frequency");
    }
    if (typeof cycle.interval !== "number" || cycle.interval < 1 || cycle.interval > 365) {
      return invalid("billingCycle.interval");
    }
    if (typeof cycle.numberOfCycles !== "number" || cycle.numberOfCycles < 0 || cycle.numberOfCycles > 99) {
      return invalid("billingCycle.numberOfCycles");
    }
    const plan: PaysafePlanLike = {
      id: `plan_${++this.seq}`,
      name,
      amount,
      currencyCode: body["currencyCode"] as string,
      billingCycle: {
        frequency: cycle.frequency as string,
        interval: cycle.interval,
        numberOfCycles: cycle.numberOfCycles,
      },
      // Plans default INITIAL; only ACTIVE plans accept subscriptions.
      status: (body["status"] as string | undefined) ?? "INITIAL",
    };
    this.plans.set(plan.id!, plan);
    this.uniquePlanCreations++;
    return json(201, plan);
  }

  /**
   * POST /subscriptionsplans/v1/plans/{planId}/subscriptions. Requires a
   * MULTI_USE token (the scheduler rejects single-use ones) and dedupes on
   * merchantRefNum — "unique for this accountId" — like the payments endpoint.
   * The create response carries the full sub-components, as documented.
   */
  private createSubscription(planId: string, body: Record<string, unknown>): Response {
    const plan = this.plans.get(planId);
    if (!plan) return json(404, { error: { code: "5269", message: "No such plan" } });
    if (plan.status !== "ACTIVE") {
      return json(400, { error: { code: "5050", message: "Subscriptions attach to ACTIVE plans only" } });
    }
    const refNum = body["merchantRefNum"];
    if (typeof refNum !== "string" || refNum === "") {
      return json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "merchantRefNum", error: "Value is required." }] },
      });
    }
    const existing = this.subscriptionRefs.get(refNum);
    if (existing) return json(200, existing);
    const token = body["paymentHandleToken"];
    if (typeof token !== "string" || !this.multiUseTokens.has(token)) {
      return json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "paymentHandleToken", error: "Either invalid or no value provided" }] },
      });
    }
    const sub: PaysafeSubscriptionLike = {
      id: `sub_${++this.seq}`,
      merchantRefNum: refNum,
      ...(typeof body["accountId"] === "string" ? { accountId: body["accountId"] } : {}),
      paymentHandleToken: token,
      status: "ACTIVE",
      ...(typeof body["startTime"] === "string" ? { startTime: body["startTime"] } : {}),
      creationTime: "2026-07-04T10:00:00Z",
      paymentType: "CARD",
      plan: { ...plan },
      customerProfile: {
        id: `cp_${this.seq}`,
        firstName: "Sub",
        lastName: "Scriber",
        email: "subscriber@example.test",
      },
      paymentsInformation: {
        nextPayment: { id: `np_${this.seq}`, amount: plan.amount, scheduledTime: "2026-08-04T10:00:00Z" },
        previousPayment: { id: `pp_${this.seq}`, amount: plan.amount, scheduledTime: "2026-07-04T10:00:00Z" },
      },
    };
    this.subscriptions.set(sub.id, sub);
    this.subscriptionRefs.set(refNum, sub);
    this.uniqueSubscriptionCreations++;
    return json(201, sub);
  }

  /**
   * GET /subscriptionsplans/v1/subscriptions: offset paging with the
   * documented meta envelope (limit default 10, max 50), a merchantRefNum
   * filter, and STRICT sub-component semantics — plan/customerProfile/
   * paymentsInformation only appear when `fields` asks for them, the
   * dangerous reading of the spec's ambiguity, so an adapter that forgets
   * `fields` loses amount/currency here like it could at Paysafe.
   */
  private listSubscriptions(params: URLSearchParams): Response {
    const refNum = params.get("merchantRefNum");
    const all = [...this.subscriptions.values()].filter((s) => !refNum || s.merchantRefNum === refNum);
    const limit = Math.min(Number(params.get("limit") ?? 10), 50);
    const offset = Number(params.get("offset") ?? 0);
    const fields = params.get("fields");
    return json(200, {
      subscriptions: all.slice(offset, offset + limit).map((s) => publicSubscription(s, fields)),
      meta: { numberOfRecords: all.length, limit, page: Math.floor(offset / Math.max(limit, 1)) + 1 },
    });
  }

  /**
   * PATCH /subscriptionsplans/v1/subscriptions/{id}. CANCELLED is absorbing:
   * the real API documents it as final, and this fake REJECTS a repeat PATCH
   * (the undocumented case) so the adapter's re-fetch recovery is what the
   * suite actually exercises. Cancelling clears the next scheduled payment.
   */
  private patchSubscription(id: string, body: Record<string, unknown>): Response {
    const sub = this.subscriptions.get(id);
    if (!sub) return json(404, { error: { code: "5269", message: "No such subscription" } });
    const status = body["status"];
    if (status === "CANCELLED") {
      if (sub.status === "CANCELLED" || sub.status === "COMPLETED") {
        return json(400, { error: { code: "5050", message: `Subscription is already ${sub.status}` } });
      }
      sub.status = "CANCELLED";
      if (sub.paymentsInformation) delete sub.paymentsInformation.nextPayment;
      // PATCH takes no `fields` — the response carries no sub-components
      // (strict reading), so the adapter must re-read for money facts.
      return json(200, publicSubscription(sub, null));
    }
    if (status === "SUSPENDED" || status === "ACTIVE") {
      if (sub.status === "CANCELLED" || sub.status === "COMPLETED") {
        return json(400, { error: { code: "5050", message: `Subscription is already ${sub.status}` } });
      }
      sub.status = status;
      return json(200, publicSubscription(sub, null));
    }
    return json(400, {
      error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "status", error: "Either invalid or no value provided" }] },
    });
  }

  /** Test helper: a subscription planted in an arbitrary status (COMPLETED, exotic wire values). */
  seedSubscription(status: string): PaysafeSubscriptionLike {
    const plan: PaysafePlanLike = {
      id: `plan_${++this.seq}`,
      name: "seeded plan",
      amount: 990,
      currencyCode: "USD",
      billingCycle: { frequency: "MONTHLY", interval: 1, numberOfCycles: 0 },
      status: "ACTIVE",
    };
    this.plans.set(plan.id!, plan);
    const sub: PaysafeSubscriptionLike = {
      id: `sub_${++this.seq}`,
      merchantRefNum: `seed-${this.seq}`,
      paymentHandleToken: SEEDED_MULTI_USE_TOKEN,
      status,
      creationTime: "2026-07-04T10:00:00Z",
      paymentType: "CARD",
      plan,
      customerProfile: { id: `cp_${this.seq}` },
      paymentsInformation: {
        previousPayment: { id: `pp_${this.seq}`, amount: plan.amount, scheduledTime: "2026-07-04T10:00:00Z" },
      },
    };
    this.subscriptions.set(sub.id, sub);
    this.subscriptionRefs.set(sub.merchantRefNum!, sub);
    return sub;
  }

  /** Test helper: a refund sitting in an arbitrary status (e.g. PENDING before the batch runs). */
  seedRefund(refund: { id?: string; status: string; amount?: number }): { id: string; status: string; amount: number; txnTime: string } {
    const stored = {
      id: refund.id ?? `ref_${++this.seq}`,
      status: refund.status,
      amount: refund.amount ?? 1000,
      txnTime: "2026-07-04T10:10:00Z",
    };
    this.refundsById.set(stored.id, stored);
    return stored;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Sub-components (plan/customerProfile/paymentsInformation) are served ONLY
 * when the `fields` query asks for them — the strict reading of the spec's
 * "comma-separated list of sub-components" parameter.
 */
function publicSubscription(sub: PaysafeSubscriptionLike, fields: string | null): PaysafeSubscriptionLike {
  const requested = new Set((fields ?? "").split(",").map((f) => f.trim()));
  const copy: PaysafeSubscriptionLike = { ...sub };
  if (!requested.has("plan")) delete copy.plan;
  if (!requested.has("customerProfile")) delete copy.customerProfile;
  if (!requested.has("paymentsInformation")) delete copy.paymentsInformation;
  return copy;
}
