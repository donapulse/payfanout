import type { LocaleBundle } from "./index.js";

/**
 * German (de) — reviewed translations (Sie-Form). Localized decline messages
 * follow the register a PSP uses: calm, non-technical, reassuring.
 */
export const de: LocaleBundle = {
  errors: {
    card_declined: "Ihre Karte wurde abgelehnt.",
    insufficient_funds: "Ihre Karte verfügt nicht über ausreichendes Guthaben.",
    expired_card: "Ihre Karte ist abgelaufen.",
    invalid_card_data: "Die Kartendaten sind ungültig.",
    authentication_required: "Zum Abschluss dieser Zahlung ist eine zusätzliche Authentifizierung erforderlich.",
    fraud_suspected: "Ihre Karte wurde abgelehnt.",
    processing_error: "Die Zahlung konnte nicht verarbeitet werden — bitte versuchen Sie es erneut.",
    rate_limited: "Zu viele Anfragen — bitte versuchen Sie es in Kürze erneut.",
    psp_unavailable: "Der Zahlungsanbieter ist vorübergehend nicht verfügbar.",
    invalid_request: "Die Zahlungsanfrage war ungültig.",
    session_expired: "Ihre Zahlungssitzung ist abgelaufen — bitte beginnen Sie erneut.",
    unsupported_operation: "Dieser Zahlungsvorgang ist für den ausgewählten Anbieter nicht verfügbar.",
    unknown: "Die Zahlung ist fehlgeschlagen. Bitte versuchen Sie es erneut oder verwenden Sie eine andere Zahlungsmethode.",
  },
  ui: {
    pay: "Bezahlen",
  },
};
