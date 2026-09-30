---
"@payfanout/adapter-payzen": minor
---

Load the neon theme's script, `neon.js`, which PayZen calls the theme's active part (its button template, field icons and form settings), once krypton-client has loaded and before `loadSdk()` resolves, next to the theme stylesheet the adapter already loaded; the embedded form rendered without it until now. The new `themeScriptUrl` option overrides the script, or loads none when empty: set it with `cssUrl` to use another theme, such as classic. The script carries `cspNonce` like the other tags and comes from `https://static.payzen.eu`, and one that fails to load only leaves the theme's active part out.
