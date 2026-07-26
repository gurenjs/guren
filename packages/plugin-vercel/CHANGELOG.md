# @guren/plugin-vercel

## 0.2.0

### Minor Changes

- 52dbaaf: BREAKING (`@guren/plugin-vercel`): the provider export changed from the `GurenPluginVercelProvider` class to a `vercelPlugin(config?)` factory built on `definePlugin()`, aligning with `@guren/plugin-cloudflare` and the plugin contract's recommended shape. The config object is empty today and reserved so future fields never force another registration-shape change. Update registrations from `providers: [GurenPluginVercelProvider]` to `providers: [vercelPlugin()]`; `createVercelHandler` and `buildVercelOutput` are unchanged. The `gurenPlugin.provider` manifest field is dropped accordingly.

  `@guren/cli`: `guren plugin` now knows the official factory-shaped plugins (`@guren/plugin-vercel`, `@guren/plugin-cloudflare`) and auto-registers them as `providers: [vercelPlugin()]`-style call expressions in `src/app.ts` — previously factory plugins could only print a "register manually" hint.

### Patch Changes

- d347625: Route the asset base back onto the output root in the emitted deployment config.

  Built assets self-reference `/public/assets/`, the base the Guren Vite plugin derives, while the files themselves are copied to the output root. The emitted `config.json` carried no mapping between the two, so on a `--prebuilt` upload — routed by that file alone, and the flow the deployment guide documents — every chunk the entry script imports missed the filesystem handler, fell through to the function, and came back as HTML. The page loaded and the app never started.

  Deployments built by Vercel itself were unaffected, since `vercel.json`'s `rewrites` are compiled into routing on that path. That is why the failure stayed hidden.

- Updated dependencies [88b45c4]
- Updated dependencies [360d1f4]
- Updated dependencies [1a6b738]
  - @guren/core@1.3.0

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
