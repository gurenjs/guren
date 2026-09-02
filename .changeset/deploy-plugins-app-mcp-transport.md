---
'@guren/plugin-cloudflare': patch
'@guren/plugin-lambda': patch
'@guren/plugin-vercel': patch
---

Stop compiling the App MCP endpoint shut when an app depends on `@guren/plugin-mcp`.

All three deploy plugins stubbed `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`, which `@guren/plugin-mcp` dynamically imports to serve the endpoint; Lambda and Vercel additionally routed *every* unlisted `@modelcontextprotocol/sdk/*` subpath to a throwing stub, which also killed the plugin's static imports of `server/index.js` and `types.js`. A deployed endpoint could therefore never load, with no build error to say so.

Each platform now derives its stub set from `stubbableDevOnlyModules()`, and Lambda and Vercel drop the SDK-prefix catch-all, from one read of the app's manifest. The dev-only MCP server (`server/mcp.js`), `@guren/cli`, `bun:sqlite` and `vite` stay stubbed on every platform, for every app.

On Cloudflare the aliases are baked into the app's committed `wrangler.jsonc`, which the scaffold writes once and never overwrites — so an app that adds the plugin after its first deploy would keep the stale alias indefinitely. `cloudflare:build` now fails with the exact alias line to delete when that app depends on `@guren/plugin-mcp`, before it runs the app build.
