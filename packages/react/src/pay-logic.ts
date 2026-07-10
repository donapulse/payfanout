import {
  isPayFanoutError,
  PayFanoutError,
  type CompletePaymentInput,
  type ConfirmResult,
  type PaymentInfo,
  type UnifiedError,
  type UnifiedErrorCode,
  type UnifiedPaymentStatus,
} from "@payfanout/core";

export interface PayResult {
  status: UnifiedPaymentStatus;
  /** Present when the payment finished via server completion (tokenize-first PSPs). */
  info?: PaymentInfo;
  error?: UnifiedError;
}

export type ServerCompletionCallback = (clientToken: string) => Promise<PaymentInfo>;

/**
 * The §4a branching, as a pure function so both completion shapes stay
 * testable without a browser:
 *  - confirm-on-client (Stripe): the confirm result is already terminal.
 *  - tokenize-first (Paysafe): confirm yields a clientToken; the host's
 *    onServerCompletion must call its own API route, which calls
 *    PaymentService.completePayment. Either way the caller sees one PayResult.
 */
export async function resolveConfirmOutcome(
  confirmResult: ConfirmResult,
  onServerCompletion?: ServerCompletionCallback,
): Promise<PayResult> {
  if (confirmResult.error) {
    return { status: confirmResult.status ?? "failed", error: confirmResult.error };
  }
  if (confirmResult.clientToken !== undefined) {
    if (!onServerCompletion) {
      return {
        status: "failed",
        error: PayFanoutError.invalidRequest(
          "The active PSP is tokenize-first and needs server completion — set completionEndpoint on " +
            "<PayFanoutProvider>, or pass onServerCompletion to <PayButton>/usePay",
        ),
      };
    }
    try {
      const info = await onServerCompletion(confirmResult.clientToken);
      return { status: info.status, info };
    } catch (err) {
      const wrapped = isPayFanoutError(err) ? err : PayFanoutError.wrap(err);
      return { status: "failed", error: wrapped };
    }
  }
  return { status: confirmResult.status };
}

/**
 * The ServerCompletionCallback the provider's `completionEndpoint` derives:
 * POST `{ sessionRef, clientToken, billingDetails? }` to the host route that
 * mounts @payfanout/server's `createCompletionHandler`, and resolve with the
 * returned `PaymentInfo`. A non-2xx response is rebuilt into a `PayFanoutError`
 * so the error `code`/`message`/`retryable` survive the wire and drive the UI
 * (localizeError, retry affordances). Exported so hosts writing a custom
 * transport can reuse the exact contract.
 */
export function createEndpointCompletion(
  endpoint: string,
  sessionRef: string,
  billingDetails?: CompletePaymentInput["billingDetails"],
  fetchImpl: typeof fetch = fetch,
): ServerCompletionCallback {
  return async (clientToken) => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionRef,
        clientToken,
        ...(billingDetails !== undefined ? { billingDetails } : {}),
      }),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw errorFromResponse(response.status, payload);
    }
    return payload as PaymentInfo;
  };
}

/** Rebuilds a PayFanoutError from the completion handler's `{ error }` body. */
function errorFromResponse(status: number, payload: unknown): PayFanoutError {
  const wire = (payload as { error?: unknown } | undefined)?.error;
  if (wire && typeof wire === "object" && typeof (wire as { message?: unknown }).message === "string") {
    const e = wire as { code?: UnifiedErrorCode; message: string; retryable?: boolean; pspName?: string };
    return new PayFanoutError({
      code: e.code ?? "unknown",
      message: e.message,
      retryable: e.retryable === true,
      raw: payload,
      ...(typeof e.pspName === "string" ? { pspName: e.pspName } : {}),
    });
  }
  return new PayFanoutError({
    code: "unknown",
    message: `Server completion failed (HTTP ${status})`,
    raw: payload,
  });
}
