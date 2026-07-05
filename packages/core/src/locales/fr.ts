import type { LocaleBundle } from "./index.js";

/**
 * French (fr) — reviewed translations (vouvoiement). Localized decline messages
 * follow the register a PSP uses: calm, non-technical, reassuring.
 */
export const fr: LocaleBundle = {
  errors: {
    card_declined: "Votre carte a été refusée.",
    insufficient_funds: "Votre carte ne dispose pas de fonds suffisants.",
    expired_card: "Votre carte a expiré.",
    invalid_card_data: "Les informations de la carte sont invalides.",
    authentication_required: "Une authentification supplémentaire est requise pour finaliser ce paiement.",
    fraud_suspected: "Votre carte a été refusée.",
    processing_error: "Le paiement n'a pas pu être traité — veuillez réessayer.",
    rate_limited: "Trop de tentatives — veuillez réessayer sous peu.",
    psp_unavailable: "Le prestataire de paiement est temporairement indisponible.",
    invalid_request: "La demande de paiement est invalide.",
    unknown: "Le paiement a échoué. Veuillez réessayer ou utiliser un autre moyen de paiement.",
  },
  ui: {
    pay: "Payer",
  },
};
