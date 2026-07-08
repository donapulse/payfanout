"use client";
import { useCallback, useRef, useState } from "react";
import { PayFanoutError } from "@payfanout/core";
import { resolveConfirmOutcome, type PayResult, type ServerCompletionCallback } from "./pay-logic.js";
import { usePayFanoutContext } from "./provider.js";
import { useLatestRef } from "./use-latest-ref.js";

export interface UsePayOptions {
  /** Same contract as <PayButton>: tokenize-first PSPs finish via the host's server route. */
  onServerCompletion?: ServerCompletionCallback;
}

export interface UsePayResult {
  /**
   * Confirms the currently mounted <PaymentFields> and resolves both
   * completion shapes (§4a) into one PayResult. Never throws — failures come
   * back as { status: "failed", error }. While a confirmation is in flight,
   * calling pay() again returns the SAME in-flight promise: the confirm runs
   * once and every caller resolves to the identical result. Identity is
   * stable across renders — safe to list as an effect dependency.
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
  const optionsRef = useLatestRef(options);
  // Single-flight lives in a ref: state would be a stale closure, letting two
  // same-tick pay() calls both pass the guard and confirm twice.
  const inFlightRef = useRef<Promise<PayResult> | null>(null);

  const pay = useCallback((): Promise<PayResult> => {
    if (inFlightRef.current) return inFlightRef.current;
    const mounted = mountedRef.current;
    const adapter = mounted ? adapters.get(mounted.psp) : undefined;
    if (!mounted || !adapter) {
      return Promise.resolve({
        status: "failed",
        error: PayFanoutError.invalidRequest(
          "No mounted <PaymentFields> to confirm — render it before calling pay()",
        ),
      });
    }
    setPaying(true);
    const flight = (async (): Promise<PayResult> => {
      try {
        const confirmResult = await adapter.confirm(mounted.handle);
        return await resolveConfirmOutcome(confirmResult, optionsRef.current.onServerCompletion);
      } catch (err) {
        return { status: "failed", error: PayFanoutError.wrap(err, { pspName: mounted.psp }) };
      } finally {
        inFlightRef.current = null;
        setPaying(false);
      }
    })();
    inFlightRef.current = flight;
    return flight;
  }, [adapters, mountedRef, optionsRef]);

  return { pay, paying };
}
