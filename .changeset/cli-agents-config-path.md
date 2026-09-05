---
'@guren/cli': patch
---

`guren check` reads the agent registry path (`config/agents.ts`) from
`@guren/core/internal/deploy-build` instead of spelling it itself, so the check
and `guren cloudflare:build` cannot drift to two different files (RFC 0017 Part 2b).
