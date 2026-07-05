"use client";
import { useCallback, useState } from "react";
import { PayFanoutError } from "@payfanout/core";
import { resolveConfirmOutcome, type PayResult, type ServerCompletionCallback } from "./pay-logic.js";
import { usePayFanoutContext } from "./provider.js";

export interface UsePayOptions {
  /** Same contract as <PayButton>: tokenize-first PSPs finish via the host's server route. */
  onServerCompletion?: ServerCompletionCallback;
}

export interface UsePayResult {
  /**
   * Confirms the currently mounted <PaymentFields> and resolves both
   * completion shapes (§4a) into one PayResult. Never throws — failures come
   * back as { status: "failed", error }. Concurrent calls no-op (returns the
   * same in-flight promise's shape with status "processing").
   */
  pay: () => Promise<PayResult>;
  /** True while a confirmation is in flight — drive spinners/disabled state. */
  paying: boolean;
}

/**
 * <PayButton>'s engine as a hook, for hosts whose design system brings its
 * own button. Everything <PayButton> does — confirm the mounted fields,
 * branch tokenize-first completions through onServerCompletion, normalize
 * errors — in three lines:
 *
 *   const { pay, paying } = usePay({ onServerCompletion });
 *   <MyDesignSystemButton loading={paying} onClick={async () => show(await pay())} />
 */
export function usePay(options: UsePayOptions = {}): UsePayResult {
  const { adapters, mountedRef } = usePayFanoutContext();
  const [paying, setPaying] = useState(false);

  const pay = useCallback(async (): Promise<PayResult> => {
    if (paying) return { status: "processing" };
    const mounted = mountedRef.current;
    const adapter = mounted ? adapters.get(mounted.psp) : undefined;
    if (!mounted || !adapter) {
      return {
        status: "failed",
        error: PayFanoutError.invalidRequest(
          "No mounted <PaymentFields> to confirm — render it before calling pay()",
        ),
      };
    }
    setPaying(true);
    try {
      const confirmResult = await adapter.confirm(mounted.handle);
      return await resolveConfirmOutcome(confirmResult, options.onServerCompletion);
    } catch (err) {
      return { status: "failed", error: PayFanoutError.wrap(err, { pspName: mounted.psp }) };
    } finally {
      setPaying(false);
    }
  }, [adapters, mountedRef, paying, options.onServerCompletion]);

  return { pay, paying };
}
