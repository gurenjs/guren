---
'@guren/plugin-cloudflare': minor
---

`cloudflare:init` finishes the move from Wrangler to cf (RFC 0035 Migration Path):

- **Durable Objects.** Those `wrangler.jsonc` hosts outside the agent registry are written into `cloudflare.config.ts` as `bindings.durableObject()` and `exports.durableObject()`, with the storage their migration declared. A renamed, deleted or transferred class, or a binding to another Worker, is named for you to declare.
- **Dependencies.** `cf` and `wrangler` are raised in `package.json` when missing or below what the cf backend needs.
- **`--plan`.** It plans a deploy once the files are written, which should show nothing to create.
