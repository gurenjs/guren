---
'@guren/cli': patch
---

`guren codegen` writes an empty `.guren/mcp-app/index.gen.ts` when a route declares `.agent({ ui })` and no MCP App build has written one yet, so `mcpPlugin({ ui: { pages: () => import('@/.guren/mcp-app/index.gen') } })` typechecks and boots on a fresh clone. The plugin then lists each page with no build behind it until `vite build --mode mcp-app` replaces the file; a file already there is never touched.
