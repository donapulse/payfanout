// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaysafeClientAdapter } from "../src/index.js";

// The location stub below would otherwise leak into every later test in this file.
afterEach(() => vi.restoreAllMocks());

/** The payload half of a signed session context — the client never verifies the signature. */
function clientSecret(payload: Record<string, unknown>): string {
  const json = JSON.stringify({ v: 1, amount: 5_44, currency: "CAD", ...payload });
  const base64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${base64}.signature`;
}

const REDIRECT_URL = "https://api.test.paysafe.com/alternatepayments/v1/redirect?paymentHandleId=ph_1";

function makeAdapter(): PaysafeClientAdapter {
  return new PaysafeClientAdapter({
    apiKey: "cHVibGljOmtleQ==",
    environment: "sandbox",
    // Loading Paysafe.js would be a bug on this path — fail loudly if it happens.
    loadScript: () => Promise.reject(new Error("Paysafe.js must not load for a redirect rail")),
    getPaysafeGlobal: () => undefined,
  });
}

describe("Paysafe Interac e-Transfer client", () => {
  it("renders a panel without loading Paysafe.js", async () => {
    const container = document.createElement("div");
    const onReady = vi.fn();
    const handle = await makeAdapter().mount(container, {
      clientSecret: clientSecret({ redirectUrl: REDIRECT_URL }),
      onReady,
    });

    expect(handle).toBeTruthy();
    expect(container.querySelector("[data-payfanout-paysafe-panel]")).not.toBeNull();
    // No hosted card fields exist on this rail.
    expect(container.querySelector("iframe")).toBeNull();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("reports fields complete — there is nothing to fill in", async () => {
    const onChange = vi.fn();
    await makeAdapter().mount(document.createElement("div"), {
      clientSecret: clientSecret({ redirectUrl: REDIRECT_URL }),
      onChange,
    });
    expect(onChange).toHaveBeenNthCalledWith(1, { complete: false, empty: true });
    expect(onChange).toHaveBeenLastCalledWith({ complete: true });
  });

  it("lets the host override the panel text", async () => {
    const container = document.createElement("div");
    await makeAdapter().mount(container, {
      clientSecret: clientSecret({ redirectUrl: REDIRECT_URL }),
      fieldOptions: { description: "Continue to your bank" },
    });
    expect(container.querySelector("[data-payfanout-paysafe-panel]")?.textContent).toBe(
      "Continue to your bank",
    );
  });

  it("navigates to the Paysafe-hosted redirect on confirm", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      assign,
    } as unknown as Location);

    const adapter = makeAdapter();
    const handle = await adapter.mount(document.createElement("div"), {
      clientSecret: clientSecret({ redirectUrl: REDIRECT_URL }),
    });
    // confirm() never settles: the navigation unloads the page.
    void adapter.confirm(handle);
    await Promise.resolve();

    expect(assign).toHaveBeenCalledWith(REDIRECT_URL);
  });

  it("removes only its own panel on unmount", async () => {
    const container = document.createElement("div");
    const hostOwned = document.createElement("span");
    container.appendChild(hostOwned);

    const adapter = makeAdapter();
    const handle = await adapter.mount(container, {
      clientSecret: clientSecret({ redirectUrl: REDIRECT_URL }),
    });
    adapter.unmount(handle);

    expect(container.querySelector("[data-payfanout-paysafe-panel]")).toBeNull();
    expect(container.contains(hostOwned)).toBe(true);
  });

  it("resolves the marked return trip as needing server completion", async () => {
    // The clientToken is a placeholder (the handle token rides the signed
    // session context, and the server ignores the wire value once a handle is
    // minted) — but it must be non-empty, or the standard completion transport
    // never fires and the completion route rejects the request.
    await expect(
      makeAdapter().handleRedirectReturn({ search: "?payfanout_psp=paysafe&order=42" }),
    ).resolves.toEqual({ status: "requires_confirmation", clientToken: "paysafe-redirect-return" });
  });

  it("ignores a return URL that is not its own, so a router can probe every adapter", async () => {
    const adapter = makeAdapter();
    await expect(adapter.handleRedirectReturn({ search: "?billing_request_id=BRQ123" })).resolves.toBeNull();
    await expect(adapter.handleRedirectReturn({ search: "" })).resolves.toBeNull();
    await expect(adapter.handleRedirectReturn({ search: "?payfanout_psp=stripe" })).resolves.toBeNull();
  });

  it("models the rail honestly: redirect flow, and off until the account opts in", () => {
    const interac = makeAdapter()
      .listPaymentMethodCapabilities()
      .find((m) => m.type === "interac_etransfer");
    // Mirrors the server adapter: Canada/CAD and per-account enablement.
    expect(interac).toEqual({
      type: "interac_etransfer",
      flow: "redirect",
      supported: false,
      currencies: ["CAD"],
    });
  });
});
