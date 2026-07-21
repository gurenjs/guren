---
description: Guren testing (@guren/testing) — TestApp client methods and the full assertion surface
globs:
  - "tests/**"
---

# Testing (@guren/testing + bun:test)

Requests run in-process through `app.fetch()` — no server, no port.

## Creating a TestApp

```typescript
import { TestApp } from '@guren/testing'

const app = await TestApp.create()             // boots the real Application
const app = await TestApp.create({ boot, providers, routes })  // all optional
const app = TestApp.fromFetch(app.fetch)       // wrap an existing fetch fn (not async)
```

Both set `GUREN_TESTING=1` so `actingAs()` header auth is accepted.

**Session + CSRF in tests.** `TestApp.create()` accepts `auth` just like `createApp({ auth: {} })`. Without it, session + CSRF middleware are **not** mounted — JSON requests (`app.json().post(...)`) pass with no CSRF check at all, which is fine for quick validation/auth-guard checks but not representative of production. To exercise real CSRF behavior (and for `withCsrf()` to work — it throws `"did not set an XSRF-TOKEN cookie"` otherwise):

```typescript
const app = await TestApp.create({
  auth: {},
  providers: [DatabaseProvider],
  routes: registerWebRoutes,
})
const csrf = await app.withCsrf()
```

**Included in `create-app`-scaffolded apps' `devDependencies`** by default (`default`/`api` blueprints) — if it's missing (e.g. an older scaffold, or a project set up by hand), run `bun add -d @guren/testing`. The main entry does not require vitest; `useDatabaseTransactions()`/`useTruncateTables()` pick up bun:test's injected globals automatically — under vitest, `import '@guren/testing/vitest'` once in your setup file to register its hooks.

## Test database isolation (SQLite)

`bun test` sets `NODE_ENV=test` automatically. A current scaffold's `config/database.ts` branches on it so tests never touch the dev DB:

```typescript
function resolveDatabaseFilename(): string {
  if (process.env.NODE_ENV === 'test') {
    return process.env.TEST_DATABASE_URL ?? './data/guren.test.db'
  }
  return process.env.DATABASE_URL ?? './data/guren.db'
}
```

Default test file: `./data/guren.test.db`. Override with `TEST_DATABASE_URL` (e.g. per CI shard). If `config/database.ts` writes straight to `DATABASE_URL`/`./data/guren.db` with no `NODE_ENV` check (pre-1.2.0 scaffold), retrofit it by adding the function above AND pointing `createSqliteDatabase({ filename: ... })` at it — replace `filename: () => process.env.DATABASE_URL ?? './data/guren.db'` with `filename: resolveDatabaseFilename`. Adding the function alone does nothing; `filename` still has to reference it.

**Cleanup between tests:** prefer `resetDatabase()`/`migrateDatabase()` (both exported from `config/database.ts`) in `beforeEach` — they operate on the same connection your models use. `useTruncateTables(tables)`/`useDatabaseTransactions()` from `@guren/testing` need a `DatabaseConnection` (`query`/`execute`/`beginTransaction`/`commit`/`rollback`) registered via `setTestDatabase()` — Guren's SQLite adapter doesn't expose one (`getDatabase()` resolves to the raw Drizzle instance, not this shape), so you'd have to hand-write an adapter. Only `useDatabaseTransactions()` requires that adapter to wrap the *same* connection your models write through (it begins/rolls back a transaction on it); `useTruncateTables()` just runs `DELETE FROM` per table, which commits immediately regardless of connection. `resetDatabase()`/`migrateDatabase()` avoids the adapter question entirely.

## Generating test files

`bunx guren make:test <Name>` auto-detects the runner: explicit `--runner bun|vitest` wins,
otherwise it checks for a `vitest.config.*` file or a `vitest` dependency in `package.json`,
falling back to `bun:test`. Pass `--controller` for a controller test — it suffixes the class
name with `Controller` and writes to `tests/controllers/${ClassName}.test.ts`, matching where
`guren check` looks for it.

## Client methods

```typescript
app.get(path)                 // → PendingTestResponse (awaitable AND chainable)
app.post(path, body?)         // body auto-JSON-encoded unless FormData
app.put(path, body?) / app.patch(path, body?) / app.delete(path, body?)

app.actingAs(user)            // returns a NEW TestApp with the user injected
app.json()                    // returns a NEW TestApp with Accept: application/json
app.withHeader(name, value) / app.withHeaders(record)   // also return new TestApp
const csrf = await app.withCsrf()   // primes session + XSRF cookies; use for mutating requests hitting CSRF
```

## Chainable assertions (on PendingTestResponse)

```typescript
await app.get('/posts').assertOk().assertJsonCount(3, 'data')
```

Exact list:
`assertStatus(code: number)` · `assertOk()` (200) · `assertCreated()` (201) ·
`assertNoContent()` (204) · `assertRedirect(url?: string)` (3xx, optional Location match) ·
`assertNotFound()` (404) · `assertForbidden()` (403) · `assertUnauthorized()` (401) ·
`assertUnprocessable()` (422) ·
`assertJson(expected: Record<string, unknown>)` (exact deep match) ·
`assertJsonCount(count: number, key?: string)` ·
`assertJsonStructure(keys: string[])` (top-level keys exist) ·
`assertJsonPath(path: string, value: unknown)` (dot-path, deep equal) ·
`assertInertia(component: string, props?: Record<string, unknown>)` ·
`assertCookie(name: string, value?: string)` · `assertCookieMissing(name: string)` ·
`assertHeader(name: string, value?: string)` · `assertHeaderMissing(name: string)`

## Awaited response (TestResponse)

Awaiting yields a `TestResponse` with extras not available on the chain:

```typescript
const res = await app.get('/posts')
res.status                          // number
res.headers                         // Headers
await res.text()                    // body string
await res.json<T>()                 // parsed body
res.assertBadRequest()              // 400
res.assertServerError()             // 500
res.assertSuccessful()              // any 2xx
await res.assertJsonContains({ k: v })   // partial top-level match
await res.assertBodyContains('text')
```

## Patterns

```typescript
import { describe, test, expect, beforeAll } from 'bun:test'

describe('PostController', () => {
  let app: TestApp
  beforeAll(async () => { app = await TestApp.create() })

  test('store validates input', async () => {
    await app.json().post('/posts', {}).assertUnprocessable()
  })

  test('store creates post for authed user', async () => {
    const csrf = await app.actingAs(user).withCsrf()
    await csrf.post('/posts', { title: 'Hi', body: '...' }).assertRedirect('/posts')
  })
})
```

Validation failures return 422 with `{ message, errors: Record<string, string[]> }` —
assert with `assertJsonPath('errors.title.0', 'Title is required')`.
