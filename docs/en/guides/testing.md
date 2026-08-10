# Testing

A single well-written test catches bugs before your users do. Guren makes testing so convenient that writing tests feels faster than manually checking things in a browser.

## TestApp

`TestApp` is the centerpiece of Guren's testing story. It boots a lightweight instance of your application with the full middleware and routing stack, then lets you make requests and assert on responses with a fluent API:

```ts
import { describe, test, beforeAll } from 'bun:test'
import { TestApp } from '@guren/testing'

describe('Posts', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await TestApp.create()
  })

  test('lists all posts', async () => {
    await app.get('/posts').assertOk()
  })

  test('creates a post', async () => {
    await app
      .post('/posts', { title: 'Hello', content: 'World' })
      .assertStatus(201)
      .assertJsonPath('post.title', 'Hello')
  })

  test('returns 404 for missing post', async () => {
    await app.get('/posts/999').assertNotFound()
  })
})
```

All standard HTTP methods are available:

```ts
await app.get('/posts')
await app.post('/posts', body)
await app.put('/posts/1', body)
await app.patch('/posts/1', body)
await app.delete('/posts/1')
```

### Wrapping the real application

`TestApp.create({ ... })` assembles an app from the parts you pass — good for isolated slices, but the subset can silently drift from what the server actually runs (providers, `auth`, `i18n`, security defaults). For tests that should exercise the real configuration, boot the app your project exports and wrap its fetch handler:

```ts
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

let http: TestApp

beforeAll(async () => {
  await app.boot()
  http = TestApp.fromFetch((request) => app.fetch(request))
})

test('serves the home page', async () => {
  await http.get('/').assertOk()
})
```

This is the pattern scaffolded apps ship with. Pass `app.fetch` through an arrow function — the method reads instance state, so handing the unbound reference over throws on the first request.

When you do assemble an app from parts, `TestApp.create()` mirrors `createApp`'s options: pass `auth` to mount session + CSRF middleware, and `i18n` when controllers under test use `this.t()` / `this.tc()`:

```ts
const app = await TestApp.create({
  routes: registerWebRoutes,
  i18n: { supported: ['en'] },
})
```

### Fluent Assertions

Chain assertions directly on the response:

```ts
// Status
await app.get('/posts').assertOk()                         // 200
await app.get('/posts').assertStatus(200)
await app.post('/posts', data).assertStatus(201)
await app.delete('/posts/1').assertNoContent()              // 204
await app.get('/secret').assertUnauthorized()                // 401
await app.get('/secret').assertForbidden()                   // 403
await app.get('/missing').assertNotFound()                   // 404

// JSON
await app.get('/posts').assertJson({ data: [] })
await app.get('/posts').assertJsonCount(5, 'data')
await app.get('/posts/1').assertJsonPath('post.title', 'Hello')
await app.get('/posts').assertJsonStructure(['data', 'meta'])

// Headers and redirects
await app.get('/posts').assertHeader('content-type', 'application/json')
await app.get('/old-page').assertRedirect('/new-page')
```

## Authentication in Tests

Use `actingAs()` to simulate an authenticated user without touching session or token logic:

```ts
import { User } from '@/app/Models/User'

const user = await User.create({
  email: 'test@example.com',
  name: 'Test User',
})

// Authenticated requests
await app.actingAs(user).get('/dashboard').assertOk()
await app.actingAs(user).post('/posts', data).assertStatus(201)

// Without auth, protected routes reject
await app.get('/dashboard').assertUnauthorized()
```

## Testing JSON APIs

For API endpoints, use `.json()` to set the appropriate headers and get JSON-focused assertions:

```ts
test('API returns paginated posts', async () => {
  await app.json().get('/api/posts')
    .assertOk()
    .assertJsonStructure(['data', 'meta'])
    .assertJsonCount(10, 'data')
    .assertJsonPath('meta.currentPage', 1)
})

test('API validates input', async () => {
  await app.json().post('/api/posts', { title: '' })
    .assertStatus(422)
    .assertJsonPath('errors.title.0', 'The title field is required.')
})
```

## Custom Request Headers

Use `withHeaders()` / `withHeader()` to send headers on every request — handy
for locale detection, API versioning, or bearer tokens. Like `actingAs()` and
`json()`, they return a new `TestApp`, so variants compose freely:

```ts
test('renders the English locale', async () => {
  const en = app.withHeaders({ 'Accept-Language': 'en' })
  await en.get('/').assertOk()
})

test('accepts an API token', async () => {
  await app
    .withHeader('Authorization', `Bearer ${token}`)
    .json()
    .get('/api/me/tasks')
    .assertOk()
})
```

## Database in Tests

### Test Database Isolation

`bun test` sets `NODE_ENV=test` automatically. A fresh scaffold's `config/database.ts` uses that to keep tests off your development database entirely:

```ts
// config/database.ts
function resolveDatabaseFilename(): string {
  if (process.env.NODE_ENV === 'test') {
    return process.env.TEST_DATABASE_URL ?? './data/guren.test.db'
  }
  return process.env.DATABASE_URL ?? './data/guren.db'
}
```

Tests read and write `./data/guren.test.db` by default — a separate file from `./data/guren.db`, so nothing a test creates ever leaks into the data you're looking at in the dev server. Override the test file itself with `TEST_DATABASE_URL` (for example, to give each parallel CI shard its own file); `DATABASE_URL` stays authoritative for every other environment.

> [!WARNING]
> Scaffolds created before this branch existed write straight to `DATABASE_URL` (or `./data/guren.db`) regardless of `NODE_ENV`, so `bun test` pollutes the same database your dev server reads from. Retrofit it by replacing the `filename` option, not just adding the helper — the helper alone does nothing until `createSqliteDatabase()` is actually pointed at it:
>
> ```diff
>  import { createSqliteDatabase } from '@guren/orm'
>
> +function resolveDatabaseFilename(): string {
> +  if (process.env.NODE_ENV === 'test') {
> +    return process.env.TEST_DATABASE_URL ?? './data/guren.test.db'
> +  }
> +  return process.env.DATABASE_URL ?? './data/guren.db'
> +}
> +
>  const database = createSqliteDatabase({
>    migrationsFolder: new URL('../db/migrations', import.meta.url),
>    seedersFolder: new URL('../db/seeders', import.meta.url),
> -  filename: () => process.env.DATABASE_URL ?? './data/guren.db',
> +  filename: resolveDatabaseFilename,
>  })
> ```

### Cleaning Up Between Tests

For most suites, the separate test-database file is isolation enough — reset it back to a clean slate in `beforeEach` using the `resetDatabase()`/`migrateDatabase()` helpers your `config/database.ts` already exports:

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { resetDatabase, migrateDatabase } from '@/config/database'

describe('User Model', () => {
  beforeEach(async () => {
    await resetDatabase()   // drops every table
    await migrateDatabase() // re-applies migrations from scratch
  })

  test('creates a user', async () => {
    const user = await User.create({
      email: 'test@example.com',
      name: 'Test User',
    })

    expect(user.id).toBeDefined()
    expect(user.email).toBe('test@example.com')
  })
})
```

`@guren/testing` also ships `useTruncateTables(tables)` and `useDatabaseTransactions()` for finer-grained, per-test cleanup. `useTruncateTables()` registers a `beforeEach` hook that deletes each table's rows; `useDatabaseTransactions()` registers `beforeEach`/`afterEach` hooks that begin a transaction and roll it back after the test. Both operate on a connection you register up front with `setTestDatabase()`, matching this shape:

```ts
interface DatabaseConnection {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<void>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
}
```

Guren's SQLite adapter doesn't hand you a ready-made `DatabaseConnection` — `getDatabase()` from `config/database.ts` resolves to the underlying Drizzle instance, not this interface — so using these helpers means writing a small adapter yourself and passing it to `setTestDatabase()` before your tests run. `useDatabaseTransactions()` specifically **must wrap the same connection your models write through**: it begins a transaction on `beforeEach` and rolls it back on `afterEach`, and a second, independently-opened connection to the same file won't see (or roll back) writes made via the first one. `useTruncateTables()` has no such requirement — a `DELETE FROM` on any connection to the same database file removes the rows your models see, since it commits immediately rather than participating in a shared transaction. If the adapter plumbing sounds like more than your suite needs, the `resetDatabase()`/`migrateDatabase()` pattern above is simpler and sidesteps the whole question.

## Faking Services

Real tests should not send actual emails, dispatch real events, or push jobs to a queue. Replace services with fakes using the container:

```ts
import { TestApp, FakeEvent, FakeMail, FakeQueue } from '@guren/testing'

const app = await TestApp.create()

// Swap real services for fakes
const fakeEvents = new FakeEvent()
const fakeMail = new FakeMail()
const fakeQueue = new FakeQueue()
app.container.fake('events', fakeEvents)
app.container.fake('mail', fakeMail)
app.container.fake('queue', fakeQueue)
```

Then assert on what happened:

```ts
test('registration sends welcome email and dispatches event', async () => {
  await app.post('/register', {
    email: 'new@example.com',
    name: 'New User',
    password: 'secret123',
  }).assertStatus(201)

  fakeEvents.assertDispatched(UserRegistered)
  fakeMail.assertSentTo('new@example.com')
  fakeQueue.assertPushed(SendWelcomeEmailJob)
})

test('does not send email for invalid registration', async () => {
  await app.post('/register', { email: '' }).assertStatus(422)

  fakeMail.assertNothingSent()
  fakeEvents.assertNotDispatched(UserRegistered)
})
```

### Available Fake Assertions

**FakeMail:**

| Method | Description |
|--------|-------------|
| `assertSent(mailable)` | A mailable was sent |
| `assertSentTo(email)` | Email was sent to address |
| `assertSentWith(mailable, data)` | Mailable sent with specific data |
| `assertNotSent(mailable)` | A mailable was not sent |
| `assertNothingSent()` | No emails sent at all |

**FakeEvent:**

| Method | Description |
|--------|-------------|
| `assertDispatched(event)` | An event was dispatched |
| `assertDispatchedWith(event, data)` | Event dispatched with specific data |
| `assertDispatchedInOrder(events)` | Events dispatched in order |
| `assertNotDispatched(event)` | An event was not dispatched |
| `assertNothingDispatched()` | No events dispatched |

**FakeQueue:**

| Method | Description |
|--------|-------------|
| `assertPushed(job)` | A job was pushed |
| `assertPushedWith(job, data)` | Job pushed with specific data |
| `assertPushedOn(queue, job)` | Job pushed to specific queue |
| `assertNotPushed(job)` | A job was not pushed |
| `assertNothingPushed()` | No jobs pushed |

## Running Tests

```bash
# Full test suite
bun run test

# Framework packages (Bun test runner)
bun run test:bun

# Example apps (Vitest)
bun run test:examples

# Single file
bun test path/to/file.test.ts

# Generate a test file
bunx guren make:test posts/PostController --runner bun
```

> [!NOTE]
> Framework packages use Bun's native test runner (`bun:test`). Example apps and React components use Vitest with jsdom. Keep the runners separate to get fast feedback from Bun for framework code and realistic DOM behavior for SPA tests.
