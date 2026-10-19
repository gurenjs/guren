---
"@guren/plugin-cloudflare": patch
---

`cloudflare:build` no longer scaffolds placeholder resource ids. A fresh `wrangler.jsonc` binds D1 by `database_name` with no `database_id`, and `--mcp-oauth` binds `OAUTH_KV` with no `id`, so the first `wrangler deploy` (Wrangler 4.129 or later) creates both instead of failing on `TODO: wrangler d1 create`. The scaffold message now gives the first-deploy order (deploy, then `wrangler d1 migrations apply <name> --remote`). Before the app build, the build now names each placeholder id (any value that is not hex or is all zeros, such as the `TODO:` ids older scaffolds wrote) under `d1_databases` or `kv_namespaces`, in every `env.<name>` scope, so it can be deleted.
