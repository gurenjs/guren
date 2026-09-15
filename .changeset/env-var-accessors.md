---
'@guren/server': minor
---

An `EnvVar` now reports its `.default()` value as `defaultValue`, and the values an `Env.enum()` admits as `choices`. `guren env:example` reads both to write `.env.example` from a schema (RFC 0027 §7).
