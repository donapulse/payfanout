---
"@payfanout/adapter-worldline-server": patch
---

The `verifyCredentials` message now screens Worldline's error id with core's shared `repeatsSecret`: an id holding the API key id or the secret API key, or eight consecutive characters of either in any letter case, is left out.
