---
'@guren/server': minor
---

`vite build --mode mcp-app` builds the MCP App views (RFC 0038 §4). It reads the pages `.agent({ ui })` routes name from `.guren/agents.gen.ts`, so `guren codegen` runs first, and builds each page as its own build of the app's Vite config, with one entry, no code splitting, and the stylesheet and assets inlined, since a host's default CSP lets a view load nothing from the application. Each page lands in `.guren/mcp-app/pages/<id>.html`, and `.guren/mcp-app/index.gen.ts` exports `mcpAppPages` with each document and its content hash, the module `mcpPlugin({ ui: { pages: () => import('@/.guren/mcp-app/index.gen') } })` takes. The first build writes `resources/js/mcp-app.tsx`, the app-owned `setup` every view mounts with (importing `resources/css/app.css` when it exists); the plugin option `mcpApp.entry` names another file. The build fails with the install command when `@modelcontextprotocol/ext-apps` is missing.
