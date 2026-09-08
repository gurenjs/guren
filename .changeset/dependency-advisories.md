---
"@guren/server": patch
"@guren/testing": minor
"@guren/plugin-cloudflare": patch
"@guren/plugin-webmcp": patch
"@guren/plugin-agents": patch
"@guren/plugin-mcp": patch
---

**Clear the open dependency advisories** — `bun run audit:deps` went red on `main` when nine advisories were published upstream against installed versions of hono, js-yaml, nodemailer, sharp and vitest. The audit runs ahead of the test step in CI, so every branch was blocked, not just failing.

`hono` moves to the fixed 4.13.7 and `nodemailer` to 9.1.1, both as declared floors on the packages that ship them, so an installed app gets the fixed minimum rather than only this repo's lockfile. `js-yaml` (4.3.2) and `sharp` (0.35.4) reach the monorepo only through `@changesets/parse` and `miniflare`, the latter on an exact pin, so they are pinned in the root `overrides` block beside the entries already there.

`vitest` needed the fixed 4.1.11, a major from the 3.2.x the workspace was on. `@guren/testing` declares it as an *optional* peer, so that range widens to `^3.2.6 || ^4.1.11` rather than dropping vitest 3 consumers — the union form the neighbouring `react` and `@testing-library/react` peers already use.
