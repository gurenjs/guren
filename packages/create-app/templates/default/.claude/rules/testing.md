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
