---
'@guren/cli': minor
---

`guren add session` and `guren add cache` declare the keys they write into `config/env.ts`, so `guren check --env` stays green on an app they just scaffolded. Provider wiring now writes a `providers: [...]` option into a `createApp()` that has none, rather than reporting the array as missing: an entry listing no providers is the scaffolded shape since RFC 0027 §4 deleted `DatabaseProvider`.
