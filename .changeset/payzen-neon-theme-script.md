---
"@payfanout/adapter-payzen": minor
---

Load the neon theme's script, `neon.js`, which PayZen calls the theme's active part (its button template, field icons and form settings for the embedded form, the smartForm and their pop-ins), once krypton-client has loaded and before `loadSdk()` resolves; the payment form rendered without it until now. It loads by default only beside the default library and stylesheet, so a host that set other `scriptUrl` or `cssUrl` files keeps its rendering unless it also sets the new `themeScriptUrl` option (to the theme's script next to its library, or `""` for none). The script carries `cspNonce`, comes from `https://static.payzen.eu`, and one that fails to load only leaves the theme's active part out.
