---
'@guren/cli': patch
'@guren/core': patch
'create-guren-app': patch
'@guren/inertia-client': patch
'@guren/openapi': patch
'@guren/orm': patch
'@guren/plugin-agents': patch
'@guren/plugin-ai': patch
'@guren/plugin-cloudflare': patch
'@guren/plugin-lambda': patch
'@guren/plugin-markdown': patch
'@guren/plugin-mcp': patch
'@guren/plugin-vercel': patch
'@guren/plugin-webmcp': patch
'@guren/server': patch
'@guren/testing': patch
---

Add an npm `description` and `keywords` to every package. Thirteen of the sixteen packages published with neither, so their npm pages and search results showed no summary. The wording states the runtime story once: develop on Bun, deploy to Bun, AWS Lambda (Node.js), Vercel or Cloudflare Workers.
