---
"@guren/server": minor
---

Serve Vite's content-hashed build assets (`/public/assets/*` in production) with `Cache-Control: public, max-age=31536000, immutable`. Their filenames change on every content change, so browsers can cache them forever instead of re-downloading on each visit. Files elsewhere under `public/` keep stable names and are served without a caching header, unchanged; the dev-mode route stays uncached so HMR keeps working. The prefix follows a custom `publicRoute` (e.g. `/static/*` → `/static/assets/*`).
