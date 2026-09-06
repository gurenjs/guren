# @guren/plugin-cloudflare

## 0.7.0

### Minor Changes

- 923a3ee: Generate the Durable Object half of a worker for apps hosting agents (RFC 0017 Part 2b)

  `guren cloudflare:build` now reads `config/agents.ts` and produces a worker that
  can actually host the agents an application registers. Nothing changes for an
  app without that file: its generated worker and scaffolded `wrangler.jsonc` are
  byte-for-byte what they were.

  - **A shared boot primitive.** `bootWorkersApp(app, env)` and
    `bootAndFetch(app, request, env, ctx)` are exported from the package root, and
    `createWorkersHandler(app)` is built on them — it now returns a `boot(env)`
    alongside `fetch`. An agent woken by an alarm has an `env` but no request, and
    before this it would have reached an unbooted application. The latch is keyed
    on the app (a `WeakMap`), so one process may boot several applications while
    one isolate still boots its own exactly once, from whichever entrypoint
    arrives first.
  - **Named-export injection.** For each registration the generated worker gains
    an `export { Class } from '…'` line, registers
    `configureAgentRuntime((env) => handler.boot(env))` at module scope, and
    default-exports an entry that boots, offers the request to the agent router,
    and otherwise dispatches to the application. With `--mcp-oauth` the OAuth
    provider's `defaultHandler` is that same entry and both halves share the one
    handler, so there is still a single boot slot.
  - **`/agents/*` is deny-all.** The mount goes through
    `routeGuardedAgentRequest`, which refuses every request — HTTP and WebSocket
    upgrade alike — with 403 until `config/agents.ts` declares
    `routing.authorize`. The refusal happens in the SDK's pre-dispatch hook, so no
    Durable Object is constructed and none pays a cold start. The build says so
    once, at generation time.
  - **Bindings verification.** A registered class with no `durable_objects`
    binding, or one that is not SQLite-backed, fails the build _before_ the app
    build runs, with the exact JSON to add. Both forms wrangler accepts are
    recognised: the legacy `migrations` list, read as _history_ (a class created
    in `v1` and deleted in `v2` is gone; a rename carries the backend), and the
    declarative `exports` map. Every named environment is verified on its own,
    since wrangler does not inherit `durable_objects` into one, and a binding with
    a `script_name` counts for neither hosting nor routing. The bindings the
    config gives the registered classes become the generated worker's routing
    allowlist. A fresh scaffold gets the legacy form written for it — that is
    what the agents SDK documents and what the workerd test lane runs. An
    unparseable config warns that the check was skipped rather than passing
    silently.
  - **Refusals before the build.** An app registering agents without
    `@guren/plugin-agents` under `dependencies` is refused, as are a registration
    with no usable `module`/`export`, a module outside the app, an export name
    that is not a class name (`default` included), two registrations claiming one class, two
    classes whose names scaffold one binding (`HTTPAgent`/`HttpAgent`), a
    `routing` block with no callable `authorize`, and a `wrangler.jsonc` with
    `"minify": true` — wrangler's minifier renames the class an agent looks itself
    up by. A registry that cannot be evaluated on Bun fails naming the file rather
    than with a bare module-resolution trace.

  One behaviour note: RFC 0017 §6 asked for `captureWorkersEnv` to treat a second,
  different `env` object as a hard error. It does not, and the reason is measured
  rather than assumed — on workerd a Worker entrypoint and a Durable Object of the
  _same_ deployment are handed different `env` objects (two Durable Objects share
  one), so identity is not a test for "another environment" and the refusal would
  break the two-entrypoint topology it was meant to protect. First-capture-wins is
  unchanged; the per-app boot latch is what keeps one isolate on one application.

- 7fafa9f: Export `isWorkersRuntime()` from `@guren/plugin-cloudflare/env`. Every app that picks D1 over a local driver needs the workerd check, and the package's own README used it in the R2 snippet without an import — so each app hand-wrote it in `config/database.ts`. It ships from the same import-free subpath as `getWorkersEnv`, and the README's snippets now import both from there.

### Patch Changes

- Updated dependencies [e94645b]
- Updated dependencies [55137f7]
- Updated dependencies [923a3ee]
- Updated dependencies [59347c1]
- Updated dependencies [20c2bc7]
  - @guren/core@1.14.0

## 0.6.0

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

- 789cd34: Add `guren cloudflare:build --mcp-oauth`: front the worker with `@cloudflare/workers-oauth-provider` so the App MCP endpoint is reached by OAuth-authorized clients (RFC 0016 §7).

  A **build** option and not plugin configuration, because the generator runs in a separate process and cannot read what `mcpPlugin()` was passed. `--mcp-path` accompanies it for an app that moved the endpoint, since a provider protecting a path the endpoint does not serve leaves that endpoint outside the OAuth boundary — silently, because the request still reaches the app.

  **The generated worker exports one `OAuthProvider`.** Its protected `apiRoute` is the MCP path; the `apiHandler` maps `ctx.props` through `mcpOAuthPropsToAuth` and presents the result over `@guren/plugin-mcp/oauth`'s request-identity seam, refusing 401 when the grant does not map rather than forwarding a partial principal. The `defaultHandler` is the _same_ `createWorkersHandler` — one handler threaded through both halves, because it dedupes `boot()` per handler while the Workers env holder is module-global, and two would share the holder without sharing the boot slot. `clientRegistrationEndpoint` wires RFC 7591 dynamic client registration, knowingly on a path deprecated in the MCP 2026-07-28 line: it is what shipping MCP SDK 1.x clients use to register themselves today.

  **Three guards, all ahead of the app build**, so a misconfigured app is told in a second rather than after several minutes of Vite output:

  - The flag is refused on an app that does not depend on `@guren/plugin-mcp` — there would be no endpoint to protect, and the generated worker would import a seam that is not installed.
  - It is refused on an app that does not depend on `@cloudflare/workers-oauth-provider`, with the `bun add` line to fix it. That package is deliberately **not** a dependency of this plugin: the large majority of Workers deployments will never front an OAuth provider, and the opt-in cost of an opt-in feature belongs to the people opting in. A devDependency does not count, for the reason `appUsesMcpPlugin` gives — wrangler resolves the import at deploy time, from a production install.
  - A committed `wrangler.jsonc` binding no `OAUTH_KV` **fails**, with the exact JSON to paste and the `wrangler kv namespace create` line. Unlike the existing build-owned-key warnings this one has a deploy-time consequence nothing in the build output would otherwise reveal. A fresh config gets the binding scaffolded; a build without the flag never requires or writes it.

  The flag records itself nowhere — passing it on every build is the contract. The drift that leaves is the other direction, and it is warned about by name: a config binding `OAUTH_KV` while today's build omitted the flag has just produced a worker whose `/oauth/token` and `/oauth/register` 404, breaking every already-authorized client.

  **The consent flow ships as real template files** under `templates/mcp-oauth/`, written into the app once and never overwritten — `routes/mcp-oauth.ts`, `app/Http/Controllers/McpOAuthController.ts`, and two `hono/jsx` views in `app/View/`. The screen renders through `Controller.view()` (RFC 0014) rather than as an Inertia page, so an API-only app can serve it and it does not break when the asset pipeline does; escaping is the renderer's, not hand-rolled. Each view opens with `/** @jsxImportSource @guren/core */`, which is what lets it compile in an app whose tsconfig points `jsx: "react-jsx"` at React for `resources/js` — no tsconfig change is needed in the scaffolded app. It renders **tools, not scope strings**: nobody can read `tools:*` and say what it reaches, so the requested scopes are expanded against the application's _live_ router derivation — never `.guren/agents.gen.ts`, which can be stale — and rendered one checkbox per tool with its read-only and approval-required facts. Read-only tools arrive ticked and anything that can write does not: the default is what most people accept unread, so granting a write has to be a decision somebody made rather than one they failed to undo. Each checkbox carries the `tool:<name>` wire form the scope grammar parses, and the submission is intersected with what the client actually requested, so a grant is a subset of the request by construction. The build prints the two lines that wire the routes file into the app's registrar, once, on the build that created it.

  **The consent POST verifies CSRF itself**, through `@guren/core`'s own `verifyCsrfToken`, rather than relying on the global middleware being mounted. An app with `autoSession: false` or a hand-composed chain may not have it — and `csrfField()` renders an entirely convincing token either way, so the screen would look protected while any site could POST a grant on a signed-in user's behalf. A malformed or tampered authorize query — a routine arrival at this URL, not an application fault — answers a clean 400 page rather than a 500 with a stack in it, and echoes nothing derived from the query.

  **New lean subpath: `@guren/plugin-cloudflare/env`.** The package root exports `buildCloudflareOutput`, which pulls `node:fs`, `node:path` and the whole deploy generator behind it, so application code importing `getWorkersEnv` from the root drags the build tooling into its module graph. On a deploy that is tree-shaken away (measured — the OAuth bundle probe asserts it); on `bun run dev` there is no bundler and no tree-shaking, and it is loaded on every boot. The three env functions now have an entry of their own with an empty import graph, and the scaffolded controller uses it. The root keeps re-exporting the same names, so nothing that already imports them from there changes.

  `--mcp-oauth` **also warns** when the committed config binds `OAUTH_KV` but its id is still the placeholder this build scaffolds: the guard passes, the build proceeds, and `wrangler deploy` would otherwise be the first thing to mention it. A warning rather than a failure — the id is not needed to build, and a `--dry-run` deploy is a reasonable thing to be doing with an unfinished config.

### Patch Changes

- f56d411: Refuse to build beside a wrangler config the plugin does not manage. wrangler resolves `wrangler.json` ?? `wrangler.jsonc` ?? `wrangler.toml` silently, so scaffolding `wrangler.jsonc` next to a lone `wrangler.toml` made wrangler stop reading the user's own config, and the build-owned key checks never ran on it. The build now fails up front with migration guidance when it finds a `wrangler.toml` (unreadable here) or a `wrangler.json` (outranks the managed file), and warns when a leftover `wrangler.toml` sits ignored beside `wrangler.jsonc`.
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

## 0.5.0

### Minor Changes

- acd6469: R2 support for the signed attachment delivery route (RFC 0015 Part 3).

  `R2Driver` implements `getStream(path, { range? })` over the binding's
  `get(key, { range })` (normalizing to the global web `ReadableStream` at
  the driver boundary; an unsatisfiable range propagates R2's rejection) and
  declares `capabilities: { presignedGet: true }` iff `presign` credentials
  are configured — a config fact, never a probe. `temporaryUrl()` accepts
  the `TemporaryUrlOptions` bag but deliberately ignores the response
  overrides: R2's S3 API does not implement GetObject's `response-content-*`
  parameters, so per the `TemporaryUrlOptions` contract an app that must
  force `Content-Disposition` on an R2 disk uses `serve: 'proxy'`.

  With this, private attachments on a binding-only R2 disk work through the
  delivery route with no `presign` credentials (the route proxies
  `get().body` through the Worker), and presign-configured disks upgrade to
  302 redirects automatically. SigV4 signing keys are now cached per
  credential and day, cutting the per-presign WebCrypto calls.

### Patch Changes

- Updated dependencies [fa7e6c7]
  - @guren/core@1.11.0

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

## 0.3.2

### Patch Changes

- 8871c4c: Build with tsdown instead of tsup, and emit declarations with the native TypeScript 7 compiler. The public file layout of every package is unchanged (same `dist/*.js` / `dist/*.d.ts` entry names, shebangs, and `exports`); only the internal chunk names differ. tsup is unmaintained and its declaration bundler needs the JavaScript compiler API that TypeScript 7 no longer ships.
- Updated dependencies [deaa5c0]
- Updated dependencies [8871c4c]
  - @guren/core@1.8.1

## 0.3.1

### Patch Changes

- 116f32d: Make the wrangler config upgrade warning reach commented configs, and suggest entries rather than whole keys

  `cloudflare:build` never overwrites an existing `wrangler.jsonc`; instead it warns
  about the keys it owns that the config is missing — notably the `alias` entries,
  without which `wrangler deploy` cannot resolve the stubbed modules. Two things
  kept that warning from doing its job.

  It read the file with `JSON.parse`, so any config carrying a comment failed to
  parse and the check bailed silently. Comments are the normal case in a `.jsonc`
  file, which meant the warning could not fire for the apps it exists to help: they
  saw nothing at build time and a resolution failure at deploy time instead. The
  config is now read with a JSONC-tolerant parser (comments and trailing commas,
  string-aware so a `//` inside a value survives), and a file that is still
  unparseable afterwards is reported rather than skipped.

  The warning also printed `alias` and `define` as complete objects holding only
  the build-owned entries, which reads as something to paste over what the file
  has. Apps keep their own entries under both keys, so following it could drop a
  pinned dependency alias or a second `define`. It now names only the individual
  entries that are missing, and says to add them alongside what is already there.

- 15cfaf5: Stub the unused database clients in the Cloudflare worker bundle

  A scaffolded app switched to D1 could not be deployed. `wrangler deploy`
  failed with `Could not resolve "postgres"` — naming a database its author had
  deliberately not chosen — and then `mysql2/promise` and
  `@aws-sdk/client-rds-data` behind it.

  `@guren/orm` names each dialect's client in a _literal_ dynamic import, and a
  bundler follows those whether or not the branch can be taken. On Workers none
  of them can be: D1 is the only database there is. `cloudflare:build` now
  writes a stub for each and aliases it, the same way it already handles
  `bun:sqlite` and the Vite dev server. Apps that worked around this by
  installing `postgres` and `mysql2` they never used can drop them.

  The clients live in their own `SQL_CLIENT_MODULES` list rather than the
  existing dev-only one, because whether they are dead weight is a property of
  the platform: Lambda and Vercel connect to Postgres through them, and
  stubbing them there would break a working deploy. Each platform's message
  table is now keyed on the modules it actually stubs, so a Workers-only entry
  cannot silently demand a message from a plugin that never renders it.

  Nothing had caught this: no gate ran wrangler over an app that imports the
  ORM, and the one Workers app in this repository carries a leftover `postgres`
  dependency from before it moved to D1, which masked the failure. An opt-in
  `GUREN_TEST_WRANGLER=1` test now bundles such an app with no client
  installed. It installs the ORM from a tarball rather than a local path,
  because a linked install resolves out into this repository's own
  `node_modules` — which is how the first version of the test passed with no
  stubs at all.

- Updated dependencies [b927659]
- Updated dependencies [15cfaf5]
  - @guren/core@1.6.2

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
