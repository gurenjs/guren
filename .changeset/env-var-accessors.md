---
'@guren/server': minor
---

An `EnvVar` now reports how it was declared: `type` (the `Env` builder), `presence` (`required`, `optional`, `defaulted` or `production`), `defaultValue` and, for `Env.enum()`, `choices`. `guren env:example` and `guren plugin` read these to write `.env.example` and a `defineEnv({...})` entry from a schema (RFC 0027 §1, §7).
