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
await app.query('/posts/search', body) // HTTP QUERY (RFC 10008)
```

### Wrapping the real application

`TestApp.create({ ... })` assembles an app from the parts you pass, which is good for isolated slices, but the subset can silently drift from what the server actually runs (providers, `auth`, `i18n`, security defaults). For tests that should exercise the real configuration, wrap the app your project exports:

```ts
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

let http: TestApp

beforeAll(async () => {
  http = await TestApp.fromApp(app)
})

test('serves the home page', async () => {
  await http.get('/').assertOk()
})
```

`fromApp()` boots the app and binds its fetch handler for you. Several test files may call it on the same instance: `boot()` is idempotent and reuses the first boot.

You may also see the longer form below, which does the same thing by hand. Note the arrow function: `fetch` reads instance state, so handing the unbound `app.fetch` reference to `fromFetch` throws on the first request. `fromApp()` exists to remove that footgun; reach for `fromFetch` when you have an arbitrary fetch function rather than a Guren application.

```ts
await app.boot()
http = TestApp.fromFetch((request) => app.fetch(request))
```

When you do assemble an app from parts, `TestApp.create()` mirrors `createApp`'s options: pass `auth` to mount session + CSRF middleware, and `i18n` when controllers under test use `this.t()` / `this.tc()`:

```ts
const app = await TestApp.create({
  routes: registerWebRoutes,
  i18n: { supported: ['en'] },
})
```

To try one environment variable without mutating `process.env`, pass your `config/env.ts` schema as `env` and the override as `envSource`. `envSource` is read ahead of `process.env`, and `''` makes a variable unset. `create()` takes no `config` array, so the override reaches what providers and controllers read through `this.make('env')`; an invalid value makes `create()` reject with an `EnvValidationError`:

```ts
import { TestApp } from '@guren/testing'
import env from '../config/env.js'

const app = await TestApp.create({
  env,
  envSource: { CACHE_STORE: 'memory', APP_URL: '' },
  providers: [ReportProvider],
})
```

`TestApp.fromApp(app)` boots with the schema and config definitions `src/app.ts` passes to `createApp()`, so a feature test sees the configuration production uses. [Configuration](./configuration.md#tests) has the details.

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

### Password hashing in tests

You do not need to configure anything to keep password tests fast. `TestApp` sets `GUREN_TESTING=1`, and while that variable is set the default hasher uses cheap parameters: scrypt at N=1024 (Argon2id at 1 MiB and one iteration under `hasher: 'argon2'`). A production-strength hash costs over 100 ms, which is most of what a test like this spends:

```ts
const user = await User.create({ email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' })
await app.post('/login', { email: 'ada@example.com', password: 'correct horse battery' }).assertRedirect('/')
```

Your login test still verifies a real hash: verification reads the parameters stored in it, so a cheap hash verifies in tests and a production hash verifies too. Outside tests, `Hash.needsRehash()` reports a cheap hash as stale, so the rehash-on-login pattern from the [Encryption guide](./encryption.md) upgrades any row a test-mode process wrote. Nothing sets the variable in a deployed app.

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

Use `withHeaders()` / `withHeader()` to send headers on every request, handy
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
const database = createSqliteDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  filename: (context) => {
    const values = context?.env ?? env.parse(undefined, { mode: 'report' }).values
    return process.env.NODE_ENV === 'test'
      ? values.TEST_DATABASE_URL ?? './data/guren.test.db'
      : values.DATABASE_URL ?? './data/guren.db'
  },
})
```

Tests read and write `./data/guren.test.db` by default, a separate file from `./data/guren.db`, so nothing a test creates ever leaks into the data you're looking at in the dev server. Override the test file itself with `TEST_DATABASE_URL` (for example, to give each parallel CI shard its own file); `DATABASE_URL` stays authoritative for every other environment. Both keys are declared in the scaffolded `config/env.ts`, and `context` carries their validated values when the app boots (see [Configuration](./configuration.md#the-database-connection)).

> [!WARNING]
> Scaffolds created before this branch existed write straight to `DATABASE_URL` (or `./data/guren.db`) regardless of `NODE_ENV`, so `bun test` pollutes the same database your dev server reads from. Retrofit it by replacing the `filename` option, and declare `DATABASE_URL` and `TEST_DATABASE_URL` in `config/env.ts` (an app without that file adds it first; see [Configuration](./configuration.md#apps-with-service-providers)):
>
> ```diff
> +import env from './env.js'
> +
>  const database = createSqliteDatabase({
>    migrationsFolder: new URL('../db/migrations', import.meta.url),
>    seedersFolder: new URL('../db/seeders', import.meta.url),
> -  filename: () => process.env.DATABASE_URL || './data/guren.db',
> +  filename: (context) => {
> +    const values = context?.env ?? env.parse(undefined, { mode: 'report' }).values
> +    return process.env.NODE_ENV === 'test'
> +      ? values.TEST_DATABASE_URL ?? './data/guren.test.db'
> +      : values.DATABASE_URL ?? './data/guren.db'
> +  },
>  })
> ```

### Cleaning Up Between Tests

For most suites, the separate test-database file is isolation enough. Reset it back to a clean slate in `beforeEach` using the `resetDatabase()` helper your `config/database.ts` already exports. It drops every table and re-applies migrations, the same end state `guren db:reset` leaves behind, so your tables are ready to query straight after:

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { resetDatabase } from '@/config/database'

describe('User Model', () => {
  beforeEach(async () => {
    await resetDatabase() // drops every table, then re-applies migrations
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

Guren's SQLite adapter doesn't hand you a ready-made `DatabaseConnection` (`getDatabase()` from `config/database.ts` resolves to the underlying Drizzle instance, not this interface), so using these helpers means writing a small adapter yourself and passing it to `setTestDatabase()` before your tests run. `useDatabaseTransactions()` specifically **must wrap the same connection your models write through**: it begins a transaction on `beforeEach` and rolls it back on `afterEach`, and a second, independently-opened connection to the same file won't see (or roll back) writes made via the first one. `useTruncateTables()` has no such requirement: a `DELETE FROM` on any connection to the same database file removes the rows your models see, since it commits immediately rather than participating in a shared transaction. If the adapter plumbing sounds like more than your suite needs, the `resetDatabase()` pattern above is simpler and sidesteps the whole question.

## Faking Services

Real tests should not send actual emails, dispatch real events, or push jobs to a queue. `@guren/testing` ships a fake for each: `fakeEvent()`, `fakeMail()` and `fakeQueue()`. Bind them on the app your project exports with `app.container.fake()`, inside the test that needs them:

```ts
import { beforeAll, test } from 'bun:test'
import { MailManager, createQueueManager } from '@guren/core'
import { TestApp, fakeEvent, fakeMail, fakeQueue } from '@guren/testing'
import app from '../src/app.js'
import { OrderPlaced } from '../app/Events/OrderPlaced.js'
import { ProcessOrderJob, type ProcessOrderPayload } from '../app/Jobs/ProcessOrderJob.js'

let http: TestApp

beforeAll(async () => {
  http = await TestApp.fromApp(app)
})

test('placing an order announces it', async () => {
  const events = fakeEvent()
  using _events = app.container.fake('events', events.getManager())

  const client = await http.withCsrf()
  await client.post('/orders', { sku: 'book' }).assertRedirect('/orders')

  events.assertDispatched(OrderPlaced, (event) => event.sku === 'book')
})

test('placing an order mails a receipt', async () => {
  const mail = fakeMail()
  const manager = new MailManager({ default: 'fake', from: { email: 'shop@example.com', name: 'Shop' } })
  manager.registerTransport('fake', () => mail.getTransport())
  using _mail = app.container.fake('mail', manager)

  const client = await http.withCsrf()
  await client.post('/orders', { sku: 'book', email: 'ada@example.com' }).assertRedirect('/orders')

  mail.assertSentTo('ada@example.com')
  mail.assertSentWithSubject('Your order')
})

test('placing an order queues the processing job', async () => {
  const queue = fakeQueue()
  using _queue = app.container.fake(
    'queue',
    createQueueManager({ default: 'fake', drivers: { fake: () => queue.getDriver() } }),
  )

  const client = await http.withCsrf()
  await client.post('/orders', { sku: 'book' }).assertRedirect('/orders')

  queue.assertPushed<ProcessOrderPayload>(ProcessOrderJob, (payload) => payload.sku === 'book')
})
```

Each container key holds a manager (`events` an `EventManager`, `mail` a `MailManager`, `queue` a `QueueManager`), and each fake is one level below that, so it goes in wrapped:

- `fakeEvent()` records through the manager it holds: bind `events.getManager()`. Nothing listens on that manager, so listeners do not run, and neither do the jobs or mail they would have started.
- `fakeMail()` is a transport: register it on a real `MailManager` and bind the manager.
- `fakeQueue()` is a driver: return it from a `createQueueManager()` factory and bind the manager.

`assertPushed` takes the payload type explicitly. A job class alone does not tell TypeScript its payload, so the predicate would receive `unknown`.

`fake()` returns a disposable, and `using` puts the app's own binding back when the test ends. Every test file that calls `fromApp()` shares one app instance, so a fake bound in `beforeAll` and never restored stays bound for the files that run after it. Bind fakes after `fromApp()` has booted the app, too: providers set up the real services during boot, and the fake event manager is not a full `EventManager`.

Binding the fake itself rather than a manager fails on first use, and the request answers 500:

| Bound directly | Error |
|---|---|
| `fakeEvent()` as `events` | `this.make("events").emit is not a function` |
| `fakeMail()` as `mail` | `manager.getDefaultFrom is not a function` |
| `fakeQueue()` as `queue` | `manager.getDefaultDriverName is not a function` |

`setQueueDriver(fakeQueue().getDriver())` also intercepts `Job.dispatch()`, but it is deprecated since 2.23.0 and removed in 3.0.0.

### Available Fake Assertions

`FakeMail` records the built message, not the `Mail` class that built it, so its assertions read addresses, subject and body.

**FakeMail:**

| Method | Description |
|--------|-------------|
| `assertSent(callback?)` | A mail was sent; with a callback, one of them matches it |
| `assertSentTimes(count)` | Exactly `count` mails were sent in total |
| `assertNothingSent()` | No mail was sent |
| `assertSentTo(email)` | A mail was sent to the address |
| `assertSentFrom(email)` | A mail was sent from the address |
| `assertSentWithSubject(subject)` | A mail has exactly this subject |
| `assertSentWithBodyContaining(text)` | A mail's text or HTML body contains `text` |
| `assertSentWithCc(email)`, `assertSentWithBcc(email)` | A mail copies the address |
| `assertSentWithAttachment(filename)` | A mail carries an attachment with this filename |
| `sent()`, `sentTo(email)` | The recorded mails, all of them or those to one address |

**FakeEvent:**

| Method | Description |
|--------|-------------|
| `assertDispatched(event, callback?)` | The event was dispatched; with a callback, one instance matches it |
| `assertDispatchedTimes(event, count)` | The event was dispatched exactly `count` times |
| `assertDispatchedWith(event, data)` | One instance has every property in `data`, compared with `===` |
| `assertDispatchedInOrder(events)` | The events were dispatched in this order, with others allowed between them |
| `assertNotDispatched(event)` | The event was not dispatched |
| `assertNothingDispatched()` | No event was dispatched |
| `dispatched(event)` | The recorded instances of the event |

**FakeQueue:**

| Method | Description |
|--------|-------------|
| `assertPushed(job, callback?)` | The job was pushed; with a callback, one payload matches it |
| `assertPushedTimes(job, count)` | The job was pushed exactly `count` times |
| `assertPushedOn(queue, job)` | The job was pushed onto the named queue |
| `assertPushedWithDelay(job, delay)` | The job was pushed with this delay, in milliseconds |
| `assertNotPushed(job)` | The job was not pushed |
| `assertNothingPushed()` | No job was pushed |
| `pushed(job)` | The recorded pushes of the job |

All three also have `clear()`, for a fake kept across tests.

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

### File uploads under jsdom

Under Vitest's `jsdom` environment, a test that posts a `File` inside a `FormData` body (for example through `createControllerContext(url, { method: 'POST', body: formData })` to an action that calls `this.file()`) hangs until its timeout and reports no error. jsdom replaces `File` and `Blob` with its own classes, and undici's multipart encoder never finishes reading them, so `formData()` never resolves. String-only forms are not affected. Controller tests render no DOM, so switch the file to the Node environment with a comment on its first line:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
```
