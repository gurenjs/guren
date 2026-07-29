---
'@guren/plugin-lambda': minor
'@guren/cli': minor
---

Add `@guren/plugin-lambda`: first-class AWS Lambda deployment tooling.

`guren plugin @guren/plugin-lambda` registers `lambdaPlugin()` and scaffolds
`src/lambda.ts` (the module whose exports become Lambda handlers). The plugin
contributes a `lambda:build` command that assembles a `.lambda/` directory:
a self-contained ESM bundle for the Node.js runtime with
`process.env.NODE_ENV` pinned to `"production"`, the SSR bundle plus Drizzle
migrations alongside it, static assets staged for S3, and an
`env.json` describing the function environment. Dev-only modules
(`bun:sqlite`, `vite`, the MCP endpoint's generators) are replaced with
throwing stubs so the bundle neither ships dev tooling nor fails to import on
Lambda.

`import.meta.url` is pinned so the framework's
`new URL('../db/migrations', import.meta.url)` convention keeps resolving
against the function root. Bundling collapses every module onto the output
file's own URL (`file:///var/task/handler.js`), which would otherwise point
that expression one directory too high and silently skip
`configureOrm()`/`seedDatabase()` at boot.
