import { afterEach, describe, expect, it, vi } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import { runClientAdapterConformanceTests } from "@payfanout/conformance";
import {
  StripeClientAdapter,
  type StripeJsConfirmResult,
  type StripeJsElementLike,
  type StripeJsLike,
} from "../src/index.js";

function makeFakeStripeJs(confirmResult: StripeJsConfirmResult): StripeJsLike & {
  elementsCalls: Record<string, unknown>[];
  confirmPaymentCalls: Record<string, unknown>[];
  confirmSetupCalls: Record<string, unknown>[];
  element: StripeJsElementLike & { mounted: unknown; unmounted: boolean; destroyed: boolean };
} {
  const element = {
    mounted: undefined as unknown,
    unmounted: false,
    destroyed: false,
    handlers: new Map<string, (payload?: unknown) => void>(),
    mount(container: unknown) {
      this.mounted = container;
      this.handlers.get("ready")?.();
    },
    unmount() {
      this.unmounted = true;
    },
    destroy() {
      this.destroyed = true;
    },
    on(event: string, handler: (payload?: unknown) => void) {
      this.handlers.set(event, handler);
    },
  };
  const fake = {
    element: element as never,
    elementsCalls: [] as Record<string, unknown>[],
    confirmPaymentCalls: [] as Record<string, unknown>[],
    confirmSetupCalls: [] as Record<string, unknown>[],
    elements: (options: Record<string, unknown>) => {
      fake.elementsCalls.push(options);
      return { create: () => element as never };
    },
    confirmPayment: async (options: Record<string, unknown>) => {
      fake.confirmPaymentCalls.push(options);
      return confirmResult;
    },
    confirmSetup: async (options: Record<string, unknown>) => {
      fake.confirmSetupCalls.push(options);
      return confirmResult;
    },
  };
  return fake as never;
}

function makeAdapter(
  confirmResult: StripeJsConfirmResult = { paymentIntent: { status: "succeeded" } },
): { adapter: StripeClientAdapter; fake: ReturnType<typeof makeFakeStripeJs> } {
  const fake = makeFakeStripeJs(confirmResult);
  const adapter = new StripeClientAdapter({
    publishableKey: "pk_test_123",
    environment: "sandbox",
    getStripeGlobal: () => () => fake,
    loadScript: async () => {},
  });
  return { adapter, fake };
}

runClientAdapterConformanceTests("stripe", () => makeAdapter().adapter, {
  expectedMethodTypes: ["card", "apple_pay", "google_pay"],
});

describe("StripeClientAdapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubBrowser(): void {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
  }

  it("rejects mount during SSR with a clear error", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.mount({} as HTMLElement, { clientSecret: "x" })).rejects.toThrowError(/browser-only/);
  });

  it("mounts the Payment Element and fires onReady", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const container = { id: "pay" } as unknown as HTMLElement;
    let ready = false;
    await adapter.mount(container, {
      clientSecret: "pi_1_secret_x",
      appearance: { theme: "flat" },
      onReady: () => {
        ready = true;
      },
    });
    expect(fake.element.mounted).toBe(container);
    expect(ready).toBe(true);
  });

  it("translates common appearance tokens into Stripe variables, native keys winning on conflict", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    await adapter.mount({ id: "pay" } as unknown as HTMLElement, {
      clientSecret: "pi_1_secret_x",
      appearance: { colorPrimary: "#7c3aed", fontSize: "15px", theme: "flat", variables: { colorText: "#111" } },
    });
    expect(fake.elementsCalls[0]!["appearance"]).toEqual({
      theme: "flat",
      variables: { colorPrimary: "#7c3aed", fontSizeBase: "15px", colorText: "#111" },
    });
  });

  it("forwards a native Stripe appearance unchanged when no common tokens are present", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    await adapter.mount({ id: "pay" } as unknown as HTMLElement, {
      clientSecret: "pi_1_secret_x",
      appearance: { theme: "flat", variables: { colorPrimary: "#635bff" } },
    });
    expect(fake.elementsCalls[0]!["appearance"]).toEqual({ theme: "flat", variables: { colorPrimary: "#635bff" } });
  });

  it("maps common tokens into variables with no native Stripe appearance present", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    await adapter.mount({ id: "pay" } as unknown as HTMLElement, {
      clientSecret: "pi_1_secret_x",
      appearance: { colorPrimary: "#7c3aed", fontSize: "15px" },
    });
    expect(fake.elementsCalls[0]!["appearance"]).toEqual({ variables: { colorPrimary: "#7c3aed", fontSizeBase: "15px" } });
  });

  it("confirm() finalizes on the client and never returns a clientToken (§4a confirm-on-client shape)", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter({ paymentIntent: { status: "succeeded" } });
    const handle = await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret_x" });
    const result = await adapter.confirm(handle);
    expect(result.status).toBe("succeeded");
    expect(result.clientToken).toBeUndefined();
    expect(result.error).toBeUndefined();
    // Inline 3DS: no full-page navigation.
    expect(fake.confirmPaymentCalls[0]!["redirect"]).toBe("if_required");
  });

  it("routes seti_ client secrets through confirmSetup (zero-amount verification sessions)", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter({ setupIntent: { status: "succeeded" } });
    const handle = await adapter.mount({} as HTMLElement, { clientSecret: "seti_1_secret_x" });
    const result = await adapter.confirm(handle);
    expect(result.status).toBe("succeeded");
    expect(fake.confirmSetupCalls).toHaveLength(1);
    expect(fake.confirmPaymentCalls).toHaveLength(0);
  });

  it("maps confirm errors to the unified taxonomy with raw preserved", async () => {
    stubBrowser();
    const declined = { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Insufficient funds." };
    const { adapter } = makeAdapter({ error: declined });
    const handle = await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret_x" });
    const result = await adapter.confirm(handle);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("insufficient_funds");
    expect(result.error?.raw).toBe(declined);
    expect(isPayFanoutError(result.error)).toBe(true);
  });

  it("unmounts and destroys the element", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const handle = await adapter.mount({} as HTMLElement, { clientSecret: "pi_1_secret_x" });
    adapter.unmount(handle);
    expect(fake.element.unmounted).toBe(true);
    expect(fake.element.destroyed).toBe(true);
  });

  it("rejects foreign handles", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.confirm({} as never)).rejects.toThrowError(/not produced by StripeClientAdapter/);
  });
});
