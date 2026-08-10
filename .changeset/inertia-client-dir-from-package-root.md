---
'@guren/server': patch
---

Serve the built Inertia client in production, not its TypeScript sources

`configureInertiaAssets()` located the vendored client by resolving
`@guren/inertia-client/app` and taking `dirname()` of whatever came back. That
subpath is not a stable anchor: a tsconfig `paths` entry mapping
`@guren/inertia-client/*` at the package's `src/` — which Bun applies to
runtime resolution, `import.meta.resolve` and `require.resolve` alike —
redirects it to `src/app.tsx`. The production route then looked for
`src/app.js`, which does not exist, and 404'd; every `chunk-*.js` the entry
imports resolved against `src/` too, so the fallback of "the entry at least
loads" was not available either.

Resolution is now anchored on `@guren/inertia-client/package.json` — a subpath
no `paths` entry shadows, since a mapping at `src/` misses and falls back to
real package resolution — and the client directory is that package root's
`dist/`. The path is derived from the package rather than from whichever file a
specifier happened to reach.

This bites wherever such a `paths` mapping is in scope, which is this
repository: the reference app, the smokes, and the E2E runs all serve
production assets through it. An app that installs `@guren/*` from npm has no
`@guren/*` mapping, so its resolution already landed on `dist/app.js` and its
behavior is unchanged.

The resolution is now `resolveInertiaClientDir()`, exported so it can be
asserted directly. Its previous form lived inline in `configureInertiaAssets()`,
where no test could observe which directory it had chosen.
