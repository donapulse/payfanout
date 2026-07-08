---
"@payfanout/adapter-paysafe-server": patch
"@payfanout/adapter-paypal-server": patch
"@payfanout/adapter-payzen-server": patch
---

The request timeout now covers the response body read. A PSP response that stalled after its headers arrived could previously hang the host's request handler indefinitely; it now rejects with the same retryable `psp_unavailable` timeout error as a connection hang.
