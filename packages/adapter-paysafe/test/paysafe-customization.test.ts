import { afterEach, describe, expect, it, vi } from "vitest";
import { PaysafeClientAdapter, type PaysafeJsLike } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

const TOKEN = `${Buffer.from(JSON.stringify({ v: 1, amount: 2500, currency: "EUR", merchantAccountId: "acct-1" })).toString("base64url")}.sig`;

function stubBrowser(): void {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    createElement: () => ({ id: "", remove: vi.fn() }),
  });
}

function capturingPaysafe(): PaysafeJsLike & { setupOptions: Record<string, unknown>[] } {
  const fake = {
    setupOptions: [] as Record<string, unknown>[],
    fields: {
      setup: async (_apiKey: string, options: Record<string, unknown>) => {
        fake.setupOptions.push(options);
        return { tokenize: async () => ({ token: "SPtok_1" }) };
      },
    },
  };
  return fake as never;
}

function makeAdapter(fake = capturingPaysafe()): { adapter: PaysafeClientAdapter; fake: typeof fake } {
  return {
    adapter: new PaysafeClientAdapter({
      apiKey: "cHVibGljOmtleQ==",
      environment: "sandbox",
      getPaysafeGlobal: () => fake,
      loadScript: async () => {},
    }),
    fake,
  };
}

interface FakeSlot {
  id: string;
  remove: ReturnType<typeof vi.fn>;
  children: Array<{ id: string; remove: () => void }>;
  appendChild: (el: { id: string; remove: () => void }) => void;
}

/** Container with host-provided layout slots (the data-payfanout-field convention). */
function slottedContainer(slots: string[]): {
  container: HTMLElement;
  slotEls: Map<string, FakeSlot>;
  appended: unknown[];
} {
  const slotEls = new Map(
    slots.map((name) => {
      const slot: FakeSlot = {
        id: "",
        remove: vi.fn(),
        children: [],
        appendChild: (el) => slot.children.push(el),
      };
      return [name, slot];
    }),
  );
  const appended: unknown[] = [];
  const container = {
    appendChild: (el: unknown) => appended.push(el),
    querySelector: (selector: string) => {
      const match = /\[data-payfanout-field="(\w+)"\]/.exec(selector);
      return match ? (slotEls.get(match[1]!) ?? null) : null;
    },
  };
  return { container: container as never, slotEls, appended };
}

describe("Paysafe field customization", () => {
  it("host placeholders and extra per-field options override the defaults; selectors stay adapter-owned", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const { container } = slottedContainer([]);
    await adapter.mount(container, {
      clientSecret: TOKEN,
      fieldOptions: {
        fields: {
          cardNumber: { placeholder: "Numéro de carte", separator: " " },
          expiryDate: { placeholder: "MM/AA" },
          cvv: { placeholder: "Cryptogramme", selector: "#attacker" }, // must be ignored
        },
      },
    });
    const fields = fake.setupOptions[0]!["fields"] as Record<string, Record<string, unknown>>;
    expect(fields["cardNumber"]).toMatchObject({ placeholder: "Numéro de carte", separator: " " });
    expect(fields["expiryDate"]!["placeholder"]).toBe("MM/AA");
    expect(fields["cvv"]!["placeholder"]).toBe("Cryptogramme");
    expect(fields["cvv"]!["selector"]).not.toBe("#attacker"); // adapter owns mount points
    expect(String(fields["cvv"]!["selector"])).toMatch(/^#payfanout-psf-/);
  });

  it("mounts wrappers INSIDE host slots (host owns the layout) and never removes the slots on unmount", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const { container, slotEls, appended } = slottedContainer(["cardNumber", "expiryDate", "cvv"]);
    const handle = await adapter.mount(container, { clientSecret: TOKEN });

    expect(appended).toHaveLength(0); // nothing stacked in the container — the host's structure is used
    const fields = fake.setupOptions[0]!["fields"] as Record<string, Record<string, unknown>>;
    for (const name of ["cardNumber", "expiryDate", "cvv"] as const) {
      const slot = slotEls.get(name)!;
      expect(slot.children).toHaveLength(1); // our per-mount wrapper lives inside the slot
      expect(fields[name]!["selector"]).toBe(`#${slot.children[0]!.id}`);
      expect(String(slot.children[0]!.id)).toMatch(/^payfanout-psf-/);
    }

    adapter.unmount(handle);
    for (const slot of slotEls.values()) {
      expect(slot.remove).not.toHaveBeenCalled(); // the host's elements survive…
      expect((slot.children[0]!.remove as ReturnType<typeof vi.fn>)).toHaveBeenCalled(); // …only OUR wrapper is removed
    }
  });

  it("mixes slots and fallbacks per field", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const { container, slotEls, appended } = slottedContainer(["cardNumber"]); // only one slot provided
    await adapter.mount(container, { clientSecret: TOKEN });
    expect(slotEls.get("cardNumber")!.children).toHaveLength(1); // wrapper inside the slot
    expect(appended).toHaveLength(2); // expiry + cvv fall back to container-stacked wrappers
    expect(fake.setupOptions[0]).toBeDefined();
  });

  it("maps BCP-47 locales to Paysafe's underscore form and passes unknown setup options through", async () => {
    const { adapter, fake } = makeAdapter();
    stubBrowser();
    await adapter.mount({ appendChild: () => {} } as never, {
      clientSecret: TOKEN,
      locale: "fr-CA",
      fieldOptions: { someFutureSdkOption: { enabled: true } },
    });
    expect(fake.setupOptions[0]).toMatchObject({
      locale: "fr_CA",
      someFutureSdkOption: { enabled: true },
    });
  });

  it("non-negotiables win over fieldOptions: environment, currencyCode, accountId", async () => {
    const { adapter, fake } = makeAdapter();
    stubBrowser();
    await adapter.mount({ appendChild: () => {} } as never, {
      clientSecret: TOKEN,
      fieldOptions: { environment: "LIVE", currencyCode: "USD", accountId: "attacker" },
    });
    expect(fake.setupOptions[0]).toMatchObject({
      environment: "TEST", // adapter config decides
      currencyCode: "EUR", // signed session decides
      accountId: "acct-1",
    });
  });

  it("translates common appearance tokens onto the Paysafe input selector", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    await adapter.mount({ appendChild: () => {} } as never, {
      clientSecret: TOKEN,
      appearance: { colorText: "#333", fontFamily: "system-ui", fontSize: "16px", colorPrimary: "#7c3aed" },
    });
    const style = fake.setupOptions[0]!["style"] as Record<string, Record<string, string>>;
    // colorPrimary is a recognized common token with no honest Paysafe surface — not applied, not warned.
    expect(style["input"]).toEqual({ color: "#333", "font-family": "system-ui", "font-size": "16px" });
  });

  it("passes native Paysafe selectors through, and a native input wins over the common tokens", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    await adapter.mount({ appendChild: () => {} } as never, {
      clientSecret: TOKEN,
      appearance: { colorText: "#333", input: { color: "#999", "border-radius": "6px" }, ":focus": { color: "#000" } },
    });
    const style = fake.setupOptions[0]!["style"] as Record<string, Record<string, string>>;
    expect(style["input"]).toEqual({ color: "#999", "border-radius": "6px" });
    expect(style[":focus"]).toEqual({ color: "#000" });
  });

  it("drops Stripe Appearance keys with a warning instead of silently breaking all styling", async () => {
    stubBrowser();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter, fake } = makeAdapter();
    await adapter.mount({ appendChild: () => {} } as never, {
      clientSecret: TOKEN,
      appearance: { variables: { colorPrimary: "#7c3aed" }, theme: "flat", input: { color: "#333" } },
    });
    expect(fake.setupOptions[0]!["style"]).toEqual({ input: { color: "#333" } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("variables"));
    warn.mockRestore();
  });
});
