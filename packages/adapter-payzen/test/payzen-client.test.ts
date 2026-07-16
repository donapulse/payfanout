import { afterEach, describe, expect, it, vi } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import { runClientAdapterConformanceTests } from "@payfanout/conformance";
import {
  PayZenClientAdapter,
  type KrErrorLike,
  type KrLike,
  type KrPaymentResponseLike,
} from "../src/index.js";

const PUBLIC_KEY = "69876357:testpublickey_UnitKey123";
const FORM_TOKEN = "ftUnitToken123";

interface FakeKr extends KrLike {
  configCalls: Array<Record<string, unknown>>;
  renderedSelectors: string[];
  submitCalls: number;
  removeFormsCalls: number;
  validateCalls: number;
  /** When set, validateForm() rejects with this value. */
  validateRejection?: unknown;
  /** When set, submit() misbehaves this way. */
  submitFailure?: { sync?: unknown; async?: unknown };
  /** KR.getPaymentMethods() outcome: a value to resolve, or a thrower. */
  paymentMethodsResult?: unknown;
  paymentMethodsRejection?: unknown;
  formValidCb?: () => void;
  errorCb?: (error: KrErrorLike) => void;
  submitCb?: (response: KrPaymentResponseLike) => boolean;
}

function makeFakeKr(): FakeKr {
  const fake: FakeKr = {
    configCalls: [],
    renderedSelectors: [],
    submitCalls: 0,
    removeFormsCalls: 0,
    validateCalls: 0,
    setFormConfig: async (config: Record<string, unknown>) => {
      fake.configCalls.push(config);
    },
    renderElements: async (selector: string) => {
      fake.renderedSelectors.push(selector);
    },
    submit: () => {
      fake.submitCalls++;
      if (fake.submitFailure?.sync) throw fake.submitFailure.sync;
      if (fake.submitFailure?.async) return Promise.reject(fake.submitFailure.async);
      return undefined;
    },
    onSubmit: (cb) => {
      fake.submitCb = cb;
    },
    onFormValid: (cb) => {
      fake.formValidCb = cb;
    },
    onError: (cb) => {
      fake.errorCb = cb;
    },
    removeForms: () => {
      fake.removeFormsCalls++;
    },
    validateForm: async () => {
      fake.validateCalls++;
      if (fake.validateRejection) throw fake.validateRejection;
    },
    getPaymentMethods: async () => {
      if (fake.paymentMethodsRejection) throw fake.paymentMethodsRejection;
      return fake.paymentMethodsResult;
    },
  };
  return fake;
}

function makeAdapter(
  fake: FakeKr = makeFakeKr(),
  config: Partial<ConstructorParameters<typeof PayZenClientAdapter>[0]> = {},
): { adapter: PayZenClientAdapter; fake: FakeKr } {
  const adapter = new PayZenClientAdapter({
    publicKey: PUBLIC_KEY,
    environment: "sandbox",
    getKrGlobal: () => fake,
    loadScript: async () => {},
    ...config,
  });
  return { adapter, fake };
}

interface FakeElement {
  className: string;
  id: string;
  rel?: string;
  href?: string;
  src?: string;
  async?: boolean;
  children: FakeElement[];
  attributes: Record<string, string>;
  onload?: () => void;
  onerror?: () => void;
  appendChild(el: FakeElement): void;
  remove: ReturnType<typeof vi.fn>;
  setAttribute(name: string, value: string): void;
}

function fakeElement(): FakeElement {
  const el: FakeElement = {
    className: "",
    id: "",
    children: [],
    attributes: {},
    appendChild(child: FakeElement) {
      el.children.push(child);
    },
    remove: vi.fn(),
    setAttribute(name: string, value: string) {
      el.attributes[name] = value;
    },
  };
  return el;
}

function stubBrowser(): { created: FakeElement[]; head: FakeElement; existing: Map<string, FakeElement> } {
  const created: FakeElement[] = [];
  const head = fakeElement();
  const existing = new Map<string, FakeElement>();
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    head,
    createElement: () => {
      const el = fakeElement();
      created.push(el);
      return el;
    },
    querySelector: (selector: string) => existing.get(selector) ?? null,
  });
  return { created, head, existing };
}

function fakeContainer(): HTMLElement & { children: FakeElement[] } {
  const container = fakeElement();
  return container as unknown as HTMLElement & { children: FakeElement[] };
}

runClientAdapterConformanceTests("payzen", () => makeAdapter().adapter, {
  expectedMethodTypes: ["card"],
});

// The smartForm shape passes the same client contract with wallets enabled.
runClientAdapterConformanceTests(
  "payzen (smartform)",
  () =>
    makeAdapter(makeFakeKr(), {
      form: "smartform",
      paymentMethods: [
        { type: "card", flow: "embedded", supported: true },
        { type: "apple_pay", flow: "popup", supported: true },
        { type: "paypal", flow: "popup", supported: true },
      ],
    }).adapter,
  { expectedMethodTypes: ["card", "apple_pay", "paypal"] },
);

afterEach(() => vi.unstubAllGlobals());

describe("PayZenClientAdapter config", () => {
  it("validates its config eagerly", () => {
    expect(() => new PayZenClientAdapter({ publicKey: "", environment: "sandbox" })).toThrowError(/publicKey/);
    expect(() => new PayZenClientAdapter({ publicKey: "k", environment: "prod" as never })).toThrowError(
      /sandbox.*live/,
    );
  });

  it("refuses a public key family that contradicts the declared environment", () => {
    expect(
      () => new PayZenClientAdapter({ publicKey: "69876357:prodpublickey_X", environment: "sandbox" }),
    ).toThrowError(/production key/);
    expect(() => new PayZenClientAdapter({ publicKey: PUBLIC_KEY, environment: "live" })).toThrowError(/test key/);
    expect(
      () => new PayZenClientAdapter({ publicKey: "69876357:prodpublickey_X", environment: "live" }),
    ).not.toThrowError();
  });
});

describe("PayZenClientAdapter mount", () => {
  it("renders the kr-embedded skeleton and configures KR under the adapter-owned keys", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const container = fakeContainer();
    let ready = false;
    const changes: Array<{ complete: boolean }> = [];
    await adapter.mount(container, {
      clientSecret: FORM_TOKEN,
      locale: "fr_FR",
      fieldOptions: {
        "kr-hide-debug-toolbar": true,
        // Hostile host values for the protected keys — the adapter must win.
        formToken: "evil-token",
        "kr-public-key": "evil-key",
        language: "de-DE",
      },
      onReady: () => {
        ready = true;
      },
      onChange: (state) => changes.push(state),
    });

    const wrapper = container.children[0]!;
    expect(wrapper.className).toBe("kr-embedded");
    expect(wrapper.children.map((c) => c.className)).toEqual([
      "kr-pan",
      "kr-expiry",
      "kr-security-code",
      "kr-form-error",
    ]);
    expect(fake.configCalls[0]).toMatchObject({
      "kr-hide-debug-toolbar": true, // host options pass through untouched
      formToken: FORM_TOKEN, // …except the keys the adapter must own
      "kr-public-key": PUBLIC_KEY,
      "kr-spa-mode": true,
      language: "fr-FR", // MountOptions.locale wins, normalized to Culture format
    });
    expect(fake.renderedSelectors[0]).toBe(`#${wrapper.id}`);
    expect(fake.removeFormsCalls).toBe(1); // clean slate before rendering
    expect(ready).toBe(true);
    expect(changes[0]).toEqual({ complete: false, empty: true }); // deterministic initial state
  });

  it("lets the host's language stand when no locale is passed", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    await adapter.mount(fakeContainer(), { clientSecret: FORM_TOKEN, fieldOptions: { language: "de-DE" } });
    expect(fake.configCalls[0]!["language"]).toBe("de-DE");
  });

  it("follows KR.onFormValid with onChange({ complete: true })", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const changes: Array<{ complete: boolean }> = [];
    await adapter.mount(fakeContainer(), { clientSecret: FORM_TOKEN, onChange: (s) => changes.push(s) });
    fake.formValidCb?.();
    expect(changes.map((c) => c.complete)).toEqual([false, true]);
  });

  it("routes mount-time KR errors to options.onError with the raw error preserved", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const errors: unknown[] = [];
    await adapter.mount(fakeContainer(), { clientSecret: FORM_TOKEN, onError: (e) => errors.push(e) });
    const krError = { errorCode: "CLIENT_004", errorMessage: "invalid public key" };
    fake.errorCb?.(krError);
    expect(errors).toHaveLength(1);
    expect((errors[0] as { code: string }).code).toBe("invalid_request");
    expect((errors[0] as { raw: unknown }).raw).toBe(krError);
  });

  it("cleans up its wrapper and reports when setFormConfig fails", async () => {
    stubBrowser();
    const fake = makeFakeKr();
    fake.setFormConfig = async () => {
      throw { errorCode: "CLIENT_999", errorMessage: "technical error" };
    };
    const { adapter } = makeAdapter(fake);
    const container = fakeContainer();
    const onError = vi.fn();
    await expect(adapter.mount(container, { clientSecret: FORM_TOKEN, onError })).rejects.toMatchObject({
      code: "psp_unavailable",
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(container.children[0]!.remove).toHaveBeenCalled(); // no orphaned DOM
  });

  it("degrades when the SDK build lacks the optional event surface", async () => {
    stubBrowser();
    const fake = makeFakeKr();
    delete (fake as Partial<KrLike>).onFormValid;
    delete (fake as Partial<KrLike>).onError;
    delete (fake as Partial<KrLike>).removeForms;
    delete (fake as Partial<KrLike>).validateForm;
    const { adapter } = makeAdapter(fake);
    const changes: Array<{ complete: boolean }> = [];
    const handle = await adapter.mount(fakeContainer(), { clientSecret: FORM_TOKEN, onChange: (s) => changes.push(s) });
    expect(changes).toEqual([{ complete: false, empty: true }]); // initialized, never breaks
    adapter.unmount(handle); // defensive without removeForms
  });

  it("rejects mount during SSR and foreign handles anywhere", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.mount({} as HTMLElement, { clientSecret: FORM_TOKEN })).rejects.toThrowError(
      /browser-only/,
    );
    await expect(adapter.confirm({} as never)).rejects.toThrowError(/not produced by PayZenClientAdapter/);
    expect(() => adapter.unmount({} as never)).toThrowError(/not produced by PayZenClientAdapter/);
  });
});

describe("PayZenClientAdapter confirm", () => {
  /** confirm() awaits KR.validateForm before wiring its resolver — settle those microtasks first. */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  async function mounted(fake: FakeKr = makeFakeKr()): Promise<{
    adapter: PayZenClientAdapter;
    fake: FakeKr;
    handle: Awaited<ReturnType<PayZenClientAdapter["mount"]>>;
  }> {
    stubBrowser();
    const { adapter } = makeAdapter(fake);
    const handle = await adapter.mount(fakeContainer(), { clientSecret: FORM_TOKEN });
    return { adapter, fake, handle };
  }

  it("resolves succeeded when KR.onSubmit reports a PAID order", async () => {
    const { adapter, fake, handle } = await mounted();
    const pending = adapter.confirm(handle);
    await flush();
    expect(fake.submitCalls).toBe(1);
    const consumed = fake.submitCb?.({ clientAnswer: { orderStatus: "PAID" } });
    expect(consumed).toBe(false); // never let KR POST to a kr-post-url
    await expect(pending).resolves.toEqual({ status: "succeeded" });
  });

  it("resolves processing for RUNNING orders (async finality arrives via IPN)", async () => {
    const { adapter, fake, handle } = await mounted();
    const pending = adapter.confirm(handle);
    await flush();
    fake.submitCb?.({ clientAnswer: { orderStatus: "RUNNING" } });
    await expect(pending).resolves.toEqual({ status: "processing" });
  });

  it("resolves failed with the refined decline for UNPAID orders", async () => {
    const { adapter, fake, handle } = await mounted();
    const pending = adapter.confirm(handle);
    await flush();
    const response = {
      clientAnswer: {
        orderStatus: "UNPAID",
        transactions: [{ uuid: "u1", detailedStatus: "REFUSED", errorCode: "ACQ_001", detailedErrorCode: "51" }],
      },
    };
    fake.submitCb?.(response);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.clientToken).toBeUndefined(); // confirm-on-client: no token, ever
    expect(result.error?.code).toBe("insufficient_funds");
    expect(result.error?.raw).toBe(response);
    expect(isPayFanoutError(result.error)).toBe(true);
  });

  it("resolves failed when KR.onError fires during confirm (refused transaction / closed 3DS pop-in)", async () => {
    const { adapter, fake, handle } = await mounted();
    const pending = adapter.confirm(handle);
    await flush();
    fake.errorCb?.({ errorCode: "CLIENT_101", errorMessage: "3DS aborted" });
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("authentication_required");
  });

  it("fails locally when KR.validateForm rejects, without submitting", async () => {
    const fake = makeFakeKr();
    fake.validateRejection = { result: { errorCode: "CLIENT_301", errorMessage: "invalid pan" } };
    const { adapter, handle } = await mounted(fake);
    const result = await adapter.confirm(handle);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invalid_card_data");
    expect(fake.submitCalls).toBe(0);
  });

  it("resolves failed when submit throws synchronously or rejects asynchronously", async () => {
    const syncFake = makeFakeKr();
    syncFake.submitFailure = { sync: { errorCode: "CLIENT_999" } };
    const sync = await mounted(syncFake);
    const syncResult = await sync.adapter.confirm(sync.handle);
    expect(syncResult.status).toBe("failed");
    expect(syncResult.error?.code).toBe("psp_unavailable");

    const asyncFake = makeFakeKr();
    asyncFake.submitFailure = { async: { errorCode: "PSP_108" } };
    const async = await mounted(asyncFake);
    const asyncResult = await async.adapter.confirm(async.handle);
    expect(asyncResult.status).toBe("failed");
    expect(asyncResult.error?.code).toBe("session_expired"); // expired formToken — new session needed
  });

  it("refuses overlapping confirmations on the same form", async () => {
    const { adapter, fake, handle } = await mounted();
    const first = adapter.confirm(handle);
    // No flush: the guard must trip SYNCHRONOUSLY, before any awaits settle.
    const second = await adapter.confirm(handle);
    expect(second.status).toBe("failed");
    expect(second.error?.code).toBe("invalid_request");
    await flush();
    fake.submitCb?.({ clientAnswer: { orderStatus: "PAID" } });
    await expect(first).resolves.toEqual({ status: "succeeded" }); // the original stays live
  });

  it("settles a pending confirm as failed when the form is unmounted mid-confirmation", async () => {
    const { adapter, handle } = await mounted();
    const pending = adapter.confirm(handle);
    await flush();
    adapter.unmount(handle); // route change / PSP switch while the 3DS pop-in is open
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invalid_request");
    expect(result.error?.message).toMatch(/unmounted during confirmation/);
  });

  it("re-mounting while a confirm is pending settles the old confirm the same way", async () => {
    const { adapter, fake, handle } = await mounted();
    const pending = adapter.confirm(handle);
    await flush();
    const next = await adapter.mount(fakeContainer(), { clientSecret: FORM_TOKEN }); // replaces the KR form
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error?.message).toMatch(/unmounted during confirmation/);
    // The replacement mount stays fully usable.
    const secondConfirm = adapter.confirm(next);
    await flush();
    fake.submitCb?.({ clientAnswer: { orderStatus: "PAID" } });
    await expect(secondConfirm).resolves.toEqual({ status: "succeeded" });
  });

  it("ignores stray KR callbacks when no confirmation is pending", async () => {
    const errors: unknown[] = [];
    stubBrowser();
    const fake = makeFakeKr();
    const { adapter } = makeAdapter(fake);
    await adapter.mount(fakeContainer(), { clientSecret: FORM_TOKEN, onError: (e) => errors.push(e) });
    expect(fake.submitCb?.({ clientAnswer: { orderStatus: "PAID" } })).toBe(false); // no crash, still consumed
    fake.errorCb?.({ errorCode: "CLIENT_999" });
    expect(errors).toHaveLength(1); // outside confirm, errors go to options.onError
  });
});

describe("PayZenClientAdapter smartform", () => {
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  async function mountedSmart(
    form: "smartform" | "smartform-expanded" = "smartform",
    fake: FakeKr = makeFakeKr(),
  ): Promise<{
    adapter: PayZenClientAdapter;
    fake: FakeKr;
    handle: Awaited<ReturnType<PayZenClientAdapter["mount"]>>;
    container: ReturnType<typeof fakeContainer>;
    errors: unknown[];
  }> {
    stubBrowser();
    const { adapter } = makeAdapter(fake, { form });
    const container = fakeContainer();
    const errors: unknown[] = [];
    const handle = await adapter.mount(container, {
      clientSecret: FORM_TOKEN,
      onError: (e) => errors.push(e),
    });
    return { adapter, fake, handle, container, errors };
  }

  it("renders an empty kr-smart-form element inside the selector wrapper", async () => {
    const { fake, container } = await mountedSmart();
    const wrapper = container.children[0]!;
    expect(wrapper.className).toBe(""); // the selector wrapper carries only the id
    expect(wrapper.children).toHaveLength(1);
    const smart = wrapper.children[0]!;
    expect(smart.className).toBe("kr-smart-form");
    expect(smart.children).toHaveLength(0); // the library renders the whole surface, buttons included
    expect(smart.attributes).not.toHaveProperty("kr-card-form-expanded");
    expect(fake.renderedSelectors[0]).toBe(`#${wrapper.id}`);
    expect(fake.configCalls[0]).toMatchObject({
      formToken: FORM_TOKEN,
      "kr-public-key": PUBLIC_KEY,
      "kr-spa-mode": true,
    });
  });

  it("pre-expands the card form in smartform-expanded mode", async () => {
    const { container } = await mountedSmart("smartform-expanded");
    const smart = container.children[0]!.children[0]!;
    expect(smart.attributes["kr-card-form-expanded"]).toBe("");
  });

  it("confirm() awaits the buyer's in-form completion without driving KR.submit", async () => {
    const { adapter, fake, handle } = await mountedSmart();
    const pending = adapter.confirm(handle);
    await flush();
    expect(fake.submitCalls).toBe(0); // the form owns its pay buttons
    expect(fake.validateCalls).toBe(0); // local card validation belongs to the form too
    fake.submitCb?.({ clientAnswer: { orderStatus: "PAID" } });
    await expect(pending).resolves.toEqual({ status: "succeeded" });
  });

  it("buffers an outcome that lands before confirm() and hands it to the next call, once", async () => {
    const { adapter, fake, handle } = await mountedSmart();
    expect(fake.submitCb?.({ clientAnswer: { orderStatus: "PAID" } })).toBe(false); // still never POSTs
    await expect(adapter.confirm(handle)).resolves.toEqual({ status: "succeeded" });
    // Consumed — the next confirm() awaits a NEW outcome instead of replaying.
    const second = adapter.confirm(handle);
    await flush();
    fake.submitCb?.({ clientAnswer: { orderStatus: "RUNNING" } });
    await expect(second).resolves.toEqual({ status: "processing" });
  });

  it("keeps awaiting through recoverable browser-side errors, which flow to options.onError", async () => {
    const { adapter, fake, handle, errors } = await mountedSmart();
    const pending = adapter.confirm(handle);
    await flush();
    fake.errorCb?.({ errorCode: "CLIENT_301", errorMessage: "invalid card number" }); // local validation
    fake.errorCb?.({ errorCode: "CLIENT_101", errorMessage: "aborted" }); // closed 3DS pop-in — the form recovers
    fake.errorCb?.({ errorCode: "CLIENT_704", errorMessage: "load Font Awesome" }); // integration warning
    expect(errors).toHaveLength(3);
    fake.submitCb?.({ clientAnswer: { orderStatus: "PAID" } }); // the buyer retried and succeeded
    await expect(pending).resolves.toEqual({ status: "succeeded" });
  });

  it("settles the await on gateway-side rejections and on fatal client errors", async () => {
    const refused = await mountedSmart();
    const pendingRefused = refused.adapter.confirm(refused.handle);
    await flush();
    refused.fake.errorCb?.({ errorCode: "ACQ_001", detailedErrorCode: "51" });
    expect((await pendingRefused).error?.code).toBe("insufficient_funds");

    const fatal = await mountedSmart();
    const pendingFatal = fatal.adapter.confirm(fatal.handle);
    await flush();
    fatal.fake.errorCb?.({ errorCode: "CLIENT_999" }); // unusable form — awaiting would hang forever
    expect((await pendingFatal).error?.code).toBe("psp_unavailable");

    // CLIENT_305 ("no formToken defined") sits INSIDE the recoverable 3xx
    // range numerically but is fatal — the regression trap for the range check.
    const noToken = await mountedSmart();
    const pendingNoToken = noToken.adapter.confirm(noToken.handle);
    await flush();
    noToken.fake.errorCb?.({ errorCode: "CLIENT_305" });
    expect((await pendingNoToken).error?.code).toBe("invalid_request");
  });

  it("unmount settles a pending smartform await as failed", async () => {
    const { adapter, handle } = await mountedSmart();
    const pending = adapter.confirm(handle);
    await flush();
    adapter.unmount(handle);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error?.message).toMatch(/unmounted during confirmation/);
  });
});

describe("PayZenClientAdapter fetchAvailablePaymentMethods", () => {
  it("maps the shop's live method codes onto unified types, raw lists preserved", async () => {
    stubBrowser();
    const fake = makeFakeKr();
    fake.paymentMethodsResult = {
      paymentMethods: ["PAYPAL", "CARDS", "APPLE_PAY", "ALMA_3X"],
      cardBrands: ["VISA", "MASTERCARD"],
    };
    const { adapter } = makeAdapter(fake);
    await expect(adapter.fetchAvailablePaymentMethods()).resolves.toEqual({
      types: ["paypal", "card", "apple_pay"], // ALMA_3X has no unified type — raw only
      methods: ["PAYPAL", "CARDS", "APPLE_PAY", "ALMA_3X"],
      cardBrands: ["VISA", "MASTERCARD"],
    });
  });

  it("tolerates missing fields and dedupes the sandbox wallet alias", async () => {
    stubBrowser();
    const fake = makeFakeKr();
    fake.paymentMethodsResult = { paymentMethods: ["PAYPAL", "PAYPAL_SB"] };
    const { adapter } = makeAdapter(fake);
    await expect(adapter.fetchAvailablePaymentMethods()).resolves.toEqual({
      types: ["paypal"],
      methods: ["PAYPAL", "PAYPAL_SB"],
      cardBrands: [],
    });
  });

  it("reports an SDK build without KR.getPaymentMethods as psp_unavailable", async () => {
    stubBrowser();
    const fake = makeFakeKr();
    delete (fake as Partial<KrLike>).getPaymentMethods;
    const { adapter } = makeAdapter(fake);
    await expect(adapter.fetchAvailablePaymentMethods()).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: false,
    });
  });

  it("maps KR rejections onto the taxonomy", async () => {
    stubBrowser();
    const fake = makeFakeKr();
    fake.paymentMethodsRejection = { errorCode: "CLIENT_999" };
    const { adapter } = makeAdapter(fake);
    await expect(adapter.fetchAvailablePaymentMethods()).rejects.toMatchObject({ code: "psp_unavailable" });
  });
});

describe("PayZenClientAdapter error mapping", () => {
  async function mountedWithErrors(): Promise<{ fake: FakeKr; errors: Array<{ code: string; retryable: boolean }> }> {
    stubBrowser();
    const fake = makeFakeKr();
    const { adapter } = makeAdapter(fake);
    const errors: Array<{ code: string; retryable: boolean }> = [];
    await adapter.mount(fakeContainer(), {
      clientSecret: FORM_TOKEN,
      onError: (e) => errors.push({ code: e.code, retryable: e.retryable }),
    });
    return { fake, errors };
  }

  it("maps the KR error families onto the taxonomy", async () => {
    const { fake, errors } = await mountedWithErrors();
    const cases: Array<[KrErrorLike, string, boolean]> = [
      [{ errorCode: "CLIENT_301" }, "invalid_card_data", false],
      [{ errorCode: "CLIENT_101" }, "authentication_required", false], // closed 3DS pop-in
      [{ errorCode: "CLIENT_100" }, "invalid_request", false], // expired/invalid formToken
      [{ errorCode: "CLIENT_305" }, "invalid_request", false], // no formToken defined — integration, not card data
      [{ errorCode: "CLIENT_502" }, "invalid_request", false], // integration errors
      [{ errorCode: "CLIENT_505" }, "invalid_request", false], // smartForm rejects the current theme
      [{ errorCode: "CLIENT_704" }, "invalid_request", false], // integration warnings — retrying cannot help
      [{ errorCode: "CLIENT_997" }, "invalid_request", false], // formToken from a sister platform's endpoint
      [{ errorCode: "CLIENT_999" }, "psp_unavailable", true],
      [{ errorCode: "PSP_108" }, "session_expired", false], // formToken expiry recovers via a new session
      [{ errorCode: "ACQ_001", detailedErrorCode: "54" }, "expired_card", false],
      [{ errorCode: "ACQ_001", detailedErrorCode: "38" }, "expired_card", false],
      [{ errorCode: "ACQ_001", detailedErrorCode: "59" }, "fraud_suspected", false],
      [{ errorCode: "ACQ_001", detailedErrorCode: "34" }, "fraud_suspected", false],
      [{ errorCode: "ACQ_001", detailedErrorCode: "41" }, "fraud_suspected", false],
      [{ errorCode: "ACQ_001", detailedErrorCode: "1A" }, "authentication_required", false],
      [{ errorCode: "AUTH_149" }, "authentication_required", false],
      [{ errorCode: "SOMETHING_ELSE" }, "processing_error", true], // shopper may safely retry
      [{}, "processing_error", true],
    ];
    for (const [krError, code, retryable] of cases) {
      fake.errorCb?.(krError);
      expect(errors.at(-1), JSON.stringify(krError)).toEqual({ code, retryable });
    }
  });

  it("refines UNPAID declines from AUTH_-family transaction errors", async () => {
    stubBrowser();
    const fake = makeFakeKr();
    const { adapter } = makeAdapter(fake);
    const handle = await adapter.mount(fakeContainer(), { clientSecret: FORM_TOKEN });
    const pending = adapter.confirm(handle);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.submitCb?.({
      clientAnswer: { orderStatus: "UNPAID", transactions: [{ uuid: "u1", errorCode: "AUTH_149" }] },
    });
    expect((await pending).error?.code).toBe("authentication_required");
  });

  it("reports a bare card_declined when an UNPAID answer carries no transaction detail", async () => {
    stubBrowser();
    const fake = makeFakeKr();
    const { adapter } = makeAdapter(fake);
    const handle = await adapter.mount(fakeContainer(), { clientSecret: FORM_TOKEN });
    const pending = adapter.confirm(handle);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.submitCb?.({ clientAnswer: { orderStatus: "UNPAID" } });
    expect((await pending).error?.code).toBe("card_declined");
  });
});

describe("PayZenClientAdapter KR global lookup", () => {
  it("falls back to window.KR when no getKrGlobal seam is configured", async () => {
    const kr = makeFakeKr();
    vi.stubGlobal("window", { KR: kr });
    vi.stubGlobal("document", {
      head: fakeElement(),
      createElement: () => fakeElement(),
      querySelector: () => null,
    });
    const adapter = new PayZenClientAdapter({ publicKey: PUBLIC_KEY, environment: "sandbox" });
    await adapter.loadSdk(); // KR present -> no injection needed
    const handle = await adapter.mount(fakeContainer(), { clientSecret: FORM_TOKEN });
    expect(kr.configCalls).toHaveLength(1);
    adapter.unmount(handle);
  });
});

describe("PayZenClientAdapter unmount", () => {
  it("removes its wrapper and tears the form down, never touching host elements", async () => {
    stubBrowser();
    const { adapter, fake } = makeAdapter();
    const container = fakeContainer();
    const handle = await adapter.mount(container, { clientSecret: FORM_TOKEN });
    const before = fake.removeFormsCalls;
    adapter.unmount(handle);
    expect(fake.removeFormsCalls).toBe(before + 1);
    expect(container.children[0]!.remove).toHaveBeenCalled();
    expect(container.remove).not.toHaveBeenCalled();
  });

  it("survives a KR teardown that throws", async () => {
    stubBrowser();
    const fake = makeFakeKr();
    const { adapter } = makeAdapter(fake);
    const handle = await adapter.mount(fakeContainer(), { clientSecret: FORM_TOKEN });
    fake.removeForms = () => {
      throw new Error("KR already gone");
    };
    expect(() => adapter.unmount(handle)).not.toThrowError();
  });
});

describe("PayZenClientAdapter loadSdk", () => {
  it("rejects during SSR and when the KR global never appears", async () => {
    const noDom = new PayZenClientAdapter({ publicKey: PUBLIC_KEY, environment: "sandbox" });
    await expect(noDom.loadSdk()).rejects.toThrowError(/browser-only/);

    stubBrowser();
    const adapter = new PayZenClientAdapter({
      publicKey: PUBLIC_KEY,
      environment: "sandbox",
      loadScript: async () => {},
      getKrGlobal: () => undefined,
    });
    await expect(adapter.loadSdk()).rejects.toMatchObject({ code: "psp_unavailable" });
  });

  it("injects the stylesheet and a non-async script carrying the kr attributes", async () => {
    const { created, head } = stubBrowser();
    let kr: KrLike | undefined = undefined;
    const adapter = new PayZenClientAdapter({
      publicKey: PUBLIC_KEY,
      environment: "sandbox",
      getKrGlobal: () => kr,
    });
    const loading = adapter.loadSdk();
    const script = created.find((el) => el.src)!;
    expect(script.src).toContain("kr-payment-form.min.js");
    expect(script.async).toBe(false); // PayZen forbids async loading; dynamic scripts default to async
    expect(script.attributes["kr-public-key"]).toBe(PUBLIC_KEY);
    expect(script.attributes["kr-spa-mode"]).toBe("true");
    const link = created.find((el) => el.rel === "stylesheet")!;
    expect(link.href).toContain("neon-reset.min.css");
    expect(head.children).toContain(script);
    kr = makeFakeKr();
    script.onload?.();
    await expect(loading).resolves.toBeUndefined();
  });

  it("reuses already-injected assets instead of adding a second script (single KR global per page)", async () => {
    const { created, existing } = stubBrowser();
    existing.set(
      'script[src="https://static.payzen.eu/static/js/krypton-client/V4.0/stable/kr-payment-form.min.js"]',
      fakeElement(),
    );
    existing.set(
      'link[href="https://static.payzen.eu/static/js/krypton-client/V4.0/ext/neon-reset.min.css"]',
      fakeElement(),
    );
    const kr = makeFakeKr();
    let lookups = 0;
    const adapter = new PayZenClientAdapter({
      publicKey: PUBLIC_KEY,
      environment: "sandbox",
      // Absent before injection runs, present afterwards — e.g. another
      // adapter instance already loaded krypton on this page.
      getKrGlobal: () => (lookups++ === 0 ? undefined : kr),
    });
    await adapter.loadSdk();
    expect(created).toHaveLength(0); // nothing new injected
  });

  it("maps a script load failure to a retryable psp_unavailable", async () => {
    const { created } = stubBrowser();
    const adapter = new PayZenClientAdapter({
      publicKey: PUBLIC_KEY,
      environment: "sandbox",
      getKrGlobal: () => undefined,
    });
    const loading = adapter.loadSdk();
    created.find((el) => el.src)!.onerror?.();
    await expect(loading).rejects.toMatchObject({ code: "psp_unavailable", retryable: true });
  });

  it("honors scriptUrl/cssUrl overrides", async () => {
    const { created } = stubBrowser();
    let kr: KrLike | undefined = undefined;
    const adapter = new PayZenClientAdapter({
      publicKey: PUBLIC_KEY,
      environment: "sandbox",
      scriptUrl: "https://assets.example/kr.js",
      cssUrl: "https://assets.example/kr.css",
      getKrGlobal: () => kr,
    });
    const loading = adapter.loadSdk();
    expect(created.find((el) => el.src)!.src).toBe("https://assets.example/kr.js");
    expect(created.find((el) => el.rel === "stylesheet")!.href).toBe("https://assets.example/kr.css");
    kr = makeFakeKr();
    created.find((el) => el.src)!.onload?.();
    await loading;
  });
});
