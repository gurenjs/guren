---
"@guren/cli": patch
---

The agent harness covers the features of 2.36. Two skills join it: `dependencies` (adding, upgrading or removing a package and fixing an advisory with `guren deps:why`, `guren deps:exposure`, `guren audit`'s verified fixes, the `minimumReleaseAge` gate and `--deps-baseline`) and `live-updates` (a page that refreshes itself with `live()` props, from the socket route and `liveTransport()` to the `live-props:*` warnings). `agent-interface` explains `.agent({ ui })`, the `vite build --mode mcp-app` build, `mcpPlugin({ ui })` and the Dev Center preview at `/_guren/mcp-apps`; `ai-agent` says a `--chat` page needs `bun add @ai-sdk/react@^4`. The controllers rule names the `exposure-sensitive-column` finding and the default `guren.arch.ts` warning for `drizzle-orm` in a controller, and the UI rule the imports a page may not make. Run `bunx guren agent:sync` to pick them up.
