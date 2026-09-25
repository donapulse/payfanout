import type {
  PaysafeBankAccountLike,
  PaysafePaymentLike,
  PaysafePlanLike,
  PaysafeStoredHandleLike,
  PaysafeSubscriptionLike,
} from "../src/index.js";

type PaysafeSettlementLike = NonNullable<PaysafePaymentLike["settlements"]>[number];

/**
 * A MULTI_USE token the fake pre-vaults at construction, for fixtures
 * (conformance createInput) that cannot run a customer/save round-trip of
 * their own first. The scheduler accepts MULTI_USE tokens only.
 */
export const SEEDED_MULTI_USE_TOKEN = "MUseededfixturetok";

/** Which requests a test lever applies to. */
export interface RequestMatcher {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** The exact pathname, or a pattern tested against it. */
  path: string | RegExp;
}

/**
 * How a processed request's answer goes missing: the connection drops
 * ("network"), no answer ever comes ("hang", until the caller aborts), or a
 * 5xx replaces it.
 */
export type LostAnswer = "network" | "hang" | 500 | 502 | 503 | 504;

/** A refusal before any processing: rate limited, or a 5xx that never reached the transaction. */
export type RefusalStatus = 429 | 500 | 502 | 503 | 504;

/**
 * Paysafe's other "already seen" answers (402): 3044 "You have submitted a
 * duplicate request." and 3417 "There is already another request being
 * processed on the transaction referenced for this request."
 */
export type ReplayRejectionCode = "3044" | "3417";

const REPLAY_REJECTION_MESSAGES: Record<ReplayRejectionCode, string> = {
  "3044": "You have submitted a duplicate request.",
  "3417": "There is already another request being processed on the transaction referenced for this request.",
};

/**
 * A write Paysafe processes into a record filed with this error, answered
 * with `status`. The record's own status is FAILED unless `recordStatus`
 * says otherwise (verifications also document ERROR, a failure "for
 * non-business reason").
 */
export interface RecordedFailure {
  status: number;
  code: string;
  message: string;
  recordStatus?: "FAILED" | "ERROR";
}

export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  body: Record<string, unknown> | undefined;
}

type RefNumIndex<T> = Map<string, T[]>;

/**
 * In-memory Paysafe Payments API, modelled on what Paysafe documents rather
 * than on what an adapter would find convenient:
 * - with `dupCheck: true`, a merchantRefNum already used on that endpoint
 *   answers 409/5031 ("The transaction you have submitted has already been
 *   processed.") and the original is never replayed. Settlements, refunds
 *   and verifications default dupCheck to true; /payments and
 *   /paymenthandles document no default (both accept the field, as Paysafe's
 *   own examples send it true and false), and /voidauths takes none at all;
 * - a payments call spends a single-use handle whatever its outcome ("the
 *   payment handle status always changes to COMPLETED"), so a second call
 *   with it answers 400/5283. Verifications do not spend one;
 * - a declined payment or verification is recorded, with its error, like any
 *   other, and payment and verification records carry their
 *   paymentHandleToken;
 * - capture, refund and void state checks answer the documented 402 codes
 *   (3203/3204, 3402/3404, 3501/3502), and a refund of an unknown
 *   settlement 400/3407;
 * - the GET ?merchantRefNum= lookups answer the documented collections.
 * Where Paysafe documents nothing — a reused merchantRefNum without dupCheck
 * on /payments, /paymenthandles or /voidauths — the fake takes the dangerous
 * reading and processes the request again, so no test can pass on an
 * adapter that relies on a replay being absorbed.
 */
export class FakePaysafeApi {
  private readonly payments = new Map<string, PaysafePaymentLike>();
  private readonly paymentsByRef: RefNumIndex<PaysafePaymentLike> = new Map();
  private readonly settlementsByRef: RefNumIndex<PaysafeSettlementLike> = new Map();
  private readonly refundsByRef: RefNumIndex<Record<string, unknown>> = new Map();
  private readonly refundsById = new Map<string, Record<string, unknown>>();
  private readonly verificationsByRef: RefNumIndex<Record<string, unknown>> = new Map();
  private readonly voidsByRef: RefNumIndex<Record<string, unknown>> = new Map();
  /** Customer Vault state: customers + MULTI_USE handles. */
  private readonly customers = new Map<string, { id: string; merchantCustomerId?: string; handles: PaysafeStoredHandleLike[] }>();
  private readonly multiUseTokens = new Set<string>();
  /** Single-use tokens a conversion already vaulted — converting one again is the same card again. */
  private readonly convertedFrom = new Map<string, PaysafeStoredHandleLike>();
  /** Redirect/bank-rail handles, keyed by token, so createPayment can echo their paymentType and bank object. */
  private readonly railHandles = new Map<
    string,
    { paymentType: string; sepa?: PaysafeBankAccountLike; bacs?: PaysafeBankAccountLike }
  >();
  private readonly handlesByRef: RefNumIndex<Record<string, unknown>> = new Map();
  private readonly handlesByToken = new Map<string, Record<string, unknown>>();
  /** Single-use handles a payments call has spent. */
  private readonly spentHandles = new Set<string>();
  /** Payment Scheduler state (subscriptionsplans/v1): plans + subscriptions, deduped on merchantRefNum. */
  private readonly plans = new Map<string, PaysafePlanLike>();
  private readonly subscriptions = new Map<string, PaysafeSubscriptionLike>();
  private readonly subscriptionRefs = new Map<string, PaysafeSubscriptionLike>();
  private readonly lostAnswers: Array<{ matcher: RequestMatcher; outcome: LostAnswer }> = [];
  private readonly refusals: Array<{ matcher: RequestMatcher; status: RefusalStatus; remaining: number }> = [];
  private readonly replayRejections: Array<{ matcher: RequestMatcher; code: ReplayRejectionCode }> = [];
  private readonly recordedFailures: Array<{ matcher: RequestMatcher; failure: RecordedFailure }> = [];
  /** `${collection} ${merchantRefNum}` -> lookups still to answer empty. */
  private readonly lookupLag = new Map<string, number>();
  /** The recordFailure lever that applies to the request being routed. */
  private activeFailure: RecordedFailure | undefined;
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
  /** Every request, in order, for asserting what went over the wire. */
  readonly requests: RecordedRequest[] = [];
  /** Test levers for the verifyCredentials probe (bad key / transient outage). */
  authFailure = false;
  networkFailure = false;
  /**
   * Settlements and refunds: run the state check (remaining authorization,
   * remaining settlement) before the merchantRefNum check, the other
   * undocumented order. Default: 5031 first.
   */
  stateCheckFirst = false;
  /**
   * The answer to a reused merchantRefNum under dupCheck on /payments:
   * Paysafe documents 409/5031, and 402/3044 "You have submitted a duplicate
   * request." among its payment errors.
   */
  duplicateCode: "5031" | "3044" = "5031";
  /**
   * File failed payments the way Paysafe's only decline example shows them:
   * id, merchantRefNum, settleWithAuth and the error, with no
   * paymentHandleToken, status, amount or currency.
   */
  failedPaymentsLikeDeclineExample = false;

  constructor() {
    this.multiUseTokens.add(SEEDED_MULTI_USE_TOKEN);
  }

  /** The next matching request is processed in full, then its answer is lost. */
  loseAnswer(matcher: RequestMatcher, outcome: LostAnswer = "network"): void {
    this.lostAnswers.push({ matcher, outcome });
  }

  /**
   * The next `count` matching requests are refused before any processing:
   * 429 (1200, rate limited) by default, or a 5xx that never reached the
   * transaction.
   */
  refuse(matcher: RequestMatcher, status: RefusalStatus = 429, count = 1): void {
    this.refusals.push({ matcher, status, remaining: count });
  }

  /** The next matching request is answered 402 with this code, unprocessed. */
  rejectAs(matcher: RequestMatcher, code: ReplayRejectionCode): void {
    this.replayRejections.push({ matcher, code });
  }

  /**
   * The next matching payment, settlement, refund or verification is
   * processed into a FAILED record filed with this error (a decline, or an
   * internal error such as 1007), and answered with `failure.status`.
   */
  recordFailure(matcher: RequestMatcher, failure: RecordedFailure): void {
    this.recordedFailures.push({ matcher, failure });
  }

  /**
   * The `collection` lookup (e.g. "payments") answers empty for this
   * merchantRefNum `count` more times: the index trailing the write.
   */
  hideFromLookups(collection: string, merchantRefNum: string, count = Number.POSITIVE_INFINITY): void {
    this.lookupLag.set(`${collection} ${merchantRefNum}`, count);
  }

  /** Requests of one method and exact path — the attempts a call made. */
  requestsTo(method: string, path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.path === path);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    if (this.networkFailure) throw new TypeError("simulated network failure");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const parsed = new URL(url);
    const path = parsed.pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    this.lastRequestBody = body;
    this.requests.push({ method, path, search: parsed.search, body });

    if (this.authFailure || !(init?.headers as Record<string, string>)?.["authorization"]?.startsWith("Basic ")) {
      return json(401, { error: { code: "5279", message: "Invalid credentials" } });
    }
    const refusal = this.refusals.find((r) => matches(r.matcher, method, path));
    if (refusal) {
      refusal.remaining -= 1;
      if (refusal.remaining <= 0) this.refusals.splice(this.refusals.indexOf(refusal), 1);
      if (refusal.status !== 429) {
        return json(refusal.status, { error: { code: "1000", message: "An internal error occurred." } });
      }
      return json(429, {
        error: { code: "1200", message: "The API call has been denied as it has exceeded the permissible call rate limit." },
      });
    }
    const rejectionIndex = this.replayRejections.findIndex((r) => matches(r.matcher, method, path));
    if (rejectionIndex !== -1) {
      const [rejection] = this.replayRejections.splice(rejectionIndex, 1);
      return json(402, { error: { code: rejection!.code, message: REPLAY_REJECTION_MESSAGES[rejection!.code] } });
    }

    const failureIndex = this.recordedFailures.findIndex((f) => matches(f.matcher, method, path));
    this.activeFailure = failureIndex === -1 ? undefined : this.recordedFailures.splice(failureIndex, 1)[0]!.failure;
    const response = this.route(method, path, parsed.searchParams, body);
    this.activeFailure = undefined;

    const lostIndex = this.lostAnswers.findIndex((l) => matches(l.matcher, method, path));
    if (lostIndex === -1) return response;
    const [lost] = this.lostAnswers.splice(lostIndex, 1);
    if (lost!.outcome === "network") throw new TypeError("simulated connection drop after processing");
    if (lost!.outcome === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
      });
    }
    return json(lost!.outcome, { error: { code: "1000", message: "An internal error occurred." } });
  };

  private route(
    method: string,
    path: string,
    params: URLSearchParams,
    body: Record<string, unknown> | undefined,
  ): Response {
    if (method === "POST" && path === "/paymenthub/v1/payments") return this.createPayment(body!);
    if (method === "POST" && path === "/paymenthub/v1/paymenthandles") return this.createPaymentHandle(body!);
    if (method === "GET" && path === "/paymenthub/v1/payments") {
      return this.lookup("payments", this.paymentsByRef, params, (p) => this.publicPayment(p));
    }
    if (method === "GET" && path === "/paymenthub/v1/paymenthandles") {
      return this.lookup("paymentHandles", this.handlesByRef, params);
    }
    // Real API: settlements are query-only, keyed by merchantRefNum.
    if (method === "GET" && path === "/paymenthub/v1/settlements") {
      return this.lookup("settlements", this.settlementsByRef, params);
    }
    if (method === "GET" && path === "/paymenthub/v1/refunds") return this.lookup("refunds", this.refundsByRef, params);
    if (method === "GET" && path === "/paymenthub/v1/verifications") {
      return this.lookup("verifications", this.verificationsByRef, params);
    }
    if (method === "GET" && path === "/paymenthub/v1/voidauths") return this.lookup("voidAuths", this.voidsByRef, params);
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
    if (method === "GET" && path === "/paymenthub/v1/customers" && params.get("merchantCustomerId")) {
      const wanted = params.get("merchantCustomerId");
      const found = [...this.customers.values()].find((c) => c.merchantCustomerId === wanted);
      if (!found) return json(404, { error: { code: "5269", message: "No such customer" } });
      return json(200, { id: found.id, merchantCustomerId: found.merchantCustomerId, status: "ACTIVE" });
    }
    const custHandlesMatch = /^\/paymenthub\/v1\/customers\/([^/?]+)\/paymenthandles$/.exec(path);
    if (method === "POST" && custHandlesMatch) {
      return this.convertToMultiUse(decodeURIComponent(custHandlesMatch[1]!), body!);
    }
    const custGetMatch = /^\/paymenthub\/v1\/customers\/([^/?]+)$/.exec(path);
    if (method === "GET" && custGetMatch) {
      const customer = this.customers.get(decodeURIComponent(custGetMatch[1]!));
      if (!customer) return json(404, { error: { code: "5269", message: "No such customer" } });
      const withHandles = params.get("fields") === "paymenthandles";
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
    if (method === "POST" && path === "/paymenthub/v1/verifications") return this.verify(body!);
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
      return this.listSubscriptions(params);
    }
    const subMatch = /^\/subscriptionsplans\/v1\/subscriptions\/([^/?]+)$/.exec(path);
    if (method === "GET" && subMatch) {
      const sub = this.subscriptions.get(decodeURIComponent(subMatch[1]!));
      if (!sub) return json(404, { error: { code: "5269", message: "No such subscription" } });
      return json(200, publicSubscription(sub, params.get("fields")));
    }
    if (method === "PATCH" && subMatch) {
      return this.patchSubscription(decodeURIComponent(subMatch[1]!), body!);
    }
    return json(404, { error: { code: "5269", message: `No route ${method} ${path}` } });
  }

  /**
   * GET /<collection>?merchantRefNum=: every record filed under the
   * reference, in the documented `{ <collection>: [...], meta }` shape.
   */
  private lookup<T>(
    collection: string,
    index: RefNumIndex<T>,
    params: URLSearchParams,
    view: (record: T) => unknown = (record) => record,
  ): Response {
    const refNum = params.get("merchantRefNum");
    if (!refNum) {
      return json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "merchantRefNum", error: "Value is required." }] },
      });
    }
    const lagKey = `${collection} ${refNum}`;
    const lag = this.lookupLag.get(lagKey) ?? 0;
    if (lag > 0) {
      this.lookupLag.set(lagKey, lag - 1);
      return json(200, { meta: { numberOfRecords: 0 }, [collection]: [] });
    }
    // Paysafe pages every lookup: limit defaults to 10, at most 50, from `offset`.
    const limit = Math.min(Number(params.get("limit") ?? 10), 50);
    const offset = Number(params.get("offset") ?? 0);
    const records = (index.get(refNum) ?? []).map(view).slice(offset, offset + limit);
    return json(200, { meta: { numberOfRecords: records.length }, [collection]: records });
  }

  /**
   * POST /paymenthandles for redirect and bank-debit rails. Redirect (Interac)
   * mirrors the documented response: INITIATED + action REDIRECT + the
   * redirect_payment link. Bank rails come back immediately PAYABLE. The
   * request takes a top-level dupCheck (the EFT schema defines it, and
   * Paysafe's ACH, EFT and wallet examples send it); without `dupCheck: true`
   * a reused merchantRefNum mints again, its default being undocumented.
   */
  private createPaymentHandle(body: Record<string, unknown>): Response {
    this.lastHandleRequestBody = body;
    const refNum = body["merchantRefNum"] as string;
    if (body["dupCheck"] === true && isFiled(this.handlesByRef, refNum)) return duplicateRefNum();
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
      usage: "SINGLE_USE",
      txnTime: "2026-07-04T10:00:00Z",
      links: [{ rel: "redirect_payment", href: `https://api.test.paysafe.com/alternatepayments/v1/redirect?paymentHandleId=${id}` }],
    };
    this.fileHandle(refNum, handle, { paymentType });
    return json(201, handle);
  }

  /**
   * Bank-debit handles: immediately PAYABLE (doc: ACH/EFT handles "should
   * immediately have the status of PAYABLE"), no redirect and no returnLinks.
   * Each echoes its bank object masked: SEPA/BACS with the scheme mandate
   * reference, like the real payloads do, and ACH/EFT with their routing
   * fields and two last digits, as Paysafe's handle examples show. The
   * object is required, as the rail cannot debit an account it was never
   * told about.
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
    const echo: PaysafeBankAccountLike =
      paymentType === "SEPA" || paymentType === "BACS"
        ? {
            accountHolderName: bank["accountHolderName"],
            lastDigits: account.slice(-4),
            mandateReference: `MND${this.seq}REF`,
          }
        : {
            accountHolderName: bank["accountHolderName"],
            lastDigits: account.slice(-2),
            ...(paymentType === "ACH"
              ? { routingNumber: bank["routingNumber"] }
              : { transitNumber: bank["transitNumber"], institutionId: bank["institutionId"] }),
          };
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
    this.fileHandle(refNum, handle, {
      paymentType,
      ...(echo && paymentType === "SEPA" ? { sepa: echo } : {}),
      ...(echo && paymentType === "BACS" ? { bacs: echo } : {}),
    });
    return json(201, handle);
  }

  private fileHandle(
    refNum: string,
    handle: Record<string, unknown> & { paymentHandleToken: string },
    rail: { paymentType: string; sepa?: PaysafeBankAccountLike; bacs?: PaysafeBankAccountLike },
  ): void {
    file(this.handlesByRef, refNum, handle);
    this.handlesByToken.set(handle.paymentHandleToken, handle);
    this.railHandles.set(handle.paymentHandleToken, rail);
    this.uniqueHandleCreations++;
  }

  /** A payments call spends a single-use handle, whatever it answers. */
  private spend(token: string): void {
    if (this.multiUseTokens.has(token)) return;
    this.spentHandles.add(token);
    const handle = this.handlesByToken.get(token);
    if (handle) handle["status"] = "COMPLETED";
  }

  private createPayment(body: Record<string, unknown>): Response {
    // Real API strict-parses the body: webhook/returnLinks/shippingDetails are
    // handle-level fields and get rejected here (error 5023).
    for (const field of ["webhook", "returnLinks", "shippingDetails"]) {
      if (field in body) return unrecognizedField(field);
    }
    const refNum = body["merchantRefNum"] as string;
    const token = body["paymentHandleToken"];
    if (typeof token !== "string" || !token) {
      return json(400, { error: { code: "5068", message: "Missing paymentHandleToken" } });
    }
    // A spent handle is refused first; which check Paysafe runs first is
    // undocumented, and the adapter never sends dupCheck with a single-use one.
    if (this.spentHandles.has(token)) return handleNotPayable();
    if (body["dupCheck"] === true && isFiled(this.paymentsByRef, refNum)) {
      return this.duplicateCode === "3044" ? duplicateRequest() : duplicateRefNum();
    }
    // Deleted/unknown MULTI_USE tokens die exactly like the real API (5068).
    if (token.startsWith("MU") && !this.multiUseTokens.has(token)) {
      return json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "paymentHandleToken", error: "Either invalid or no value provided" }] },
      });
    }
    this.spend(token);
    const settleWithAuth = body["settleWithAuth"] as boolean;
    const amount = body["amount"] as number;
    const currencyCode = body["currencyCode"] as string;
    const failure =
      this.activeFailure ??
      (token === "tok_declined" ? { status: 402, code: "3022", message: "Insufficient funds" } : undefined);
    if (failure) {
      // Paysafe records the failed payment too; it answers the call with the error alone.
      const failed: PaysafePaymentLike = this.failedPaymentsLikeDeclineExample
        ? {
            id: `pay_${++this.seq}`,
            merchantRefNum: refNum,
            settleWithAuth,
            error: { code: failure.code, message: failure.message },
          }
        : {
            id: `pay_${++this.seq}`,
            merchantRefNum: refNum,
            paymentHandleToken: token,
            status: failure.recordStatus ?? "FAILED",
            amount,
            currencyCode,
            settleWithAuth,
            txnTime: "2026-07-04T10:00:00Z",
            paymentType: this.railHandles.get(token)?.paymentType ?? "CARD",
            error: { code: failure.code, message: failure.message },
          };
      this.payments.set(failed.id, failed);
      file(this.paymentsByRef, refNum, failed);
      return json(failure.status, { error: failed.error });
    }
    const payment: PaysafePaymentLike = {
      id: `pay_${++this.seq}`,
      merchantRefNum: refNum,
      paymentHandleToken: token,
      status: "COMPLETED",
      amount,
      availableToSettle: settleWithAuth ? 0 : amount,
      currencyCode,
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
      file(this.settlementsByRef, refNum, settlement);
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
      file(this.settlementsByRef, refNum, settlement);
    }
    this.payments.set(payment.id, payment);
    file(this.paymentsByRef, refNum, payment);
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
    // Settlements default dupCheck to true.
    const reused = body["dupCheck"] !== false && isFiled(this.settlementsByRef, refNum);
    if (reused && !this.stateCheckFirst) return duplicateRefNum();
    // Real Paysafe rejects settlements without an explicit amount.
    if (typeof body["amount"] !== "number") {
      return json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "amount", error: "must not be null" }] },
      });
    }
    const settleAmount = body["amount"] as number;
    // Real API allows MULTIPLE partial settlements while availableToSettle covers them.
    const remaining = payment.availableToSettle ?? payment.amount ?? 0;
    if (payment.status !== "COMPLETED" || payment.settleWithAuth || remaining <= 0) {
      return stateRejection("3203", "The Authorization is either fully settled or cancelled.");
    }
    if (settleAmount > remaining) {
      return stateRejection("3204", "The requested Settlement amount exceeds the remaining Authorization amount.");
    }
    if (reused) return duplicateRefNum();
    if (this.activeFailure) {
      const failed = { id: `stl_${++this.seq}`, merchantRefNum: refNum, ...failedRecord(this.activeFailure), amount: settleAmount };
      file(this.settlementsByRef, refNum, failed);
      return json(this.activeFailure.status, { error: failed.error });
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
    file(this.settlementsByRef, refNum, settlement);
    return json(200, settlement);
  }

  /** Voidauths take no dupCheck: only the remaining authorization stops a repeated void. */
  private voidAuth(id: string, body: Record<string, unknown>): Response {
    if ("dupCheck" in body) return unrecognizedField("dupCheck");
    const payment = this.payments.get(id);
    if (!payment) return json(404, { error: { code: "5269", message: "No such payment" } });
    // Real Paysafe rejects voidauths without an explicit amount.
    if (typeof body["amount"] !== "number") {
      return json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "amount", error: "must not be null" }] },
      });
    }
    const remaining = payment.availableToSettle ?? 0;
    if (payment.settleWithAuth) {
      return stateRejection(
        "3502",
        "You cannot process a void (Authorization Reversal) transaction against an Authorization that has been settled.",
      );
    }
    if (remaining <= 0 || (body["amount"] as number) > remaining) {
      return stateRejection(
        "3501",
        "The requested void (Authorization Reversal) amount exceeds the remaining Authorization amount.",
      );
    }
    // Voiding the remainder AFTER a partial
    // settlement works — settled funds stay settled, payment stays COMPLETED.
    // Only a payment with no settlements at all flips to CANCELLED.
    payment.availableToSettle = remaining - (body["amount"] as number);
    if ((payment.settlements ?? []).length === 0) payment.status = "CANCELLED";
    const voided = {
      id: `void_${++this.seq}`,
      merchantRefNum: body["merchantRefNum"] as string,
      status: "COMPLETED",
      amount: body["amount"] as number,
      txnTime: "2026-07-04T10:06:00Z",
    };
    file(this.voidsByRef, voided.merchantRefNum, voided);
    return json(200, voided);
  }

  private refund(settlementId: string, body: Record<string, unknown>): Response {
    const refNum = body["merchantRefNum"] as string;
    // Refunds default dupCheck to true.
    const reused = body["dupCheck"] !== false && isFiled(this.refundsByRef, refNum);
    if (reused && !this.stateCheckFirst) return duplicateRefNum();
    for (const payment of this.payments.values()) {
      const settlement = (payment.settlements ?? []).find((s) => s.id === settlementId);
      if (settlement) {
        const refunded = settlement.refundedAmount ?? 0;
        if (refunded >= (settlement.amount ?? 0)) {
          return stateRejection("3404", "The Settlement has already been fully refunded.");
        }
        const amount = (body["amount"] as number | undefined) ?? (settlement.amount ?? 0) - refunded;
        if (refunded + amount > (settlement.amount ?? 0)) {
          return stateRejection("3402", "The requested Refund amount exceeds the remaining Settlement amount.");
        }
        if (reused) return duplicateRefNum();
        if (this.activeFailure) {
          const failed = {
            id: `ref_${++this.seq}`,
            merchantRefNum: refNum,
            ...failedRecord(this.activeFailure),
            amount,
            currencyCode: payment.currencyCode,
          };
          file(this.refundsByRef, refNum, failed);
          return json(this.activeFailure.status, { error: failed.error });
        }
        settlement.refundedAmount = refunded + amount;
        settlement.availableToRefund = (settlement.amount ?? 0) - settlement.refundedAmount;
        const refund = {
          id: `ref_${++this.seq}`,
          merchantRefNum: refNum,
          status: "COMPLETED",
          amount,
          currencyCode: payment.currencyCode,
          txnTime: "2026-07-04T10:10:00Z",
        };
        file(this.refundsByRef, refNum, refund);
        this.refundsById.set(refund.id, refund);
        this.uniqueRefundCreations++;
        return json(200, refund);
      }
    }
    return json(400, {
      error: { code: "3407", message: "The Settlement referred to by the transaction response ID you provided cannot be found." },
    });
  }

  /** Verifications default dupCheck to true and do not spend the handle; a declined one is recorded too. */
  private verify(body: Record<string, unknown>): Response {
    const refNum = body["merchantRefNum"] as string;
    if (body["dupCheck"] !== false && isFiled(this.verificationsByRef, refNum)) return duplicateRefNum();
    const token = body["paymentHandleToken"] as string;
    const base = {
      id: `ver_${++this.seq}`,
      merchantRefNum: refNum,
      paymentHandleToken: token,
      currencyCode: body["currencyCode"] as string,
      txnTime: "2026-07-04T10:00:00Z",
    };
    const failure =
      this.activeFailure ??
      (token === "tok_declined" ? { status: 402, code: "3022", message: "Insufficient funds" } : undefined);
    if (failure) {
      const failed = { ...base, ...failedRecord(failure) };
      file(this.verificationsByRef, refNum, failed);
      return json(failure.status, { error: failed.error });
    }
    const verification = { ...base, status: "COMPLETED" };
    file(this.verificationsByRef, refNum, verification);
    return json(200, verification);
  }

  /**
   * POST /customers/{id}/paymenthandles: single-use → MULTI_USE. Vault
   * handles carry the merchantRefNum they were created under. Re-saving a
   * card this customer already holds answers 409/7503 (Customer Vault
   * errors: "The card number you are trying to add to this profile is
   * already used by this profile."), and the error names the existing handle
   * (probe-verified 2026-07-04, see docs/decisions.md). What Paysafe answers
   * when the same single-use token is converted twice is undocumented; the
   * fake reads it as the same card saved again. The special token simulates
   * re-saving a card this customer already holds.
   */
  private convertToMultiUse(customerId: string, body: Record<string, unknown>): Response {
    const customer = this.customers.get(customerId);
    if (!customer) return json(404, { error: { code: "5269", message: "No such customer" } });
    const source = body["paymentHandleTokenFrom"];
    if (typeof source !== "string") {
      return json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "paymentHandleTokenFrom", error: "required" }] },
      });
    }
    const sameCard = source === "tok_single_use_dupcard" ? customer.handles[0] : this.convertedFrom.get(source);
    if (sameCard) {
      return json(409, {
        error: {
          code: "7503",
          message: "Card number already in use - some-owner-id",
          details: [`This card is currently associated with Payment Handle Id: ${sameCard.id}`],
        },
      });
    }
    const handle: PaysafeStoredHandleLike = {
      id: `mhdl_${++this.seq}`,
      paymentHandleToken: `MU${++this.seq}tok`,
      merchantRefNum: body["merchantRefNum"] as string,
      status: "PAYABLE",
      usage: "MULTI_USE",
      paymentType: "CARD",
      card: { cardType: "VI", lastDigits: "1111", cardExpiry: { month: 12, year: 2030 } },
    };
    customer.handles.push(handle);
    this.multiUseTokens.add(handle.paymentHandleToken);
    this.convertedFrom.set(source, handle);
    return json(201, handle);
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

function matches(matcher: RequestMatcher, method: string, path: string): boolean {
  if (matcher.method !== method) return false;
  return typeof matcher.path === "string" ? matcher.path === path : matcher.path.test(path);
}

function file<T>(index: RefNumIndex<T>, refNum: string, record: T): void {
  const filed = index.get(refNum);
  if (filed) filed.push(record);
  else index.set(refNum, [record]);
}

/** dupCheck looks back 90 days; the fake keeps no clock, so every filed reference is recent. */
function isFiled<T>(index: RefNumIndex<T>, refNum: string): boolean {
  return (index.get(refNum)?.length ?? 0) > 0;
}

function duplicateRefNum(): Response {
  return json(409, { error: { code: "5031", message: "The transaction you have submitted has already been processed." } });
}

function duplicateRequest(): Response {
  return json(402, { error: { code: "3044", message: REPLAY_REJECTION_MESSAGES["3044"] } });
}

/** Capture, refund and void state checks: Paysafe answers them 402. */
function stateRejection(code: string, message: string): Response {
  return json(402, { error: { code, message } });
}

/** The fields a write processed into a failure is filed with. */
function failedRecord(failure: RecordedFailure): { status: string; txnTime: string; error: { code: string; message: string } } {
  return {
    status: failure.recordStatus ?? "FAILED",
    txnTime: "2026-07-04T10:00:00Z",
    error: { code: failure.code, message: failure.message },
  };
}

function handleNotPayable(): Response {
  return json(400, {
    error: {
      code: "5283",
      message: "The requested operation can only be executed on a Payment Handle with the status of PAYABLE.",
    },
  });
}

function unrecognizedField(field: string): Response {
  return json(400, {
    error: { code: "5023", message: "Request body not parsable", details: [`field '${field}' not recognized`] },
  });
}
