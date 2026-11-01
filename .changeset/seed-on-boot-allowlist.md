---
'create-guren-app': patch
'@guren/cli': minor
---

Seeding on boot is now allowed by name. The scaffolded `config/database.ts` passes `seedOnBoot: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'` instead of `process.env.NODE_ENV !== 'production'`, so a server started without `NODE_ENV` (a forgotten variable, a platform that sets none) no longer runs every seeder, demo accounts included. The `dev:server` script sets `NODE_ENV=development`, so `bun run dev` keeps seeding, and `bun test` sets `test` itself. `guren dev` sets `NODE_ENV=development` when it is unset.

A new `seed-on-boot` doctor check warns on the old expression. `guren upgrade` rewrites it only when `bun run dev` keeps seeding afterwards: a `dev` or `dev:server` script already sets `NODE_ENV=development`, or the one starting `serve.ts` is a single command it prefixes with `NODE_ENV=development`. A value that goes on past the comparison, or a dev script it cannot prefix, is left to the manual fix the check prints. The `guren add browser-tests` warning and the `guren doctor --next` database migration hint spell the new expression.
