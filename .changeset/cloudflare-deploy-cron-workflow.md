---
"@guren/plugin-cloudflare": minor
"@guren/core": minor
"@guren/cli": minor
---

Cron triggers and a deploy workflow for the `cf` backend (RFC 0035 §2, §4).

- `cloudflare:build` on the `cf` backend records a `* * * * *` cron in the manifest when the schedule kernel registers tasks, and `gurenWorker()` emits it as `triggers`. A kernel the build cannot load adds no trigger and is recorded, and `cloudflare:deploy` blocks (`schedule-unreadable`) unless the config sets its own `triggers`, rather than deploy away a trigger the Worker may have. The manifest version moves to 2, so `cf build` against an older manifest asks for a rebuild. `@guren/cli` exports `loadScheduleKernel()`, read through `readScheduledTasks()` in `@guren/core/internal/deploy-plan`, so the build and `schedule:list` read the kernel alike.
- `guren deploy --target cloudflare` writes `.github/workflows/deploy-cloudflare.yml`: `bunx guren cloudflare:deploy --yes` on every push to main (with `--mcp-oauth` when the app depends on `@cloudflare/workers-oauth-provider`), under a `cloudflare-deploy-<worker>` concurrency group with `cancel-in-progress: false`.
- `cloudflare:deploy` running in GitHub Actions warns (`serialization`) when the running workflow has no top-level concurrency group, or one that cancels a running deploy.
