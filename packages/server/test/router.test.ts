import { describe, expect, it } from "vitest";
import { isPayFanoutError, PayFanoutError, type CreatePaymentSessionInput } from "@payfanout/core";
import { defaultShouldFailover, PaymentRouter, PaymentService } from "../src/index.js";
import { FakeAdapter } from "./fake-adapter.js";

const input = (overrides: Partial<CreatePaymentSessionInput> = {}): CreatePaymentSessionInput => ({
  amount: 1000,
  currency: "USD",
  idempotencyKey: "route-key",
  ...overrides,
});

function twoPspService(): { service: PaymentService; a: FakeAdapter; b: FakeAdapter } {
  const a = new FakeAdapter({ pspName: "psp-a" });
  const b = new FakeAdapter({ pspName: "psp-b" });
  return { service: new PaymentService({ adapters: [a, b] }), a, b };
}

/** Makes the adapter's createPaymentSession reject with the given error. */
function failWith(adapter: FakeAdapter, error: PayFanoutError): void {
  adapter.createPaymentSession = async () => {
    adapter.calls.push({ method: "createPaymentSession", args: [] });
    throw error;
  };
}

describe("PaymentRouter construction", () => {
  it("rejects rules and chains that reference unregistered PSPs", () => {
    const { service } = twoPspService();
    expect(
      () => new PaymentRouter({ service, rules: [{ when: {}, use: ["psp-c"] }] }),
    ).toThrowError(/not registered/);
    expect(() => new PaymentRouter({ service, defaultChain: ["ghost"] })).toThrowError(/not registered/);
    expect(() => new PaymentRouter({ service, rules: [{ use: [] }] })).toThrowError(/at least one PSP/);
  });

  it("rejects an empty registry-derived default chain", () => {
    const service = new PaymentService({ adapters: [] });
    expect(() => new PaymentRouter({ service })).toThrowError(/at least one PSP/);
  });
});

describe("PaymentRouter rule selection", () => {
  const { service } = twoPspService();
  const router = new PaymentRouter({
    service,
    rules: [
      { when: { currency: ["eur", "GBP"] }, use: ["psp-b", "psp-a"] },
      { when: { country: ["CA"] }, use: ["psp-b"] },
      { when: { currency: ["USD"], country: ["US"] }, use: ["psp-a"] },
      { when: { paymentMethodType: ["ideal"] }, use: ["psp-b"] },
    ],
  });

  it("first matching rule wins; no match falls back to registration order", () => {
    expect(router.selectChain(input({ currency: "EUR" }))).toEqual(["psp-b", "psp-a"]);
    expect(router.selectChain(input({ currency: "gbp" }))).toEqual(["psp-b", "psp-a"]); // case-insensitive
    expect(router.selectChain(input({ currency: "CAD", country: "ca" }))).toEqual(["psp-b"]);
    expect(router.selectChain(input({ currency: "USD", country: "US" }))).toEqual(["psp-a"]);
    expect(router.selectChain(input({ currency: "JPY" }))).toEqual(["psp-a", "psp-b"]);
  });

  it("AND-combines conditions — a partially matching rule does not fire", () => {
    // currency matches the third rule but country is missing -> rule skipped.
    expect(router.selectChain(input({ currency: "USD" }))).toEqual(["psp-a", "psp-b"]);
  });

  it("method-type conditions only match sessions that restrict method types", () => {
    expect(router.selectChain(input({ currency: "JPY", paymentMethodTypes: ["ideal"] }))).toEqual(["psp-b"]);
    expect(router.selectChain(input({ currency: "JPY", paymentMethodTypes: ["card"] }))).toEqual([
      "psp-a",
      "psp-b",
    ]);
  });

  it("never throws on unnormalizable currencies in rule matching", () => {
    expect(router.selectChain(input({ currency: "not-a-currency" }))).toEqual(["psp-a", "psp-b"]);
  });
});

describe("PaymentRouter failover cascade", () => {
  it("returns the first success with an empty attempts list", async () => {
    const { service } = twoPspService();
    const router = new PaymentRouter({ service });
    const result = await router.createPaymentSession(input());
    expect(result.pspName).toBe("psp-a");
    expect(result.session.pspName).toBe("psp-a");
    expect(result.attempts).toEqual([]);
  });

  it("cascades on transient errors and reports the failed attempt", async () => {
    const { service, a } = twoPspService();
    failWith(a, new PayFanoutError({ code: "psp_unavailable", message: "down", retryable: true, pspName: "psp-a" }));
    const seen: string[] = [];
    const router = new PaymentRouter({
      service,
      onAttempt: (attempt) => seen.push(`${attempt.pspName}:${attempt.ok ? "ok" : (attempt.error?.code ?? "?")}`),
    });
    const result = await router.createPaymentSession(input());
    expect(result.pspName).toBe("psp-b");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ pspName: "psp-a", skipped: false });
    expect(result.attempts[0]!.error.code).toBe("psp_unavailable");
    expect(seen).toEqual(["psp-a:psp_unavailable", "psp-b:ok"]);
  });

  it("a throwing onAttempt hook never breaks routing — skip, failure, and success stages all fire", async () => {
    const noManual = new FakeAdapter({
      pspName: "no-manual",
      capabilities: { supportsManualCapture: false, supportsMultiCapture: false },
    });
    const flaky = new FakeAdapter({ pspName: "flaky" });
    failWith(flaky, new PayFanoutError({ code: "psp_unavailable", message: "down", retryable: true, pspName: "flaky" }));
    const winner = new FakeAdapter({ pspName: "winner" });
    const service = new PaymentService({ adapters: [noManual, flaky, winner] });
    const stages: string[] = [];
    const router = new PaymentRouter({
      service,
      onAttempt: (attempt) => {
        stages.push(`${attempt.pspName}:${attempt.ok ? "ok" : attempt.skipped ? "skipped" : "failed"}`);
        throw new Error("observer down");
      },
    });

    const result = await router.createPaymentSession(input({ captureMethod: "manual" }));
    expect(result.pspName).toBe("winner");
    expect(result.attempts).toHaveLength(2);
    expect(stages).toEqual(["no-manual:skipped", "flaky:failed", "winner:ok"]);
  });

  it("does NOT cascade business rejections — the error surfaces immediately", async () => {
    const { service, a, b } = twoPspService();
    failWith(a, new PayFanoutError({ code: "invalid_request", message: "bad request", retryable: false }));
    const router = new PaymentRouter({ service });
    await expect(router.createPaymentSession(input())).rejects.toMatchObject({ code: "invalid_request" });
    expect(b.calls.length).toBe(0); // never reached
  });

  it("rethrows the last error when every candidate fails", async () => {
    const { service, a, b } = twoPspService();
    failWith(a, new PayFanoutError({ code: "rate_limited", message: "slow down", retryable: true }));
    failWith(b, new PayFanoutError({ code: "psp_unavailable", message: "also down", retryable: true }));
    const router = new PaymentRouter({ service });
    await expect(router.createPaymentSession(input())).rejects.toMatchObject({ code: "psp_unavailable" });
  });

  it("carries the earlier attempts trail on the final error's raw when every candidate fails", async () => {
    const { service, a, b } = twoPspService();
    const pspRaw = { incident: "b-outage" };
    failWith(a, new PayFanoutError({ code: "rate_limited", message: "slow down", retryable: true, pspName: "psp-a" }));
    failWith(
      b,
      new PayFanoutError({ code: "psp_unavailable", message: "also down", retryable: true, pspName: "psp-b", raw: pspRaw }),
    );
    const router = new PaymentRouter({ service });
    try {
      await router.createPaymentSession(input());
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("psp_unavailable");
        expect(err.pspName).toBe("psp-b");
        expect(err.raw).toEqual({
          pspError: pspRaw,
          attempts: [
            { pspName: "psp-a", code: "rate_limited", message: "slow down" },
            { pspName: "psp-b", code: "psp_unavailable", message: "also down" },
          ],
        });
      }
    }
  });

  it("a failure with no earlier attempts rethrows the adapter error untouched", async () => {
    const { service, a } = twoPspService();
    const declined = new PayFanoutError({
      code: "card_declined",
      message: "no",
      retryable: false,
      pspName: "psp-a",
      raw: { decline_code: "generic_decline" },
    });
    failWith(a, declined);
    const router = new PaymentRouter({ service });
    await expect(router.createPaymentSession(input())).rejects.toBe(declined);
  });

  it("honors a custom shouldFailover", async () => {
    const { service, a } = twoPspService();
    failWith(a, new PayFanoutError({ code: "card_declined", message: "no", retryable: false }));
    const router = new PaymentRouter({ service, shouldFailover: (err) => err.code === "card_declined" });
    const result = await router.createPaymentSession(input());
    expect(result.pspName).toBe("psp-b");
  });

  it("skips capability-ineligible candidates without a PSP call", async () => {
    const noManual = new FakeAdapter({
      pspName: "no-manual",
      capabilities: { supportsManualCapture: false, supportsMultiCapture: false },
    });
    const full = new FakeAdapter({ pspName: "full" });
    const service = new PaymentService({ adapters: [noManual, full] });
    const router = new PaymentRouter({ service });

    const result = await router.createPaymentSession(input({ captureMethod: "manual" }));
    expect(result.pspName).toBe("full");
    expect(result.attempts[0]).toMatchObject({ pspName: "no-manual", skipped: true });
    expect(noManual.calls.length).toBe(0); // screened out before any adapter call

    // Zero-amount verification screening.
    const noVerify = new FakeAdapter({
      pspName: "no-verify",
      capabilities: { supportsPaymentMethodVerification: false },
    });
    const verifying = new FakeAdapter({ pspName: "verifying" });
    const router2 = new PaymentRouter({
      service: new PaymentService({ adapters: [noVerify, verifying] }),
    });
    const verification = await router2.createPaymentSession(input({ amount: 0 }));
    expect(verification.pspName).toBe("verifying");

    // Method-type screening: candidate supports none of the requested types.
    const cardOnly = new FakeAdapter({ pspName: "card-only" });
    const idealCapable = new FakeAdapter({
      pspName: "ideal-capable",
      capabilities: {
        paymentMethods: [
          { type: "card", flow: "embedded", supported: true },
          { type: "ideal", flow: "redirect", supported: true },
        ],
      },
    });
    const router3 = new PaymentRouter({
      service: new PaymentService({ adapters: [cardOnly, idealCapable] }),
    });
    const idealResult = await router3.createPaymentSession(input({ paymentMethodTypes: ["ideal"] }));
    expect(idealResult.pspName).toBe("ideal-capable");
    expect(cardOnly.calls.length).toBe(0);
  });

  it("fails a currency-ineligible rail over to a PSP that settles it", async () => {
    // A host offering "pay by bank debit" in GBP. Both PSPs do bank debit and
    // both take GBP — but SEPA settles in EUR only, so the euro PSP cannot
    // serve this payment. Before the per-method gate it looked available and
    // the cascade died on its PSP-local rejection instead of failing over.
    const sepaPsp = new FakeAdapter({
      pspName: "sepa-psp",
      capabilities: {
        paymentMethods: [{ type: "sepa_debit", flow: "embedded", supported: true, currencies: ["EUR"] }],
      },
    });
    const bacsPsp = new FakeAdapter({
      pspName: "bacs-psp",
      capabilities: {
        paymentMethods: [{ type: "bacs_debit", flow: "embedded", supported: true, currencies: ["GBP"] }],
      },
    });
    const router = new PaymentRouter({
      service: new PaymentService({ adapters: [sepaPsp, bacsPsp] }),
    });

    const result = await router.createPaymentSession(
      input({ currency: "GBP", paymentMethodTypes: ["sepa_debit", "bacs_debit"] }),
    );
    expect(result.pspName).toBe("bacs-psp");
    expect(result.attempts[0]).toMatchObject({ pspName: "sepa-psp", skipped: true });
    expect(result.attempts[0]?.error.message).toMatch(/in GBP/);
    expect(sepaPsp.calls.length).toBe(0); // screened out before any adapter call
  });

  it("fails with a diagnostic error when every candidate is ineligible", async () => {
    const noManualA = new FakeAdapter({
      pspName: "nm-a",
      capabilities: { supportsManualCapture: false, supportsMultiCapture: false },
    });
    const noManualB = new FakeAdapter({
      pspName: "nm-b",
      capabilities: { supportsManualCapture: false, supportsMultiCapture: false },
    });
    const router = new PaymentRouter({
      service: new PaymentService({ adapters: [noManualA, noManualB] }),
    });
    try {
      await router.createPaymentSession(input({ captureMethod: "manual" }));
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("invalid_request");
        expect(err.message).toMatch(/No PSP in the routing chain/);
        expect(Array.isArray(err.raw)).toBe(true); // per-candidate diagnostics preserved
      }
    }
  });
});

describe("PaymentRouter circuit breaker", () => {
  const transientError = () =>
    new PayFanoutError({ code: "psp_unavailable", message: "down", retryable: true });

  /** Router with a 2-failure threshold, 1s cooldown, and a hand-cranked clock. */
  function breakerSetup(): {
    router: PaymentRouter;
    a: FakeAdapter;
    b: FakeAdapter;
    clock: { now: number };
  } {
    const { service, a, b } = twoPspService();
    const clock = { now: 100_000 };
    const router = new PaymentRouter({
      service,
      circuitBreaker: { failureThreshold: 2, cooldownMs: 1000, now: () => clock.now },
    });
    return { router, a, b, clock };
  }

  it("opens after consecutive transient failures and skips the PSP without calling it", async () => {
    const { router, a } = breakerSetup();
    failWith(a, transientError());
    await router.createPaymentSession(input()); // failure 1 -> psp-b wins
    await router.createPaymentSession(input()); // failure 2 -> circuit opens
    const callsBefore = a.calls.length;

    const routed = await router.createPaymentSession(input());
    expect(routed.pspName).toBe("psp-b");
    expect(a.calls.length).toBe(callsBefore); // psp-a never called — circuit open
    expect(routed.attempts[0]).toMatchObject({ pspName: "psp-a", skipped: true });
    expect(routed.attempts[0]!.error.message).toMatch(/circuit breaker/);
  });

  it("a business rejection proves the PSP alive and resets the failure count", async () => {
    const { router, a } = breakerSetup();
    failWith(a, transientError());
    await router.createPaymentSession(input()); // failure 1
    // PSP answers with a business rejection -> counter resets…
    failWith(a, new PayFanoutError({ code: "card_declined", message: "no", retryable: false }));
    await router.createPaymentSession(input()).catch(() => undefined); // aborts cascade, resets breaker
    // …so one more transient failure is 1/2, not 2/2: psp-a is still attempted.
    failWith(a, transientError());
    const routed = await router.createPaymentSession(input());
    expect(routed.attempts[0]).toMatchObject({ pspName: "psp-a", skipped: false });
  });

  it("half-opens after the cooldown: a successful probe closes the circuit", async () => {
    const { router, a, clock } = breakerSetup();
    failWith(a, transientError());
    await router.createPaymentSession(input());
    await router.createPaymentSession(input()); // open
    clock.now += 1001; // cooldown elapsed -> half-open

    // Heal the adapter; the probe goes through and closes the circuit.
    a.createPaymentSession = FakeAdapter.prototype.createPaymentSession.bind(a);
    const probe = await router.createPaymentSession(input());
    expect(probe.pspName).toBe("psp-a");
    const next = await router.createPaymentSession(input());
    expect(next.pspName).toBe("psp-a");
    expect(next.attempts).toEqual([]);
  });

  it("a failed half-open probe re-opens the circuit and restarts the cooldown", async () => {
    const { router, a, clock } = breakerSetup();
    failWith(a, transientError());
    await router.createPaymentSession(input());
    await router.createPaymentSession(input()); // open
    clock.now += 1001;

    const probe = await router.createPaymentSession(input()); // probe fails -> reopen
    expect(probe.attempts[0]).toMatchObject({ pspName: "psp-a", skipped: false });
    const callsAfterProbe = a.calls.length;

    clock.now += 500; // still inside the fresh cooldown
    const routed = await router.createPaymentSession(input());
    expect(routed.attempts[0]).toMatchObject({ pspName: "psp-a", skipped: true });
    expect(a.calls.length).toBe(callsAfterProbe);
  });

  it("desperation mode: when every candidate's circuit is open, they are attempted anyway", async () => {
    const { router, a, b, clock } = breakerSetup();
    failWith(a, transientError());
    failWith(b, transientError());
    for (let i = 0; i < 2; i++) await router.createPaymentSession(input()).catch(() => undefined);
    // Both circuits are now open and the cooldown has NOT elapsed.
    clock.now += 10;
    b.createPaymentSession = FakeAdapter.prototype.createPaymentSession.bind(b); // psp-b heals
    const routed = await router.createPaymentSession(input());
    expect(routed.pspName).toBe("psp-b"); // attempted despite the open circuit — not a self-inflicted outage
  });

  it("a throwing onAttempt hook never breaks a circuit-breaker skip", async () => {
    const { service, a } = twoPspService();
    failWith(a, transientError());
    const router = new PaymentRouter({
      service,
      circuitBreaker: { failureThreshold: 1, cooldownMs: 1000, now: () => 100_000 },
      onAttempt: () => {
        throw new Error("observer down");
      },
    });
    await router.createPaymentSession(input()); // failure opens psp-a's circuit
    const routed = await router.createPaymentSession(input());
    expect(routed.pspName).toBe("psp-b");
    expect(routed.attempts[0]).toMatchObject({ pspName: "psp-a", skipped: true });
    expect(routed.attempts[0]!.error.message).toMatch(/circuit breaker/);
  });

  it("circuitBreaker: false disables outage memory entirely", async () => {
    const { service, a } = twoPspService();
    failWith(a, transientError());
    const router = new PaymentRouter({ service, circuitBreaker: false });
    for (let i = 0; i < 6; i++) await router.createPaymentSession(input());
    const routed = await router.createPaymentSession(input());
    expect(routed.attempts[0]).toMatchObject({ pspName: "psp-a", skipped: false }); // still tried every time
  });

  it("getBreakerState snapshots failures, the open flag, and openUntil through the breaker lifecycle", async () => {
    const { router, a, clock } = breakerSetup(); // threshold 2, cooldown 1000ms, clock at 100_000
    expect(router.getBreakerState()).toEqual({});

    failWith(a, transientError());
    await router.createPaymentSession(input());
    expect(router.getBreakerState()).toEqual({ "psp-a": { consecutiveFailures: 1, open: false } });

    await router.createPaymentSession(input()); // threshold reached -> opens
    expect(router.getBreakerState()).toEqual({
      "psp-a": { consecutiveFailures: 2, open: true, openUntil: new Date(101_000).toISOString() },
    });

    clock.now += 1001; // cooldown elapsed: half-open — not skipped, failures remembered
    expect(router.getBreakerState()["psp-a"]).toMatchObject({
      consecutiveFailures: 2,
      open: false,
      openUntil: new Date(101_000).toISOString(),
    });

    a.createPaymentSession = FakeAdapter.prototype.createPaymentSession.bind(a);
    await router.createPaymentSession(input()); // successful probe closes the circuit
    expect(router.getBreakerState()).toEqual({});
  });

  it("onBreakerStateChange fires once per open and close transition and is exception-isolated", async () => {
    const { service, a } = twoPspService();
    const clock = { now: 100_000 };
    const transitions: string[] = [];
    const router = new PaymentRouter({
      service,
      circuitBreaker: { failureThreshold: 2, cooldownMs: 1000, now: () => clock.now },
      onBreakerStateChange: (event) => {
        transitions.push(`${event.pspName}:${event.state}`);
        throw new Error("observer down");
      },
    });
    failWith(a, transientError());
    await router.createPaymentSession(input()); // failure 1 — below threshold
    expect(transitions).toEqual([]);
    await router.createPaymentSession(input()); // failure 2 -> opened
    expect(transitions).toEqual(["psp-a:opened"]);

    clock.now += 1001;
    await router.createPaymentSession(input()); // failed probe: circuit never closed — no repeat event
    expect(transitions).toEqual(["psp-a:opened"]);

    clock.now += 1001;
    a.createPaymentSession = FakeAdapter.prototype.createPaymentSession.bind(a);
    const probe = await router.createPaymentSession(input()); // successful probe -> closed
    expect(probe.pspName).toBe("psp-a");
    expect(transitions).toEqual(["psp-a:opened", "psp-a:closed"]);
  });

  it("a business rejection on the half-open probe also closes the breaker — the PSP answered", async () => {
    const { router, a, clock } = breakerSetup();
    failWith(a, transientError());
    await router.createPaymentSession(input());
    await router.createPaymentSession(input()); // open
    clock.now += 1001;

    failWith(a, new PayFanoutError({ code: "card_declined", message: "no", retryable: false }));
    await router.createPaymentSession(input()).catch(() => undefined); // probe: business rejection aborts the cascade
    expect(router.getBreakerState()).toEqual({}); // …but proves the PSP alive
  });

  it("circuitBreaker: false keeps the snapshot empty and never fires transitions", async () => {
    const { service, a } = twoPspService();
    const transitions: string[] = [];
    failWith(a, transientError());
    const router = new PaymentRouter({
      service,
      circuitBreaker: false,
      onBreakerStateChange: (event) => transitions.push(`${event.pspName}:${event.state}`),
    });
    for (let i = 0; i < 6; i++) await router.createPaymentSession(input());
    expect(router.getBreakerState()).toEqual({});
    expect(transitions).toEqual([]);
  });
});

describe("defaultShouldFailover", () => {
  it("fails over on transient trouble only", () => {
    const transient = ["psp_unavailable", "rate_limited", "processing_error"] as const;
    for (const code of transient) {
      expect(defaultShouldFailover(new PayFanoutError({ code, message: "x", retryable: false }))).toBe(true);
    }
    expect(
      defaultShouldFailover(new PayFanoutError({ code: "card_declined", message: "x", retryable: true })),
    ).toBe(true); // adapter explicitly marked it retryable
    expect(
      defaultShouldFailover(new PayFanoutError({ code: "card_declined", message: "x", retryable: false })),
    ).toBe(false);
    expect(
      defaultShouldFailover(new PayFanoutError({ code: "invalid_request", message: "x", retryable: false })),
    ).toBe(false);
  });
});

describe("PaymentRouter capability screening (shared predicate with PaymentService)", () => {
  it("a vault session skips candidates without saved-payment-method support instead of aborting", async () => {
    const a = new FakeAdapter({ pspName: "psp-a" }); // no vault support
    const b = new FakeAdapter({ pspName: "psp-b", capabilities: { supportsSavedPaymentMethods: true } });
    const service = new PaymentService({ adapters: [a, b] });
    const router = new PaymentRouter({ service });

    const { pspName, attempts } = await router.createPaymentSession(
      input({ savePaymentMethod: true, customer: "cus_1" }),
    );
    expect(pspName).toBe("psp-b");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ pspName: "psp-a", skipped: true });
    expect(attempts[0]!.error.message).toMatch(/saved payment methods/);
    expect(a.calls.filter((c) => c.method === "createPaymentSession")).toHaveLength(0); // never burned a PSP call
  });

  it("a zero-amount save-card session is eligible on a vault-capable candidate", async () => {
    const b = new FakeAdapter({
      pspName: "psp-b",
      capabilities: { supportsSavedPaymentMethods: true, supportsPaymentMethodVerification: false },
    });
    const service = new PaymentService({ adapters: [b] });
    const router = new PaymentRouter({ service });

    const { pspName, attempts } = await router.createPaymentSession(
      input({ amount: 0, savePaymentMethod: true, customer: "cus_1" }),
    );
    expect(pspName).toBe("psp-b");
    expect(attempts).toHaveLength(0); // not skipped — the service accepts exactly this input
  });
});
