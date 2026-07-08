"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PayFanoutError, type RedirectReturnLocation } from "@payfanout/core";
import { resolveConfirmOutcome, type PayResult, type ServerCompletionCallback } from "./pay-logic.js";
import { usePayFanoutContext } from "./provider.js";
import { useLatestRef } from "./use-latest-ref.js";

export type RedirectReturnPhase =
  /** Still probing the URL / resolving the outcome. */
  | "checking"
  /** The URL carried no PSP return params — a normal page load, render checkout as usual. */
  | "none"
  /** A redirect return was found and resolved into `result`. */
  | "complete";

export interface RedirectReturnState {
  phase: RedirectReturnPhase;
  /** Set when phase === "complete". */
  result?: PayResult;
  /** Which PSP's return params matched. */
  pspName?: string;
}

export interface UseRedirectReturnOptions {
  /** Fired once when a redirect return resolves. */
  onResult?: (result: PayResult, pspName: string) => void;
  /** Same contract as <PayButton>: tokenize-first PSPs finish via the host's server route. */
  onServerCompletion?: ServerCompletionCallback;
  /** Test/router seam; defaults to window.location. */
  location?: RedirectReturnLocation;
}

/**
 * The return-trip half of redirect payment methods (flow: "redirect" — iDEAL,
 * bank redirects, …). Mount it on the returnUrl page: it probes every
 * registered adapter's handleRedirectReturn until one recognizes the landing
 * URL, resolves the outcome (activating that PSP for consistency), and
 * reports the same PayResult shape <PayButton> produces.
 *
 * SSR-safe: everything happens in an effect; the first client render reports
 * "checking".
 */
export function useRedirectReturn(options: UseRedirectReturnOptions = {}): RedirectReturnState {
  const { adapters, setActivePsp } = usePayFanoutContext();
  const [state, setState] = useState<RedirectReturnState>({ phase: "checking" });
  const optionsRef = useLatestRef(options);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return; // a previous invocation settled (or is settling) this mount
    startedRef.current = true;
    let cancelled = false;
    let settled = false;

    const run = async (): Promise<void> => {
      const current = optionsRef.current;
      const location: RedirectReturnLocation = current.location ?? {
        search: window.location.search,
        hash: window.location.hash,
      };
      for (const [pspName, adapter] of adapters) {
        if (typeof adapter.handleRedirectReturn !== "function") continue;
        let confirmResult;
        try {
          confirmResult = await adapter.handleRedirectReturn(location);
        } catch (err) {
          confirmResult = {
            status: "failed" as const,
            error: PayFanoutError.wrap(err, { pspName }),
          };
        }
        // Bail before any side effect: handleRedirectReturn is a read-only
        // probe (safe to re-run), but activation and above all
        // onServerCompletion must only ever run for the surviving invocation.
        if (cancelled) return;
        if (confirmResult === null) continue; // not this PSP's return URL
        try {
          setActivePsp(pspName);
        } catch {
          // Provider registry changed mid-flight — the result still stands.
        }
        const result = await resolveConfirmOutcome(confirmResult, current.onServerCompletion);
        if (cancelled) return;
        settled = true;
        setState({ phase: "complete", result, pspName });
        current.onResult?.(result, pspName);
        return;
      }
      if (!cancelled) {
        settled = true;
        setState({ phase: "none" });
      }
    };

    void run();
    return () => {
      cancelled = true;
      // StrictMode unmounts before the async probe can settle; free the
      // guard so the paired remount runs to a terminal phase (onResult still
      // fires exactly once — the cancelled invocation discarded its result).
      // Once settled, the guard stays set: production keeps single-flight.
      if (!settled) startedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- single-flight per mount, never re-probed on context churn
  }, []);

  return state;
}

export interface RedirectReturnProps extends UseRedirectReturnOptions {
  /** Render-prop over the current state; nothing is rendered without it. */
  children?: (state: RedirectReturnState) => ReactNode;
}

/**
 * Component form of useRedirectReturn for hosts that prefer JSX:
 *
 *   <RedirectReturn onResult={showOutcome}>
 *     {({ phase }) => phase === "checking" ? <Spinner /> : null}
 *   </RedirectReturn>
 */
export function RedirectReturn({ children, ...options }: RedirectReturnProps): ReactNode {
  const state = useRedirectReturn(options);
  return children ? children(state) : null;
}
