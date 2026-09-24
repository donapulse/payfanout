---
"@payfanout/adapter-paysafe": patch
---

Card tokenization now always sends the `merchantRefNum` Paysafe.js requires, fresh on every attempt (the session `id` when set, then a random suffix, 255 characters at most), so sessions created without an `id` can take card payments and a card retried after a decline gets a new reference. Setup preselects the session's merchant account with Paysafe.js's documented `accounts.default` option instead of an `accountId` it ignores, which API keys holding more than one account for the currency need; when the session's account is numeric it replaces any `fieldOptions.accounts`. The adapter also calls `show()` after setup, as Paysafe documents, so a setup whose options add another payment method is no longer left locked.
