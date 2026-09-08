---
"@guren/server": minor
"@guren/core": minor
---

**`vite --mode prototype` (RFC 0021 Part 1)** — the Guren Vite plugin gains a prototype branch: `import.meta.env.GUREN_PROTOTYPE` is defined as `true` (and as `false` in every other mode, so the client's prototype wiring is statically dead in production), the build takes a generated HTML shell (`.guren/prototype/index.html`, or `resources/js/prototype/index.html` when the project ships one) as its input and emits a static `dist/prototype/` with `index.html`, `404.html` and `_redirects` for SPA fallback, `public/` is copied in, and the dev server answers every document request with the shell. `guren({ prototype: { base, outDir, shell } })` sets the subpath base for a build hosted under one.
