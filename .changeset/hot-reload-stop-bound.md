---
'@guren/server': patch
---

A `bun --hot` reload no longer waits up to `GUREN_BUN_STOP_TIMEOUT_MS` (5 s by default) on the server it replaces. That stop is forced and the hot-reload teardown has already closed every broadcast WebSocket, so nothing is draining; `listen()` now gives the replaced server 250 ms and does not warn when it runs out. On Bun 1.3.11 and 1.3.14, where `server.stop()` never resolves once the server itself has closed a WebSocket, a reload with one broadcasting client connected took about 5.1 s and printed `Bun server did not stop within 5000ms` every time; it now takes about 0.3 s. Bun 1.4.0 and later were never affected. `app.stop()` keeps its bound and warning.
