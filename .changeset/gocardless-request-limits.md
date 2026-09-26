---
"@payfanout/adapter-gocardless-server": patch
---

Check GoCardless's documented request limits before sending anything: metadata key names over 50 characters or values over 500, a session `amount` of 0 and a subscription `intervalCount` that would leave a year without a charge now reject with an `invalid_request` naming the limit, instead of a generic error from GoCardless. Amounts GoCardless returns as strings of digits now read as integers on every read, and any other amount rejects the read with `unknown` rather than reaching `amount` or `amountRefunded` as a string. An idempotency key over GoCardless's 128 characters, or one no request header can carry, is now sent as a SHA-256 digest of itself, the same for every retry, instead of failing; every request now sends `Accept: application/json`, and `fallback_enabled` is sent only when `fallbackEnabled` is `true`, as GoCardless asks accounts that use its payment intelligence feature.
