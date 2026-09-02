# @guren/plugin-vercel

## 0.5.0

### Minor Changes

- bf4020f: Carry the static-document download policy onto Cloudflare Workers and Vercel.

  Files a browser renders as a document — `.html`, `.htm`, `.svg`, `.xhtml`,
  `.xml` — are served from `public/` with `Content-Disposition: attachment` and
  `X-Content-Type-Options: nosniff`, so navigating straight to one downloads it
  instead of running its script on the app's origin. On both of these deploy
  targets the platform answers for `public/` before the app runs, so the
  framework's guard never saw those requests: the same app downloaded an SVG
  locally and rendered it inline in production.

  Each plugin now declares the policy to its platform at build time, keyed on
  file extension because the platform, not the app, computes the content type.
  The Cloudflare build writes a `_headers` file into the staged asset directory,
  keeping and going ahead of any `_headers` the app ships under `public/`. The
  Vercel build adds the rule to the generated `config.json` after
  `handle: "hit"`, which confines it to files the CDN answered — in the initial
  phase it would also have forced a download on a path the function serves, such
  as a dynamic `/sitemap.xml`.

  Cloudflare's `_headers` also names any staged document whose extension is not
  already lowercase, as an exact rule. The platform compiles a pattern
  case-sensitively while `getMimeType` lowercases before its lookup, so `/*.svg`
  alone would leave `logo.SVG` inline there while the framework's own mounts
  download it. Enumerating the case variants is not possible — one splat per
  rule — but on this platform the asset set is closed at build time, so naming
  the offenders exactly is complete, and an app spelling its extensions the
  ordinary way gets no extra rules. The build now also warns when merging with an
  app's own `_headers` crosses the 100 rules the platform reads, since it stops
  there rather than reporting the rest.

  The Cloudflare scaffold additionally sets `"html_handling": "none"` on the
  `assets` binding. Under the platform default a staged `page.html` is served at
  `/page` and `/page.html` merely redirects there, which both leaves the `.html`
  rule landing on the redirect rather than the document and lets a file under
  `public/` shadow an app route of the same name. An app that names another
  `html_handling` itself is left alone; an existing `wrangler.jsonc` with no
  value is named in the build's upgrade warning.

  `inlineDocuments` does not reach either plugin — they read a built directory,
  not the app's route configuration. The deployment guides say so and describe
  how to undo the platform-side rules after a build.

### Patch Changes

- 691f12a: Stop compiling the App MCP endpoint shut when an app depends on `@guren/plugin-mcp`.

  All three deploy plugins stubbed `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`, which `@guren/plugin-mcp` dynamically imports to serve the endpoint; Lambda and Vercel additionally routed _every_ unlisted `@modelcontextprotocol/sdk/*` subpath to a throwing stub, which also killed the plugin's static imports of `server/index.js` and `types.js`. A deployed endpoint could therefore never load, with no build error to say so.

  Each platform now derives its stub set from `stubbableDevOnlyModules()`, and Lambda and Vercel drop the SDK-prefix catch-all, from one read of the app's manifest. The dev-only MCP server (`server/mcp.js`), `@guren/cli`, `bun:sqlite` and `vite` stay stubbed on every platform, for every app.

  On Cloudflare the aliases are baked into the app's committed `wrangler.jsonc`, which the scaffold writes once and never overwrites — so an app that adds the plugin after its first deploy would keep the stale alias indefinitely. `cloudflare:build` now fails with the exact alias line to delete when that app depends on `@guren/plugin-mcp`, before it runs the app build.

- Updated dependencies [0346aeb]
- Updated dependencies [0a5dd3c]
- Updated dependencies [39db410]
- Updated dependencies [bf4020f]
- Updated dependencies [691f12a]
- Updated dependencies [a6e3a1f]
  - @guren/core@1.13.0

## 0.4.0

### Minor Changes

- 451755c: Build-time Vite manifest injection for serverless targets: `viteAsset()` now
  resolves production entries from `GUREN_VITE_MANIFEST` (the client manifest
  JSON) before reading the filesystem, and all three deploy plugins populate it
  during their build step — Cloudflare Workers and Lambda in their generated
  entry module, Vercel by substituting the read at bundle time. Content pages
  rendered with `Controller.view()` work on deploy targets whose runtime never
  sees `public/assets/manifest.json`.

### Patch Changes

- Updated dependencies [104c9b6]
- Updated dependencies [451755c]
  - @guren/core@1.10.0

## 0.3.1

### Patch Changes

- 8871c4c: Build with tsdown instead of tsup, and emit declarations with the native TypeScript 7 compiler. The public file layout of every package is unchanged (same `dist/*.js` / `dist/*.d.ts` entry names, shebangs, and `exports`); only the internal chunk names differ. tsup is unmaintained and its declaration bundler needs the JavaScript compiler API that TypeScript 7 no longer ships.
- Updated dependencies [deaa5c0]
- Updated dependencies [8871c4c]
  - @guren/core@1.8.1

## 0.3.0

### Minor Changes

- b927659: Stub the database clients a Lambda or Vercel app does not use

  A Postgres app failed to bundle for either platform with
  `Could not resolve "mysql2"` — naming a database its author never chose — and
  `@aws-sdk/client-rds-data` behind it. `@guren/orm` names each dialect's client
  in a _literal_ dynamic import, and a bundler follows those whether or not the
  branch can be taken, so every client the app did not install broke the build.

  Workers could stub all of them, because D1 is the only database there is.
  Here the client the app _does_ use is load-bearing, so the build now reads
  which dialects `config/database.ts` declares and stubs only the rest.
  Detection is a union, never a single answer — an app legitimately pairs
  Postgres with sqlite and picks at runtime — and it fails open: when no
  factory can be read, nothing is stubbed and the build says so. Over-stubbing
  would ship a function that builds clean and cannot reach its own database,
  which is a far worse failure than the loud one this replaces.

  Pass `databaseDialects` to `buildLambdaOutput`/`buildVercelOutput`, or
  `guren lambda:build --database postgres,sqlite`, for an app whose config
  reaches a factory without naming it.

  `buildVercelOutput` is now **async**. It bundled by spawning `bun build`,
  whose CLI has no way to replace a module — no alias flag, no plugin flag — so
  this platform had no stub mechanism at all. It now uses Bun's JS API, which
  takes plugins. Update `scripts/vercel-build.ts` to `await buildVercelOutput({
... })`; the scaffold emits that from now on.

  That missing mechanism was also why a scaffolded app could not be bundled for
  Vercel at all: the disabled MCP endpoint's `import("@guren/cli")` resolves and
  the CLI's own `import("@guren/openapi")` behind it does not. The Vercel build
  now stubs the same dev-only modules Lambda has stubbed since it shipped —
  Vite and the MCP endpoint — which also drops the dev tooling those dragged
  into the function. `bun:sqlite` is deliberately **not** stubbed here: the
  function runs on Vercel's Bun runtime, so sqlite is a working database on this
  platform, unlike on Workers and Lambda.

  Both plugins also pass `throw: false` to `Bun.build`: it rejects with a bare
  "Bundle failed" by default, discarding the one line that matters — the module
  it could not resolve.

  An opt-in `GUREN_TEST_BUNDLE=1` test per platform bundles a Postgres app with
  no other client installed. Each installs the ORM from a tarball rather than a
  local path, because a linked install resolves out into this repository's own
  `node_modules` where every client exists. The assertions are behavioural
  rather than about the stub's text: resolution happens before dead-code
  elimination, so the message a stub throws is not in the output either way.

### Patch Changes

- Updated dependencies [b927659]
- Updated dependencies [15cfaf5]
  - @guren/core@1.6.2

## 0.2.1

### Patch Changes

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

- 26b81fe: fix: stop the Vercel function bundle from mangling class names

  The serverless function was bundled with a bare `--minify`, which enables
  identifier mangling and renames every class in the graph. Guren treats class
  names as durable identity, so the rename reaches data that outlives a single
  deploy:

  - the queue registry keys jobs on `JobClass.name` and serializes that name into
    every queued message, so a job dispatched by one build resolves to nothing
    after the next — and a message injected by name from outside the bundle never
    resolves at all
  - notifications persist `notifiable.constructor.name` as their `type`, and
    `Notification.type()` returns `this.constructor.name`
  - `HttpException` reports `this.constructor.name` as its `name`

  The build now passes `--minify-whitespace --minify-syntax` instead, dropping
  only identifier mangling. `--keep-names` is not an alternative: as of Bun
  1.3.14 it is accepted and silently leaves class names mangled.

  The bundle grows as a result. The ratio depends on the dependency graph —
  measured at ~35% on a framework-linked entrypoint (3.33 MB → 4.51 MB), and
  higher on smaller graphs. That is the cost of names that survive a redeploy.

- Updated dependencies [a7aec95]
- Updated dependencies [4b8ed69]
  - @guren/core@1.4.0

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
