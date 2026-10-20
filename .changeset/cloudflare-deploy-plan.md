---
"@guren/plugin-cloudflare": minor
---

Add `guren cloudflare:deploy --plan` (RFC 0035 §1, stages 1 to 3) for apps on the `cf` backend. It checks the deploy tools first (Node 22.18+ on PATH, Wrangler 4.136+, a logged-in `cf`), builds, runs `cf build`, and resolves each D1 and KV binding of the evaluated config against the account's listings: `existing`, `adopt` (found by name, not yet resolved) or `create`. It exits 1 on `binding-conflict`, `resource-missing` (including a creation a `--ci` run without `--provision` may not perform) or `source-unreadable`; a listing `cf` could not read is never taken as empty. `--json` prints `{ plan }`. Nothing is written to the account; running without `--plan` is refused until the deploy stages land.
