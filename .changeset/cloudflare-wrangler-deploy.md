---
'@guren/plugin-cloudflare': minor
---

`cloudflare:deploy` works on an app that deploys through `wrangler.jsonc`. It runs the same plan and checks through the app's Wrangler (4.129 or later): it creates a missing D1 database or `OAUTH_KV` namespace, applies the pending migrations behind a Time Travel bookmark and the destructive-migration guard, then runs `wrangler deploy` with provisioning off. `wrangler.jsonc` is never written. The resolved ids go into `.cloudflare/wrangler.deploy.json` and `.cloudflare/guren-worker.json`, which the build's new `.cloudflare/.gitignore` lists.

On the cf backend, a database that `cloudflare.config.ts` names by id now gets its pending migrations applied. Before this release they were planned and then skipped without a message.
