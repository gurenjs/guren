---
"@guren/cli": patch
---

The agent harness gains three skills. `deploy` covers `guren deploy`'s Docker, Fly.io and Railway recipes, the Vercel, Lambda and Cloudflare plugins, the production checklist (`NODE_ENV`, `APP_KEY`, `APP_URL`, migrations, shared session and cache stores, explicit providers, the hasher) and `guren doctor`'s deploy verdicts. `auth` takes an app from `guren add auth` or `make:auth --oauth` through guarded routes to a registered policy, `authorize()` with `[Model, record]`, `denyAsNotFound()` and tests for the owner and the denied user. `attachments` covers `guren add attachments`, `Attachable(...)` collections, `make:feature --attach`, delivery and the production disk, and the `attachments-*` check keys. Run `bunx guren agent:sync` to pick them up.
