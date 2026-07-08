"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PayFanoutError, type SavedPaymentMethod, type UnifiedError } from "@payfanout/core";
import { useLatestRef } from "./use-latest-ref.js";

export type SavedPaymentMethodsStatus = "idle" | "loading" | "ready" | "error";

export interface UseSavedPaymentMethodsOptions {
  /**
   * Loads the customer's saved methods from YOUR backend, which calls
   * PaymentService.listSavedPaymentMethods with the pspCustomerId it stores.
   */
  fetch: () => Promise<SavedPaymentMethod[]>;
  /**
   * Deletes one saved method (by SavedPaymentMethod.token) via YOUR backend,
   * which calls PaymentService.deleteSavedPaymentMethod. Omit if the UI never
   * removes cards; remove() then fails with invalid_request.
   */
  remove?: (token: string) => Promise<void>;
  /** Fetch on mount (default true). Pass false to fetch only via refresh(). */
  auto?: boolean;
}

export interface UseSavedPaymentMethodsResult {
  /** Last successfully fetched list — kept on screen through reloads, empty until the first "ready". */
  methods: SavedPaymentMethod[];
  status: SavedPaymentMethodsStatus;
  /** Set while status === "error"; cleared when the next call starts. */
  error: UnifiedError | undefined;
  /** Re-fetches the list. Never throws — failures land in error/status. */
  refresh: () => Promise<void>;
  /**
   * Awaits the injected remove, then re-fetches: the host's list is the
   * truth, never spliced locally. Never throws — failures land in error/status.
   */
  remove: (token: string) => Promise<void>;
}

/**
 * The returning-customer surface: a loading/error/refresh state machine over
 * the HOST's saved-method endpoints. PayFanout persists nothing, so both
 * fetchers hit the host's own backend (which calls
 * PaymentService.listSavedPaymentMethods / deleteSavedPaymentMethod with the
 * pspCustomerId it maps to its user) — the hook holds nothing beyond
 * component state. Methods are opaque tokens plus display facts; card data
 * never appears. Needs no <PayFanoutProvider>; SSR-safe (fetching starts in
 * an effect); refresh/remove identities are stable across renders.
 */
export function useSavedPaymentMethods(options: UseSavedPaymentMethodsOptions): UseSavedPaymentMethodsResult {
  const [methods, setMethods] = useState<SavedPaymentMethod[]>([]);
  const [status, setStatus] = useState<SavedPaymentMethodsStatus>("idle");
  const [error, setError] = useState<UnifiedError | undefined>(undefined);
  const optionsRef = useLatestRef(options);
  // Monotonic call identity: every new load and every unmount bumps it, so a
  // resolving stale fetch (superseded, StrictMode-cancelled, or post-unmount)
  // never applies state.
  const epochRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const epoch = ++epochRef.current;
    setStatus("loading");
    setError(undefined);
    try {
      const list = await optionsRef.current.fetch();
      if (epochRef.current !== epoch) return;
      setMethods(list);
      setStatus("ready");
    } catch (err) {
      if (epochRef.current !== epoch) return;
      setError(PayFanoutError.wrap(err));
      setStatus("error");
    }
  }, [optionsRef]);

  const remove = useCallback(
    async (token: string): Promise<void> => {
      const injected = optionsRef.current.remove;
      if (!injected) {
        setError(
          PayFanoutError.invalidRequest(
            "useSavedPaymentMethods has no remove fetcher — pass options.remove to enable deletion",
          ),
        );
        setStatus("error");
        return;
      }
      const epoch = ++epochRef.current;
      setStatus("loading");
      setError(undefined);
      try {
        await injected(token);
      } catch (err) {
        if (epochRef.current !== epoch) return;
        setError(PayFanoutError.wrap(err));
        setStatus("error");
        return;
      }
      if (epochRef.current !== epoch) return;
      await refresh();
    },
    [optionsRef, refresh],
  );

  useEffect(() => {
    // auto is a mount-time behavior (read once, like the option says); later
    // fetches go through refresh().
    if (optionsRef.current.auto ?? true) void refresh();
    const epochs = epochRef; // not a DOM ref — the cleanup mutation is the point
    return () => {
      // Discard whatever this mount still has in flight. A StrictMode remount
      // fetches again — the list read is harmless to repeat.
      epochs.current++;
    };
  }, [optionsRef, refresh]);

  return { methods, status, error, refresh, remove };
}
