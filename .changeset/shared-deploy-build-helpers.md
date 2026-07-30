---
'@guren/plugin-cloudflare': patch
'@guren/plugin-lambda': patch
'@guren/plugin-vercel': patch
'@guren/core': minor
---

Share the deploy plugins' build-time helpers through `@guren/core/internal/deploy-build`

The Cloudflare, Lambda, and Vercel plugins each carried their own copy of the
manifest and path helpers, and Cloudflare and Lambda separately listed the
dev-only modules a deployed bundle has to stub. That list describes the
framework's own module graph, so keeping it in two places had already let the
copies drift.

Three behaviour fixes fall out of the plugins now sharing one implementation:

- `buildVercelOutput` gained the output-directory guard it never had. It
  deletes `outputDir` before writing, so pointing it at the project previously
  deleted the source tree.
- `buildCloudflareOutput` and `buildVercelOutput` no longer accept the
  filesystem root as `outputDir`. The old check compared strings, and `out + sep`
  is `//` at the root, which no absolute path is prefixed by.
- `buildCloudflareOutput` now honours a custom `publicDir` when reading the
  client manifest instead of always looking under `<root>/public`.

Cloudflare's generated stub filenames are now derived from the module
specifier, so `stub-mcp-server.js` and `stub-mcp-transport.js` are written
under their full specifier-derived names. An existing `wrangler.jsonc` keeps
its old `alias` values, which now point at files the build no longer writes —
the build warns and prints the map to paste in. The other three stub filenames
are unchanged.
