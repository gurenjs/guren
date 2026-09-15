---
'@guren/core': patch
---

The Cloudflare Workers and AWS Lambda builds stage the built client assets once, under `public/assets/`, instead of also copying them to a top-level `assets/`. Nothing the framework generates addresses `/assets/` any more, so the second copy doubled the static file count and kept answering a URL that should return 404, which is how a wrong asset prefix went unnoticed. Rebuild with `cloudflare:build` or `lambda:build` to pick it up. The Vercel build is unchanged: it serves `public/` from its static root and rewrites `/public/(.*)` onto it.
