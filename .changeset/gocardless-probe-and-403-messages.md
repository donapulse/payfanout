---
"@payfanout/adapter-gocardless-server": patch
---

`verifyCredentials` now reports a failure, `category: "internal"`, when GoCardless answers the connection check with a status that is neither a success, an authentication rejection nor a transient error, such as a 404 from a wrong `baseUrl` or a rejected `goCardlessVersion` override, where it used to report `ok: true`; the message names the HTTP status and GoCardless's error reason. A 403 from GoCardless now carries a message chosen from its reason: refunds not enabled on the account (enable them in the GoCardless Dashboard), an access token without the required scope, or an action only the GoCardless Dashboard allows; a refund 403 without such a reason names both likely causes.
