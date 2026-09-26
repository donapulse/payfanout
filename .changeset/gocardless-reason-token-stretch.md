---
"@payfanout/adapter-gocardless-server": patch
---

The `verifyCredentials` message withholds any error reason holding eight or more consecutive characters of the access token, in any letter case, including a stretch that sits inside a longer reason.
