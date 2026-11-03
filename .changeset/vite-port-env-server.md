---
"@guren/server": minor
---

`listen()` starts its managed Vite dev server on `GUREN_VITE_PORT` when the variable is set, so two apps on one machine no longer both start on 5173. Unset or blank, the port stays with the project's Vite config (5173 by default). A busy port still makes Vite move to the next free one unless `vite.config.ts` sets `server.strictPort`, and the banner's Asset server line, `VITE_DEV_SERVER_URL` and the dev entry name the port Vite bound. A value that is not a port from 0 to 65535 fails `listen()` with an error naming the variable instead of falling back to 5173. An explicit `listen({ vite: { port } })` still wins. `startViteDevServer()` now reports the bound port, not the requested one, when Vite gives it no local URL.
