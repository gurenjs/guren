# @guren/plugin-vercel

## 0.1.2

### Patch Changes

- 494ac11: Turn `guren plugin <pkg>` into a full plugin installer driven by the declarative `gurenPlugin` package.json manifest (RFC 0001, Part B). The command now installs the dependency with `bun add` when missing (`--no-install` to skip), verifies the plugin's declared Guren `compatibility` range against the installed `@guren/core` (`--ignore-compatibility` to override), registers the manifest-declared `provider` export (falling back to the name heuristic), copies declared `publishes` files into `config/`, `db/migrations/`, or `resources/` (path-traversal guarded, never overwriting without `--force`), and appends declared `env` keys to `.env.example`/`.env`. The manifest is pure data — no plugin code is executed during installation. The command is now also registered at the top level (`bunx guren plugin ...` previously only worked as `guren add plugin ...` despite being documented). `bunx guren doctor` gains a Plugin Compatibility check that flags installed plugins whose `compatibility` range excludes the installed core version. `@guren/plugin-vercel` now declares its `gurenPlugin` manifest.
- Updated dependencies [2bbc832]
  - @guren/core@1.1.0

## 0.1.1

### Patch Changes

- f12e754: Fix Inertia SSR on serverless deployments and stop shipping dev import maps in production.

  - The Guren Vite plugin now defaults `ssr.noExternal` to `true` for SSR builds so `.guren/ssr` bundles are self-contained and importable on runtimes without `node_modules` (Vercel, Lambda).
  - `@guren/plugin-vercel` pins `process.env.NODE_ENV` to `"production"` when bundling the function entrypoint; `bun build` otherwise inlines it as `"development"`, disabling every production code path at runtime.
  - The Inertia HTML document no longer emits the esm.sh dev React import map when `NODE_ENV` is `production`.

## 0.1.1

### Patch Changes

- f12e754: Fix Inertia SSR on serverless deployments and stop shipping dev import maps in production.

  - The Guren Vite plugin now defaults `ssr.noExternal` to `true` for SSR builds so `.guren/ssr` bundles are self-contained and importable on runtimes without `node_modules` (Vercel, Lambda).
  - `@guren/plugin-vercel` pins `process.env.NODE_ENV` to `"production"` when bundling the function entrypoint; `bun build` otherwise inlines it as `"development"`, disabling every production code path at runtime.
  - The Inertia HTML document no longer emits the esm.sh dev React import map when `NODE_ENV` is `production`.
