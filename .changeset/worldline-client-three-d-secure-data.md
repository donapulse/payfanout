---
"@payfanout/adapter-worldline": minor
---

`confirm()` now sends the browser data Worldline needs for 3-D Secure along with the `hostedTokenizationId`, and tokenizes the card without storing it at Worldline for later use. The new `clientToken` format is decoded by the matching `@payfanout/adapter-worldline-server` major release, so upgrade the server adapter first.
