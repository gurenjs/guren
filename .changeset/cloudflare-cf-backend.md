---
"@guren/plugin-cloudflare": minor
---

Add a `cf` CLI backend (RFC 0035 phase 1, part 1). When the app has a `cloudflare.config.ts` and declares `cf`, `cloudflare:build` assembles into `.guren/cloudflare/` (self-ignoring, so `cf`'s own `.cloudflare/` is left alone), writes a `guren-worker.json` manifest instead of scaffolding `wrangler.jsonc`, carries the manifest's `resolved` section across builds, and skips the checks that read `wrangler.jsonc`. A `cloudflare.config.ts` without `cf` declared is refused. The new `@guren/plugin-cloudflare/config` subpath, which `cf` loads under Node, exports `gurenWorker()` for `cloudflare.config.ts` (entry, the id-less `DB` binding, `OAUTH_KV` under `--mcp-oauth`, agents as SQLite-backed Durable Object exports) and `gurenWranglerBundle()` for `wrangler.config.ts` (stubs, `define`, assets directory, `keepNames` on). `cloudflare:size` refuses the `cf` backend, which it cannot measure. Apps without `cloudflare.config.ts` are unchanged.
