---
"@payfanout/adapter-paysafe": patch
---

Card tokenization now always sends the `merchantRefNum` Paysafe.js requires, fresh on every attempt (the session `id` when set, then a random suffix, 255 characters at most), so sessions created without an `id` can take card payments and a card retried after a decline gets a new reference. Setup preselects the session's merchant account with Paysafe.js's documented `accounts.default` option instead of an `accountId` it ignores, which API keys holding more than one account for the currency need, and the adapter calls `show()` after setup as Paysafe documents, failing the mount when the card fields report an initialization error.
