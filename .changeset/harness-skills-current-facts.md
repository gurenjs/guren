---
'@guren/cli': patch
---

The agent harness skills `db-manage`, `dev-workflow`, `feature` and `scaffold` match what the CLI does today. `db-manage` resets a database with `guren db:reset --seed` (stopping and starting the container kept the data in its volume), no longer suggests the unsupported rollback, and leaves `--force` in production to the user. `feature` shows the route block `make:feature` prints (`/create`, the `auth` middleware, the destroy route) and no longer scaffolds a vitest test in a `bun test` app. `dev-workflow` names `guren gate` as the check before a commit. `scaffold` generates the companions a request needs without stopping to ask about each one. `guren agent:sync` brings the files to an existing app.
