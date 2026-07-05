import { describe, expect, it } from "vitest";
import { defaultShouldRetry, PayFanoutError, withRetry } from "../src/index.js";

const transient = (): PayFanoutError =>
  new PayFanoutError({ code: "psp_unavailable", message: "down", retryable: true });
const terminal = (): PayFanoutError =>
  new PayFanoutError({ code: "card_declined", message: "no", retryable: false });

/** Records requested delays instead of sleeping. */
function fakeSleep(): { sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

describe("withRetry", () => {
  it("retries retryable PayFanoutErrors with exponential backoff, then succeeds", async () => {
    const { sleeps, sleep } = fakeSleep();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw transient();
        return "ok";
      },
      { retries: 3, sleep, jitter: false },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([200, 400]); // 200 * 2^(attempt-1)
  });

  it("gives up after the retry budget and rethrows the last error", async () => {
    const { sleeps, sleep } = fakeSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw transient();
        },
        { retries: 2, sleep, jitter: false },
      ),
    ).rejects.toMatchObject({ code: "psp_unavailable" });
    expect(calls).toBe(3); // initial + 2 retries
    expect(sleeps).toHaveLength(2);
  });

  it("rethrows non-retryable errors immediately — declines are never replayed", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw terminal();
      }),
    ).rejects.toMatchObject({ code: "card_declined" });
    expect(calls).toBe(1);
  });

  it("caps the backoff at maxDelayMs and applies bounded jitter", async () => {
    const { sleeps, sleep } = fakeSleep();
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 5) throw transient();
        return "ok";
      },
      { retries: 4, minDelayMs: 1000, maxDelayMs: 1500, sleep, random: () => 1 },
    );
    // base delays: 1000, 1500(cap), 1500, 1500 — jitter ×1.25 with random()=1
    expect(sleeps).toEqual([1250, 1875, 1875, 1875]);
  });

  it("honors a custom shouldRetry and reports attempts via onRetry", async () => {
    const seen: Array<{ attempt: number; delayMs: number }> = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("plain error, not a PayFanoutError");
        return calls;
      },
      {
        shouldRetry: (err) => err instanceof Error,
        onRetry: (_err, attempt, delayMs) => seen.push({ attempt, delayMs }),
        sleep: async () => {},
        jitter: false,
      },
    );
    expect(result).toBe(2);
    expect(seen).toEqual([{ attempt: 1, delayMs: 200 }]);
  });

  it("defaultShouldRetry accepts only retryable PayFanoutErrors", () => {
    expect(defaultShouldRetry(transient())).toBe(true);
    expect(defaultShouldRetry(terminal())).toBe(false);
    expect(defaultShouldRetry(new Error("boom"))).toBe(false);
    expect(defaultShouldRetry(undefined)).toBe(false);
  });

  it("passes through an immediate success untouched", async () => {
    await expect(withRetry(async () => 42)).resolves.toBe(42);
  });
});
