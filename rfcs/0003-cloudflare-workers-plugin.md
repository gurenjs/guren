# RFC: Cloudflare Workers Adapter (`@guren/plugin-cloudflare`)

**Author:** 7nohe
**Date:** 2026-07-24
**Status:** Accepted (2026-07-25 — the standard two-week discussion window
was shortened by the deciding maintainer for this solo-driven change; the
draft did receive one full external review cycle before acceptance)

## Problem

Guren applications can currently deploy to three targets: a long-running Bun
server, AWS Lambda (`@guren/server/lambda`), and Vercel
(`@guren/plugin-vercel`). Cloudflare Workers is not supported, which rules out
the Cloudflare stack entirely — including D1 (SQLite at the edge) and KV —
even though it offers one of the most generous free tiers available
(D1: 5 GB storage, 5 M row reads/day; Workers: 100 k requests/day) and fits
Guren's SQLite-first onboarding story.

The concrete motivating use case is the guren.dev blog: a Guren-built CMS on
`web/` where we want the database included in the same platform (D1) instead
of provisioning a separate managed Postgres. Nothing in the request path
fundamentally blocks this — the HTTP layer is Hono, and `Bun.*` usage in
`@guren/server` is confined to dev asset serving, auto-discovery, and
`ScryptHasher`, all of which are already optional or replaceable on the
Lambda/Vercel paths. What is missing is the adapter and platform glue:

1. **No Workers entrypoint.** Workers use module syntax
   (`export default { fetch(request, env, ctx) }`); Guren has no equivalent of
   `createLambdaHandler` / `createVercelHandler` for it.
2. **Bindings vs. boot lifecycle.** D1/KV are only reachable through the `env`
   object passed to `fetch`, but Guren boots once (`app.boot()` →
   `configureOrm()`) before any request exists. Vercel's module-scope
   `await app.boot()` cannot work on Workers.
3. **No D1 driver in `@guren/orm`.** Factories exist for postgres, mysql, and
   `bun:sqlite`; `drizzle-orm/d1` is unused.
4. **No serverless-friendly session store.** Only `MemorySessionStore` and
   `RedisSessionStore` exist today. This gap is not Workers-specific — the
   Lambda and Vercel guides currently say "use Redis" too, so any app that
   wants to stay portable across serverless targets has to provision Redis
   just for sessions.
5. **Password hashing.** `ScryptHasher` (`Bun.password`) is hard-wired as
   the default hasher (`AuthManager.ts:137`,
   `AuthenticatableModel.resolvePasswordHasher()`), with no automatic
   fallback. Separately, the Workers Free plan's 10 ms CPU budget cannot fit
   any credible password hash (see §4).
6. **No build/deploy pipeline.** `buildVercelOutput()` has no Cloudflare
   counterpart (worker bundle, static assets, wrangler configuration).

## Proposed Solution

A new workspace package `packages/plugin-cloudflare` (`@guren/plugin-cloudflare`),
following the `@guren/plugin-vercel` precedent, plus additive pieces in
`@guren/orm` (the D1 factory, §2), `@guren/core` (database-backed session
and OAuth-state stores, §3/§4), and `@guren/server` (the SSR renderer
setter, §5 — Workers has no filesystem for `GUREN_INERTIA_SSR_ENTRY`'s
dynamic import, unlike Vercel). Everything is additive; no existing API
changes.

### 1. Workers handler

The worker entry is **generated** by `guren cloudflare:build` (§5) — app
authors do not hand-write it. The canonical user-owned module stays
`src/app.ts` (the `Application` instance), the same as every other deploy
target, so there is exactly one `createWorkersHandler` call site:

```ts
// .cloudflare/worker.js (generated — full version in §5)
import { createWorkersHandler } from '@guren/plugin-cloudflare'
import app from '../src/app.js'

export default createWorkersHandler(app)
```

```ts
export interface WorkersAppLike {
  boot(): Promise<void>
  fetch(
    request: Request,
    env?: unknown,
    executionCtx?: ExecutionContext,
  ): Response | Promise<Response>
}

export function createWorkersHandler(app: WorkersAppLike): {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response>
}
```

`Application.fetch` already has exactly this shape — it forwards
`(request, env, executionCtx)` straight to `hono.fetch`
(`packages/server/src/http/Application.ts:391`) — so each request's own
`env` and `ExecutionContext` (`waitUntil` etc.) must be passed through,
reaching Hono middleware and controllers as `c.env` / `c.executionCtx`.
The handler never swallows them.

Boot semantics: on the first request, the handler captures that request's
`env` in a **write-once** module-scoped holder (later requests never
overwrite it), awaits a deduplicated `app.boot()` promise, then delegates
to `app.fetch(request, env, ctx)`. Concurrent first requests share the boot
promise; a failed boot clears both the promise and the holder so the next
request retries cleanly.

Boot is lazy because `boot()` performs I/O (ORM configuration against D1),
which workerd disallows in global scope — not because bindings are
invisible there. workerd does expose module-scope bindings via
`import { env } from 'cloudflare:workers'`, but importing that module from
shared application code would break every other runtime (Bun dev, Lambda,
Vercel); the holder keeps `config/*.ts` portable.

For boot-time code, bindings are exposed through an accessor —
request-path code should prefer `c.env` from the Hono context instead:

```ts
import { getWorkersEnv } from '@guren/plugin-cloudflare'

interface Env {
  DB: D1Database
}

const env = getWorkersEnv<Env>() // throws before the first request
```

This mirrors how `config/database.ts` already defers connection resolution
behind a closure (`connectionString: () => process.env.DATABASE_URL`), so the
same deferral pattern works for bindings.

### 2. `createD1Database` in `@guren/orm`

A fourth factory alongside `postgres.ts` / `mysql.ts` / `sqlite.ts`, with the
same returned surface:

```ts
// config/database.ts
import { createD1Database } from '@guren/orm'
import { getWorkersEnv } from '@guren/plugin-cloudflare'

const database = createD1Database({
  binding: () => getWorkersEnv<Env>().DB,
  migrationsFolder: new URL('../db/migrations', import.meta.url),
})

export const { getDatabase, configureOrm, closeDatabase } = database
```

Implementation uses `drizzle-orm/d1` and feeds the resulting drizzle instance
to `DrizzleAdapter.configure()` exactly as the other factories do. D1 speaks
the SQLite dialect, so existing `db/schema.ts` written for
`createSqliteDatabase` ports unchanged.

Differences from the other factories:

- **`migrateDatabase()` does not run migrations at runtime.** Migrations are
  applied out-of-band with `wrangler d1 migrations apply <db>` using the same
  drizzle-kit-generated SQL files. Running migrations on cold start is both
  slow and unsafe under concurrent isolates. `migrateDatabase()` throws with
  a message pointing at the wrangler command. (See Open Questions for the
  runtime-migrator alternative.)
- **`closeDatabase()` is a no-op** — D1 sessions have no connection to close.
- **`seedDatabase()` throws.** The existing seeder machinery reads seeder
  files from disk (`orm/src/seeder.ts`), and a Worker has no filesystem —
  `wrangler dev` storing local D1 data in SQLite does not give the Worker
  fs access. Seeding is an explicit CLI workflow: generate SQL, apply with
  `wrangler d1 execute`.
- **`migrationStatus()` / `resetDatabase()` defer to wrangler.** Wrangler
  maintains its own applied-migrations tracker, which is authoritative for
  D1; v1 of these methods throws with a pointer to
  `wrangler d1 migrations list`. The drizzle-kit SQL format contract
  (filename ordering, statement-breakpoint handling) gets an end-to-end
  generated-migration test in Part 2.

### 3. `DatabaseSessionStore` — a runtime-agnostic database session store

An earlier draft of this RFC proposed a KV-backed store. That is rejected:
Workers KV is [eventually consistent](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
— a write is not guaranteed to be promptly visible even in the location that
performed it, and each key is limited to one write per second. A session
store with those semantics breaks the most common auth flow there is
(login → write session → redirect → read session). See Alternatives.

Instead, sessions go in the database the app already has: a
`DatabaseSessionStore` in `@guren/core`, backed by whatever connection
`configureOrm()` established — D1 on Workers, and equally Postgres on
Lambda/Vercel or SQLite on a Bun server. `@guren/core` is the established
home for exactly this kind of cross-package glue: `DatabaseApiTokenStore`
(`packages/core/src/api-token-store.ts`) already imports the real
`ApiTokenStore` contract from `@guren/server`, wraps the table in an
internal `@guren/orm` `Model` subclass, and is labeled as cross-package
glue in core's index. `DatabaseSessionStore` follows that pattern
verbatim — implementing the real `SessionStore` interface (no
structural-typing games) and staying dialect-agnostic by going through the
Model/QueryBuilder API rather than any drizzle dialect type.

```ts
// db/schema.ts — SQLite/D1 variant. The scaffold emits the
// dialect-appropriate table for the other factories (pgTable/mysqlTable,
// with timestamp/bigint expiry); the store itself never touches dialect
// types. Each claimed dialect gets a compile-time + integration test.
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  data: text('data').notNull(),          // JSON-serialized SessionData
  expiresAt: integer('expires_at').notNull(),
})
```

```ts
import { DatabaseSessionStore } from '@guren/core'
import { sessions } from '@/db/schema'

app.use(createSessionMiddleware({
  store: new DatabaseSessionStore(sessions),
}))
```

`read` treats expired rows as missing (and deletes them opportunistically);
a `sessions:prune` console command handles bulk cleanup.

**This deliberately solves more than Workers.** The same store removes the
"Redis required" caveat from the Lambda and Vercel guides: those apps
already have a database, and portability across serverless targets (a
stated goal — the blog should be able to move to Lambda later) falls out of
keeping the store driver-agnostic instead of writing a D1-only or KV-only
one.

**Session write volume is a hard prerequisite, not a checkpoint.** Code
review of `session.ts` confirms the current middleware writes on
essentially every request: `shouldPersist()` returns true for every new
session (`dirty || isNew`), `ageFlashData()` unconditionally marks every
loaded session dirty at request start, and the default auth wiring mounts
CSRF globally, which generates a token — and therefore a persisted session
— for anonymous GETs. On D1's free tier (100 k row writes/day) that turns
every page view into a database write. Part 3 therefore includes: empty
guest sessions are not persisted; flash aging only dirties sessions that
actually carried flash data; CSRF state is created lazily; and write-count
regression tests for anonymous GET, authenticated GET, flash aging, and
rotation.

### 4. Password hashing

Resolved by verification against Cloudflare's documentation — workerd's
`nodejs_compat` implements
[all `node:crypto` APIs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)
(the only exceptions are DSA/DH key generation, ed448/x448, and FIPS mode).
Every crypto call Guren makes on the request path — `scrypt`, `hkdfSync`,
`createHmac`, `timingSafeEqual`, `randomBytes`, AES-GCM/CBC — is supported,
so `NodeHasher` runs unmodified and no `PBKDF2Hasher` is needed.

What does **not** work is the CPU budget on the Free plan:
[10 ms CPU per request](https://developers.cloudflare.com/workers/platform/limits/).
Any credible password hash (scrypt, bcrypt, argon2, PBKDF2 at OWASP
parameters) deliberately burns tens to hundreds of milliseconds of CPU;
switching algorithms cannot fix an arithmetic impossibility. Consequences,
to be documented prominently:

- **Free plan: password authentication is effectively unsupported.** The
  documented path is OAuth login (`make:auth --oauth`) — a redirect flow
  costs negligible CPU and session HMAC verification is microseconds. This
  is what the guren.dev blog will use (single admin, GitHub OAuth).
- **Paid plan (currently $5/mo; 30 s CPU default, configurable up to
  5 min):** `NodeHasher` works with ample margin; document it as the
  requirement for password-based auth on Workers.

The adapter docs must also instruct swapping the default hasher: because
`ScryptHasher` (`Bun.password`) is hard-wired as the default
(`AuthManager.ts:137`), Workers apps set `hasher: new NodeHasher()`
explicitly — the same guidance the Lambda docs already give.

Two verified gaps make "OAuth on Free" more than a documentation stance;
both are in scope (Part 3):

- **The OAuth scaffold currently hashes a synthetic password.** OAuth user
  creation generates a random password so the account "satisfies
  AuthenticatableModel's hashing pipeline" (`make-auth.ts`), and
  `resolvePasswordHasher()` defaults to `ScryptHasher`
  (`AuthenticatableModel.ts`) — and on Free even one scrypt hash at signup
  blows the CPU budget regardless of hasher. The scaffold needs a genuine
  passwordless mode for OAuth-only apps: nullable password hash, no
  synthetic-password hashing, password routes disabled. (`static
  passwordHasher` is already configurable per model, but on Free the fix
  is to not hash at all.)
- **The default OAuth state store is isolate-local memory.** `OAuthManager`
  falls back to `MemoryOAuthStateStore` (`auth/oauth/index.ts`); on Workers
  the redirect and callback are not guaranteed to hit the same isolate, so
  state validation randomly fails. The Workers guide must configure a
  `DatabaseOAuthStateStore` (same `@guren/core` pattern as §3) or an
  HMAC-signed self-contained state parameter with replay protection.

### 5. Build & deploy pipeline

The plugin declares a CLI command via the `gurenPlugin.commands` manifest
field (per the plugin contract):

```jsonc
"gurenPlugin": {
  "compatibility": ">=1.0.0 <2.0.0",
  "commands": { "entry": "./dist/commands.js", "names": ["cloudflare:build"] }
}
```

`guren cloudflare:build`:

1. Runs codegen, then the standard Vite client + SSR builds. Codegen is
   invoked through the installed CLI entry directly (not `bunx guren`) so a
   clean checkout and CI both work — the Vite route-types plugin
   intentionally skips generation when `process.env.CI` is set.
2. Emits `.cloudflare/worker.js`, a generated wrapper that statically
   imports the app instance (`src/app.ts`) and the built SSR entry —
   resolved from `.guren/ssr/.vite/manifest.json`, the same lookup
   `buildVercelOutput` performs, never a hardcoded filename — registers the
   SSR renderer via `setInertiaSsrRenderer()`, and exports the handler from
   the single `createWorkersHandler(app)` call site (§1). The build fails
   if the SSR manifest entry or its `render` export is missing. See below
   for why this differs from Vercel's approach.
3. Copies `public/` + Vite client output into `.cloudflare/assets/`.
4. Scaffolds `wrangler.jsonc` on first run (never overwrites):

```jsonc
{
  "name": "my-app",
  "main": ".cloudflare/worker.js",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": ".cloudflare/assets" },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "my-app",
    "database_id": "...",
    "migrations_dir": "db/migrations"
  }],
  "vars": { "NODE_ENV": "production" }
}
```

`migrations_dir` points wrangler at the same drizzle-kit-generated SQL files
described in §2 (`db/migrations`) instead of wrangler's default `migrations/`
directory, so `wrangler d1 migrations apply <db>` finds them without the app
author having to duplicate or relocate anything.

Bundling is delegated to wrangler's esbuild — unlike the Vercel path there is
no `bun build` step, which sidesteps the `NODE_ENV` inlining pitfall (the
value comes from `vars` at runtime instead; `nodejs_compat` populates
`process.env` from vars by default for compatibility dates ≥ 2025-04-01,
which the scaffold's `compatibility_date` satisfies).
Deploy is plain `wrangler deploy`; static assets are served by Workers Static
Assets before the worker runs, mirroring Vercel's filesystem-first routing.

**SSR wiring differs from Vercel and needs its own path.** Vercel's plugin
(`packages/plugin-vercel/src/index.ts`) copies `.guren/ssr/` alongside the
deployed function and points `GUREN_INERTIA_SSR_ENTRY` at the copied file;
`InertiaEngine` then resolves it with a runtime `import(normalized)` — see
`packages/server/src/mvc/inertia/InertiaEngine.ts`'s `loadSsrRenderer`. That
works because Vercel Functions ship with a real filesystem. Workers have
none: `wrangler deploy` bundles exactly one `main` entry, and a dynamic
`import()` of a path that isn't part of that bundle fails at runtime (no
`.guren/ssr/` directory exists to import from), silently falling back to
client-side rendering — the exact failure `InertiaEngine`'s catch block
swallows today.

`InertiaEngine` does support supplying the render function directly
(`InertiaSsrOptions.render`, checked before `entry`/`GUREN_INERTIA_SSR_ENTRY`
— see `InertiaEngine.ts` line 209), which is exactly what avoids the dynamic
import. The catch: `render` is read from the `InertiaOptions` passed to each
individual `inertia()` call, and `Controller.inertia()` (`Controller.ts`
line 324) never populates `ssr` unless an app author passes it explicitly on
every single `this.inertia(...)` call site — impractical to require, and not
how `GUREN_INERTIA_SSR_ENTRY` behaves today (it's a one-time, process-wide
default). There is currently no process-wide *function* equivalent — only
the process-wide *path* (`GUREN_INERTIA_SSR_ENTRY`, string, dynamically
imported).

So this RFC needs one small, additive change in `@guren/server` alongside
the plugin: a module-scope setter mirroring the existing
`setMailManager()` (`packages/server/src/mail/Mail.ts`) /
`setQueueDriver()` (`packages/server/src/queue/Job.ts`) convention —

```ts
// packages/server/src/mvc/inertia/InertiaEngine.ts (additive export)
let defaultSsrRenderer: InertiaSsrRenderer | undefined

export function setInertiaSsrRenderer(renderer: InertiaSsrRenderer): void {
  defaultSsrRenderer = renderer
}
```

— consulted by `renderInertiaSsr` before falling back to
`ssrOptions?.entry ?? process.env.GUREN_INERTIA_SSR_ENTRY`:
`ssrOptions?.render ?? defaultSsrRenderer ?? (await loadSsrRenderer(...))`.
This is backwards compatible (Bun/Lambda/Vercel keep working unchanged via
`GUREN_INERTIA_SSR_ENTRY`) and gives Workers a way to register a real
function reference once, at module scope, instead of a path:

```ts
// .cloudflare/worker.js (generated by `guren cloudflare:build`)
import { createWorkersHandler } from '@guren/plugin-cloudflare'
import { setInertiaSsrRenderer } from '@guren/server'
// import path resolved from .guren/ssr/.vite/manifest.json at build time
import { render as ssrRender } from '../.guren/ssr/assets/entry-server-Ck2h.js'
import app from '../src/app.js'

setInertiaSsrRenderer(ssrRender)

export default createWorkersHandler(app)
```

Because `ssrRender` is a static `import`, wrangler's esbuild inlines the SSR
renderer into the single worker bundle at build time instead of dynamically
resolving a path — the same `ssr.noExternal: true` Vite setting Vercel
relies on (already the Guren Vite plugin default) ensures that bundle has no
external runtime dependencies to resolve. `createWorkersHandler`'s own
signature is unchanged; the wiring happens once at worker module scope,
before the first `fetch`. The setter accepts `undefined` to clear (for test
isolation), and per-call `ssrOptions.render` remains the highest-priority
override. This `setInertiaSsrRenderer` addition is tracked as part of
Part 1's implementation.

### 6. Workers runtime support matrix

A full request-path audit of `@guren/server`, `@guren/orm`, and
`@guren/inertia-client` against workerd's `nodejs_compat` produced the
following. This matrix ships in the plugin docs — Workers is a supported
*deploy target*, not a claim of full feature parity.

**Works unchanged:**

- HTTP kernel, routing, controllers, validation — `Application.fetch()`
  already has the workerd signature (`hono.fetch(request, env, ctx)`).
- All request-path crypto: session cookie signing (`createHmac` /
  `timingSafeEqual`), `Encrypter` (AES-GCM/CBC), `MessageSigner`, app-key
  derivation (`hkdfSync`), token utils, `NodeHasher` (Paid plan; §4).
- `process.env` reads — request-path reads are function-scoped, matching
  workerd's env-population model (`nodejs_compat_populate_process_env`) —
  with two module-scope exceptions to verify under workerd: the
  `DEFAULT_COOKIE_SECURE` constants in `session.ts` and `csrf.ts` read
  `NODE_ENV` at module evaluation. If module-scope population proves
  unreliable there, move those defaults into middleware construction.
- `@guren/inertia-client` SSR (`renderToString`) — no fs/Bun dependencies.
- `MemoryStore` cache — correctness holds (expiry is checked on read); its
  cleanup timer never fires outside a request context, so memory is bounded
  only by isolate lifetime. Acceptable; documented.

**Works via this RFC's replacements:**

- Database → `createD1Database` (§2)
- Sessions → `DatabaseSessionStore` (§3)
- Password hashing → `NodeHasher` swap + OAuth-on-Free guidance (§4)
- Inertia SSR loading → `setInertiaSsrRenderer` static wiring (§5)
- Static assets (`Bun.file` paths) → Workers Static Assets (§5)

**Unsupported on Workers (documented, error early where possible):**

- `ScryptHasher` (`Bun.password`), `createSqliteDatabase` (`bun:sqlite`),
  `AutoDiscovery` (`Bun.Glob` + runtime import of source files)
- Filesystem-backed drivers: storage `LocalDriver`, cache `FileStore`,
  logging `FileChannel`/`DailyFileChannel` (use console/external), i18n
  `JsonLoader` (build-time bundling is future work)
- `S3Driver.putFile(localPath)` (reads local fs) — `put(buffer)` works, the
  driver is otherwise fetch-based
- Long-lived processes: `Scheduler.start()`, queue `Worker`, WebSocket
  broadcasting — see below (future adapters map to Cron Triggers / Queues /
  Durable Objects)

### 7. Explicitly out of scope (future RFCs)

- **Queues adapter** (Cloudflare Queues ↔ `createSqsHandler` equivalent)
- **Cron Triggers** (↔ `createScheduleHandler` equivalent — the module worker
  shape already reserves the `scheduled` export for this)
- **Cache store** on Cache API / KV
- **R2 storage driver**
- Auto-discovery on Workers (providers must be listed explicitly in
  `createApp()`, same as the documented Lambda constraint)

### Implementation plan

Split into reviewable parts, referencing this RFC:

1. **Part 1** — `packages/plugin-cloudflare`: `createWorkersHandler`,
   `getWorkersEnv`, `cloudflare:build` (including the generated
   `.cloudflare/worker.js` wrapper and `migrations_dir` in the wrangler
   scaffold), docs; plus the additive `setInertiaSsrRenderer` export in
   `@guren/server` (§5) it depends on. Includes a Workers test adapter —
   a `TestApp` variant that supplies a fake `env`/`ExecutionContext` and
   exercises the lazy-boot lifecycle (dedupe, failure-retry, env
   write-once); the existing `TestApp.create()` boots eagerly and
   `fromFetch()` models a one-argument fetch, so neither covers it.
2. **Part 2** — `@guren/orm`: `createD1Database`, the D1 method-surface
   semantics from §2, an end-to-end generated-migration test against
   wrangler, and migration/seed workflow docs.
3. **Part 3** — `DatabaseSessionStore` in `@guren/core` (+ per-dialect
   `sessions` scaffold, `sessions:prune`), the session write-volume fixes
   and write-count tests (§3), the OAuth gaps (§4: passwordless OAuth
   accounts, `DatabaseOAuthStateStore` or signed state), and the hasher
   documentation. Includes updating the Lambda/Vercel guides to recommend
   the database store over Redis for simple apps.
4. **Part 4** — dogfooding: guren.dev blog module on Workers + D1 (separate
   app-level work, validates the whole stack end-to-end), plus
   Miniflare/`wrangler dev` integration coverage: local D1 migrations,
   OAuth redirect/callback across isolates, SSR rendering from the built
   worker.

## Alternatives Considered

- **Vercel + Neon Postgres for the blog, no new plugin.** Cheapest path to
  ship the blog, but leaves the database on a second provider and adds a
  migration later if we ever consolidate on Cloudflare. Rejected in favor of
  building the adapter first; the blog doubles as the dogfooding vehicle.
- **D1 over its HTTP REST API from other hosts.** The REST API is a
  Cloudflare admin API with admin-level rate limits, not a data plane for
  application traffic. Not viable.
- **Hyperdrive + external Postgres on Workers.** Works, but reintroduces the
  separate database provider that D1 avoids, and still requires everything in
  this RFC except `createD1Database`.
- **Runtime migrations via `drizzle-orm/d1` migrator.** Convenient for toy
  apps but unsafe under concurrent isolate cold starts and slow on the hot
  path. Wrangler-applied migrations keep parity with how D1 is operated
  everywhere else.
- **KV-backed session store.** The original draft. Rejected on verified
  semantics: KV is eventually consistent (a write is not guaranteed to be
  promptly readable anywhere, including the writing location) and capped at
  one write per second per key — both break login flows. KV remains a good
  candidate for the future *cache* store, where staleness is acceptable.
- **Durable Objects session store.** Strongly consistent and
  Workers-native, but introduces a second storage primitive, more moving
  parts in `wrangler.jsonc`, and a Cloudflare-only implementation. The
  database store is simpler, has no extra infrastructure, and is portable to
  Lambda/Vercel/Bun. Revisit only if D1 session latency proves problematic.
- **Placing the session store in `@guren/server` or `@guren/orm`.** The
  server package must not depend on the ORM, and an ORM-side store could
  only satisfy the `SessionStore` contract structurally — fragile against
  contract drift. `@guren/core` already hosts `DatabaseApiTokenStore` for
  exactly this reason; the session store sits next to it.

## Migration Path

Purely additive — no existing API changes, no breaking changes. Existing
Bun/Lambda/Vercel deployments are unaffected.

## Open Questions

1. ~~Does workerd's `nodejs_compat` `node:crypto` support `scrypt`?~~
   **Resolved during drafting:** yes — all `node:crypto` APIs are
   implemented (see §4). The open issue moved to CPU budget, answered in §4
   (OAuth on Free, `NodeHasher` on Paid).
2. **Local dev story.** Two candidate workflows: (a) `bun run dev` with
   `createSqliteDatabase` on a local file (fast HMR, but doesn't exercise the
   Workers runtime), (b) `wrangler dev` with local D1 (faithful, but slower
   and needs the built worker). Proposal: support (a) as the default via a
   runtime switch in `config/database.ts`, document (b) as the pre-deploy
   check. Needs validation in Part 4.
3. ~~Worker size limits — measure whether the SSR bundle fits in 3 MB.~~
   **Resolved during drafting** with a bundle probe of the real `web/` app
   (app + `@guren/server` + Hono + ORM + `react-dom/server`, minified):
   **1.10 MB gzipped** — comfortable against the Free plan's 3 MB cap.
   The full `web/` build including shiki's default bundle (every grammar
   and theme) measures 2.74 MB gzipped — technically under the cap but
   with no headroom, so shiki must not ship in the worker as the full
   bundle. For the blog this resolves cleanly: highlight at write time
   (store rendered HTML in D1, keeping shiki out of the worker entirely)
   or use `shiki/core` with only the needed grammars. CSR-only Inertia
   remains the documented fallback for apps that outgrow the cap.
4. **`getWorkersEnv` vs. container-based injection.** A module-level accessor
   is simple and mirrors `process.env` ergonomics, but a service-container
   binding would be more testable. Leaning accessor-first with a container
   binding added if real usage demands it.
