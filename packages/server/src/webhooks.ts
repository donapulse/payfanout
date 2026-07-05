import { PayFanoutError, type ServerPaymentAdapter, type UnifiedWebhookEvent } from "@payfanout/core";

/**
 * Framework-agnostic webhook ingress. The host app supplies the RAW request
 * body string (exactly as received — express.raw / fastify rawBody /
 * `await req.text()` in Next.js App Router; see the README recipes) plus the
 * headers, and translates the returned status to its framework's response.
 *
 * Ack-fast contract: the handler only verifies the signature, parses the event,
 * and hands it to `onEvent`. `onEvent` must ENQUEUE and return — respond 2xx
 * immediately and defer heavy processing. Paysafe in particular retries
 * effectively forever until it sees a success response.
 */
export interface WebhookRequest {
  rawBody: string;
  headers: Record<string, string>;
}

export type WebhookHandlerResult =
  | { ok: true; status: 200; pspName: string; event: UnifiedWebhookEvent }
  | { ok: false; status: 400 | 401 | 500; reason: string };

export type WebhookHandler = (req: WebhookRequest) => Promise<WebhookHandlerResult>;

export interface WebhookHandlerOptions {
  /**
   * Receives the normalized event. Must be fast (enqueue, don't process).
   * Dedupe by event.id is the HOST's responsibility — PayFanout stores nothing.
   * A thrown error yields a 500 so the PSP retries delivery.
   */
  onEvent: (event: UnifiedWebhookEvent) => void | Promise<void>;
  /** Observability hook (which adapter matched, verification failures, ...). */
  log?: (message: string) => void;
}

/** Recommended default: one endpoint per adapter (/webhooks/stripe, /webhooks/paysafe). */
export function createAdapterWebhookHandler(
  adapter: ServerPaymentAdapter,
  options: WebhookHandlerOptions,
): WebhookHandler {
  return async (req) => {
    const invalid = validateRequest(req);
    if (invalid) return invalid;
    const headers = lowercaseHeaders(req.headers);

    let verified: boolean;
    try {
      verified = await adapter.verifyWebhookSignature(req.rawBody, headers);
    } catch (err) {
      options.log?.(`[payfanout] ${adapter.pspName} signature verification threw: ${describe(err)}`);
      verified = false;
    }
    if (!verified) {
      return { ok: false, status: 401, reason: `Signature verification failed for "${adapter.pspName}"` };
    }
    return parseAndDispatch(adapter, req.rawBody, headers, options);
  };
}

/**
 * Single shared entry point (one public URL for every PSP): tries each
 * registered adapter's signature verification until one succeeds, then parses
 * with that adapter. Convenient, but it relies on each PSP's signature check
 * being a reliable discriminator — prefer per-adapter endpoints when in doubt.
 */
export function createUnifiedWebhookHandler(
  adapters: ServerPaymentAdapter[],
  options: WebhookHandlerOptions,
): WebhookHandler {
  if (adapters.length === 0) {
    throw PayFanoutError.invalidRequest("createUnifiedWebhookHandler requires at least one adapter");
  }
  return async (req) => {
    const invalid = validateRequest(req);
    if (invalid) return invalid;
    const headers = lowercaseHeaders(req.headers);

    for (const adapter of adapters) {
      let verified = false;
      try {
        verified = await adapter.verifyWebhookSignature(req.rawBody, headers);
      } catch (err) {
        options.log?.(`[payfanout] ${adapter.pspName} signature verification threw: ${describe(err)}`);
      }
      if (verified) {
        options.log?.(`[payfanout] unified webhook matched adapter "${adapter.pspName}"`);
        return parseAndDispatch(adapter, req.rawBody, headers, options);
      }
    }
    return { ok: false, status: 401, reason: "No registered adapter's signature verification matched" };
  };
}

async function parseAndDispatch(
  adapter: ServerPaymentAdapter,
  rawBody: string,
  headers: Record<string, string>,
  options: WebhookHandlerOptions,
): Promise<WebhookHandlerResult> {
  let event: UnifiedWebhookEvent;
  try {
    event = await adapter.parseWebhookEvent(rawBody, headers);
  } catch (err) {
    return { ok: false, status: 400, reason: `Failed to parse "${adapter.pspName}" webhook: ${describe(err)}` };
  }
  try {
    await options.onEvent(event);
  } catch (err) {
    // Host enqueue failed — 500 so the PSP retries later.
    return { ok: false, status: 500, reason: `onEvent handler failed: ${describe(err)}` };
  }
  return { ok: true, status: 200, pspName: adapter.pspName, event };
}

function validateRequest(req: WebhookRequest): WebhookHandlerResult | undefined {
  if (typeof req.rawBody !== "string" || req.rawBody.length === 0) {
    return {
      ok: false,
      status: 400,
      reason:
        "rawBody must be the exact raw request body string. Framework body parsers destroy it — " +
        "use express.raw({ type: 'application/json' }), Fastify's raw-body config, or await req.text() in Next.js.",
    };
  }
  return undefined;
}

function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) out[key.toLowerCase()] = value;
  return out;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
