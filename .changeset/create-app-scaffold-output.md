---
'create-guren-app': patch
---

Three fixes to what a new app starts with. The README now matches the rendering mode and database the app was created with: the SSR template no longer replaces it with one describing PostgreSQL, and a PostgreSQL or MySQL app is told to run `bun run db:up` before `bun run db:make` and `bun run db:migrate`, while an SQLite app is not told to start a container. The `api` template declares `zod`, which the validators `guren make:validator` writes import, instead of resolving it through `@guren/cli`. After installing dependencies and running `guren add auth` or `guren add prototype`, the scaffolder runs `bun run codegen`, so `.guren/` lists the new pages and routes before the initial commit; previously the commit held stale generated files and a boot before codegen failed on `/login`. With `--no-install` nothing is generated, and the shipped `.guren/` files already match the bare template.
