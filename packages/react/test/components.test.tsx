// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getUiLabel, type PaymentInfo } from "@payfanout/core";
import { PayButton, PayFanoutProvider, PaymentFields, usePayFanout, type PayResult } from "../src/index.js";
import { deferred, FakeClientAdapter } from "./fake-client-adapter.js";

afterEach(cleanup);

function StatusProbe(): JSX.Element {
  const { status, activePsp, availablePsps } = usePayFanout();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="active">{activePsp}</span>
      <span data-testid="available">{availablePsps.join(",")}</span>
    </div>
  );
}

const paymentInfo: PaymentInfo = {
  id: "order-1",
  pspName: "fakepsp",
  pspPaymentId: "pay_1",
  status: "succeeded",
  amount: 1000,
  amountRefunded: 0,
  currency: "USD",
  paymentMethodType: "card",
  createdAt: "2026-07-04T00:00:00.000Z",
  raw: {},
};

describe("PayFanoutProvider / usePayFanout", () => {
  it("registers adapters, tracks the active PSP, and lists capabilities", async () => {
    const a = new FakeClientAdapter("stripe");
    const b = new FakeClientAdapter("paysafe");
    render(
      <PayFanoutProvider adapters={[a, b]} initialPsp="paysafe">
        <StatusProbe />
      </PayFanoutProvider>,
    );
    expect(screen.getByTestId("active").textContent).toBe("paysafe");
    expect(screen.getByTestId("available").textContent).toBe("stripe,paysafe");
    // Provider never loads SDKs eagerly — only PaymentFields does.
    expect(a.loadSdkCalls + b.loadSdkCalls).toBe(0);
  });

  it("throws on duplicate adapters and on hooks used outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dup = [new FakeClientAdapter("x"), new FakeClientAdapter("x")];
    expect(() =>
      render(
        <PayFanoutProvider adapters={dup}>
          <div />
        </PayFanoutProvider>,
      ),
    ).toThrowError(/duplicate client adapter/);
    expect(() => render(<StatusProbe />)).toThrowError(/inside <PayFanoutProvider>/);
    spy.mockRestore();
  });

  it("throws when initialPsp names an unregistered adapter", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <PayFanoutProvider adapters={[new FakeClientAdapter("stripe")]} initialPsp="stripee">
          <div />
        </PayFanoutProvider>,
      ),
    ).toThrowError(/no client adapter registered for psp "stripee"/);
    spy.mockRestore();
  });
});

describe("PaymentFields", () => {
  it("lazily loads the SDK, mounts the adapter into its container, and reports ready", async () => {
    const adapter = new FakeClientAdapter();
    const onReady = vi.fn();
    render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="cs_1" appearance={{ theme: "flat" }} onReady={onReady} />
        <StatusProbe />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"));
    expect(adapter.loadSdkCalls).toBe(1);
    expect(adapter.mountCalls).toHaveLength(1);
    expect(adapter.mountCalls[0]!.clientSecret).toBe("cs_1");
    expect(adapter.mountCalls[0]!.appearance).toEqual({ theme: "flat" });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-payfanout-fields="fakepsp"]')).not.toBeNull();
  });

  it("unmounts the adapter on component teardown", async () => {
    const adapter = new FakeClientAdapter();
    const view = render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="cs_1" />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));
    view.unmount();
    expect(adapter.unmountCalls).toBe(1);
  });

  it("survives the unmount-while-still-mounting race without leaking a handle", async () => {
    const adapter = new FakeClientAdapter();
    adapter.mountGate = deferred<void>();
    const view = render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="cs_1" />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));
    view.unmount(); // React tears down while the adapter is still awaiting its SDK
    adapter.mountGate.resolve();
    await waitFor(() => expect(adapter.unmountCalls).toBe(1)); // late handle cleaned up, not leaked
  });

  it("surfaces mount failures through onError and the unified status", async () => {
    const adapter = new FakeClientAdapter();
    adapter.mountError = new Error("SDK exploded");
    const onError = vi.fn();
    render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="cs_1" onError={onError} />
        <StatusProbe />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("error"));
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]![0] as { code: string; raw: unknown };
    expect(err.code).toBe("unknown");
    expect(err.raw).toBe(adapter.mountError);
  });

  it("errors cleanly when the requested psp has no registered adapter", async () => {
    const adapter = new FakeClientAdapter();
    const onError = vi.fn();
    render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields psp="ghost" clientSecret="cs_1" onError={onError} />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect((onError.mock.calls[0]![0] as { code: string }).code).toBe("invalid_request");
    expect(adapter.mountCalls).toHaveLength(0);
  });

  it("errors explicitly when there is no PSP to mount at all", async () => {
    const onError = vi.fn();
    render(
      <PayFanoutProvider adapters={[]}>
        <PaymentFields clientSecret="cs_1" onError={onError} />
        <StatusProbe />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("error"));
    const err = onError.mock.calls[0]![0] as { code: string; message: string };
    expect(err.code).toBe("invalid_request");
    expect(err.message).toMatch(/No PSP to mount/);
  });

  it("does not remount the hosted fields when the adapters array identity changes", async () => {
    const adapter = new FakeClientAdapter();
    const view = render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="cs_1" />
        <StatusProbe />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"));

    // New array, same adapter instance — a host passing an inline `adapters`
    // prop does this on every render; typed card data must survive it.
    view.rerender(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="cs_1" />
        <StatusProbe />
      </PayFanoutProvider>,
    );
    await act(async () => {});
    expect(adapter.mountCalls).toHaveLength(1);
    expect(adapter.unmountCalls).toBe(0);
    expect(screen.getByTestId("status").textContent).toBe("ready");
  });

  it("rejects a second concurrent instance without disturbing the first", async () => {
    const adapter = new FakeClientAdapter();
    const onError2 = vi.fn();
    const results: PayResult[] = [];
    const checkout = (second: boolean): JSX.Element => (
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="cs_1" />
        {second ? <PaymentFields clientSecret="cs_2" onError={onError2} /> : null}
        <PayButton onResult={(r) => void results.push(r)}>Pay now</PayButton>
        <StatusProbe />
      </PayFanoutProvider>
    );
    const view = render(checkout(false));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"));

    view.rerender(checkout(true));
    await waitFor(() => expect(onError2).toHaveBeenCalledTimes(1));
    const err = onError2.mock.calls[0]![0] as { code: string; message: string };
    expect(err.code).toBe("invalid_request");
    expect(err.message).toMatch(/one <PaymentFields>/);
    expect(adapter.mountCalls).toHaveLength(1); // the second never mounted

    // The first instance still owns the mounted fields and still confirms.
    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));
    await waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toEqual({ status: "succeeded" });

    // Unmounting the rejected instance must not release the first's slot.
    view.rerender(checkout(false));
    await act(async () => {});
    expect(adapter.unmountCalls).toBe(0);
    expect(screen.getByTestId("status").textContent).not.toBe("idle");
    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));
    await waitFor(() => expect(results).toHaveLength(2));
    expect(results[1]).toEqual({ status: "succeeded" });
  });
});

describe("PayButton", () => {
  async function renderCheckout(
    adapter: FakeClientAdapter,
    props: { onResult: (r: PayResult) => void; onServerCompletion?: (token: string) => Promise<PaymentInfo> },
  ): Promise<void> {
    render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="cs_1" />
        <PayButton {...props}>Pay now</PayButton>
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));
  }

  it("confirms the mounted fields and reports the confirm-on-client result", async () => {
    const adapter = new FakeClientAdapter();
    const results: PayResult[] = [];
    await renderCheckout(adapter, { onResult: (r) => void results.push(r) });
    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));
    await waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toEqual({ status: "succeeded" });
    expect(adapter.confirmCalls).toBe(1);
  });

  it("routes tokenize-first confirms through onServerCompletion (§4a, same button)", async () => {
    const adapter = new FakeClientAdapter();
    adapter.confirmImpl = async () => ({ status: "requires_confirmation", clientToken: "SPtok_9" });
    const tokens: string[] = [];
    const results: PayResult[] = [];
    await renderCheckout(adapter, {
      onResult: (r) => void results.push(r),
      onServerCompletion: async (token) => {
        tokens.push(token);
        return paymentInfo;
      },
    });
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(results).toHaveLength(1));
    expect(tokens).toEqual(["SPtok_9"]);
    expect(results[0]!.status).toBe("succeeded");
    expect(results[0]!.info).toBe(paymentInfo);
  });

  it("disables itself while a confirmation is in flight (no double submit)", async () => {
    const adapter = new FakeClientAdapter();
    const gate = deferred<void>();
    adapter.confirmImpl = async () => {
      await gate.promise;
      return { status: "succeeded" };
    };
    const results: PayResult[] = [];
    await renderCheckout(adapter, { onResult: (r) => void results.push(r) });
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.getAttribute("aria-busy")).toBe("false");
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button); // ignored while submitting
    gate.resolve();
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(adapter.confirmCalls).toBe(1);
    expect(results).toHaveLength(1);
  });

  it("fails loudly when clicked with no mounted fields", async () => {
    const adapter = new FakeClientAdapter();
    const results: PayResult[] = [];
    render(
      <PayFanoutProvider adapters={[adapter]}>
        <PayButton onResult={(r) => void results.push(r)} />
      </PayFanoutProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.error?.code).toBe("invalid_request");
    expect(results[0]!.error?.message).toMatch(/PaymentFields/);
  });
});

describe("PayButton with provider completionEndpoint (derived onServerCompletion)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("derives server completion from completionEndpoint for tokenize-first PSPs", async () => {
    const adapter = new FakeClientAdapter();
    adapter.confirmImpl = async () => ({ status: "requires_confirmation", clientToken: "SPtok_42" });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(paymentInfo), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const results: PayResult[] = [];
    render(
      <PayFanoutProvider adapters={[adapter]} completionEndpoint="/api/complete">
        <PaymentFields clientSecret="cs_ref_1" />
        <PayButton onResult={(r) => void results.push(r)}>Pay now</PayButton>
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));

    await waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]!.status).toBe("succeeded");
    expect(results[0]!.info).toEqual(paymentInfo);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/complete");
    // The mounted clientSecret is the completion reference — no host-minted id needed.
    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).toEqual({ sessionRef: "cs_ref_1", clientToken: "SPtok_42" });
  });

  it("lets an explicit onServerCompletion override the endpoint", async () => {
    const adapter = new FakeClientAdapter();
    adapter.confirmImpl = async () => ({ status: "requires_confirmation", clientToken: "SPtok_7" });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(paymentInfo), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const explicit = vi.fn(async () => paymentInfo);
    const results: PayResult[] = [];
    render(
      <PayFanoutProvider adapters={[adapter]} completionEndpoint="/api/complete">
        <PaymentFields clientSecret="cs_ref_1" />
        <PayButton onResult={(r) => void results.push(r)} onServerCompletion={explicit}>
          Pay now
        </PayButton>
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));

    await waitFor(() => expect(results).toHaveLength(1));
    expect(explicit).toHaveBeenCalledWith("SPtok_7");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards PayButton billingDetails to the completion endpoint", async () => {
    const adapter = new FakeClientAdapter();
    adapter.confirmImpl = async () => ({ status: "requires_confirmation", clientToken: "SPtok_z" });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(paymentInfo), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PayFanoutProvider adapters={[adapter]} completionEndpoint="/c">
        <PaymentFields clientSecret="cs_x" />
        <PayButton onResult={() => {}} billingDetails={{ address: { postalCode: "94107" } }}>
          Pay now
        </PayButton>
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).toEqual({
      sessionRef: "cs_x",
      clientToken: "SPtok_z",
      billingDetails: { address: { postalCode: "94107" } },
    });
  });

  it("still fails loudly for a tokenize-first PSP when neither endpoint nor callback is set", async () => {
    const adapter = new FakeClientAdapter();
    adapter.confirmImpl = async () => ({ status: "requires_confirmation", clientToken: "SPtok_x" });
    const results: PayResult[] = [];
    render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="cs_1" />
        <PayButton onResult={(r) => void results.push(r)}>Pay now</PayButton>
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));

    await waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.error?.code).toBe("invalid_request");
    expect(results[0]!.error?.message).toMatch(/completionEndpoint/);
  });
});

describe("PayButton localization", () => {
  it("defaults to the built-in English label with no locale", () => {
    render(
      <PayFanoutProvider adapters={[new FakeClientAdapter()]}>
        <PayButton onResult={() => {}} />
      </PayFanoutProvider>,
    );
    expect(screen.getByRole("button").textContent).toBe("Pay");
  });

  it("uses the provider locale's built-in label (fr)", () => {
    render(
      <PayFanoutProvider adapters={[new FakeClientAdapter()]} locale="fr">
        <PayButton onResult={() => {}} />
      </PayFanoutProvider>,
    );
    const label = screen.getByRole("button").textContent;
    expect(label).toBe(getUiLabel("pay", "fr"));
    expect(label).not.toBe("Pay"); // proves a real French translation ships
  });

  it("falls back to English for an unknown locale, and lets children override", () => {
    render(
      <PayFanoutProvider adapters={[new FakeClientAdapter()]} locale="zz">
        <PayButton onResult={() => {}} />
      </PayFanoutProvider>,
    );
    expect(screen.getByRole("button").textContent).toBe("Pay");
    cleanup();
    render(
      <PayFanoutProvider adapters={[new FakeClientAdapter()]} locale="de">
        <PayButton onResult={() => {}}>Jetzt kaufen</PayButton>
      </PayFanoutProvider>,
    );
    expect(screen.getByRole("button").textContent).toBe("Jetzt kaufen");
  });
});
