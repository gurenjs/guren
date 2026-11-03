---
"@guren/cli": patch
---

`guren browser:serve --port <n>` starts the app with `GUREN_VITE_PORT=<n+1>` unless the variable is already set, so its Vite dev server no longer lands on the 5173 a running `guren dev` holds. It needs an `@guren/server` that reads `GUREN_VITE_PORT`; an older one ignores it and starts Vite where it did before.
