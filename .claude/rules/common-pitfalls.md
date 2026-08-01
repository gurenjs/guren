# Common Pitfalls

Lessons learned from code review cycles. Check these before submitting changes.

## Core-First Architecture

- **Never reference `@guren/server` in docs or user-facing code.** Use `@guren/core` for all imports. The `audit:core-first` script catches this.
- **When adding exports to `@guren/server`**, they are auto-available from `@guren/core` (via `export *`). No need to touch core's index.
- **When adding ORM exports**, they must be explicitly listed in `packages/core/src/index.ts` (allowlist, not `export *`).
- **Don't reference non-existent symbols in docs.** Verify imports compile before documenting them.

## Stale Build Artifacts

- **A stale `dist/` can fail tests silently, not just loudly.** The documented symptom is a DTS build error (`could not find declaration file`), but a stale artifact can also load fine and merely *lack a field added since it was built* — which surfaces as a confusing `toEqual` mismatch in an unrelated package's unit test.
- **`packages/cli` tests reach `@guren/server` through `dist/`, not `src/`.** `@guren/core` resolves to `packages/core/src/index.ts`, but its `export * from '@guren/server'` follows the workspace symlink to `packages/server`'s `exports`, which points at `dist/index.js`. So anything a CLI test loads via `@guren/core` (routers, route definitions) is the *built* server, however fresh the source is.
- **`git stash` does not make a checkout clean.** `dist/` is untracked, so stashing leaves stale artifacts in place. When a test fails only on one machine, rebuild before bisecting: `bun run build:clean` (or `bun run build:<pkg>` for a targeted check).

## CI Environment

- **Never use `bunx guren` in CI.** The `guren` package is not on npm. Use `bun packages/cli/src/bin.ts` directly.
- **Vite route-types plugin calls `bunx guren` internally.** The plugin skips generation when `process.env.CI` is set.
- **E2E webServer in CI uses `bun run e2e:server`** — not `bun run dev` (triggers codegen) and not `bun run dev:server` (runs under `bun --hot`, so the server would reload mid-test if anything touched a watched file).
- **`bun run --cwd` with `bunx` can resolve from npm instead of local.** Use `cd dir && bun ...` or direct paths.

## Templates vs. Published Packages

- **A template can use an API that does not exist yet for its users.** `packages/create-app/templates/**` is application code that resolves `@guren/*` from **npm**, not from this checkout. Adding an export in `packages/orm` and using it from a template in the same PR ships templates that only build after the next release.
- **Nothing in the normal gate can see this.** Root `typecheck` skips templates (`packages/create-app/tsconfig.json` excludes `templates`), and the generated files are worse — `config/database.ts` is emitted as a *string* from `packages/create-app/src/blueprints.ts`, so no tsconfig anywhere covers it. `smoke:starter` and `smoke:starter:packed` both rewrite the app's `@guren/*` deps to local builds, so they typecheck against unreleased code too. The create-app tests assert the generated text, not that the symbols exist.
- **`bun run smoke:starter:npm` is the one check that installs from the registry.** It is on the scheduled `Published Package Drift` workflow rather than in CI, because it is *correctly* red between a template-facing change and the release that publishes what the template needs. Cutting that release is the fix — not editing the template back to an older API. **A drizzle pin bump reads the same way:** the `@guren/*` ranges only ever move at `changeset version`, but `packages/orm`'s `drizzle-orm` pin can move in an ordinary PR, and until that release ships, npm's `@guren/orm` still installs the old copy beside the template's new one.
- **A caret range does not follow a major, so "just release it" is not automatic.** A template stranded on an older major keeps installing that line forever, while any `@guren/*` package still on a minor line *is* followed — which is how one app ends up with two copies of the ORM, a runtime `database has not been configured` rather than a type error.
- **Template dependency versions are generated, never hand-edited.** `bun run sync:template-deps` writes the `@guren/*` ranges from the workspace versions and the drizzle pins from `packages/orm/package.json`; `version-packages` runs it right after `changeset version`, the first moment the new numbers exist. `audit:template-deps` asserts the same invariant in CI. Any release that moves a `@guren/*` version must also bump `create-guren-app`, or `changeset publish` ships no tarball carrying the new ranges — the sync script fails the release if that happens.

## Security Defaults

- **`X-Testing-User` header is gated behind `GUREN_TESTING` env var.** TestApp sets this automatically. Never trust this header in production.
- **MCP endpoint requires `GUREN_MCP=1` to mount.** Features that expand attack surface (debug endpoints, code generation APIs) must be opt-in, not opt-out. Security protections (CSRF, headers) are the opposite — enabled by default.
- **The MCP endpoint is CSRF-exempt and guards its own access.** MCP clients POST JSON-RPC without ever fetching an `XSRF-TOKEN`, so `createCsrfMiddleware` skips that one path while `isMcpEndpointEnabled()` holds. `createMcpAccessGuard()` replaces it and has to stop **two** classes of caller: browser pages (rejected unless the `Origin` is loopback) and non-browser clients (rejected unless the socket peer is loopback). The second half is not optional — templates bind `0.0.0.0`, `Host` is trivially forged so host authorization does not help, and a client that sends no `Origin` is otherwise indistinguishable from a local agent.
- **Rate limiting default key uses `server.requestIP()` (Bun only).** Falls back to shared per-route bucket with console warning. Docs tell users to supply custom `keyGenerator` in production.
- **CORS defaults to same-origin** (no `Access-Control-Allow-Origin` header). Users must explicitly set `origin: '*'` if needed.
- **Host authorization is dev-only** in templates (`process.env.NODE_ENV === 'production' ? false : { ... }`).

## Auth Middleware Ordering

- **Auth context resolves its session lazily** (at first guard use, not attach time), so `attachAuthContext()` may sit anywhere in the chain — including before session middleware. The session middleware only has to run before an auth *method* is called.
- **For apps without `options.auth`**, the fallback `attachAuthContext` is attached in the `Application` constructor, so `app.use(requireAuthenticated())` before `boot()` works (#13).
- **With `options.auth`**, `AuthServiceProvider.register()` mounts session middleware and attaches its own auth context as before.

## Template Dependencies

- **`drizzle-orm` and `drizzle-kit` in the templates are generated too, from `packages/orm/package.json`.** Bump the ORM's exact pin (under `dependencies`, not peerDeps) and run `bun run sync:template-deps`; `audit:template-deps` fails CI if you don't. The rule lives in `packages/cli/src/drizzle-pins.ts`, shared with `guren upgrade`, which applies the same alignment to an installed app. Templates pinning a different `drizzle-orm` than the ORM installs is how a scaffolded app gets two copies in one process.
- **The one drizzle case still left to a human:** `drizzle-kit` has no upstream declaration to follow, and the two packages have never shared numbers on their stable lines, so the sync checks the companion release exists on npm before writing it. When it doesn't — or when npm can't answer — both the sync and `guren upgrade` say so and leave the pin alone rather than failing; pick the matching `drizzle-kit` release yourself. The two refusals the sync *does* fail on are the ones fixable here: a template specifier naming a location (`workspace:*` and friends can never ship to npm) and a `packages/orm` that stopped pinning one exact `drizzle-orm` version, which silently switches the whole rule off.
- **API-only template has no Vite, React, or Inertia.** Force SPA mode in CLI (`blueprint === 'api'` → skip SSR).
- **Default template always calls `configureOrm()`** even without migrations (models need a DB connection).

## Dockerfile / Deployment

- **Use multi-stage builds.** Builder stage needs devDeps for Vite/TypeScript. Production stage uses `--production`.
- **Entrypoint is `bun bin/serve.ts`**, not `bun run start` (no `start` script exists in templates).
- **Copy runtime dirs explicitly**: `bin/`, `src/`, `app/`, `config/`, `routes/`, `public/`, `db/`, `.guren/`.

## Serverless Bundling (Vercel / Lambda)

- **`bun build` inlines `process.env.NODE_ENV` at bundle time** (defaults to `"development"`, regardless of minification). Runtime `NODE_ENV=production` cannot override it. Always pass `--define 'process.env.NODE_ENV="production"'` when bundling server entrypoints for deployment (`@guren/plugin-vercel` does this).
- **Never bundle app code with identifier mangling** — no bare `--minify`, no esbuild/oxc `minify: true`. Guren keys durable records on class names: the queue registry stores `JobClass.name` in every queued message, notifications persist `constructor.name` as their `type`, and `HttpException` reports `this.constructor.name`. Mangled, records written by one deploy stop resolving after the next. Use `--minify-whitespace --minify-syntax` (or `minify: { whitespace: true, syntax: true, identifiers: false }`). `--keep-names`/`keepNames` is **not** a substitute: as of Bun 1.3.14 it is accepted and silently leaves class names mangled.
- **SSR bundles must be self-contained on serverless.** Function directories ship without `node_modules`, so externalized `react`/`@inertiajs/react` imports fail at runtime and Inertia silently falls back to CSR. The Guren Vite plugin defaults `ssr.noExternal: true` for SSR builds — don't re-externalize deps in `.guren/ssr` unless the deploy target has them installed.

## ESM Compatibility

- **No `require()` in ESM packages.** Use top-level `import` or dynamic `import()`. Bun tolerates `require()` but Node ESM does not.
- **Keep `"type": "module"` and `format: ['esm']` in tsup config.**

## E2E Tests

- **E2E needs `NODE_ENV=production` for Vite assets but runs over HTTP.** Two CI-specific issues: (1) `VITE_DEV_SERVER_URL` in `.env` forces dev-mode asset serving even with production NODE_ENV — remove the line in CI setup. (2) Cookie `Secure` flag must be disabled when `CI` is set (see `examples/blog/src/app.ts`), otherwise Inertia XHR POSTs fail (CSRF/session cookies rejected over HTTP).
- **Use `storageState` for authenticated tests** — login once in setup, share session across all tests.
- **Avoid asserting specific post titles in lists** — pagination may push them off page 1.
- **Use `page.waitForLoadState('networkidle')` after Inertia navigations** in CI.
