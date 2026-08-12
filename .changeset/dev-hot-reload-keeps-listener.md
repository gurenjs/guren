---
'@guren/server': patch
---

Keep the dev server listening across `bun --hot` reloads by reusing the managed Vite dev server

Editing a backend file in a scaffolded app — or running `guren add resource` /
`guren add auth`, which edit several — killed the dev server silently. `bun
--hot` re-runs the entrypoint, and the new `listen()` stopped the previous Bun
server first, then awaited the previous Vite dev server's `close()`. Vite
waits for every open connection, and a browser tab holding its HMR socket can
keep that wait alive indefinitely — so the process stayed up with no HTTP
listener at all, no error printed, and every checkpoint URL dead until a
manual restart.

`listen()` now adopts the still-listening Vite dev server a previous run left
on `globalThis` (which `bun --hot` preserves) instead of tearing it down. The
browser keeps its HMR socket, the reload skips the `close()` wait entirely,
and the Bun listener re-binds immediately. Explicit `vite` options still force
a restart — the running server was built from the previous call's options.

Two failure paths harden alongside: the previous Bun server is force-closed
(a dev reload must not wait on in-flight requests — an open SSE stream used to
be able to hang it the same way), and the paths that do close Vite abandon a
`close()` that has not resolved within `GUREN_VITE_CLOSE_TIMEOUT_MS` (default
5000) with a loud warning instead of hanging the process.
