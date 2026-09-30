---
"@payfanout/adapter-gocardless-server": patch
---

Check GoCardless's documented request limits before sending: metadata key names over 50 characters or values over 500, a session `amount` of 0 and a subscription `intervalCount` that leaves a year without a charge now reject with an `invalid_request` naming the limit, instead of a generic error from GoCardless. Amounts GoCardless returns as strings now read as integers when they are whole numbers of minor units, and otherwise reject the read with `unknown`. An idempotency key GoCardless never received, over its 128 characters or one no request header can carry, is sent as a SHA-256 digest of itself instead of failing, every request sends `Accept: application/json`, and `fallback_enabled` is sent only when `fallbackEnabled` is `true`.
