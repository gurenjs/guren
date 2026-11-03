---
'@guren/server': minor
---

The dev server banner says whether Guren started the asset server. When `listen()` starts or adopts the Vite dev server, the line reads `Asset server  : http://localhost:5173 (Vite, started by Guren)`. When it starts none, because `VITE_DEV_SERVER_URL` or the `assetsUrl` option names an asset server, or `vite: false` or `GUREN_DEV_VITE=0` turns Vite off, it reads `(not started by Guren, run it yourself)`; it used to say `(Vite)` in both cases, so a developer who set `VITE_DEV_SERVER_URL` had no sign that Vite still had to be started. `DevBannerOptions` from `@guren/server/runtime` gains an optional `assetServer: 'managed' | 'external'`; a `logDevServerBanner()` call that leaves it out prints `(Vite)` as before.
