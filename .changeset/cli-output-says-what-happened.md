---
'@guren/cli': patch
---

Several commands now report what they did rather than a fixed script.

- `guren add resource` says whether it added the table to `db/schema.ts` and the route group to `routes/web.ts`. On an app that already had both it used to print "Schema and routes were updated automatically" and send you to `db:make`, which found nothing to generate. The next steps now list `db:make` and `db:migrate` only when the schema changed.
- `guren make:feature`, run again without `--prototype` to promote a prototype feature, no longer reports the validator it kept as created. When `db/schema.ts` already declares the table, the next steps stop telling you to add it. The `--prototype` hint no longer claims promotion writes a migration: the table and its migration are yours to add before promoting.
- `guren context` prints the installed Guren version (the `@guren/server` release the app runs) instead of labelling the `@guren/core` range from `package.json` as Guren's; core sits on its own version line. When `@guren/server` is not hoisted, or nothing is installed yet, the line falls back to core's installed version or declared range and names it `@guren/core`.
- `guren gate --deps` labels the audit stage `audit + dependency scan`, so the output shows the scan ran.
- A scaffolder refusing to overwrite an existing file (`guren deploy` on an app that already has a `Dockerfile`, for one) prints the "already exists. Use --force to overwrite." message without a stack trace.
- The `db-manage` harness skill no longer tells agents to edit a migration journal: drizzle-kit's migration folders have none. Run `bunx guren agent:sync` to refresh it.
