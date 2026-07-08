import { describe, expect, it } from "vitest";
import { PayFanoutError } from "../src/errors.js";
import {
  classifyHttpFallback,
  isTransportRetryable,
  requestWithTimeout,
  safeJson,
  withTransportRetries,
} from "../src/transport.js";

function failure(timedOut: boolean, cause: unknown): Error {
  return new PayFanoutError({
    code: "psp_unavailable",
    message: timedOut ? "timed out" : "unreachable",
    retryable: true,
    raw: cause,
  });
}

describe("requestWithTimeout", () => {
  it("returns the response and its fully-read body text", async () => {
    const result = await requestWithTimeout(
      {
        fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
        timeoutMs: 1000,
        onFailure: failure,
      },
      "https://psp.example/v1/thing",
      { method: "GET" },
    );
    expect(result.response.status).toBe(200);
    expect(result.text).toBe('{"ok":true}');
  });

  it("forwards url and init, adding its own abort signal", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    await requestWithTimeout(
      {
        fetch: async (url, init) => {
          seenUrl = String(url);
          seenInit = init;
          return new Response("{}");
        },
        timeoutMs: 1000,
        onFailure: failure,
      },
      "https://psp.example/v1/thing",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(seenUrl).toBe("https://psp.example/v1/thing");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.body).toBe("{}");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts a hung request and reports timedOut to onFailure", async () => {
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    await expect(
      requestWithTimeout({ fetch: hangingFetch, timeoutMs: 5, onFailure: failure }, "https://x", {}),
    ).rejects.toMatchObject({ code: "psp_unavailable", message: "timed out" });
  });

  it("keeps plain network failures distinguishable from timeouts", async () => {
    await expect(
      requestWithTimeout(
        {
          fetch: async () => {
            throw new TypeError("fetch failed");
          },
          timeoutMs: 1000,
          onFailure: failure,
        },
        "https://x",
        {},
      ),
    ).rejects.toMatchObject({ message: "unreachable", raw: expect.any(TypeError) });
  });

  it("bounds the BODY read with the same timer — headers alone do not disarm it", async () => {
    // Headers arrive immediately but the body stream never closes.
    await expect(
      requestWithTimeout(
        {
          fetch: async () => new Response(new ReadableStream({ start() {} })),
          timeoutMs: 5,
          onFailure: failure,
        },
        "https://x",
        {},
      ),
    ).rejects.toMatchObject({ message: "timed out" });
  });

  it("refuses to read a body that lands only after the abort fired", async () => {
    // An injected transport may ignore the signal and resolve late.
    await expect(
      requestWithTimeout(
        {
          fetch: () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("{}")), 40)),
          timeoutMs: 5,
          onFailure: failure,
        },
        "https://x",
        {},
      ),
    ).rejects.toMatchObject({ message: "timed out" });
  });

  it("threads an external AbortSignal through, including one already aborted", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      requestWithTimeout(
        {
          fetch: async () => new Response(new ReadableStream({ start() {} })),
          timeoutMs: 60_000,
          signal: preAborted.signal,
          onFailure: failure,
        },
        "https://x",
        {},
      ),
    ).rejects.toMatchObject({ message: "timed out" });

    const controller = new AbortController();
    const pending = requestWithTimeout(
      {
        fetch: async () => new Response(new ReadableStream({ start() {} })),
        timeoutMs: 60_000,
        signal: controller.signal,
        onFailure: failure,
      },
      "https://x",
      {},
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ message: "timed out" });
  });
});

describe("withTransportRetries", () => {
  const transient = () =>
    new PayFanoutError({ code: "psp_unavailable", message: "down", retryable: true, raw: undefined });

  it("retries transient failures with capped exponential backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withTransportRetries(
      async () => {
        calls += 1;
        if (calls < 5) throw transient();
        return "ok";
      },
      {
        attempts: 6,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(5);
    expect(sleeps).toEqual([250, 500, 1000, 2000]); // doubling, capped at 2s
  });

  it("gives up after the attempt budget and surfaces the last error", async () => {
    let calls = 0;
    await expect(
      withTransportRetries(
        async () => {
          calls += 1;
          throw transient();
        },
        { attempts: 3, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ code: "psp_unavailable" });
    expect(calls).toBe(3);
  });

  it("never retries what the predicate rejects", async () => {
    let calls = 0;
    await expect(
      withTransportRetries(
        async () => {
          calls += 1;
          throw new PayFanoutError({ code: "card_declined", message: "no", retryable: false, raw: undefined });
        },
        { attempts: 3, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ code: "card_declined" });
    expect(calls).toBe(1);
  });

  it("honors a custom isRetryable predicate", async () => {
    let calls = 0;
    await expect(
      withTransportRetries(
        async () => {
          calls += 1;
          throw new Error("plain");
        },
        { attempts: 2, sleep: async () => {}, isRetryable: (err) => err instanceof Error },
      ),
    ).rejects.toThrowError("plain");
    expect(calls).toBe(2);
  });
});

describe("isTransportRetryable", () => {
  it("accepts only rate_limited and psp_unavailable PayFanoutErrors", () => {
    const make = (code: "rate_limited" | "psp_unavailable" | "processing_error" | "invalid_request") =>
      new PayFanoutError({ code, message: "m", retryable: true, raw: undefined });
    expect(isTransportRetryable(make("rate_limited"))).toBe(true);
    expect(isTransportRetryable(make("psp_unavailable"))).toBe(true);
    // retryable-but-business (e.g. Paysafe 3406) must not spin the transport loop.
    expect(isTransportRetryable(make("processing_error"))).toBe(false);
    expect(isTransportRetryable(make("invalid_request"))).toBe(false);
    expect(isTransportRetryable(new Error("boom"))).toBe(false);
    expect(isTransportRetryable(undefined)).toBe(false);
  });
});

describe("safeJson", () => {
  it("parses JSON and answers undefined for anything else", () => {
    expect(safeJson('{"a":1}')).toEqual({ a: 1 });
    expect(safeJson("<html>502</html>")).toBeUndefined();
    expect(safeJson("")).toBeUndefined();
  });
});

describe("classifyHttpFallback", () => {
  it("maps 429, 5xx, and the caller-side rest", () => {
    expect(classifyHttpFallback(429)).toEqual({ code: "rate_limited", retryable: true });
    expect(classifyHttpFallback(500)).toEqual({ code: "psp_unavailable", retryable: true });
    expect(classifyHttpFallback(503)).toEqual({ code: "psp_unavailable", retryable: true });
    expect(classifyHttpFallback(400)).toEqual({ code: "invalid_request", retryable: false });
    expect(classifyHttpFallback(404)).toEqual({ code: "invalid_request", retryable: false });
    expect(classifyHttpFallback(409)).toEqual({ code: "invalid_request", retryable: false });
  });
});
