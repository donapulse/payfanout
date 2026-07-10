import {
  isPayFanoutError,
  PayFanoutError,
  type CompletePaymentInput,
  type PaymentInfo,
  type UnifiedErrorCode,
} from "@payfanout/core";
import type { PaymentService } from "./payment-service.js";

/**
 * Built-in server-completion transport for tokenize-first PSPs (Paysafe,
 * PayPal). `requiresServerCompletion` describes the flow; this turns it into a
 * mountable HTTP route so the host stops rebuilding the same bridge per surface.
 *
 * The wire contract is owned and versioned here: the browser POSTs
 * `{ sessionRef, clientToken, billingDetails? }` and gets back `PaymentInfo`
 * (or a mapped error). Unlike the webhook handler's neutral request/result
 * objects, this speaks web-standard `Request`/`Response` — those are runtime
 * globals in Next.js / Hono / workers / Node 18+, so it mounts as one route
 * with no framework dependency (Express bridges via `new Request(...)`).
 */

/**
 * What the host resolves from the opaque completion reference the browser sent.
 * Because the client already holds the session's `clientSecret` (it mounted
 * `<PaymentFields>` with it), that value is a sufficient reference — no
 * host-minted id needs to travel through session-creation responses and every
 * checkout component. For the tokenize-first adapters the session token IS the
 * `pspSessionId`, so `resolveSession` is often just a lookup for `pspName` plus
 * a stable idempotency key.
 */
export interface ResolvedCompletionSession {
  /** The tenant-scoped service that owns the routed PSP. */
  service: PaymentService;
  /** The PSP the session was created on (what `createPaymentSession`/the router reported). */
  pspName: string;
  /** The session id `completePayment` finalizes. */
  pspSessionId: string;
  /**
   * Idempotency key for this completion (required). Return a STABLE key per
   * session so a retried POST dedupes at the PSP instead of double-charging.
   */
  idempotencyKey: string;
}

/** Passed to `onCompleted` — the reference the client sent and the routed PSP. */
export interface CompletionHandlerContext {
  sessionRef: string;
  pspName: string;
  /** The original request (headers/URL only — its body is already consumed). */
  request: Request;
}

export interface CompletionHandlerOptions {
  /**
   * Maps the opaque reference the client sent (the session token / clientSecret
   * itself) to the tenant-scoped `PaymentService` + session. Read the request's
   * headers/URL here for tenant scoping — the body is already parsed and must
   * not be read again. Throw a `PayFanoutError` to reject (e.g.
   * `invalidRequest` for an unknown reference, `session_expired` for a stale
   * one); it is mapped to the matching HTTP status.
   */
  resolveSession: (
    sessionRef: string,
    request: Request,
  ) => ResolvedCompletionSession | Promise<ResolvedCompletionSession>;
  /**
   * Runs after a successful completion, before the response is sent — persist
   * status, link `pspPaymentId` to your domain record. The payment has already
   * completed at the PSP; a throw here becomes a 500 so the host notices and
   * reconciles (keep it lightweight and reliable).
   */
  onCompleted?: (info: PaymentInfo, ctx: CompletionHandlerContext) => void | Promise<void>;
  /** Observability hook; exceptions it throws are swallowed. */
  log?: (message: string) => void;
}

/** The wire request body the browser POSTs to the completion endpoint. */
export interface CompletionRequestBody {
  /** The opaque session reference — the `clientSecret` the fields were mounted with. */
  sessionRef: string;
  /** The single-use token the client adapter's `confirm()` produced. */
  clientToken: string;
  /** Optional AVS billing gathered on the payment step, merged at completion. */
  billingDetails?: CompletePaymentInput["billingDetails"];
}

export type CompletionHandler = (request: Request) => Promise<Response>;

/**
 * Creates a web-standard completion route. Mount it as one POST endpoint; the
 * client's `<PayFanoutProvider completionEndpoint>` drives it automatically.
 */
export function createCompletionHandler(options: CompletionHandlerOptions): CompletionHandler {
  return async (request) => {
    if (request.method !== "POST") {
      return jsonError(405, PayFanoutError.invalidRequest("Completion endpoint accepts POST requests only"));
    }

    let body: CompletionRequestBody;
    try {
      body = (await request.json()) as CompletionRequestBody;
    } catch {
      return jsonError(400, PayFanoutError.invalidRequest("Completion request body must be JSON"));
    }
    const invalid = validateBody(body);
    if (invalid) return jsonError(400, invalid);

    let pspName: string | undefined;
    try {
      const resolved = await options.resolveSession(body.sessionRef, request);
      pspName = resolved.pspName;
      const info = await resolved.service.completePayment(resolved.pspName, {
        pspSessionId: resolved.pspSessionId,
        clientToken: body.clientToken,
        idempotencyKey: resolved.idempotencyKey,
        ...(body.billingDetails !== undefined ? { billingDetails: body.billingDetails } : {}),
      });

      try {
        await options.onCompleted?.(info, { sessionRef: body.sessionRef, pspName: resolved.pspName, request });
      } catch (err) {
        safeLog(options.log, `[payfanout] completion onCompleted hook threw after a completed payment: ${describe(err)}`);
        return jsonError(500, isPayFanoutError(err) ? err : PayFanoutError.wrap(err, { code: "processing_error", pspName }));
      }
      return jsonResponse(200, info);
    } catch (err) {
      const wrapped = isPayFanoutError(err) ? err : PayFanoutError.wrap(err, pspName ? { pspName } : undefined);
      safeLog(options.log, `[payfanout] completion failed (${wrapped.code}): ${wrapped.message}`);
      return jsonError(completionErrorStatus(wrapped.code), wrapped);
    }
  };
}

/**
 * Maps the normalized error taxonomy to a completion HTTP status. Card and
 * business declines are 402 Payment Required (the request was well-formed, the
 * payment failed); the client rebuilds a `PayFanoutError` from the body, so the
 * `code` — not the status — drives the UI.
 */
export function completionErrorStatus(code: UnifiedErrorCode): number {
  switch (code) {
    case "card_declined":
    case "insufficient_funds":
    case "expired_card":
    case "invalid_card_data":
    case "fraud_suspected":
    case "authentication_required":
      return 402;
    case "invalid_request":
      return 400;
    case "session_expired":
      return 410;
    case "unsupported_operation":
      return 422;
    case "rate_limited":
      return 429;
    case "psp_unavailable":
      return 503;
    case "processing_error":
      return 502;
    case "unknown":
      return 500;
    // No default: the switch exhausts UnifiedErrorCode, so a new code fails
    // typecheck here (missing return) until it is given an explicit status.
  }
}

function validateBody(body: CompletionRequestBody): PayFanoutError | undefined {
  if (typeof body?.sessionRef !== "string" || body.sessionRef.length === 0) {
    return PayFanoutError.invalidRequest("Completion request is missing a string `sessionRef`");
  }
  if (typeof body.clientToken !== "string" || body.clientToken.length === 0) {
    return PayFanoutError.invalidRequest("Completion request is missing a string `clientToken`");
  }
  return undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(status: number, error: PayFanoutError): Response {
  return jsonResponse(status, { error: error.toJSON() });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeLog(log: CompletionHandlerOptions["log"], message: string): void {
  try {
    log?.(message);
  } catch {
    // Logging must never break completion handling.
  }
}
