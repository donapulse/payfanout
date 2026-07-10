---
"@payfanout/adapter-paysafe": patch
---

Coerce a digit-only Paysafe `merchantAccountId` to the numeric form Paysafe.js requires. A `merchantAccountResolver` returning the account id as a string (the documented type) previously failed every tokenize client-side with error 9003 ("Invalid accountId parameter") before any card data was evaluated. The account id is now passed to `fields.setup`/`tokenize` as a number; ids too large to represent exactly are left as strings so one is never silently rounded to a different account.
