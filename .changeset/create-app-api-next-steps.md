---
'create-guren-app': patch
---

`--blueprint api` no longer lists `bunx guren add auth` and `bunx guren add resource` under "Add features:", since both refuse an API-only app. It suggests `bunx guren make:controller Post` instead, which writes a JSON controller there. The same line says to register the controller's actions in `routes/api.ts`. `--auth` with the api blueprint is now ignored with an info line that names `createBearerTokenMiddleware` from `@guren/core` and links the API tokens guide, instead of running `guren add auth` and warning when it fails.
