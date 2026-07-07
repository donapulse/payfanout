/**
 * Both PSPs behind identical UI, switchable at runtime — and the whole checkout
 * localizes at runtime across en/fr/de/es. UI chrome comes from the demo's own
 * `t()` dictionary; payment error text comes from the LIBRARY via
 * `localizeError` (proving @payfanout/core ships those translations); and the
 * active locale is handed to both <PayFanoutProvider> and <PaymentFields> so
 * the PSP's own hosted-field texts follow the language too.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { StripeClientAdapter } from "@payfanout/adapter-stripe";
import { PaysafeClientAdapter } from "@payfanout/adapter-paysafe";
import { GoCardlessClientAdapter } from "@payfanout/adapter-gocardless";
import { PayFanoutProvider, PaymentFields, usePay, usePayFanout, type PayResult } from "@payfanout/react";
import { localizeError, PayFanoutError, type PaymentInfo } from "@payfanout/core";
import { I18nProvider, LOCALES, useI18n } from "./i18n.js";

const adapters = [
  new StripeClientAdapter({
    publishableKey: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? "pk_test_replace_me",
    environment: "sandbox",
  }),
  new PaysafeClientAdapter({
    apiKey: import.meta.env.VITE_PAYSAFE_PUBLIC_KEY ?? "replace_me_base64",
    environment: "sandbox",
  }),
  // No client key at all: the session's clientSecret carries the hosted flow URL.
  new GoCardlessClientAdapter({ environment: "sandbox" }),
];

// The order total, shown verbatim in every language (a real app would format
// per-locale with Intl.NumberFormat; the sandbox account here is USD).
const AMOUNT_LABEL = "$10.99";

// Appearance tokens are PSP-vocabulary: same design intent, each SDK's format.
const APPEARANCE_BY_PSP: Record<string, Record<string, unknown>> = {
  stripe: { theme: "flat", variables: { colorPrimary: "#635bff", borderRadius: "8px" } },
  paysafe: { input: { "font-family": "system-ui, sans-serif", "font-size": "16px", color: "#32325d" } },
  gocardless: { panel: { padding: "12px", background: "#f8f9fb", borderRadius: "8px", color: "#32325d" } },
};

const SLOT_BOX: React.CSSProperties = {
  border: "1px solid #d0d5dd",
  borderRadius: 8,
  padding: "4px 10px",
  background: "#fff",
};

// Sandbox accounts are provisioned per currency (Paysafe test accounts are often CAD).
const CURRENCY_BY_PSP: Record<string, string> = {
  stripe: "USD",
  paysafe: import.meta.env.VITE_PAYSAFE_CURRENCY ?? "USD",
  gocardless: "GBP", // one-off GoCardless bank payments are GBP/EUR only
  // "auto" lets the SERVER pick the PSP via PaymentRouter rules (by currency) —
  // using the Paysafe account's currency demonstrates routing AWAY from the default.
  auto: import.meta.env.VITE_PAYSAFE_CURRENCY ?? "USD",
};
const BILLING_BY_CURRENCY: Record<string, { country: string; postalCode: string }> = {
  USD: { country: "US", postalCode: "10001" },
  CAD: { country: "CA", postalCode: "M5V 3L9" },
  EUR: { country: "DE", postalCode: "10115" },
  GBP: { country: "GB", postalCode: "SW1A 1AA" },
};

export function App(): JSX.Element {
  return (
    <I18nProvider>
      <LocalizedApp />
    </I18nProvider>
  );
}

function LocalizedApp(): JSX.Element {
  const { locale } = useI18n();
  return (
    // locale flows to the library: the default <PayButton> label and any
    // library-rendered text localize; hosts still override with their own copy.
    <PayFanoutProvider adapters={adapters} initialPsp="stripe" locale={locale}>
      <Checkout />
    </PayFanoutProvider>
  );
}

interface CheckoutSession {
  psp: string;
  orderId: string;
  clientSecret: string;
}

function LanguagePicker(): JSX.Element {
  const { locale, setLocale, t } = useI18n();
  return (
    <label style={{ float: "right", fontSize: 14, color: "#666" }}>
      {t("demo.language")}{" "}
      <select value={locale} onChange={(e) => setLocale(e.target.value as typeof locale)}>
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Checkout(): JSX.Element {
  const { t, tStatus, locale } = useI18n();
  const { activePsp, setActivePsp, availablePsps, capabilities, status } = usePayFanout();
  // What the customer picked: a concrete PSP, or "auto" (server-side routing).
  const [choice, setChoice] = useState("stripe");
  // Session is tracked WITH its psp: a clientSecret must never reach another
  // PSP's adapter during the switch (they are not interchangeable).
  const [session, setSession] = useState<CheckoutSession>();
  const [result, setResult] = useState<PayResult>();
  // Field-state stream from the PSP's own SDK — Pay stays disabled until valid.
  const [fieldsComplete, setFieldsComplete] = useState(false);
  // "Save my card" consent — vaulting only ever happens with this checked.
  const [saveCard, setSaveCard] = useState(false);
  const [savedCard, setSavedCard] = useState<{ psp: string; label: string }>();

  // Full design-system control, PSP vocabulary passed through untouched. The
  // Paysafe field placeholders follow the active language.
  const fieldOptionsByPsp = useMemo<Record<string, Record<string, unknown>>>(
    () => ({
      stripe: {
        layout: { type: "accordion", defaultCollapsed: false, radios: true },
        paymentMethodOrder: ["card"],
      },
      paysafe: {
        fields: {
          cardNumber: { placeholder: t("demo.field.cardNumber") },
          expiryDate: { placeholder: t("demo.field.expiry") },
          cvv: { placeholder: t("demo.field.cvv") },
        },
      },
    }),
    [t],
  );

  // Stale-state reset lives in the event handlers (select/checkbox); this
  // effect only loads the session for the current choice. The cancellation
  // flag matters: without it, a slow response for the PREVIOUS choice lands
  // after the switch and clobbers the new session.
  const resetCheckout = useCallback(() => {
    setSession(undefined);
    setResult(undefined);
    setFieldsComplete(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        psp: choice,
        amount: 1099,
        currency: CURRENCY_BY_PSP[choice] ?? "USD",
        billing: BILLING_BY_CURRENCY[CURRENCY_BY_PSP[choice] ?? "USD"],
        save: saveCard,
      }),
    })
      .then(async (r) => {
        const data = (await r.json()) as {
          orderId?: string;
          clientSecret?: string;
          pspName?: string;
          error?: string;
        };
        if (!r.ok || !data.orderId || !data.clientSecret) {
          throw new Error(data.error ?? `session creation failed (HTTP ${r.status})`);
        }
        if (cancelled) return;
        const routedPsp = data.pspName ?? choice;
        // "auto": the router picked — activate that adapter for the mount.
        if (routedPsp !== activePsp) setActivePsp(routedPsp);
        setSession({ psp: routedPsp, orderId: data.orderId, clientSecret: data.clientSecret });
      })
      .catch((err: unknown) => {
        // Surface session failures in the UI — silent checkout failures are the worst kind.
        if (!cancelled) setResult({ status: "failed", error: PayFanoutError.wrap(err) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one session per choice/consent
  }, [choice, saveCard]);

  // Learn the vaulting outcome after a successful payment. Paysafe's server
  // completion already carries the token; Stripe's confirm happened client-side,
  // so the token is fetched from the host API.
  const handleResult = useCallback(
    (payResult: PayResult) => {
      setResult(payResult);
      if (payResult.status !== "succeeded" || !saveCard || !session) return;
      const psp = session.psp;
      const fromInfo = payResult.info?.savedPaymentMethodToken;
      const details = payResult.info?.paymentMethodDetails;
      if (fromInfo) {
        setSavedCard({ psp, label: details ? `${details.brand ?? "card"} •••• ${details.last4 ?? "????"}` : "card" });
        return;
      }
      void fetch(`/api/orders/${session.orderId}/vault`)
        .then(async (r) => (await r.json()) as {
          savedPaymentMethodToken: string | null;
          paymentMethodDetails: { brand?: string; last4?: string } | null;
        })
        .then((data) => {
          if (data.savedPaymentMethodToken) {
            const d = data.paymentMethodDetails;
            setSavedCard({ psp, label: d ? `${d.brand ?? "card"} •••• ${d.last4 ?? "????"}` : "card" });
          }
        })
        .catch(() => undefined);
    },
    [saveCard, session],
  );

  // Tokenize-first PSPs (Paysafe) land here; Stripe never calls it.
  const orderId = session?.orderId;
  const onServerCompletion = useCallback(
    async (clientToken: string): Promise<PaymentInfo> => {
      const response = await fetch("/api/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId, clientToken }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      return (await response.json()) as PaymentInfo;
    },
    [orderId],
  );

  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "system-ui" }}>
      <LanguagePicker />
      <h1>
        {t("demo.title")} — {AMOUNT_LABEL}
      </h1>

      <label>
        {t("demo.paymentProvider")}{" "}
        <select
          value={choice}
          onChange={(e) => {
            resetCheckout();
            setChoice(e.target.value);
            if (e.target.value !== "auto") setActivePsp(e.target.value);
          }}
        >
          <option value="auto">{t("demo.autoRouted")}</option>
          {availablePsps.map((psp) => (
            <option key={psp} value={psp}>
              {psp}
            </option>
          ))}
        </select>
      </label>
      <p style={{ color: "#666" }} data-routed-psp={session?.psp ?? ""}>
        {t("demo.sdkStatus")}: {status}
        {choice === "auto" && session ? ` · ${t("demo.routedTo")}: ${session.psp}` : ""} · {t("demo.methods")}:{" "}
        {capabilities.filter((c) => c.supported).map((c) => `${c.type} (${c.flow})`).join(", ")}
      </p>

      {session && session.psp === activePsp && (
        <>
          <PaymentFields
            key={`${session.psp}:${session.clientSecret}:${locale}`}
            psp={session.psp}
            clientSecret={session.clientSecret}
            appearance={APPEARANCE_BY_PSP[session.psp]}
            fieldOptions={fieldOptionsByPsp[session.psp]}
            locale={locale}
            onChange={(state) => setFieldsComplete(state.complete)}
            onError={(err) => {
              // Raw PSP error to the console: PayFanoutError messages are user-safe,
              // the diagnostics live on `raw`.
              console.error("[payfanout-demo] mount failed, raw PSP error:", JSON.stringify((err as { raw?: unknown }).raw ?? String(err)));
              setResult({ status: "failed", error: err });
            }}
          >
            {/* Split-field PSPs (Paysafe): the HOST owns the layout via slots —
                here a 2-column expiry/CVV row, any grid works. Stripe's single
                Payment Element ignores slots (layout via fieldOptions). */}
            {session.psp === "paysafe" && (
              <div style={{ display: "grid", gap: 8 }}>
                <div data-payfanout-field="cardNumber" style={SLOT_BOX} />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div data-payfanout-field="expiryDate" style={SLOT_BOX} />
                  <div data-payfanout-field="cvv" style={SLOT_BOX} />
                </div>
              </div>
            )}
          </PaymentFields>
          <label style={{ display: "block", marginTop: 12 }}>
            <input type="checkbox" checked={saveCard} onChange={(e) => { resetCheckout(); setSaveCard(e.target.checked); }} />{" "}
            {t("demo.saveCard")}
          </label>
          <DesignSystemPayButton
            disabled={!fieldsComplete}
            onResult={handleResult}
            onServerCompletion={onServerCompletion}
          />
        </>
      )}

      {result && (
        <p role="status">
          {result.status === "succeeded"
            ? `✅ ${t("demo.paid", { id: result.info?.pspPaymentId ?? t("demo.confirmedClientSide") })}`
            : result.error
              ? `❌ ${result.error.code}: ${localizeError(result.error, locale)}`
              : t("demo.statusLabel", { status: tStatus(result.status) })}
        </p>
      )}

      {savedCard && <VaultPanel psp={savedCard.psp} label={savedCard.label} />}
    </main>
  );
}

/**
 * Bring-your-own-button: usePay() gives any design-system button the exact
 * <PayButton> behavior (confirm + §4a branching + normalized failures) —
 * the styling and label below are 100% the host's (localized here via t()).
 */
function DesignSystemPayButton(props: {
  disabled?: boolean;
  onResult: (result: PayResult) => void;
  onServerCompletion?: (clientToken: string) => Promise<PaymentInfo>;
}): JSX.Element {
  const { t } = useI18n();
  const { pay, paying } = usePay({ onServerCompletion: props.onServerCompletion });
  return (
    <button
      type="button"
      disabled={props.disabled || paying}
      onClick={() => void pay().then(props.onResult)}
      style={{
        marginTop: 16,
        padding: "12px 28px",
        border: "none",
        borderRadius: 999,
        background: props.disabled || paying ? "#c7c9d1" : "linear-gradient(135deg, #635bff, #9066ff)",
        color: "#fff",
        fontWeight: 600,
        fontSize: 15,
        cursor: props.disabled || paying ? "not-allowed" : "pointer",
        boxShadow: props.disabled || paying ? "none" : "0 4px 14px rgba(99, 91, 255, .35)",
      }}
    >
      {paying ? t("demo.paying") : t("demo.pay", { amount: AMOUNT_LABEL })}
    </button>
  );
}

/**
 * Everything after the card is vaulted: off-session recharges and the full
 * subscription lifecycle — no card fields anywhere below this line.
 */
function VaultPanel({ psp, label }: { psp: string; label: string }): JSX.Element {
  const { t, tStatus } = useI18n();
  const [chargeMessage, setChargeMessage] = useState<string>();
  const [subscription, setSubscription] = useState<{
    id: string;
    status: string;
    currentPeriodEnd: string;
    lastPaymentId?: string;
  }>();
  const [subscriptionMessage, setSubscriptionMessage] = useState<string>();

  const post = async (url: string, body?: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error((data["error"] as string) ?? `HTTP ${response.status}`);
    return data;
  };

  return (
    <section data-testid="vault-panel" style={{ marginTop: 24, borderTop: "1px solid #ddd", paddingTop: 16 }}>
      <p data-testid="saved-card">💳 {t("demo.cardSaved", { label })}</p>
      <button
        type="button"
        data-testid="charge-saved"
        onClick={() => {
          setChargeMessage(t("demo.charging"));
          post("/api/charge-saved", { psp, amount: 1099 })
            .then((info) => setChargeMessage(`✅ ${t("demo.chargedAgain", { id: String(info["pspPaymentId"]) })}`))
            .catch((err: Error) => setChargeMessage(`❌ ${err.message}`));
        }}
      >
        {t("demo.chargeSaved", { amount: AMOUNT_LABEL })}
      </button>
      {chargeMessage && <p data-testid="charge-saved-result">{chargeMessage}</p>}

      <div style={{ marginTop: 12 }}>
        {!subscription ? (
          <button
            type="button"
            data-testid="subscribe"
            onClick={() => {
              setSubscriptionMessage(t("demo.subscribing"));
              post("/api/subscriptions", { psp, amount: 1099 })
                .then((data) => {
                  setSubscription(data["subscription"] as never);
                  setSubscriptionMessage(undefined);
                })
                .catch((err: Error) => setSubscriptionMessage(`❌ ${err.message}`));
            }}
          >
            {t("demo.subscribe", { amount: AMOUNT_LABEL })}
          </button>
        ) : (
          <div data-testid="subscription">
            <p data-testid="subscription-state">
              📅 {t("demo.subscriptionState", { status: tStatus(subscription.status), date: subscription.currentPeriodEnd.slice(0, 10) })}
              {subscription.lastPaymentId ? ` · ${t("demo.lastPayment", { id: subscription.lastPaymentId })}` : ""}
            </p>
            <button
              type="button"
              data-testid="simulate-renewal"
              disabled={subscription.status !== "active"}
              onClick={() => {
                setSubscriptionMessage(t("demo.collectingRenewal"));
                post(`/api/subscriptions/${subscription.id}/simulate-renewal`)
                  .then((data) => {
                    setSubscription(data["subscription"] as never);
                    setSubscriptionMessage(`✅ ${t("demo.renewalCharged")}`);
                  })
                  .catch((err: Error) => setSubscriptionMessage(`❌ ${err.message}`));
              }}
            >
              {t("demo.simulateRenewal")}
            </button>{" "}
            <button
              type="button"
              data-testid="cancel-subscription"
              disabled={subscription.status === "canceled"}
              onClick={() => {
                post(`/api/subscriptions/${subscription.id}/cancel`)
                  .then((record) => {
                    setSubscription(record as never);
                    setSubscriptionMessage(t("demo.subscriptionCanceled"));
                  })
                  .catch((err: Error) => setSubscriptionMessage(`❌ ${err.message}`));
              }}
            >
              {t("demo.cancelSubscription")}
            </button>
          </div>
        )}
        {subscriptionMessage && <p data-testid="subscription-result">{subscriptionMessage}</p>}
      </div>
    </section>
  );
}
