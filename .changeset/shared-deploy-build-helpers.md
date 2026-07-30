---
'@guren/plugin-cloudflare': patch
'@guren/plugin-lambda': patch
'@guren/plugin-vercel': patch
'@guren/core': minor
---

Share the deploy plugins' build-time helpers through `@guren/core/internal/deploy-build`

The Cloudflare, Lambda, and Vercel plugins each carried their own copy of the
manifest and path helpers, the static-asset staging step, and the SSR manifest
lookup. Cloudflare and Lambda separately listed the dev-only modules a deployed
bundle has to stub. That list describes the module graph of any app importing
`@guren/core`, so keeping it in two places had already let the copies drift.

Four behaviour fixes fall out of the plugins now sharing one implementation:

- `buildVercelOutput` gained the output-directory guard it never had. It
  deletes `outputDir` before writing, so pointing it at the project previously
  deleted the source tree.
- No plugin accepts the filesystem root as `outputDir`. The old check compared
  strings, and `out + sep` is `//` at the root, which no absolute path is
  prefixed by.
- `buildCloudflareOutput` and `buildVercelOutput` now honour a custom
  `publicDir` when reading the client manifest instead of always looking under
  `<root>/public`. Vercel likewise honours `ssrDir`.
- `buildVercelOutput` no longer reports `GUREN_INERTIA_SSR_MANIFEST` as
  `.vite/manifest.json` when the SSR build emitted the flat `manifest.json`
  layout instead.

Stubs for the dev-only modules are emitted as throwing functions rather than
classes. The stubbed names mix constructors (`new Database()`) with plain calls
(`createServer()`), and only a function reports the intended message under
both — a class invoked without `new` reports "Class constructor cannot be
invoked without 'new'" instead.
