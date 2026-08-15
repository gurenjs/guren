# @guren/plugin-cloudflare

## 0.3.0

### Minor Changes

- 44e6323: Add `R2Driver`, a storage driver over the Cloudflare R2 bucket binding

  `R2Driver` implements the `StorageDriver` contract on top of `env.<BUCKET>`
  — the same lazy `binding: () => getWorkersEnv<Env>().BUCKET` contract as
  `createD1Database` — so a Guren app on Workers can put files behind
  `StorageManager` without provisioning an R2 API token or shipping the AWS
  SDK in the worker. Register it with `storage.registerDisk('media', () =>
new R2Driver({ binding, publicUrl }))`; on Bun the same disk name can point
  at `LocalStorageDriver`, mirroring the D1/SQLite runtime switch.

  Where the binding differs from S3, the driver says so instead of guessing:
  `url()` needs `publicUrl` (R2 has no derivable public URL); `temporaryUrl()`
  presigns on WebCrypto
  (no dependency) when `presign` credentials are configured and throws with
  guidance otherwise (bindings cannot sign);
  `put({ visibility })` / `setVisibility()` throw when asked for the opposite
  of the bucket's declared `visibility` (R2 has no per-object ACL);
  `putFile()` throws (no filesystem). Bulk deletes are batched to the
  binding's 1000-key limit and listings follow the cursor across pages.

  Design and rationale: RFC 0009.

## 0.2.2

### Patch Changes

- b8a9805: Stop a stale boot waiter in `createWorkersHandler` from clearing a live retry

  When the first boot fails, every request awaiting that shared promise runs the
  catch block, and each one dropped the boot promise and the write-once env
  holder unconditionally. That is only correct for the waiter whose attempt is
  still the current one.

  This is a long-standing race in the boot-failure cleanup, not a regression from
  the synchronous-throw fix released alongside it.

  A retry can start _between_ two waiters' catches: the app may attach its own
  rejection reaction to the promise `boot()` returned, and reactions run in
  registration order, so the reaction can sit between waiter one and waiter two.
  `handler.fetch` captures the env and installs the new boot promise
  synchronously, before its first `await` — so by the time the second, now-stale
  waiter reaches its catch, the retry is already live. Clearing there wiped the
  retry's boot promise and its env, leaving a successfully booted app with an
  empty holder: `getWorkersEnv()` then threw for every subsequent request, and
  the next request booted a second time.

  The cleanup is now guarded by the identity of the attempt the request actually
  waited on, so only its owner clears state. That ownership is per-handler, which
  matches what the generated worker builds: one `createWorkersHandler` call per
  module. Two handlers constructed in the same module still share the env holder
  without sharing a boot promise, so a boot failure in one can clear the holder
  the other captured — unchanged by this release, and out of reach of the
  generated topology. A synchronous throw from `boot()`
  leaves both the captured attempt and the boot promise `undefined` — nothing can
  interleave before that catch runs, so the guard holds and the env captured by
  that same request is still cleared.

- eb7728c: Clear the captured Workers env when `boot()` throws synchronously

  `createWorkersHandler` boots on the first request and, when that boot fails,
  drops both the shared boot promise and the write-once env holder so the retry
  starts from the new request's bindings. The `app.boot()` call sat one line
  above the `try`, so only a _rejected promise_ reached that cleanup. An
  implementation that throws before returning a promise skipped it, leaving the
  holder populated with the failed request's `env` — and since the holder is
  first-call-wins, every later request would then boot against those stale
  bindings, which is the exact failure the catch exists to prevent.

  `Application.boot()` is `async` and so cannot reach this, but the handler
  publishes `WorkersAppLike`, a structural type requiring only
  `boot(): Promise<void>`; a conforming non-async implementation can throw
  synchronously. The call now happens inside the `try`. On a synchronous throw
  the assignment never runs, so the promise is already `undefined` and the
  existing reset stays a no-op.

  `@guren/plugin-vercel`'s `createVercelHandler` is not affected on either count:
  it is an `async` function, which converts a synchronous throw into a rejection,
  and it keeps no module-scope env holder to leave stale.

- Updated dependencies [72bd945]
- Updated dependencies [72bd945]
- Updated dependencies [b210a53]
  - @guren/core@1.5.2

## 0.2.1

### Patch Changes

- 57385c1: fix: the generated Workers entry names the SSR export the bundle actually has

  `cloudflare:build` emitted `setInertiaSsrRenderer(ssrModule.render ?? ssrModule.default)`,
  probing both renderer shapes. Since a built SSR chunk only ever has one of them,
  esbuild reported the other as missing on every `wrangler deploy`:

  ```
  ▲ [WARNING] Import "render" will always be undefined because there is no matching
    export in ".guren/ssr/ssr-XXXX.js" [import-is-undefined]
  ```

  The runtime fallback made it harmless, but it sat on the one line whose real
  failure mode is Inertia silently falling back to CSR — so the warning that
  means "your SSR is wired wrong" was printed on every healthy deploy too, and
  could not be told apart from the genuine one.

  `resolveSsrImport` already imports the built chunk to check it exposes a
  renderer, so it now records which export won and the generated entry names that
  one directly. Both shapes stay supported: a chunk built from
  `export default` gets `ssrModule.default`, one from `export function render`
  gets `ssrModule.render`.

  The same check now tests each candidate for being a function rather than taking
  the first non-nullish one, matching how the runtime loader picks a renderer — an
  entry exporting `const render = 42` alongside a valid default builds instead of
  failing.

- 4369af6: Add a README to both deploy plugins. Neither package shipped one, so their npm pages were blank — the first thing anyone sees when evaluating the plugin said nothing about what it does. Each README covers install, build and deploy, the exported API, and the runtime constraints that change how an app is configured, then links to the full guide.
- 4b8ed69: Share the deploy plugins' build-time helpers through `@guren/core/internal/deploy-build`

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

  `buildVercelOutput` now fails when the SSR manifest names a chunk that is not
  on disk, or one that escapes the SSR output directory. It previously wrote the
  entry into the function environment unchecked, so a stale or partial SSR build
  deployed and fell back to client-side rendering at request time. Cloudflare and
  Lambda already treated this as fatal. It also checks the entrypoint exists
  before deleting the previous output — the spawned `bun build` caught a missing
  `src/vercel.ts` too, but only after the last deployable artifact was gone.

  Stubs for the dev-only modules are emitted as throwing functions rather than
  classes. The stubbed names mix constructors (`new Database()`) with plain calls
  (`createServer()`), and only a function reports the intended message under
  both — a class invoked without `new` reports "Class constructor cannot be
  invoked without 'new'" instead.

- Updated dependencies [a7aec95]
- Updated dependencies [4b8ed69]
  - @guren/core@1.4.0

## 0.2.0

### Minor Changes

- 5348a76: `cloudflare:build` now bridges two real-world gaps found while migrating guren.dev to Workers:

  - **drizzle-kit ↔ wrangler migration layout**: drizzle-kit 1.x emits one `<timestamp>_<name>/migration.sql` folder per migration, but wrangler's `migrations_dir` only discovers flat `*.sql` files. The build flattens each folder into `<folder-name>.sql` under `.cloudflare/d1-migrations/` (plain `*.sql` files pass through, `meta/` is skipped), and the `wrangler.jsonc` scaffold points `migrations_dir` there. `flattenD1Migrations()` is exported for scripts. The opt-in wrangler contract test now uses the real nested layout.
  - **`public/index.html` no longer shadows the root route**: Workers Static Assets serves `index.html` for `/` before the worker runs; Guren apps only carry it as the dev-mode Vite shell, so the build drops it from the assets output.
  - **Dev-only modules no longer bloat (or break) the bundle**: `bun:sqlite`, `vite`, and the opt-in MCP endpoint's SDK and CLI generators sit in every app's graph behind dev-time branches, and bundlers follow them regardless. The build emits throwing stubs and aliases them, cutting the guren.dev worker from 4,282 KB to 1,899 KB gzipped against the 3 MB limit.
  - **The worker starts**: `NODE_ENV` and `import.meta.url` are substituted at build time. workerd leaves `import.meta.url` undefined, which breaks both Vite's `createRequire(import.meta.url)` in the SSR bundle and scaffolded `new URL(..., import.meta.url)` config — both at module scope, before anything is served. Substituting a literal is safe because Workers has no filesystem, so those paths are already meaningless there.

  **Upgrading an existing Cloudflare app:** the scaffold never overwrites your `wrangler.jsonc`, so the build now warns with the exact `alias`, `define`, and `migrations_dir` entries to add — without them the worker fails to start or silently skips migrations.

- db4450e: Added `@guren/plugin-cloudflare` — the Cloudflare Workers deploy adapter (RFC 0003 Part 1). `createWorkersHandler(app)` wraps a Guren `Application` in a Workers module handler with lazy, deduplicated boot on the first request (bindings arrive with `fetch`, so boot cannot run at module scope) and passes each request's `env`/`ExecutionContext` through to Hono untouched. `getWorkersEnv<Env>()` exposes the first request's bindings to boot-time config behind a write-once holder, and `guren cloudflare:build` assembles a deployable `.cloudflare/` directory: the app's canonical build, a generated worker entry that statically wires the built SSR bundle, copied static assets for Workers Static Assets, and a `wrangler.jsonc` scaffold (D1 binding, `nodejs_compat`, drizzle migrations dir).

  The plugin's provider follows the `definePlugin()` factory shape (`cloudflarePlugin()` — configuration reserved for upcoming session/OAuth-state wiring), so there is no auto-registered class provider; the CLI command works regardless via the `gurenPlugin.commands` manifest.

  Supporting additions: `setInertiaSsrRenderer()` in `@guren/server` registers a process-wide default SSR renderer (per-call `ssr.render` still wins) so filesystem-free runtimes can use a static import instead of the `GUREN_INERTIA_SSR_ENTRY` dynamic import, and `TestApp.fromWorkers(handler, { env })` in `@guren/testing` drives a Workers-style handler with a fake `ExecutionContext` for testing the lazy-boot lifecycle.

### Patch Changes

- Updated dependencies [88b45c4]
- Updated dependencies [360d1f4]
- Updated dependencies [1a6b738]
  - @guren/core@1.3.0
