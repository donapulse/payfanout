// @vitest-environment jsdom
import { StrictMode, type JSX } from "react";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavedPaymentMethod } from "@payfanout/core";
import { useSavedPaymentMethods } from "../src/index.js";
import { deferred } from "./fake-client-adapter.js";

afterEach(cleanup);

function saved(token: string): SavedPaymentMethod {
  return {
    token,
    pspName: "fakepsp",
    pspCustomerId: "cus_1",
    paymentMethodType: "card",
    details: { brand: "visa", last4: "4242" },
    raw: {},
  };
}

describe("useSavedPaymentMethods", () => {
  it("fetches on mount by default and reaches ready", async () => {
    const list = [saved("tok_a"), saved("tok_b")];
    const fetchList = vi.fn(async () => list);
    const { result } = renderHook(() => useSavedPaymentMethods({ fetch: fetchList }));
    expect(result.current.status).toBe("loading");
    expect(result.current.methods).toEqual([]);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.methods).toEqual(list);
    expect(result.current.error).toBeUndefined();
    expect(fetchList).toHaveBeenCalledTimes(1);
  });

  it("auto: false stays idle until refresh() is called", async () => {
    const fetchList = vi.fn(async () => [saved("tok_a")]);
    const { result } = renderHook(() => useSavedPaymentMethods({ fetch: fetchList, auto: false }));
    expect(result.current.status).toBe("idle");
    expect(fetchList).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.methods).toEqual([saved("tok_a")]);
  });

  it("StrictMode double-mount re-reads harmlessly and settles on the survivor", async () => {
    // render (not renderHook) — a StrictMode wrapper around renderHook's test
    // component does not double-invoke effects in this RTL version.
    const fetchList = vi.fn(async () => [saved("tok_a")]);
    function Probe(): JSX.Element {
      const { methods, status } = useSavedPaymentMethods({ fetch: fetchList });
      return (
        <span data-testid="state">
          {status}:{methods.map((m) => m.token).join(",")}
        </span>
      );
    }
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("ready:tok_a"));
    // Both invocations fetch (a list read is safe to repeat); the cancelled
    // one's result is discarded.
    expect(fetchList).toHaveBeenCalledTimes(2);
  });

  it("discards a fetch that resolves after unmount", async () => {
    const gate = deferred<SavedPaymentMethod[]>();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useSavedPaymentMethods({ fetch: () => gate.promise }));
    expect(result.current.status).toBe("loading");
    unmount();
    gate.resolve([saved("tok_a")]);
    await act(async () => {});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("discards a fetch that rejects after unmount", async () => {
    const gate = deferred<SavedPaymentMethod[]>();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderHook(() => useSavedPaymentMethods({ fetch: () => gate.promise }));
    unmount();
    gate.reject(new Error("late failure"));
    await act(async () => {});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("records fetch failures and recovers on the next refresh", async () => {
    const boom = new Error("backend down");
    let fail = true;
    const fetchList = vi.fn(async () => {
      if (fail) throw boom;
      return [saved("tok_a")];
    });
    const { result } = renderHook(() => useSavedPaymentMethods({ fetch: fetchList }));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.code).toBe("unknown");
    expect(result.current.error?.raw).toBe(boom);
    fail = false;
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeUndefined();
    expect(result.current.methods).toEqual([saved("tok_a")]);
  });

  it("remove() awaits the injected remove, then re-reads the host's list", async () => {
    const calls: string[] = [];
    let list = [saved("tok_a"), saved("tok_b")];
    const fetchList = vi.fn(async () => {
      calls.push("fetch");
      return list;
    });
    const removeImpl = vi.fn(async (token: string) => {
      calls.push(`remove:${token}`);
      list = list.filter((m) => m.token !== token);
    });
    const { result } = renderHook(() => useSavedPaymentMethods({ fetch: fetchList, remove: removeImpl }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.remove("tok_a");
    });
    // Delete first, then re-fetch — the list is never spliced locally.
    expect(calls).toEqual(["fetch", "remove:tok_a", "fetch"]);
    expect(result.current.methods).toEqual([saved("tok_b")]);
    expect(result.current.status).toBe("ready");
  });

  it("records a failed remove without re-fetching", async () => {
    const boom = new Error("delete rejected");
    const fetchList = vi.fn(async () => [saved("tok_a")]);
    const removeImpl = vi.fn(async () => {
      throw boom;
    });
    const { result } = renderHook(() => useSavedPaymentMethods({ fetch: fetchList, remove: removeImpl }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.remove("tok_a");
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error?.raw).toBe(boom);
    expect(result.current.methods).toEqual([saved("tok_a")]); // last good list stays
    expect(fetchList).toHaveBeenCalledTimes(1);
  });

  it("remove() without an injected remove fails with invalid_request", async () => {
    const { result } = renderHook(() => useSavedPaymentMethods({ fetch: async () => [saved("tok_a")] }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.remove("tok_a");
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error?.code).toBe("invalid_request");
    expect(result.current.error?.message).toMatch(/remove/);
  });

  it("discards a remove that settles after unmount (no post-unmount refresh)", async () => {
    const gate = deferred<void>();
    const fetchList = vi.fn(async () => [saved("tok_a")]);
    const { result, unmount } = renderHook(() =>
      useSavedPaymentMethods({ fetch: fetchList, remove: () => gate.promise }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      void result.current.remove("tok_a");
    });
    unmount();
    gate.resolve();
    await act(async () => {});
    expect(fetchList).toHaveBeenCalledTimes(1);
  });

  it("a newer refresh supersedes an older in-flight one", async () => {
    const first = deferred<SavedPaymentMethod[]>();
    const second = deferred<SavedPaymentMethod[]>();
    const gates = [first, second];
    let i = 0;
    const fetchList = (): Promise<SavedPaymentMethod[]> => gates[i++]!.promise;
    const { result } = renderHook(() => useSavedPaymentMethods({ fetch: fetchList }));
    let refreshed!: Promise<void>;
    act(() => {
      refreshed = result.current.refresh();
    });
    second.resolve([saved("tok_new")]);
    await act(async () => {
      await refreshed;
    });
    expect(result.current.methods).toEqual([saved("tok_new")]);
    first.resolve([saved("tok_stale")]); // the superseded auto-fetch lands late
    await act(async () => {});
    expect(result.current.methods).toEqual([saved("tok_new")]);
    expect(result.current.status).toBe("ready");
  });

  it("keeps refresh/remove identities stable and reads the latest inline fetchers", async () => {
    let calls = 0;
    const make = (label: string) => async (): Promise<SavedPaymentMethod[]> => {
      calls++;
      return [saved(label)];
    };
    const { result, rerender } = renderHook(({ fetch }) => useSavedPaymentMethods({ fetch }), {
      initialProps: { fetch: make("tok_1") },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const { refresh, remove } = result.current;
    rerender({ fetch: make("tok_2") }); // new inline fetcher identity
    expect(result.current.refresh).toBe(refresh);
    expect(result.current.remove).toBe(remove);
    expect(calls).toBe(1); // a re-render alone never re-fetches
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.methods).toEqual([saved("tok_2")]); // latest fetcher was used
  });
});
