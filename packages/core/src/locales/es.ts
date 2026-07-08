import type { LocaleBundle } from "./index.js";

/**
 * Spanish (es) — reviewed translations (usted, neutral international). Localized
 * decline messages follow the register a PSP uses: calm, non-technical, reassuring.
 */
export const es: LocaleBundle = {
  errors: {
    card_declined: "Su tarjeta fue rechazada.",
    insufficient_funds: "Su tarjeta no tiene fondos suficientes.",
    expired_card: "Su tarjeta ha caducado.",
    invalid_card_data: "Los datos de la tarjeta no son válidos.",
    authentication_required: "Se requiere autenticación adicional para completar este pago.",
    fraud_suspected: "Su tarjeta fue rechazada.",
    processing_error: "No se pudo procesar el pago — inténtelo de nuevo.",
    rate_limited: "Demasiadas solicitudes — vuelva a intentarlo en breve.",
    psp_unavailable: "El proveedor de pagos no está disponible temporalmente.",
    invalid_request: "La solicitud de pago no fue válida.",
    session_expired: "Tu sesión de pago ha expirado — vuelve a empezar.",
    unsupported_operation: "Esta operación de pago no está disponible para el proveedor seleccionado.",
    unknown: "El pago no se pudo completar. Inténtelo de nuevo o utilice otro método de pago.",
  },
  ui: {
    pay: "Pagar",
  },
};
