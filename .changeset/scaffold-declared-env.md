---
'create-guren-app': minor
---

Scaffolded apps declare their environment in `config/env.ts` and pass it to `createApp({ env, config })` (RFC 0027 Part 2d). `config/database.ts` default-exports `defineDatabaseConfig()` and resolves its connection through the validated environment, so `config/app.ts` and `app/Providers/DatabaseProvider.ts` are gone; host authorization moves to `config/http.ts`, where a production app with no `APP_URL` fails its boot instead of disabling the check. `.env.example` lists what the base app reads, and each blueprint adds its own keys when it runs.

`APP_URL` and `APP_KEY` are required in production, so a production boot without either now fails instead of warning. Development is unchanged: both stay optional there, and the scaffolder still writes an `APP_KEY` into `.env`.
