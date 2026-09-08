---
"@guren/plugin-cloudflare": minor
---

**Cron triggers on Workers** — the worker `cloudflare:build` generates now exports a `scheduled` handler beside `fetch`, so a `triggers.crons` entry in `wrangler.jsonc` runs the tasks the app registered with `createScheduler()`. Workers has no long-lived process to hold a ticking scheduler, so a scheduled job — sweeping the `sessions` table with the work behind `sessions:prune`, say — previously had nowhere to run at all; only Bun servers and the Lambda adapter's `handler.schedule` could.

The handler boots the app, resolves `scheduler` from the container, and runs the tasks due for `event.scheduledTime` — the minute the trigger was *meant* for, since workerd may deliver it late. An app that binds no `scheduler` throws rather than reporting a successful sweep of nothing.

`triggers.crons` is **not** scaffolded: a trigger fires and bills whether or not the app has tasks, the same rule the OAuth KV namespace follows. The build prints the entry to add when it scaffolds a config, along with the granularity constraint — each firing runs only the tasks due at that minute, so a trigger coarser than your finest task means that task never runs.

The build does not verify that a committed config declares a cron either: whether an app registers scheduled tasks is only visible to a build that can load its schedule kernel, and a task declared any other way would read as absent. The Cloudflare guide names the entry under *Upgrading an Existing App* for apps whose config the build never scaffolds.

Every shape the generated worker can take — plain, agents, `--mcp-oauth`, and both — now emits the same default export, so none can carry a `fetch` without a `scheduled` beside it.
