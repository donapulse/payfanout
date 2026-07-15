// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaysafeClientAdapter, type PaysafeJsLike } from "../src/index.js";

// Containers attach to the document because jsdom runs checkbox activation
// (the change event mandate ticks rely on) only for connected elements.
afterEach(() => {
  document.body.innerHTML = "";
});

/** The payload half of a signed session context — the client never verifies the signature. */
function clientSecret(payload: Record<string, unknown>): string {
  const json = JSON.stringify({ v: 1, amount: 12_50, currency: "EUR", ...payload });
  return `${Buffer.from(json).toString("base64url")}.signature`;
}

function makeAdapter(): PaysafeClientAdapter {
  return new PaysafeClientAdapter({
    apiKey: "cHVibGljOmtleQ==",
    environment: "sandbox",
    // Loading Paysafe.js would be a bug on this path — fail loudly if it happens.
    loadScript: () => Promise.reject(new Error("Paysafe.js must not load for a bank-debit rail")),
    getPaysafeGlobal: () => undefined,
  });
}

const input = (container: HTMLElement, name: string): HTMLInputElement =>
  container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;

function fill(container: HTMLElement, name: string, value: string): void {
  const el = input(container, name);
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The exact wire format the server parses: "paysafe-bank." + base64url(JSON). */
function decodeEnvelope(clientToken: string | undefined): Record<string, unknown> {
  expect(clientToken).toMatch(/^paysafe-bank\./);
  const b64 = clientToken!.slice("paysafe-bank.".length);
  return JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as Record<string, unknown>;
}

interface RailCase {
  paymentType: "SEPA" | "ACH" | "BACS" | "EFT";
  currency: string;
  /** Paysafe's documented test values, in the rail's render order. */
  fields: Record<string, string>;
  /** SEPA and BACS are mandate schemes — they render the consent checkbox. */
  consent: boolean;
}

const RAILS: RailCase[] = [
  {
    paymentType: "SEPA",
    currency: "EUR",
    consent: true,
    fields: { accountHolderName: "Erik van Houten", iban: "NL77ABNA0492122466", bic: "ABNANL2A" },
  },
  {
    paymentType: "ACH",
    currency: "USD",
    consent: false,
    fields: { accountHolderName: "Pat Doe", routingNumber: "123456789", accountNumber: "1234567890" },
  },
  {
    paymentType: "BACS",
    currency: "GBP",
    consent: true,
    fields: { accountHolderName: "Alex Smith", sortCode: "086081", accountNumber: "51120177" },
  },
  {
    paymentType: "EFT",
    currency: "CAD",
    consent: false,
    fields: {
      accountHolderName: "Jean Tremblay",
      institutionId: "001",
      transitNumber: "22446",
      accountNumber: "897543213",
    },
  },
];

function railSecret(rail: RailCase): string {
  return clientSecret({ currency: rail.currency, paymentType: rail.paymentType });
}

async function mountRail(
  rail: RailCase,
  options: Record<string, unknown> = {},
): Promise<{ adapter: PaysafeClientAdapter; container: HTMLElement; handle: Awaited<ReturnType<PaysafeClientAdapter["mount"]>> }> {
  const adapter = makeAdapter();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const handle = await adapter.mount(container, { clientSecret: railSecret(rail), ...options });
  return { adapter, container, handle };
}

describe("Paysafe bank-debit client", () => {
  for (const rail of RAILS) {
    it(`${rail.paymentType}: renders its inputs without loading Paysafe.js`, async () => {
      const onReady = vi.fn();
      const { container, handle } = await mountRail(rail, { onReady });

      expect(handle).toBeTruthy();
      const names = [...container.querySelectorAll("input")].map((el) => el.name);
      expect(names).toEqual([...Object.keys(rail.fields), ...(rail.consent ? ["mandateConsent"] : [])]);
      // Plain adapter-owned inputs — no hosted iframes on this rail.
      expect(container.querySelector("iframe")).toBeNull();
      for (const name of Object.keys(rail.fields)) {
        const el = input(container, name);
        expect(el.type).toBe("text");
        expect(container.querySelector(`label[for="${el.id}"]`)).not.toBeNull();
        // Only the holder's name has an autocomplete token; coordinates never invite autofill.
        expect(el.autocomplete).toBe(name === "accountHolderName" ? "name" : "off");
      }
      expect(onReady).toHaveBeenCalledOnce();
    });

    it(`${rail.paymentType}: onChange flips complete only once every requirement is satisfied`, async () => {
      const onChange = vi.fn();
      const { container } = await mountRail(rail, { onChange });
      expect(onChange).toHaveBeenNthCalledWith(1, { complete: false, empty: true });

      // bic is SEPA's one optional field — completeness must not wait for it.
      const required = Object.entries(rail.fields).filter(([name]) => name !== "bic");
      for (const [name, value] of required) {
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ complete: false }));
        fill(container, name, value);
      }
      if (rail.consent) {
        expect(onChange).toHaveBeenLastCalledWith({ complete: false });
        input(container, "mandateConsent").click();
      }
      expect(onChange).toHaveBeenLastCalledWith({ complete: true });
    });

    it(`${rail.paymentType}: confirm() packs the trimmed details into the envelope, exactly as typed`, async () => {
      const { adapter, container, handle } = await mountRail(rail);
      for (const [name, value] of Object.entries(rail.fields)) fill(container, name, `  ${value} `);
      if (rail.consent) input(container, "mandateConsent").click();

      const result = await adapter.confirm(handle);
      expect(result.status).toBe("requires_confirmation");
      expect(decodeEnvelope(result.clientToken)).toEqual({
        v: 1,
        paymentType: rail.paymentType,
        ...rail.fields,
        ...(rail.consent ? { mandateConsent: true } : {}),
      });
    });
  }

  it("SEPA: a blank BIC stays out of the envelope — it is optional", async () => {
    const sepa = RAILS[0]!;
    const { adapter, container, handle } = await mountRail(sepa);
    fill(container, "accountHolderName", "Erik van Houten");
    fill(container, "iban", "NL77ABNA0492122466");
    input(container, "mandateConsent").click();

    const result = await adapter.confirm(handle);
    expect(result.status).toBe("requires_confirmation");
    expect(decodeEnvelope(result.clientToken)).toEqual({
      v: 1,
      paymentType: "SEPA",
      accountHolderName: "Erik van Houten",
      iban: "NL77ABNA0492122466",
      mandateConsent: true,
    });
  });

  it("unticking the mandate flips completeness back off", async () => {
    const bacs = RAILS[2]!;
    const onChange = vi.fn();
    const { container } = await mountRail(bacs, { onChange });
    for (const [name, value] of Object.entries(bacs.fields)) fill(container, name, value);
    const consent = input(container, "mandateConsent");
    consent.click();
    expect(onChange).toHaveBeenLastCalledWith({ complete: true });
    consent.click();
    expect(onChange).toHaveBeenLastCalledWith({ complete: false });
  });

  it("names the missing field on confirm() and never echoes entered values", async () => {
    const cases: Array<[RailCase, string]> = [
      [RAILS[0]!, "iban"],
      [RAILS[1]!, "routingNumber"],
      [RAILS[2]!, "sortCode"],
      [RAILS[3]!, "transitNumber"],
    ];
    for (const [rail, omitted] of cases) {
      const { adapter, container, handle } = await mountRail(rail);
      const entered = Object.entries(rail.fields).filter(([name]) => name !== omitted);
      for (const [name, value] of entered) fill(container, name, value);
      if (rail.consent) input(container, "mandateConsent").click();

      const result = await adapter.confirm(handle);
      expect(result.status).toBe("failed");
      expect(result.clientToken).toBeUndefined();
      expect(result.error?.code).toBe("invalid_request");
      expect(result.error?.retryable).toBe(false);
      expect(result.error?.message).toContain(omitted);
      // Bank coordinates never leak into error text or raw.
      for (const [, value] of entered) {
        expect(result.error?.message).not.toContain(value);
        expect(JSON.stringify(result.error?.raw)).not.toContain(value);
      }
    }
  });

  it("treats whitespace-only values as missing", async () => {
    const sepa = RAILS[0]!;
    const { adapter, container, handle } = await mountRail(sepa);
    fill(container, "accountHolderName", "Erik van Houten");
    fill(container, "iban", "   ");
    input(container, "mandateConsent").click();

    const result = await adapter.confirm(handle);
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("iban");
  });

  it("SEPA/BACS: an unticked mandate fails confirm(), naming mandateConsent", async () => {
    for (const rail of [RAILS[0]!, RAILS[2]!]) {
      const { adapter, container, handle } = await mountRail(rail);
      for (const [name, value] of Object.entries(rail.fields)) fill(container, name, value);

      const result = await adapter.confirm(handle);
      expect(result.status).toBe("failed");
      expect(result.clientToken).toBeUndefined();
      expect(result.error?.code).toBe("invalid_request");
      expect(result.error?.message).toContain("mandateConsent");
    }
  });

  it("mounts into host slots and removes only its own wrappers on unmount", async () => {
    const container = document.createElement("div");
    const slot = document.createElement("div");
    slot.setAttribute("data-payfanout-field", "iban");
    container.appendChild(slot);
    const hostOwned = document.createElement("span");
    container.appendChild(hostOwned);

    const adapter = makeAdapter();
    const handle = await adapter.mount(container, { clientSecret: railSecret(RAILS[0]!) });
    // The IBAN wrapper (label + input) lives inside the host's slot.
    expect(slot.querySelector('input[name="iban"]')).not.toBeNull();

    adapter.unmount(handle);
    expect(container.querySelector("input")).toBeNull();
    expect(container.contains(slot)).toBe(true); // host elements survive
    expect(container.contains(hostOwned)).toBe(true);
  });

  it("lets the host override labels, placeholders, and the mandate line", async () => {
    const { container } = await mountRail(RAILS[0]!, {
      fieldOptions: {
        fields: { iban: { label: "IBAN du compte", placeholder: "NL00 …" } },
        mandateText: "J'autorise ce prélèvement.",
      },
    });
    const iban = input(container, "iban");
    expect(container.querySelector(`label[for="${iban.id}"]`)?.textContent).toBe("IBAN du compte");
    expect(iban.placeholder).toBe("NL00 …");
    const consent = input(container, "mandateConsent");
    expect(container.querySelector(`label[for="${consent.id}"]`)?.textContent).toBe(
      "J'autorise ce prélèvement.",
    );
  });

  it("applies the shared appearance tokens inline to its inputs", async () => {
    const { container } = await mountRail(RAILS[1]!, {
      appearance: { fontFamily: "system-ui", fontSize: "16px" },
    });
    const holder = input(container, "accountHolderName");
    expect(holder.style.getPropertyValue("font-family")).toBe("system-ui");
    expect(holder.style.getPropertyValue("font-size")).toBe("16px");
  });

  it("card sessions still mount hosted card fields — no plain inputs on that path", async () => {
    const setupCalls: Record<string, unknown>[] = [];
    const paysafe: PaysafeJsLike = {
      fields: {
        setup: async (_apiKey, options) => {
          setupCalls.push(options);
          return { tokenize: async () => ({ token: "SPtok_1" }) };
        },
      },
    };
    const adapter = new PaysafeClientAdapter({
      apiKey: "cHVibGljOmtleQ==",
      environment: "sandbox",
      getPaysafeGlobal: () => paysafe,
      loadScript: async () => {},
    });
    const container = document.createElement("div");
    await adapter.mount(container, { clientSecret: clientSecret({}) }); // card payloads carry no paymentType
    expect(setupCalls).toHaveLength(1);
    expect(container.querySelectorAll("div[id^='payfanout-psf-']")).toHaveLength(3);
    expect(container.querySelector("input")).toBeNull();
  });

  it("a redirect session wins the dispatch even though it carries a paymentType (Interac)", async () => {
    const container = document.createElement("div");
    await makeAdapter().mount(container, {
      clientSecret: clientSecret({
        currency: "CAD",
        paymentType: "INTERAC_ETRANSFER",
        redirectUrl: "https://api.test.paysafe.com/alternatepayments/v1/redirect?paymentHandleId=ph_1",
      }),
    });
    expect(container.querySelector("[data-payfanout-paysafe-panel]")).not.toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });

  it("rejects a typed session this adapter version does not know, instead of mounting card fields", async () => {
    // The server never mints such a session today — hitting this is version
    // skew (newer server, older client), where card fields would tokenize a
    // CARD payment against a session created for another rail.
    const container = document.createElement("div");
    await expect(
      makeAdapter().mount(container, { clientSecret: clientSecret({ paymentType: "PIX" }) }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringContaining("PIX") });
    expect(container.childElementCount).toBe(0); // nothing half-mounted
  });

  it("models the rails honestly: embedded flow, off until the account opts in, gates declared", () => {
    const methods = makeAdapter().listPaymentMethodCapabilities();
    // Mirrors the server adapter's declarations, entry for entry.
    expect(methods.find((m) => m.type === "sepa_debit")).toEqual({
      type: "sepa_debit",
      flow: "embedded",
      supported: false,
      currencies: ["EUR"],
    });
    expect(methods.find((m) => m.type === "ach")).toEqual({ type: "ach", flow: "embedded", supported: false });
    expect(methods.find((m) => m.type === "bacs_debit")).toEqual({
      type: "bacs_debit",
      flow: "embedded",
      supported: false,
      currencies: ["GBP"],
      countries: ["GB"],
    });
    expect(methods.find((m) => m.type === "pad")).toEqual({
      type: "pad",
      flow: "embedded",
      supported: false,
      countries: ["CA"],
    });
  });
});
