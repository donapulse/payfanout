import { describe, expect, it } from "vitest";
import { PayPalServerAdapter } from "../src/index.js";
import { FakePayPalApi } from "./fake-paypal-api.js";

function makePair(): { adapter: PayPalServerAdapter; fake: FakePayPalApi } {
  const fake = new FakePayPalApi();
  const adapter = new PayPalServerAdapter({
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    environment: "sandbox",
    fetch: fake.fetch,
    sleep: async () => {},
  });
  return { adapter, fake };
}

const berlin = { name: "Ann", address: { line1: "2 Way", city: "Berlin", postalCode: "10115", country: "DE" } };
const paris = { name: "Bea", address: { line1: "3 Rue", city: "Paris", postalCode: "75001", country: "FR" } };

async function orderUnit(adapter: PayPalServerAdapter, orderId: string): Promise<Record<string, unknown>> {
  const info = await adapter.retrievePayment(orderId);
  return (info.raw as { purchase_units: Array<Record<string, unknown>> }).purchase_units[0]!;
}

describe("PayPal order updates", () => {
  it("gives an order created without shipping its name and address by replace, as PayPal's sample does", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 2000, currency: "USD", idempotencyKey: "k" });
    await adapter.updatePaymentSession({ pspSessionId: session.pspSessionId, shippingDetails: berlin, idempotencyKey: "k-up" });
    expect(fake.lastRequestBody).toEqual([
      { op: "replace", path: "/purchase_units/@reference_id=='default'/shipping/name", value: { full_name: "Ann" } },
      {
        op: "replace",
        path: "/purchase_units/@reference_id=='default'/shipping/address",
        value: { address_line_1: "2 Way", admin_area_2: "Berlin", postal_code: "10115", country_code: "DE" },
      },
    ]);
    expect((await orderUnit(adapter, session.pspSessionId))["shipping"]).toMatchObject({ name: { full_name: "Ann" } });
  });

  it("adds a missing name under an order's existing shipping and replaces its address", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 2000,
      currency: "USD",
      shippingDetails: { address: berlin.address },
      idempotencyKey: "k",
    });
    await adapter.updatePaymentSession({ pspSessionId: session.pspSessionId, shippingDetails: paris, idempotencyKey: "k-up" });
    const ops = fake.lastRequestBody as Array<{ op: string; path: string }>;
    expect(ops.map((op) => `${op.op} ${op.path.split("/").slice(3).join("/")}`)).toEqual([
      "add shipping/name",
      "replace shipping/address",
    ]);
    expect((await orderUnit(adapter, session.pspSessionId))["shipping"]).toMatchObject({
      name: { full_name: "Bea" },
      address: { country_code: "FR" },
    });
  });

  it("keeps the order's name when an update sends only an address", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 2000,
      currency: "USD",
      shippingDetails: berlin,
      idempotencyKey: "k",
    });
    await adapter.updatePaymentSession({
      pspSessionId: session.pspSessionId,
      shippingDetails: { address: paris.address },
      idempotencyKey: "k-up",
    });
    const ops = fake.lastRequestBody as Array<{ op: string; path: string }>;
    expect(ops.map((op) => `${op.op} ${op.path.split("/").slice(3).join("/")}`)).toEqual(["replace shipping/address"]);
    expect((await orderUnit(adapter, session.pspSessionId))["shipping"]).toMatchObject({
      name: { full_name: "Ann" },
      address: { country_code: "FR" },
    });
  });

  it("replaces the shipping of an order that already has one", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 2000,
      currency: "USD",
      shippingDetails: berlin,
      idempotencyKey: "k",
    });
    await adapter.updatePaymentSession({
      pspSessionId: session.pspSessionId,
      amount: 2500,
      shippingDetails: paris,
      idempotencyKey: "k-up",
    });
    const ops = fake.lastRequestBody as Array<{ op: string; path: string }>;
    expect(ops.map((op) => `${op.op} ${op.path.split("/").slice(3).join("/")}`)).toEqual([
      "replace amount",
      "replace shipping/name",
      "replace shipping/address",
    ]);
    const unit = await orderUnit(adapter, session.pspSessionId);
    expect(unit["amount"]).toEqual({ currency_code: "USD", value: "25.00" });
    expect(unit["shipping"]).toMatchObject({ name: { full_name: "Bea" }, address: { country_code: "FR" } });
  });

  it("replaces an order's statement descriptor, cut to 22 characters as PayPal does", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({
      amount: 2000,
      currency: "USD",
      statementDescriptor: "OLD SHOP",
      idempotencyKey: "k",
    });
    await adapter.updatePaymentSession({
      pspSessionId: session.pspSessionId,
      statementDescriptor: "A MUCH LONGER SHOP NAME THAN PAYPAL KEEPS",
      idempotencyKey: "k-up",
    });
    expect(fake.lastRequestBody).toEqual([
      { op: "replace", path: "/purchase_units/@reference_id=='default'/soft_descriptor", value: "A MUCH LONGER SHOP NAM" },
    ]);
    expect((await orderUnit(adapter, session.pspSessionId))["soft_descriptor"]).toBe("A MUCH LONGER SHOP NAM");
  });

  it("refuses to add a statement descriptor to an order created without one, sending no update", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ amount: 2000, currency: "USD", idempotencyKey: "k" });
    const before = fake.requestCount;
    await expect(
      adapter.updatePaymentSession({
        pspSessionId: session.pspSessionId,
        amount: 2500,
        statementDescriptor: "NEW SHOP",
        idempotencyKey: "k-up",
      }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/when creating the session/) });
    expect(fake.requestCount - before).toBe(1); // the order read only
    expect((await orderUnit(adapter, session.pspSessionId))["amount"]).toEqual({ currency_code: "USD", value: "20.00" });
  });
});
