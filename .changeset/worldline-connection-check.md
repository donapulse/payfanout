---
"@payfanout/adapter-worldline-server": patch
---

`verifyCredentials` now reports `ok: true` only when Worldline's test-connection service answers OK. Any other answer that is neither an authentication rejection nor a transient error, such as the empty answer a wrong `baseUrl` override gets or a web page at a mis-pasted `baseUrl`, reports a failure with `category: "internal"` instead of `ok: true`, and its message names the HTTP status and, when it reads as one, Worldline's error id. The authentication-failure message now also names the `merchantId` and the environment, which Worldline refuses with the same 403 as a mismatched key, and the `baseUrl` when one is configured.
