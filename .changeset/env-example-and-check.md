---
'@guren/cli': minor
---

Tooling for the declared environment (RFC 0027 §1, §7).

- `guren env:example` appends each key `config/env.ts` declares to `.env.example`: the default as the value, a secret left blank, the `describe()` text and enum choices as the comment. `$` is written as `\$`, since Bun expands it inside either quote style. Lines already in the file are kept, an `export KEY=` line included, and keys the schema does not declare are reported.
- `guren check --env` fails when `.env.example` and `config/env.ts` disagree on the set of keys, or when `config/env.ts` cannot be imported. It also runs in the full `guren check`, and contributes nothing to an app without `config/env.ts`.
- `guren/no-unvalidated-env-read`, shipped through `@guren/cli/oxlint`, reports a `process.env.X` read other than `NODE_ENV` and `GUREN_*`. Enable it with `overrides` on application code, since `bin/serve.ts` and `drizzle.config.ts` run outside an application.
- A plugin manifest's `env` entries accept `type`, `choices`, `required`, `default` and `secret`. When the app has a `config/env.ts`, `guren plugin` declares each key in its `defineEnv({ ... })` object. An invalid declaration is refused before anything is installed.
