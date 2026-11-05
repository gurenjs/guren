---
'@guren/cli': patch
---

`guren deps:exposure` reads an app from the default `create-guren-app` scaffold as complete. The files the server entry (`src/main.ts`, `bin/serve.ts`) loads at boot, such as `src/app.ts`, the routes files, `config/` and middleware files, are attributed to every route instead of making their packages `unknown`. Middleware built inline in a routes file no longer leaves the graph partial once a server entry exists. Seeders, console commands and `resources/js/dev-entry.ts` are placed `build`, `resources/js/mcp-app.tsx` counts as a page entry, and Vite's output under `public/assets/` is no longer scanned. The same attribution reaches the routes `guren audit` lists under each advisory.
