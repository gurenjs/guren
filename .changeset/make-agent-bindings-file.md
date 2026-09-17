---
'@guren/cli': patch
---

`guren make:agent` writes the Worker bindings interface its class imports to `config/bindings.ts` rather than `config/env.ts`, which is now the env schema (RFC 0027 §1). Before, an app with a `defineEnv` schema got a refusal asking it to add `interface Env` to that schema. An app whose earlier `make:agent` put `Env` in `config/env.ts` keeps importing it from there.
