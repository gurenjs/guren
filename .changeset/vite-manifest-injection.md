---
"@guren/server": minor
"@guren/core": patch
"@guren/plugin-cloudflare": minor
"@guren/plugin-vercel": minor
"@guren/plugin-lambda": minor
---

Build-time Vite manifest injection for serverless targets: `viteAsset()` now
resolves production entries from `GUREN_VITE_MANIFEST` (the client manifest
JSON) before reading the filesystem, and all three deploy plugins populate it
during their build step — Cloudflare Workers and Lambda in their generated
entry module, Vercel by substituting the read at bundle time. Content pages
rendered with `Controller.view()` work on deploy targets whose runtime never
sees `public/assets/manifest.json`.
