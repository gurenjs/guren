---
'@guren/cli': minor
'create-guren-app': minor
---

The `.oxlintrc.json` that `guren add lint` writes and the starters ship enables `guren/no-unvalidated-env-read` as an error in `app/`, `config/`, `routes/`, `src/` and `modules/*/` (RFC 0027 §7): a `process.env.X` read there, other than `NODE_ENV` and `GUREN_*`, should come from the `env` a config definition receives. `bin/` and `drizzle.config.ts` stay out of scope. The provider-form scaffold templates and `AppUrl.ts` disable it with their reason, so an app running `guren add lint` does not start red on them.
