---
'@guren/cli': minor
---

`guren add session` (and so `guren add auth`) writes `config/session.ts` as a `defineSessionConfig` definition listed in `createApp({ config })` when the app declares its environment in `config/env.ts` and nothing already binds sessions (RFC 0027 §2); an app without `config/env.ts` keeps `SessionProvider`. `guren check`'s session table rule and the deploy-runtime session verdict read the definition, so a migrated app is not reported as keeping sessions in memory.
