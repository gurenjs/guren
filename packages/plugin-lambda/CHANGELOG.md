# @guren/plugin-lambda

## 0.5.0

### Minor Changes

- 2894c60: Run the deploy-runtime checks where builds run, not only in `guren doctor` (RFC 0020 Part 0)

  An app that keeps sessions in `MemorySessionStore` works on one Bun server and
  loses every login on Cloudflare Workers, Lambda, or Vercel, where requests share
  no memory. `guren doctor` has reported that, along with a Bun-only
  `ScryptHasher` and filesystem provider discovery, but nothing in the path to a
  deploy ran `doctor`.

  - `guren check` now reports the same three verdicts for an app that declares a
    deploy plugin or the Lambda adapter, as advisory results: they print in the
    report and in `--json`, and `check --ci` and `guren gate` never fail on them,
    because the scan reads constructions rather than intent (a custom
    `SessionStore` passed as `store:` reads as unbacked). Apps with no deploy
    target see nothing new.
  - `cloudflare:build`, `lambda:build`, and `vercel:build` print the failing
    verdicts before the app build, prefixed with the build's label, and go on to
    build. A scan that cannot run says so in one line rather than staying silent.
  - `@guren/cli` exports `analyzeDeployRuntime`, `judgeDeployRuntime`, and
    `checkDeployRuntime`; `@guren/core/internal/deploy-check` exports
    `reportDeployRuntimeHazards`, the helper the three builds share. `doctor`'s
    output is unchanged: it maps the same verdicts onto its checks.

### Patch Changes

- Updated dependencies [52a23b1]
- Updated dependencies [68aa3d7]
- Updated dependencies [2894c60]
  - @guren/core@1.15.0

## 0.4.0

### Minor Changes

- 2d99a8c: Carry the static-document download policy onto AWS Lambda's CloudFront distribution.

  The CDK construct stages `public/` into S3 and puts a cache behavior for it in
  front of the app, so CloudFront answers for those files before the function
  runs and the framework's own guard never sees the request: an `.svg` under
  `public/` rendered inline, script and all, on the app's origin. This is the
  same gap the Cloudflare and Vercel builds close, on the third target that
  serves `public/` off-app.

  The construct now attaches a viewer-response CloudFront function to the asset
  behaviors, setting `Content-Disposition: attachment` and
  `X-Content-Type-Options: nosniff` on the types a browser renders as a
  document. Its extensions come from the same `DOCUMENT_ASSET_EXTENSIONS` the
  other two plugins read, so the three targets cannot drift apart.

  A function rather than one cache behavior per extension: a behavior is chosen
  by path, so `*.svg` would also capture a `/feed.svg` the _app_ renders and
  send it to S3, and CloudFront's default limit of 25 behaviors is already spent
  one per staged root entry. The association rides on the asset behaviors alone,
  so the default behavior — your app — keeps answering with its own headers.
  Reading the extension off the path also covers `logo.SVG`, which the framework
  guard catches and a literal pattern cannot.

  Deploying `.lambda/assets` by hand, without the construct, still serves those
  files inline; the serverless guide says so.

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

## 0.3.0

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

## 0.2.1

### Patch Changes

- 8871c4c: Build with tsdown instead of tsup, and emit declarations with the native TypeScript 7 compiler. The public file layout of every package is unchanged (same `dist/*.js` / `dist/*.d.ts` entry names, shebangs, and `exports`); only the internal chunk names differ. tsup is unmaintained and its declaration bundler needs the JavaScript compiler API that TypeScript 7 no longer ships.
- Updated dependencies [deaa5c0]
- Updated dependencies [8871c4c]
  - @guren/core@1.8.1

## 0.2.0

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

## 0.1.0

### Minor Changes

- aa091f7: Add the `GurenLambdaApp` CDK construct under `@guren/plugin-lambda/cdk`.

  One construct provisions the full serverless topology for a Guren app: an
  HTTP API in front of the `http` handler, an SQS queue + worker with a
  dead-letter queue and partial batch failures, an EventBridge rule for the
  scheduler, a console function for CLI commands, CloudFront + S3 serving
  the staged assets (including per-file behaviors for root-level public files),
  and a `dataApi` option that wires the DATABASE\_\* environment and IAM grants
  for Aurora's RDS Data API onto every function. `aws-cdk-lib` and
  `constructs` are optional peer dependencies. The `guren deploy` error message
  now points AWS Lambda users at the plugin.

- 4e8ccc2: Add `@guren/plugin-lambda`: first-class AWS Lambda deployment tooling.

  `guren plugin @guren/plugin-lambda` registers `lambdaPlugin()` and scaffolds
  `src/lambda.ts` (the module whose exports become Lambda handlers). The plugin
  contributes a `lambda:build` command that assembles a `.lambda/` directory:
  a self-contained ESM bundle for the Node.js runtime with
  `process.env.NODE_ENV` pinned to `"production"`, the SSR bundle plus Drizzle
  migrations alongside it, static assets staged for S3, and an
  `env.json` describing the function environment. Dev-only modules
  (`bun:sqlite`, `vite`, the MCP endpoint's generators) are replaced with
  throwing stubs so the bundle neither ships dev tooling nor fails to import on
  Lambda.

  `import.meta.url` is pinned so the framework's
  `new URL('../db/migrations', import.meta.url)` convention keeps resolving
  against the function root. Bundling collapses every module onto the output
  file's own URL (`file:///var/task/handler.js`), which would otherwise point
  that expression one directory too high and silently skip
  `configureOrm()`/`seedDatabase()` at boot.

### Patch Changes

- 2cf9bdf: Keep class names intact in the Lambda bundle.

  `lambda:build` minified identifiers, which renamed every class in the bundle.
  The framework treats class names as durable identity — `registerJob()`/
  `getJob()` key the job registry on `JobClass.name`, and that same name is
  serialized into each queued message and into a notification's persisted `type`.
  Mangled, a job queued by one build became unresolvable after the next, and an
  SQS message addressed by its real class name never resolved at all: the handler
  reported a batch item failure in milliseconds with no job code ever running.
  The bundle now minifies whitespace and syntax only.

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
