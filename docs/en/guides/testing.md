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

Keep tests isolated by resetting the database between runs:

```ts
import { describe, test, beforeEach, afterEach } from 'bun:test'
import { RefreshDatabase } from '@guren/testing'

describe('User Model', () => {
  beforeEach(async () => {
    await RefreshDatabase.refresh()
  })

  afterEach(async () => {
    await RefreshDatabase.cleanup()
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

> [!TIP]
> `RefreshDatabase.refresh()` resets the database to a clean state. Use it in `beforeEach` so every test starts fresh.

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
