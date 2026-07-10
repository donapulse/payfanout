---
"@payfanout/server": minor
"@payfanout/react": minor
---

Add a built-in server-completion transport for tokenize-first PSPs (Paysafe, PayPal).
`@payfanout/server` gains `createCompletionHandler`, a web-standard `Request`→`Response`
route that finalizes a payment from `{ sessionRef, clientToken, billingDetails? }` and maps
the error taxonomy to HTTP status. `@payfanout/react`'s `<PayFanoutProvider>` gains a
`completionEndpoint` prop so `usePay`/`<PayButton>` derive `onServerCompletion`
automatically, posting the session's `clientSecret` as the reference — no per-surface wiring
or host-minted id. The explicit `onServerCompletion` callback remains as the escape hatch.
