---
"@payfanout/adapter-worldline": major
---

Breaking: `confirm()` now resolves a JSON `clientToken` that carries the browser data Worldline needs for 3-D Secure along with the `hostedTokenizationId`, instead of the bare `hostedTokenizationId`. Only the matching `@payfanout/adapter-worldline-server` major release decodes it, so upgrade the server adapter first: an earlier server adapter would send the whole envelope to Worldline as the `hostedTokenizationId`. The card is also tokenized without being stored at Worldline for later use.
