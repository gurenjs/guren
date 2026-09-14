---
"@guren/server": patch
---

`Application.listen()` prints one `[guren] Listening on http://<host>:<port>` line in production, where the development banner stays off. A production container's log previously said nothing about where the app was answering.
