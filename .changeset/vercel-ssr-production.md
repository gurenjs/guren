---
'@guren/server': patch
'@guren/plugin-vercel': patch
---

Fix Inertia SSR on serverless deployments and stop shipping dev import maps in production.

- The Guren Vite plugin now defaults `ssr.noExternal` to `true` for SSR builds so `.guren/ssr` bundles are self-contained and importable on runtimes without `node_modules` (Vercel, Lambda).
- `@guren/plugin-vercel` pins `process.env.NODE_ENV` to `"production"` when bundling the function entrypoint; `bun build` otherwise inlines it as `"development"`, disabling every production code path at runtime.
- The Inertia HTML document no longer emits the esm.sh dev React import map when `NODE_ENV` is `production`.
