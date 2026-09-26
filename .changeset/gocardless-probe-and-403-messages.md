---
"@payfanout/adapter-gocardless-server": patch
---

`verifyCredentials` now reports `ok: true` only when the connection check returns GoCardless's payment list. Any other answer that is neither an authentication rejection nor a transient error, such as a 404 from a wrong `baseUrl`, a rejected `goCardlessVersion` override or a web page at a mis-pasted `baseUrl`, reports a failure with `category: "internal"` instead of `ok: true`, and its message names the HTTP status and, when it reads as one, GoCardless's error reason. A 403 from GoCardless now carries a message chosen from its reason: refunds not enabled on the account (enable them in the GoCardless Dashboard), an access token without the required scope, or an action only the GoCardless Dashboard allows. A refund 403 without such a reason names both likely causes.
