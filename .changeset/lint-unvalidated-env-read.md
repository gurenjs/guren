---
'@guren/cli': minor
'create-guren-app': minor
---

The `.oxlintrc.json` that `guren add lint` writes and the starters ship enables `guren/no-unvalidated-env-read` as an error in `app/`, `config/`, `routes/`, `src/` and `modules/*/` (RFC 0027 §7): a `process.env.X` read there, other than `NODE_ENV` and `GUREN_*`, should come from the `env` a config definition receives. `bin/` and `drizzle.config.ts` stay out of scope. The provider-form scaffold templates and `AppUrl.ts` disable it with their reason, so those files do not turn an app's lint red. An app created before `config/env.ts` does get reports for its own `process.env` reads in `config/database.ts` and `src/app.ts` until they move to the schema or carry a disable.
