/**
 * The Stripe API version both halves pin, in one place: the server adapter sends
 * it on every call, and the client adapter loads the Stripe.js build that speaks
 * it. A date alone loads Stripe.js v3; a version with a release name, such as
 * "2026-08-26.dahlia", loads that release's build.
 */
export const STRIPE_API_VERSION = "2024-06-20";
