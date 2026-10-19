# Testing: reference

The rule `__RULES_DIR__/testing.md` attaches when you edit `tests/**` and covers
`TestApp.fromApp()`, CSRF, the client, every assertion and the common mistakes.
This file holds the rest.

## Creating a TestApp

```typescript
import { TestApp } from '@guren/testing'

const http = await TestApp.create()             // boots a fresh Application
const http = await TestApp.create({ boot, providers, routes })  // all optional
const http = await TestApp.fromApp(app)         // wrap the app exported by src/app.ts
```

**Prefer wrapping the real app.** Scaffolded apps export the configured
application from `src/app.ts` — wrap it so tests exercise the app's actual
configuration (providers, auth, i18n, security defaults) instead of
reconstructing a subset that silently drifts:

```typescript
import app from '../src/app.js'

const http = await TestApp.fromApp(app)
```

`fromApp()` boots the app for you and binds its `fetch` to the instance.
It is `async` — `await` it. Calling it from several test files is fine:
`Application.boot()` is idempotent and reuses the first boot.

Keep `TestApp.create({ ... })` for isolated slices (a single route or
middleware under test).

`TestApp.fromFetch(fn)` — the only one of the three that is *not* async —
wraps an arbitrary fetch function, e.g. a bare Hono app:

```typescript
const hono = new Hono()
const http = TestApp.fromFetch((request) => hono.fetch(request))
```

Do not reach for it to wrap a Guren `Application`; use `fromApp()`. Hand-wiring
one is where the footgun lives: `Application.fetch` reads instance state, so
`fromFetch(app.fetch)` throws `undefined is not an object (evaluating
'this.hono')` at the first request. It has to be an arrow —
`fromFetch((request) => app.fetch(request))` — which is exactly what
`fromApp()` does for you.

All three set `GUREN_TESTING=1` so `actingAs()` header auth is accepted.

**Session + CSRF in tests.** `TestApp.create()` accepts `auth` just like `createApp({ auth: {} })`. Without it, session + CSRF middleware are **not** mounted — JSON requests (`app.json().post(...)`) pass with no CSRF check at all, which is fine for quick validation/auth-guard checks but not representative of production. To exercise real CSRF behavior (and for `withCsrf()` to work — it throws `"did not set an XSRF-TOKEN cookie"` otherwise):

```typescript
const app = await TestApp.create({
  auth: {},
  routes: registerWebRoutes,
})
const csrf = await app.withCsrf()
```

**Included in `create-app`-scaffolded apps' `devDependencies`** by default (`default`/`api` blueprints) — if it's missing (e.g. an older scaffold, or a project set up by hand), run `bun add -d @guren/testing`. The main entry does not require vitest; `useDatabaseTransactions()`/`useTruncateTables()` pick up bun:test's injected globals automatically — under vitest, `import '@guren/testing/vitest'` once in your setup file to register its hooks.

## Test database isolation (SQLite)

`bun test` sets `NODE_ENV=test` automatically. A current scaffold's `config/database.ts` branches on it so tests never touch the dev DB:

```typescript
filename: (context) => {
  const values = context?.env ?? env.parse(undefined, { mode: 'report' }).values
  return process.env.NODE_ENV === 'test'
    ? values.TEST_DATABASE_URL ?? './data/guren.test.db'
    : values.DATABASE_URL ?? './data/guren.db'
},
```

Default test file: `./data/guren.test.db`. Override with `TEST_DATABASE_URL` (e.g. per CI shard). If `config/database.ts` writes straight to `DATABASE_URL`/`./data/guren.db` with no `NODE_ENV` check (pre-1.2.0 scaffold), retrofit its `filename` to branch on `NODE_ENV` the same way. With `config/env.ts`, declare `DATABASE_URL` and `TEST_DATABASE_URL` there and read them from `values` as above: `guren/no-unvalidated-env-read` reports a `process.env.DATABASE_URL` read in `config/`. Without `config/env.ts`, read `process.env` and branch the same way.

**Cleanup between tests:** prefer `resetDatabase()` (exported from `config/database.ts`) in `beforeEach` — it operates on the same connection your models use, and drops every table then re-applies migrations, so the tables are queryable straight after (same end state as `guren db:reset`; an extra `migrateDatabase()` call is harmless but redundant). `useTruncateTables(tables)`/`useDatabaseTransactions()` from `@guren/testing` need a `DatabaseConnection` (`query`/`execute`/`beginTransaction`/`commit`/`rollback`) registered via `setTestDatabase()` — Guren's SQLite adapter doesn't expose one (`getDatabase()` resolves to the raw Drizzle instance, not this shape), so you'd have to hand-write an adapter. Only `useDatabaseTransactions()` requires that adapter to wrap the *same* connection your models write through (it begins/rolls back a transaction on it); `useTruncateTables()` just runs `DELETE FROM` per table, which commits immediately regardless of connection. `resetDatabase()` avoids the adapter question entirely.

## Generating test files

`bunx guren make:test <Name>` auto-detects the runner: explicit `--runner bun|vitest` wins,
otherwise it checks for a `vitest.config.*` file or a `vitest` dependency in `package.json`,
falling back to `bun:test`. Pass `--controller` for a controller test — it suffixes the class
name with `Controller` and writes to `tests/controllers/${ClassName}.test.ts`, matching where
`guren check` looks for it.
