# Testing

Test your app over HTTP with `TestApp`: send a request through the real middleware and routes, then assert on the response. This page also covers signing a user in, keeping tests off your development database, and swapping mail, events and queues for fakes.

A scaffolded app runs its tests with Bun's test runner and ships one example, `tests/HomeController.test.ts`. Run the suite with `bun run test` (see [Running Tests](#running-tests)).

## TestApp

`TestApp` boots your application in-process, with the full middleware and routing stack, and gives each request a fluent set of assertions. The scaffold's own test wraps the app `src/app.ts` exports:

```ts
import { beforeAll, describe, test } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

describe('Posts', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  test('lists all posts', async () => {
    await http.get('/posts').assertOk()
  })

  test('returns 404 for a missing post', async () => {
    await http.get('/posts/999').assertNotFound()
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

### Choosing How to Build the App

| Builder | What it runs | Use it when |
|---------|--------------|-------------|
| `TestApp.fromApp(app)` | The app `src/app.ts` exports, with its providers, `auth`, `i18n` and config | Most tests: they see the configuration production uses |
| `TestApp.create({ ... })` | An app assembled from the options you pass | Testing one slice in isolation, or trying an env override |
| `TestApp.fromFetch(fetch)` | Any fetch function | The handler is not a Guren application |

### Wrapping the real application

`fromApp()` boots the app and binds its fetch handler. Several test files may call it on the same instance: `boot()` runs once, and later calls reuse that boot. It also boots with the env schema and config definitions `src/app.ts` passes to `createApp()` ([Configuration](./configuration.md#tests) has the details).

You may see the longer form below, which does the same by hand:

```ts
await app.boot()
http = TestApp.fromFetch((request) => app.fetch(request))
```

Keep the arrow function if you write it this way. `fetch` reads instance state, so passing the unbound `app.fetch` to `fromFetch` throws on the first request.

### Assembling an app from parts

`TestApp.create()` takes the same options as `createApp`. A subset can drift from what the server actually runs, so pass what the code under test needs: `auth` to mount the session and CSRF middleware, and `i18n` when controllers call `this.t()` / `this.tc()`:

```ts
const app = await TestApp.create({
  routes: registerWebRoutes,
  i18n: { supported: ['en'] },
})
```

To try one environment variable without changing `process.env`, pass your `config/env.ts` schema as `env` and the override as `envSource`:

```ts
import { TestApp } from '@guren/testing'
import env from '../config/env.js'

const app = await TestApp.create({
  env,
  envSource: { CACHE_STORE: 'memory', APP_URL: '' },
  providers: [ReportProvider],
})
```

- `envSource` is read ahead of `process.env`, and `''` makes a variable unset.
- The override reaches what providers and controllers read through `this.make('env')`. `create()` takes no `config` array.
- An invalid value makes `create()` reject with an `EnvValidationError`.

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

Use `actingAs()` to send requests as a user without going through the login flow:

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

Password tests are fast with no setup. `TestApp` sets `GUREN_TESTING=1`, and while that variable is set the default hasher uses cheap parameters: scrypt at N=1024 (Argon2id at 1 MiB and one iteration under `hasher: 'argon2'`). A production-strength hash costs over 100 ms, which would be most of what a test like this spends:

```ts
const user = await User.create({ email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' })
await app.post('/login', { email: 'ada@example.com', password: 'correct horse battery' }).assertRedirect('/')
```

The login test still verifies a real hash, because verification reads the parameters stored in the hash itself. A cheap hash never survives into production either: outside tests, `Hash.needsRehash()` reports it as stale, and the rehash-on-login pattern from the [Encryption guide](./encryption.md) upgrades it. Nothing sets the variable in a deployed app.

## Testing JSON APIs

For API endpoints, `.json()` sends JSON headers so the app answers with JSON, including its validation errors:

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
    .assertJsonPath('errors.title.0', 'Too small: expected string to have >=1 characters')
})
```

The error body has the shape described in [Validation](./validation.md#form-validation-errors).

## Custom Request Headers

Use `withHeaders()` / `withHeader()` to send headers on every request: a locale, an API version, a bearer token. Like `actingAs()` and `json()`, they return a new `TestApp`, so variants compose:

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

`bun test` sets `NODE_ENV=test`, and a scaffolded `config/database.ts` uses it to point tests at a separate SQLite file:

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

| Environment | Database file | Override with |
|-------------|---------------|---------------|
| `bun test` | `./data/guren.test.db` | `TEST_DATABASE_URL` (for example, one file per parallel CI shard) |
| Everything else | `./data/guren.db` | `DATABASE_URL` |

Nothing a test creates shows up in the dev server's data. Both keys are declared in the scaffolded `config/env.ts`, and `context` carries their validated values when the app boots (see [Configuration](./configuration.md#the-database-connection)).

> [!WARNING]
> Apps scaffolded with `create-guren-app` 1.1.0 or earlier write to `DATABASE_URL` (or `./data/guren.db`) whatever `NODE_ENV` is, so `bun test` writes into the database your dev server reads. To fix one, replace the `filename` option and declare `DATABASE_URL` and `TEST_DATABASE_URL` in `config/env.ts` (an app without that file adds it first; see [Configuration](./configuration.md#apps-with-service-providers)):
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

To start each test from an empty database, call the `resetDatabase()` helper your `config/database.ts` already exports in `beforeEach`. It drops every table and re-applies migrations, the same end state `guren db:reset` leaves, so the tables are ready to query straight after:

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

### Per-test cleanup helpers

`@guren/testing` also ships two finer-grained helpers. Most suites do not need them; `resetDatabase()` is simpler.

| Helper | What it registers |
|--------|-------------------|
| `useTruncateTables(tables)` | A `beforeEach` hook that deletes every row of each listed table |
| `useDatabaseTransactions()` | `beforeEach` / `afterEach` hooks that begin a transaction and roll it back after the test |

Both run against a connection you register first with `setTestDatabase()`, in this shape:

```ts
interface DatabaseConnection {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<void>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
}
```

Things to know before writing that connection:

- Guren does not hand you one. `getDatabase()` from `config/database.ts` returns the underlying Drizzle instance, so you write a small adapter and pass it to `setTestDatabase()` before the tests run.
- `useDatabaseTransactions()` **must wrap the connection your models write through**. A second connection to the same file neither sees nor rolls back the first one's writes.
- `useTruncateTables()` works through any connection to the same database, because each `DELETE FROM` commits immediately.
- Tables are cleared in list order. On a connection that enforces foreign keys (every Postgres and MySQL connection, and the SQLite one `getDatabase()` returns), list each child table before its parent unless the foreign key cascades.

## Faking Services

Tests should not send real mail, run real listeners or push real jobs. `@guren/testing` ships a fake for each: `fakeEvent()`, `fakeMail()` and `fakeQueue()`. Bind one on the app your project exports with `app.container.fake()`, inside the test that needs it:

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

`http.withCsrf()` fetches `/` once and returns a `TestApp` that sends the session cookie and CSRF token on every later request, so a `POST` passes CSRF protection the way a browser's would.

### Binding a fake

Each container key holds a manager, and each fake sits one level below it, so it goes in wrapped:

| Key | The manager it holds | How to bind the fake |
|-----|----------------------|----------------------|
| `events` | `EventManager` | `fakeEvent()` records through its own manager: bind `events.getManager()` |
| `mail` | `MailManager` | `fakeMail()` is a transport: register it on a real `MailManager` and bind the manager |
| `queue` | `QueueManager` | `fakeQueue()` is a driver: return it from a `createQueueManager()` factory and bind the manager |

With the event fake bound, listeners do not run, and neither do the jobs or mail they would have started.

Binding the fake itself rather than a manager fails on first use, and the request answers 500:

| Bound directly | Error |
|---|---|
| `fakeEvent()` as `events` | `this.make("events").emit is not a function` |
| `fakeMail()` as `mail` | `manager.getDefaultFrom is not a function` |
| `fakeQueue()` as `queue` | `manager.getDefaultDriverName is not a function` |

Two rules about when to bind:

- **Bind with `using` inside the test.** `fake()` returns a disposable, and `using` puts the app's own binding back when the test ends. Every test file that calls `fromApp()` shares one app instance, so a fake bound in `beforeAll` and never restored stays bound for the files that run after it.
- **Bind after `fromApp()` has booted the app.** Providers set up the real services during boot, and the fake event manager is not a full `EventManager`.

`assertPushed` takes the payload type explicitly. A job class alone does not tell TypeScript its payload, so the predicate would receive `unknown`.

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
# The whole suite
bun run test

# One file
bun test tests/HomeController.test.ts

# Generate a test file
bunx guren make:test posts/PostController
```

`make:test` writes a `bun:test` file, or a Vitest one when the app has a `vitest.config.*` or depends on `vitest`. Pass `--runner bun` or `--runner vitest` to choose.

## Testing a Controller Without the App (Vitest)

`TestApp` covers most controller tests. If you add Vitest to test a controller in isolation, with its models mocked, `@guren/testing` has helpers for that:

- `createControllerContext(url, init?)` builds the request context a controller reads.
- `createControllerModuleMock()` is passed to `vi.mock('@guren/core', …)`. Its `Controller` extends the framework's own and replaces only `inertia()` and `make()`, which need a booted app.
- `createGurenControllerModule()` is the module that mock is built from, for a test that needs only the `Controller`.
- `readInertiaResponse(response)` normalizes an Inertia response to `{ format, payload, body }` for assertions.

Two problems are specific to this setup:

- `vi.mock is not a function` means Bun ran the file. Run Vitest files with `bunx vitest`, not `bun test`.
- `ReferenceError: document is not defined` means a test that needs the DOM ran outside jsdom. Set the file's environment to `jsdom`.

### File uploads under jsdom

Under Vitest's `jsdom` environment, a `File` posted inside a `FormData` body (for example through `createControllerContext(url, { method: 'POST', body: formData })` to an action that calls `this.file()`) never reaches the action. jsdom replaces the global `File` and `Blob` with its own classes, which are not the ones undici uses to encode and parse the multipart body. Depending on the Vitest and Node versions, the test times out, fails inside undici, or passes while `this.file()` returns `null`. Controller tests render no DOM, so switch the file to the Node environment with a comment on its first line:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
```
