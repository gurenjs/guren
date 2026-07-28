---
'create-guren-app': patch
---

Stop seeding the database on boot in production.

The scaffolded `config/app.ts` seeded whenever migrations existed, including on
every serverless cold start. Seeding is one-shot provisioning, not part of
booting, and the seeder loader resolves raw `db/seeders/*.ts` at runtime —
which a self-contained bundle has no module resolver for, so a standard app
crashed on cold start with `ERR_MODULE_NOT_FOUND`. Boot-time seeding is now a
development convenience that is skipped when `NODE_ENV=production`; run
seeders explicitly instead.

Seeders cannot run inside a deployed serverless bundle at all — they are
ordinary `.ts` modules importing the app's schema, and the function ships
without `node_modules` or a TypeScript loader. The serverless guide now says
so, and points at seeding from the project source or shipping the data as a
migration.
