---
'@guren/server': patch
---

Write the dev-endpoint gates in the form the deploy bundlers substitute

`isMcpEndpointEnabled()` and `isDocsViewerEnabled()` read
`process.env?.NODE_ENV` and `process.env?.GUREN_*`. The deploy plugins settle
these branches at build time with `--define 'process.env.NODE_ENV="production"'`,
which targets `process.env.NODE_ENV` — the optional-chained form is a different
expression and was never substituted. `@guren/plugin-cloudflare`'s own comment
records why that matters: wrangler `vars` are not guaranteed to reach
`process.env` before the app's module graph evaluates, so a module-scope
`NODE_ENV` branch has to be settled by the bundler.

Both gates now use the plain form behind the existing `typeof process` guard,
with a comment recording why `?.` must not come back. Deployed apps were already
closed for other reasons — each plugin also sets `NODE_ENV=production` at
runtime, and nothing sets `GUREN_MCP`/`GUREN_DOCS` — but the mechanism the
plugins rely on now actually applies.
