---
'@guren/core': patch
---

Deployed apps (Cloudflare Workers, AWS Lambda, Vercel) no longer download every lazily loaded page chunk twice. The deploy build addressed the client entry and its CSS under `/assets/`, while Vite's modulepreload helper addresses chunks under `/public/assets/`, so each Inertia navigation fetched a chunk once as a preload and again as the real import. The entry now uses `/public/assets/`, the prefix the app already uses when it serves itself. Rebuild with `cloudflare:build`, `lambda:build` or the Vercel build to pick it up.
