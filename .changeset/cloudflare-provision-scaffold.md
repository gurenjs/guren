---
"@guren/plugin-cloudflare": patch
---

`cloudflare:build` no longer scaffolds placeholder resource ids. A fresh `wrangler.jsonc` binds D1 by `database_name` with no `database_id`, and `--mcp-oauth` binds `OAUTH_KV` with no `id`, so the first `wrangler deploy` (Wrangler 4.129 or later) creates both instead of failing on `TODO: wrangler d1 create`. The scaffold message now gives the first-deploy order (deploy, then `wrangler d1 migrations apply <name> --remote`). On an existing config the build names each `TODO:` id an older scaffold left under `d1_databases` or `kv_namespaces`, so it can be deleted.
