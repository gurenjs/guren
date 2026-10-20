---
"@guren/plugin-cloudflare": minor
---

Add `guren cloudflare:init`, which moves an app onto the `cf` backend (RFC 0035 §3). It writes `cloudflare.config.ts` (the `gurenWorker()` spread, named after the package without its scope, with today's `compatibilityDate`), `wrangler.config.ts` (`gurenWranglerBundle()`) and `config/cloudflare.ts`, and adds `.cloudflare/` to `.gitignore`. From an existing `wrangler.jsonc` it carries over a D1 `database_name` that differs from the default (as `resourceNames.DB`) and an `OAUTH_KV` binding (as `mcpOAuth: true`), and it warns when the file declares Durable Objects, whose storage across the move to `exports` is unconfirmed. It overwrites nothing without `--force` and installs nothing; it prints the `bun add -d cf wrangler@latest` and `cloudflare:deploy --plan` steps.
