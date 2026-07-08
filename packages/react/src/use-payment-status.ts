"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PayFanoutError, type UnifiedError, type UnifiedPaymentStatus } from "@payfanout/core";
import { useLatestRef } from "./use-latest-ref.js";

const TERMINAL_STATUSES: ReadonlySet<UnifiedPaymentStatus> = new Set(["succeeded", "failed", "canceled"]);
const DEFAULT_INTERVAL_MS = 3_000;
const DEFAULT_MAX_INTERVAL_MS = 15_000;

function isTerminal(status: UnifiedPaymentStatus | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.has(status);
}

export interface UsePaymentStatusOptions {
  /**
   * Reads the payment's current unified status from YOUR backend, which calls
   * PaymentService.retrievePayment with the pspPaymentId it stores.
   */
  fetch: () => Promise<{ status: UnifiedPaymentStatus }>;
  /** First polling gap in ms (default 3000). */
  intervalMs?: number;
  /** Gap cap in ms (default 15000): gaps double after every poll until they hit it. */
  maxIntervalMs?: number;
  /** Pass false to pause the loop (default true). */
  enabled?: boolean;
}

export interface UsePaymentStatusResult {
  /** Latest fetched status; undefined until the first fetch lands. */
  status: UnifiedPaymentStatus | undefined;
  /** True while the polling loop is running. */
  polling: boolean;
  /** Last fetch failure — polling continues (transient by default) and the next success clears it. */
  error: UnifiedError | undefined;
  /**
   * Fetches now, never throws. While polling it also resets the backoff
   * cadence; while paused (enabled: false) it is a one-shot read. A no-op
   * once the status is terminal.
   */
  refresh: () => Promise<void>;
}

/**
 * Polls an async-rail payment (SEPA, ACH, vouchers — anything that resolves
 * "processing") to a terminal state. Fetches immediately on mount, then keeps
 * polling with exponentially growing gaps (intervalMs doubling up to
 * maxIntervalMs) until the status is terminal ("succeeded" | "failed" |
 * "canceled"), the component unmounts, or enabled flips false. Server-side
 * webhooks stay the source of truth — this is the browser mirror for the
 * waiting UI. Needs no <PayFanoutProvider>; SSR-safe (polling starts in an
 * effect); the refresh identity is stable across renders.
 */
export function usePaymentStatus(options: UsePaymentStatusOptions): UsePaymentStatusResult {
  const [status, setStatus] = useState<UnifiedPaymentStatus | undefined>(undefined);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<UnifiedError | undefined>(undefined);
  const optionsRef = useLatestRef(options);
  // The loop must not restart on status churn, so terminality is read from a ref.
  const statusRef = useRef<UnifiedPaymentStatus | undefined>(undefined);
  // The active loop's manual-refresh hook; null while not polling.
  const loopRef = useRef<{ refresh: () => Promise<void> } | null>(null);
  // Guards the one-shot refresh path (loop inactive) against post-unmount state.
  const epochRef = useRef(0);

  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled || isTerminal(statusRef.current)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay: number | undefined;
    // Single-flight: a manual refresh during an in-flight poll joins it
    // instead of forking a second timer chain.
    let inFlight: Promise<void> | null = null;
    setPolling(true);

    const tick = (): Promise<void> => {
      inFlight ??= (async (): Promise<void> => {
        let reachedTerminal = false;
        try {
          const { status: next } = await optionsRef.current.fetch();
          if (cancelled) return;
          statusRef.current = next;
          setStatus(next);
          setError(undefined);
          reachedTerminal = TERMINAL_STATUSES.has(next);
        } catch (err) {
          if (cancelled) return;
          // Transient by default: record it and keep polling.
          setError(PayFanoutError.wrap(err));
        } finally {
          inFlight = null;
        }
        if (reachedTerminal) {
          loopRef.current = null;
          setPolling(false);
          return;
        }
        const { intervalMs = DEFAULT_INTERVAL_MS, maxIntervalMs = DEFAULT_MAX_INTERVAL_MS } = optionsRef.current;
        delay = delay === undefined ? intervalMs : Math.min(delay * 2, maxIntervalMs);
        timer = setTimeout(() => void tick(), delay);
      })();
      return inFlight;
    };

    loopRef.current = {
      refresh: (): Promise<void> => {
        clearTimeout(timer);
        delay = undefined;
        return tick();
      },
    };
    void tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      loopRef.current = null;
      setPolling(false);
    };
  }, [enabled, optionsRef]);

  useEffect(
    () => () => {
      epochRef.current++;
    },
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const loop = loopRef.current;
    if (loop) return loop.refresh();
    if (isTerminal(statusRef.current)) return;
    // Paused (enabled: false): a guarded one-shot read.
    const epoch = epochRef.current;
    try {
      const { status: next } = await optionsRef.current.fetch();
      if (epochRef.current !== epoch) return;
      statusRef.current = next;
      setStatus(next);
      setError(undefined);
    } catch (err) {
      if (epochRef.current !== epoch) return;
      setError(PayFanoutError.wrap(err));
    }
  }, [optionsRef]);

  return { status, polling, error, refresh };
}
