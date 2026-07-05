import {
  isPayFanoutError,
  PayFanoutError,
  type ConfirmResult,
  type PaymentInfo,
  type UnifiedError,
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
          "The active PSP is tokenize-first and needs server completion — pass onServerCompletion to <PayButton>",
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
