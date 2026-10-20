---
"@guren/plugin-cloudflare": minor
---

`guren cloudflare:deploy` now deploys (RFC 0035 §1 stages 4 to 8). Without `--plan`, it shows the plan and asks once; `--yes` skips the question, and a run with no terminal needs `--yes` or `--ci`. Then:

- it creates each missing D1 database or KV namespace under its planned name (`cf d1 create`, `cf kv namespaces create`) and records every resolved id in the manifest's `resolved` section;
- it runs `cf build` again when an id changed, and stops if the evaluated config binds another resource;
- it records a Time Travel bookmark, lists the pending migrations again, and applies them with `cf d1 migrations apply` only if they are still the set the plan judged (`--skip-migrations` leaves them out);
- it deploys with `cf deploy --prebuilt --no-provision`, forwarding `--secrets-file` as an absolute path;
- it reports the URL, what it created and migrated, and the rollback route.

Nothing is deleted: a failure after a write lists the delete and Time Travel restore commands for what the run did. `--json` prints `{ plan, created, migrated, deployment, url }`, with `stopped` or `failure` when the run did not deploy.
