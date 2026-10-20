---
"@guren/plugin-cloudflare": minor
"@guren/core": minor
"@guren/cli": minor
---

Cron triggers and a deploy workflow for the `cf` backend (RFC 0035 §2, §4).

- `cloudflare:build` on the `cf` backend records a `* * * * *` cron in the manifest when the schedule kernel registers tasks, or under `--mcp-oauth` for the OAuth storage sweep, and `gurenWorker()` emits it as `triggers`. A kernel the build cannot load adds no trigger and is warned about. `@guren/cli` exports `loadScheduleKernel()`, read through `readScheduledTasks()` in `@guren/core/internal/deploy-plan`, so the build and `schedule:list` read the kernel alike.
- `guren deploy --target cloudflare` writes `.github/workflows/deploy-cloudflare.yml`: `bunx guren cloudflare:deploy --yes` on every push to main, under a `cloudflare-deploy-<app>` concurrency group with `cancel-in-progress: false`.
- `cloudflare:deploy` running in GitHub Actions warns (`serialization`) when the running workflow sets no concurrency group.
