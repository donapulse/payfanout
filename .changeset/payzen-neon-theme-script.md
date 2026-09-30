---
"@payfanout/adapter-payzen": minor
---

Load the neon theme's script, `neon.js`, which PayZen calls the theme's active part (its button template, field icons and form settings for the embedded form, the smartForm and their pop-ins), once krypton-client has loaded and before `loadSdk()` resolves, next to the theme stylesheet the adapter already loaded; the payment form rendered without it until now. It loads by default only beside the default library and stylesheet: if you set `scriptUrl` or `cssUrl`, nothing changes unless you also set the new `themeScriptUrl` option, to the theme's script next to your library. An empty `themeScriptUrl` loads none. The script carries `cspNonce` like the other tags and comes from `https://static.payzen.eu`, and one that fails to load only leaves the theme's active part out.
