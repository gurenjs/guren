---
'@guren/cli': minor
---

Tooling for the declared environment (RFC 0027 §1, §7).

- `guren env:example` appends each key `config/env.ts` declares to `.env.example`: the default as the value, a secret left blank, the `describe()` text and enum choices as the comment. Lines already in the file are kept, and keys the schema does not declare are reported.
- `guren check --env` fails when `.env.example` and `config/env.ts` disagree on the set of keys. It also runs in the full `guren check`, and contributes nothing to an app without `config/env.ts`.
- `guren/no-unvalidated-env-read`, shipped through `@guren/cli/oxlint`, reports a `process.env.X` read under `app/`, `config/`, `routes/` or `src/`, except `NODE_ENV` and `GUREN_*`.
- A plugin manifest's `env` entries accept `type`, `choices`, `required`, `default` and `secret`. When the app has a `config/env.ts`, `guren plugin` declares each key in its `defineEnv({ ... })` object. An invalid declaration is refused before anything is installed.
