---
"@guren/server": minor
"@guren/orm": patch
"@guren/cli": minor
"@guren/core": patch
"@guren/testing": patch
"@guren/openapi": patch
"@guren/inertia-client": patch
"create-guren-app": patch
---

Fixes and features from building a real app (Kadai) on the published packages:

- **@guren/server: entry bundles now share chunks** (tsup `splitting: true`). Each entry point previously bundled its own copy of module-level state, so `registerJob()` via the root entry and `Worker` via `./queue` used different job registries — jobs failed with "Job class not found". The same duplication affected the mail manager and queue driver globals.
- **@guren/server: new `SyncDriver` (queue) and `LogTransport` (mail)** — the template `.env` defaults (`QUEUE_CONNECTION=sync`, `MAIL_MAILER=log`) previously named drivers that did not exist. Sync dispatch executes jobs inline with no worker process; the log transport writes full messages to server output. The `add queue` / `add mail` blueprints now honor these env vars and default to sync/log.
- **@guren/orm: multi-relation type fix** — `findWith(id, ['a', 'b'])` and `with(['a', 'b'])` typed their results as a union of single-relation picks instead of an intersection, making relation properties inaccessible.
- **@guren/orm: `QueryBuilder.paginate()` accepts an options object** (`{ page, perPage }`) in addition to positional arguments, matching `Model.paginate()`.
