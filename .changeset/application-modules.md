---
'@guren/server': minor
'@guren/cli': minor
---

Added application modules — a `modules/<name>/` directory convention for composing self-contained slices of an app instead of piling everything into one flat `app/`, `routes/`, and `db/schema.ts`. `defineModule()` (new in `@guren/server`, re-exported from `@guren/core`) declares a module's routes and providers; `Application` folds them into its provider list and route mounting at boot via the new `mountModuleRoutes()`.

On the CLI side: `guren make:module <name>` scaffolds and auto-wires a module (`index.ts`, `routes.ts`, `db/schema.ts`, plus `src/app.ts`/`db/schema.ts` patching). Most `make:*` generators accept `--module <name>` to scaffold inside a module instead of the project root. `guren check`, `guren audit`, `guren context`, `model:list`, and `doctor` are all module-aware automatically, and once any `modules/` directory exists, `guren check` derives zero-config boundary rules that flag cross-module imports reaching past a module's public surface (`index.ts` or `db/schema.ts`) — no `guren.arch.ts` authoring required. `guren codegen`, `guren audit`, `openapi:generate`, and `guren route:list` all see routes registered inside a module's own `routes.ts`, not just the top-level `routes/web.ts`.
