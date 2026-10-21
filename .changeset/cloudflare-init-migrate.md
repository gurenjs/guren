---
'@guren/plugin-cloudflare': minor
---

`cloudflare:init` finishes the move from Wrangler to cf (RFC 0035 Migration Path):

- **Durable Objects.** It reads the agent registry the build reads. It names every live Durable Object class no agent registers, every binding to another Worker, and every rename, delete or transfer in `migrations`: on cf nothing declares them, so the first deploy could drop their storage. If `config/agents.ts` cannot be read, init says so and keeps going.
- **Dependencies.** `cf` and `wrangler` in `package.json` are raised when they are missing or start below what the cf backend is verified against. A range init cannot read, such as `latest` or `catalog:`, is left alone, and CRLF line endings are kept.
- **`--plan`.** It plans a deploy once the files are written, which should show nothing to create. It waits when init has just raised dependencies.
