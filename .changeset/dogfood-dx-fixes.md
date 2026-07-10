---
"@guren/server": patch
"@guren/orm": patch
"@guren/cli": minor
"@guren/inertia-client": patch
"create-guren-app": patch
"@guren/core": patch
"@guren/testing": patch
"@guren/openapi": patch
---

Fix critical scaffold-to-runtime breakages found by dogfooding the published packages:

- **@guren/server**: stop bundling `@guren/orm` (now a real dependency). The bundled copy created a second `Model`/`DrizzleAdapter` instance, so `configureOrm()` never reached `AuthenticatableModel` and every auth query failed with "database has not been configured" in published apps.
- **@guren/cli `add auth`**: schema updates and the users migration now respect the app's database dialect (sqlite/postgres/mysql) instead of always emitting Postgres SQL; the migration is generated via drizzle-kit instead of a loose `.sql` file that `db:migrate` never executed; `createApp()` is patched with `auth: {}` so sessions and CSRF actually mount.
- **@guren/cli `add resource`**: honors `--fields` (previously silently ignored) and adds `--public`; delegates file generation to the `make:feature` templates; registers the route group with typed body contracts — the previous insertion regex never matched the starter template, so routes were silently never registered.
- **@guren/cli `codegen`**: generates route/data/channel/API-client artifacts by default (previously skipped silently unless `--routes` was passed, leaving `routes.gen.ts` empty).
- **@guren/orm**: warn when the migrations folder contains loose `.sql` files that the drizzle migrator will not execute; export `jsonb` from `@guren/orm/drizzle`.
- **@guren/inertia-client**: add missing `./typed-forms` and `./components` export map entries (imports failed to resolve in published apps).
- **create-guren-app**: `--auth` now runs after dependency installation using the app-local CLI and reports failures honestly (previously it always failed silently when run via bunx, yet printed a success message).
- Docs: quick start now pins `create-guren-app@rc` (npm `latest` still points at the old 0.2.0 alpha) and reflects the SQLite default.
