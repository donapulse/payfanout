---
"@payfanout/adapter-worldline-server": minor
---

Declare the new native-subscription capability block explicitly all-false: Worldline Direct has no native subscription engine — recurring payments are credential-on-file charges the merchant initiates, which the vault surface and the host-side subscription engine already cover.
