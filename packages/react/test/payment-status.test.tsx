// @vitest-environment jsdom
import { StrictMode, type JSX } from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedPaymentStatus } from "@payfanout/core";
import { usePaymentStatus } from "../src/index.js";
import { deferred } from "./fake-client-adapter.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Serves statuses in order, repeating the last one forever. */
function statusFeed(...statuses: [UnifiedPaymentStatus, ...UnifiedPaymentStatus[]]) {
  const fetchStatus = vi.fn(async (): Promise<{ status: UnifiedPaymentStatus }> => {
    const index = Math.min(fetchStatus.mock.calls.length - 1, statuses.length - 1);
    return { status: statuses[index]! };
  });
  return fetchStatus;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("usePaymentStatus", () => {
  it("fetches immediately, polls to a terminal status, then stops for good", async () => {
    const fetchStatus = statusFeed("processing", "processing", "succeeded");
    const { result } = renderHook(() => usePaymentStatus({ fetch: fetchStatus }));
    expect(result.current.polling).toBe(true);
    expect(result.current.status).toBeUndefined();

    await advance(0); // the immediate read lands
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("processing");

    await advance(3000); // first gap = intervalMs
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("processing");

    await advance(6000); // gap doubled
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    expect(result.current.status).toBe("succeeded");
    expect(result.current.polling).toBe(false);

    await advance(120_000); // terminal: nothing ever polls again
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("doubles the gap after every poll and caps it at maxIntervalMs", async () => {
    const fetchStatus = statusFeed("processing");
    renderHook(() => usePaymentStatus({ fetch: fetchStatus, intervalMs: 1000, maxIntervalMs: 4000 }));
    await advance(0); // read 1 (immediate)
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    await advance(999); // gap 1 = 1000
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    await advance(1999); // gap 2 = 2000
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetchStatus).toHaveBeenCalledTimes(3);

    await advance(3999); // gap 3 = 4000 (the cap)
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(fetchStatus).toHaveBeenCalledTimes(4);

    await advance(4000); // stays at the cap
    expect(fetchStatus).toHaveBeenCalledTimes(5);
  });

  it("records a failed poll and keeps polling — the next success clears the error", async () => {
    const boom = new Error("blip");
    const fetchStatus = vi.fn(async (): Promise<{ status: UnifiedPaymentStatus }> => {
      if (fetchStatus.mock.calls.length === 1) throw boom;
      return { status: fetchStatus.mock.calls.length === 2 ? "processing" : "succeeded" };
    });
    const { result } = renderHook(() => usePaymentStatus({ fetch: fetchStatus }));
    await advance(0);
    expect(result.current.error?.raw).toBe(boom);
    expect(result.current.status).toBeUndefined();
    expect(result.current.polling).toBe(true); // transient by default

    await advance(3000);
    expect(result.current.error).toBeUndefined();
    expect(result.current.status).toBe("processing");

    await advance(6000);
    expect(result.current.status).toBe("succeeded");
    expect(result.current.polling).toBe(false);
  });

  it("enabled gates the loop: off means no reads, on starts it, off again stops it", async () => {
    const fetchStatus = statusFeed("processing");
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => usePaymentStatus({ fetch: fetchStatus, enabled }),
      { initialProps: { enabled: false } },
    );
    await advance(60_000);
    expect(fetchStatus).not.toHaveBeenCalled();
    expect(result.current.polling).toBe(false);

    rerender({ enabled: true });
    await advance(0);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(result.current.polling).toBe(true);

    rerender({ enabled: false });
    expect(result.current.polling).toBe(false);
    await advance(60_000); // the pending timer was cancelled
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("stops on unmount and discards the in-flight read", async () => {
    const gate = deferred<{ status: UnifiedPaymentStatus }>();
    const fetchStatus = vi.fn((): Promise<{ status: UnifiedPaymentStatus }> => gate.promise);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderHook(() => usePaymentStatus({ fetch: fetchStatus }));
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    unmount();
    gate.resolve({ status: "processing" });
    await advance(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1); // never rescheduled
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("StrictMode double-mount leaves exactly one timer chain", async () => {
    // render (not renderHook) — a StrictMode wrapper around renderHook's test
    // component does not double-invoke effects in this RTL version.
    const fetchStatus = statusFeed("processing", "processing", "succeeded");
    function Probe(): JSX.Element {
      const { status, polling } = usePaymentStatus({ fetch: fetchStatus });
      return (
        <span data-testid="state">
          {status ?? "none"}:{String(polling)}
        </span>
      );
    }
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await advance(0);
    // Both invocations issue the immediate read (harmless); the cancelled one
    // schedules nothing.
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("state").textContent).toBe("processing:true");

    await advance(3000); // one chain -> one poll per gap
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("state").textContent).toBe("succeeded:false");

    await advance(120_000);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("refresh() polls immediately and resets the backoff cadence", async () => {
    const fetchStatus = statusFeed("processing");
    const { result } = renderHook(() => usePaymentStatus({ fetch: fetchStatus }));
    await advance(0); // read 1
    await advance(3000); // read 2; next gap would be 6000
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      await result.current.refresh(); // read 3, cadence reset
    });
    expect(fetchStatus).toHaveBeenCalledTimes(3);

    await advance(3000); // back to the base gap, not 6000
    expect(fetchStatus).toHaveBeenCalledTimes(4);
  });

  it("refresh() during an in-flight poll joins it instead of double-fetching", async () => {
    const gate = deferred<{ status: UnifiedPaymentStatus }>();
    let gated = true;
    const fetchStatus = vi.fn((): Promise<{ status: UnifiedPaymentStatus }> => {
      if (gated) {
        gated = false;
        return gate.promise;
      }
      return Promise.resolve({ status: "processing" });
    });
    const { result } = renderHook(() => usePaymentStatus({ fetch: fetchStatus }));
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    const joined = result.current.refresh(); // coalesces into the in-flight read
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    gate.resolve({ status: "processing" });
    await act(async () => {
      await joined;
    });
    expect(result.current.status).toBe("processing");
  });

  it("refresh() while paused is a one-shot read; a terminal status makes it a no-op", async () => {
    const fetchStatus = statusFeed("succeeded");
    const { result } = renderHook(() => usePaymentStatus({ fetch: fetchStatus, enabled: false }));
    expect(result.current.polling).toBe(false);
    await act(async () => {
      await result.current.refresh();
    });
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("succeeded");
    expect(result.current.polling).toBe(false); // a one-shot never starts the loop

    await act(async () => {
      await result.current.refresh(); // terminal: nothing left to ask
    });
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("refresh() while paused records failures without starting a loop", async () => {
    const boom = new Error("nope");
    const fetchStatus = vi.fn(async (): Promise<{ status: UnifiedPaymentStatus }> => {
      throw boom;
    });
    const { result } = renderHook(() => usePaymentStatus({ fetch: fetchStatus, enabled: false }));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error?.raw).toBe(boom);
    expect(result.current.polling).toBe(false);
    await advance(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });
});
