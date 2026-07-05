/**
 * A tiny, dependency-free i18n layer for the demo — just enough to show the
 * whole checkout (labels, statuses, and PSP error text) switch language at
 * runtime across en/fr/de/es. Error messages are localized by the LIBRARY
 * (`localizeError` from @payfanout/core); this dictionary covers the app's own
 * chrome. A real app would use react-intl / i18next, but the shape is the same:
 * a locale, a `t(key)`, and one source of truth per language.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export const LOCALES = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

const en = {
  "demo.title": "PayFanout demo",
  "demo.language": "Language",
  "demo.paymentProvider": "Payment provider",
  "demo.autoRouted": "auto (routed)",
  "demo.sdkStatus": "SDK status",
  "demo.routedTo": "routed to",
  "demo.methods": "methods",
  "demo.saveCard": "Save my card for future payments",
  "demo.field.cardNumber": "Card number",
  "demo.field.expiry": "MM/YY",
  "demo.field.cvv": "CVV",
  "demo.pay": "Pay {amount}",
  "demo.paying": "Paying…",
  "demo.paid": "Paid — {id}",
  "demo.confirmedClientSide": "confirmed client-side",
  "demo.statusLabel": "Status: {status}",
  "demo.cardSaved": "Card saved: {label} — the PSP holds the card; this app holds only a token.",
  "demo.chargeSaved": "Charge saved card {amount} (off-session)",
  "demo.charging": "charging…",
  "demo.chargedAgain": "charged again — {id}",
  "demo.subscribe": "Subscribe {amount}/month",
  "demo.subscribing": "subscribing…",
  "demo.subscriptionState": "Subscription {status} — paid through {date}",
  "demo.lastPayment": "last payment {id}",
  "demo.simulateRenewal": "Simulate next renewal (real charge)",
  "demo.collectingRenewal": "collecting renewal…",
  "demo.renewalCharged": "renewal charged",
  "demo.cancelSubscription": "Cancel subscription",
  "demo.subscriptionCanceled": "subscription canceled",
  "status.requires_payment_method": "requires payment method",
  "status.requires_confirmation": "requires confirmation",
  "status.requires_action": "requires action",
  "status.requires_capture": "requires capture",
  "status.processing": "processing",
  "status.succeeded": "succeeded",
  "status.canceled": "canceled",
  "status.failed": "failed",
  "status.active": "active",
  "status.past_due": "past due",
} as const;

export type TKey = keyof typeof en;

// Reviewed translations (adversarial verify + cross-language consistency pass).
// Payment/subscription error text comes from @payfanout/core; these cover the
// demo's own chrome. Field placeholders (Card number / MM-YY / CVV) are the
// demo's, not the workflow's.
const fr: Record<TKey, string> = {
  "demo.title": "Démo PayFanout",
  "demo.language": "Langue",
  "demo.paymentProvider": "Prestataire de paiement",
  "demo.autoRouted": "auto (acheminé)",
  "demo.sdkStatus": "Statut du SDK",
  "demo.routedTo": "acheminé vers",
  "demo.methods": "moyens",
  "demo.saveCard": "Enregistrer ma carte pour mes prochains paiements",
  "demo.field.cardNumber": "Numéro de carte",
  "demo.field.expiry": "MM/AA",
  "demo.field.cvv": "CVV",
  "demo.pay": "Payer {amount}",
  "demo.paying": "Paiement en cours…",
  "demo.paid": "Payé — {id}",
  "demo.confirmedClientSide": "confirmé côté client",
  "demo.statusLabel": "Statut : {status}",
  "demo.cardSaved": "Carte enregistrée : {label} — le PSP conserve la carte ; cette application ne conserve qu'un jeton.",
  "demo.chargeSaved": "Débiter la carte enregistrée de {amount} (hors session)",
  "demo.charging": "débit en cours…",
  "demo.chargedAgain": "nouveau débit — {id}",
  "demo.subscribe": "S'abonner {amount}/mois",
  "demo.subscribing": "abonnement en cours…",
  "demo.subscriptionState": "Abonnement {status} — payé jusqu'au {date}",
  "demo.lastPayment": "dernier paiement {id}",
  "demo.simulateRenewal": "Simuler le prochain renouvellement (débit réel)",
  "demo.collectingRenewal": "encaissement du renouvellement…",
  "demo.renewalCharged": "renouvellement encaissé",
  "demo.cancelSubscription": "Résilier l'abonnement",
  "demo.subscriptionCanceled": "abonnement résilié",
  "status.requires_payment_method": "moyen de paiement requis",
  "status.requires_confirmation": "confirmation requise",
  "status.requires_action": "action requise",
  "status.requires_capture": "capture requise",
  "status.processing": "en cours de traitement",
  "status.succeeded": "réussi",
  "status.canceled": "annulé",
  "status.failed": "échoué",
  "status.active": "actif",
  "status.past_due": "en retard de paiement",
};

const de: Record<TKey, string> = {
  "demo.title": "PayFanout-Demo",
  "demo.language": "Sprache",
  "demo.paymentProvider": "Zahlungsanbieter",
  "demo.autoRouted": "automatisch (weitergeleitet)",
  "demo.sdkStatus": "SDK-Status",
  "demo.routedTo": "weitergeleitet an",
  "demo.methods": "Methoden",
  "demo.saveCard": "Meine Karte für zukünftige Zahlungen speichern",
  "demo.field.cardNumber": "Kartennummer",
  "demo.field.expiry": "MM/JJ",
  "demo.field.cvv": "CVV",
  "demo.pay": "{amount} bezahlen",
  "demo.paying": "Zahlung läuft…",
  "demo.paid": "Bezahlt — {id}",
  "demo.confirmedClientSide": "clientseitig bestätigt",
  "demo.statusLabel": "Status: {status}",
  "demo.cardSaved": "Karte gespeichert: {label} — der PSP speichert die Karte; diese App speichert nur ein Token.",
  "demo.chargeSaved": "Gespeicherte Karte mit {amount} belasten (außerhalb der Sitzung)",
  "demo.charging": "wird belastet…",
  "demo.chargedAgain": "erneut belastet — {id}",
  "demo.subscribe": "{amount}/Monat abonnieren",
  "demo.subscribing": "wird abonniert…",
  "demo.subscriptionState": "Abonnement {status} — bezahlt bis {date}",
  "demo.lastPayment": "letzte Zahlung {id}",
  "demo.simulateRenewal": "Nächste Verlängerung simulieren (echte Belastung)",
  "demo.collectingRenewal": "Verlängerung wird eingezogen…",
  "demo.renewalCharged": "Verlängerung belastet",
  "demo.cancelSubscription": "Abonnement kündigen",
  "demo.subscriptionCanceled": "Abonnement gekündigt",
  "status.requires_payment_method": "Zahlungsmethode erforderlich",
  "status.requires_confirmation": "Bestätigung erforderlich",
  "status.requires_action": "Aktion erforderlich",
  "status.requires_capture": "Erfassung erforderlich",
  "status.processing": "wird verarbeitet",
  "status.succeeded": "erfolgreich",
  "status.canceled": "storniert",
  "status.failed": "fehlgeschlagen",
  "status.active": "aktiv",
  "status.past_due": "überfällig",
};

const es: Record<TKey, string> = {
  "demo.title": "Demo de PayFanout",
  "demo.language": "Idioma",
  "demo.paymentProvider": "Proveedor de pagos",
  "demo.autoRouted": "auto (enrutado)",
  "demo.sdkStatus": "Estado del SDK",
  "demo.routedTo": "enrutado a",
  "demo.methods": "métodos",
  "demo.saveCard": "Guardar mi tarjeta para futuros pagos",
  "demo.field.cardNumber": "Número de tarjeta",
  "demo.field.expiry": "MM/AA",
  "demo.field.cvv": "CVV",
  "demo.pay": "Pagar {amount}",
  "demo.paying": "Pagando…",
  "demo.paid": "Pagado — {id}",
  "demo.confirmedClientSide": "confirmado del lado del cliente",
  "demo.statusLabel": "Estado: {status}",
  "demo.cardSaved": "Tarjeta guardada: {label} — el PSP conserva la tarjeta; esta aplicación solo guarda un token.",
  "demo.chargeSaved": "Cobrar {amount} a la tarjeta guardada (fuera de sesión)",
  "demo.charging": "cobrando…",
  "demo.chargedAgain": "cobrado de nuevo — {id}",
  "demo.subscribe": "Suscribirse por {amount}/mes",
  "demo.subscribing": "suscribiendo…",
  "demo.subscriptionState": "Suscripción {status} — pagada hasta {date}",
  "demo.lastPayment": "último pago {id}",
  "demo.simulateRenewal": "Simular la próxima renovación (cobro real)",
  "demo.collectingRenewal": "cobrando renovación…",
  "demo.renewalCharged": "renovación cobrada",
  "demo.cancelSubscription": "Cancelar suscripción",
  "demo.subscriptionCanceled": "suscripción cancelada",
  "status.requires_payment_method": "requiere método de pago",
  "status.requires_confirmation": "requiere confirmación",
  "status.requires_action": "requiere acción",
  "status.requires_capture": "requiere captura",
  "status.processing": "procesando",
  "status.succeeded": "completado",
  "status.canceled": "cancelado",
  "status.failed": "fallido",
  "status.active": "activa",
  "status.past_due": "vencida",
};

const DICTIONARIES: Record<Locale, Record<TKey, string>> = { en, fr, de, es };

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

export interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** Translate a key for the active locale, interpolating {placeholders}. */
  t: (key: TKey, params?: Record<string, string | number>) => string;
  /** Localize a unified payment/subscription status word (falls back to the raw value). */
  tStatus: (status: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }): ReactNode {
  const [locale, setLocale] = useState<Locale>("en");

  const value = useMemo<I18nValue>(() => {
    const dict = DICTIONARIES[locale];
    const t = (key: TKey, params?: Record<string, string | number>): string =>
      interpolate(dict[key] ?? en[key] ?? key, params);
    return {
      locale,
      setLocale,
      t,
      tStatus: (status: string) => {
        const key = `status.${status}` as TKey;
        return dict[key] ?? en[key] ?? status;
      },
    };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within <I18nProvider>");
  return ctx;
}
