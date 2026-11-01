---
'create-guren-app': patch
'@guren/cli': patch
---

Seeding on boot is now allowed by name. The scaffolded `config/database.ts` passes `seedOnBoot: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'` instead of `process.env.NODE_ENV !== 'production'`, so a server started without `NODE_ENV` (a forgotten variable, a platform that sets none) no longer runs every seeder, demo accounts included. The `dev:server` script sets `NODE_ENV=development`, so `bun run dev` keeps seeding, and `bun test` sets `test` itself. `guren dev` sets `NODE_ENV=development` when it is unset.

A new `seed-on-boot` doctor check warns on the old expression, and `guren upgrade` rewrites it, adding `NODE_ENV=development` to a `bun --hot` serve script that names no `NODE_ENV`. The `guren add browser-tests` warning and the `guren doctor --next` database migration hint spell the new expression.
