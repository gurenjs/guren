# @guren/plugin-lambda

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
