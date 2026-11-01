---
"@guren/cli": patch
---

The Vite codegen plugin (`routeTypesPlugin()` from `@guren/cli/vite`) now regenerates when a validator under `app/Http/Validators/` changes, when a routes file beside the routes entry changes (`routes/auth.ts`), and when a module's entry or routes change, at the project root and in `modules/*/` alike. Before, editing a route's body schema left the `ApiRoutes` body types in `.guren/api-client.gen.ts` stale until the routes entry itself was saved or `guren codegen` was run.
