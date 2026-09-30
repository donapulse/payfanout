/**
 * The Stripe API version both halves pin, in one place. The server adapter sends
 * it on every call. The client adapter picks the Stripe.js build from it: a date
 * alone, as here, loads Stripe.js v3, which is then given this version and
 * speaks exactly it; a version with a release name, such as
 * "2026-08-26.dahlia", loads that release's build, which speaks the API version
 * Stripe pins it to within the release.
 */
export const STRIPE_API_VERSION = "2024-06-20";
