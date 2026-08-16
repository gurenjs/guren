# @guren/plugin-lambda

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
