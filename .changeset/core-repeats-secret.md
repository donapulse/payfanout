---
"@payfanout/core": minor
---

Add `repeatsSecret(text, secrets, span?)`, which reports whether a text holds one of the given secrets, or `span` consecutive characters of one (8 by default), in any letter case. Server adapters call it before quoting a server-written value, such as an error code, in a message, so a credential echoed back by whatever answered a request stays out of that message. An empty secret always counts as repeated, so a blank credential withholds the text.
