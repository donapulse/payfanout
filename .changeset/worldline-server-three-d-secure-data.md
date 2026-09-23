---
"@payfanout/adapter-worldline-server": major
---

Send the 3-D Secure data Worldline lists as mandatory on every card payment: the browser device data forwarded by `@payfanout/adapter-worldline`, `threeDSecure.skipAuthentication: false`, the return URL in both documented forms, and a `challenge-required` indicator when a session passes `sca: { challenge: "force" }`. A return URL is now required — pass `returnUrl` on each session or set the new `defaultReturnUrl` option, absolute, with a scheme such as `https://` or an app scheme, at most 200 characters; a session with neither, or with a URL that breaks those rules, is refused with `invalid_request` before anything reaches Worldline. Session creation also refuses an `id` longer than 40 characters (Worldline's merchant reference limit) or a `statementDescriptor` longer than 256 characters, and the descriptor is now sent as `softDescriptor` instead of the deprecated `descriptor`.
