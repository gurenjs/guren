# Testing Guide

Guren ships with two different styles of automated tests:

- **Framework unit/integration tests** live inside the packages (for example `packages/server/tests`). These run with Bun’s native `bun test` runner.
- **Example application tests** (such as the blog demo under `examples/blog`) use Vitest and jsdom so that React components render the same way they would in the browser.

Because the runners have different expectations, run them the way they were designed:

```bash
# Framework packages – Bun’s test runner
bun test packages/server/tests
bun test packages/orm/tests
bun test packages/core/tests
bun test packages/cli/tests
bun test packages/create-app/tests
bun test packages/inertia-client/tests

# Testing utilities – Vitest
bun run --cwd packages/testing test

# Example apps – Vitest + jsdom
bun run --cwd examples/blog test
bun run --cwd examples/api test
bun run --cwd web test
```

### Writing Bun tests for framework packages

Framework tests rely on Bun’s built-in assertions from `bun:test`. They help validate lower-level utilities such as the routing registry or HTTP helpers without needing a full application boot.

Common patterns:

- Instantiate controllers and call `setContext(ctx)` with a stubbed Hono context before invoking actions.
- Use lightweight fakes (for example an in-memory ORM adapter) to cover success and failure paths.
- Prefer focused unit tests inside the package that owns the code; use higher-level application tests sparingly to keep the inner loop fast.

Need a starting point? Run the generator:

```bash
# Bun-style test file under tests/
bunx guren make:test server/http/request --runner bun

# Vitest-style test file for SPA code
bunx guren make:test blog/pages/Login
```

The command writes scaffold files beneath `tests/` (creating directories as needed) and defaults to Vitest unless you override `--runner bun`.

### Testing controllers with `@guren/testing`

The `@guren/testing` package provides helpers tailored for controller testing, including:

- `createControllerContext(url, init?)` – builds a controller-ready Hono context.
- `createGurenControllerModule()` – mocks the `guren` package when running in Vitest so you can test controllers in isolation.
- `createControllerModuleMock()` – drop-in mock for `@guren/server` with `Controller`, `json`, and `redirect` wired for Vitest.
- `readInertiaResponse(response)` – normalizes Inertia responses into `{ format, payload, body }` for easy assertions.

Import these utilities in Vitest suites (for example under `examples/blog/tests`) to keep React/Inertia controller tests expressive while avoiding Bun-specific APIs.

### Troubleshooting

- Seeing `vi.mock is not a function`? That test is running under Bun; switch to the Vitest command shown above.
- Hitting `ReferenceError: document is not defined` indicates a DOM-dependent test is running outside jsdom. Use the Vitest runner or set up jsdom explicitly.

Keeping the runners separate ensures you get fast feedback from Bun for framework code and realistic DOM behavior for SPA tests.

## Testing Fakes

The `@guren/testing` package provides fake implementations of services for testing. These let you test code that sends emails, dispatches events, or queues jobs without actually performing those actions.

### FakeMail

Test email sending without actually sending emails:

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { FakeMail } from '@guren/testing'

describe('User Registration', () => {
  let fakeMail: FakeMail

  beforeEach(() => {
    fakeMail = new FakeMail()
  })

  it('sends welcome email', async () => {
    await userService.register({ email: 'user@example.com' })

    fakeMail.assertSent(WelcomeEmail)
    fakeMail.assertSentTo('user@example.com')
  })

  it('sends email with correct subject', async () => {
    await userService.register({ email: 'user@example.com' })

    fakeMail.assertSentWith(WelcomeEmail, {
      subject: 'Welcome to our app!',
    })
  })
})
```

#### FakeMail Methods

| Method | Description |
|--------|-------------|
| `assertSent(mailable)` | Assert a mailable was sent |
| `assertSentTimes(mailable, count)` | Assert mailable sent exact number of times |
| `assertNotSent(mailable)` | Assert a mailable was not sent |
| `assertNothingSent()` | Assert no emails were sent |
| `assertSentTo(email)` | Assert email was sent to address |
| `assertSentWith(mailable, data)` | Assert mailable was sent with specific data |
| `assertQueuedCount(count)` | Assert number of queued emails |
| `sent(mailable)` | Get all sent instances of a mailable |

### FakeQueue

Test job dispatching without processing jobs:

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { FakeQueue } from '@guren/testing'

describe('Order Processing', () => {
  let fakeQueue: FakeQueue

  beforeEach(() => {
    fakeQueue = new FakeQueue()
  })

  it('dispatches order processing job', async () => {
    await orderService.create(orderData)

    fakeQueue.assertPushed(ProcessOrderJob)
    fakeQueue.assertPushedWith(ProcessOrderJob, {
      orderId: expect.any(Number),
    })
  })

  it('does not dispatch job for invalid orders', async () => {
    await orderService.create(invalidData)

    fakeQueue.assertNotPushed(ProcessOrderJob)
  })
})
```

#### FakeQueue Methods

| Method | Description |
|--------|-------------|
| `assertPushed(job)` | Assert a job was pushed |
| `assertPushedTimes(job, count)` | Assert job pushed exact number of times |
| `assertPushedOn(queue, job)` | Assert job pushed to specific queue |
| `assertPushedWith(job, data)` | Assert job pushed with specific data |
| `assertNotPushed(job)` | Assert a job was not pushed |
| `assertNothingPushed()` | Assert no jobs were pushed |
| `pushed(job)` | Get all pushed instances of a job |

### FakeEvent

Test event dispatching without triggering listeners:

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { FakeEvent } from '@guren/testing'

describe('User Actions', () => {
  let fakeEvent: FakeEvent

  beforeEach(() => {
    fakeEvent = new FakeEvent()
  })

  it('dispatches user registered event', async () => {
    await userService.register(userData)

    fakeEvent.assertDispatched(UserRegistered)
  })

  it('dispatches events in correct order', async () => {
    await userService.register(userData)

    fakeEvent.assertDispatchedInOrder([
      UserCreated,
      UserRegistered,
      WelcomeEmailSent,
    ])
  })

  it('dispatches event with correct data', async () => {
    await userService.register({ email: 'test@example.com' })

    fakeEvent.assertDispatchedWith(UserRegistered, {
      email: 'test@example.com',
    })
  })
})
```

#### FakeEvent Methods

| Method | Description |
|--------|-------------|
| `assertDispatched(event, callback?)` | Assert an event was dispatched |
| `assertDispatchedTimes(event, count)` | Assert event dispatched exact number of times |
| `assertNotDispatched(event)` | Assert an event was not dispatched |
| `assertNothingDispatched()` | Assert no events were dispatched |
| `assertDispatchedInOrder(events)` | Assert events dispatched in specific order |
| `assertDispatchedWith(event, data)` | Assert event dispatched with specific data |
| `dispatched(event)` | Get all dispatched instances of an event |

### Database Testing

Use database fakes for testing without affecting your real database:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { DatabaseFake, RefreshDatabase } from '@guren/testing'

describe('User Model', () => {
  beforeEach(async () => {
    await RefreshDatabase.refresh()
  })

  afterEach(async () => {
    await RefreshDatabase.cleanup()
  })

  it('creates a user', async () => {
    const user = await User.create({
      email: 'test@example.com',
      name: 'Test User',
    })

    expect(user.id).toBeDefined()
    expect(user.email).toBe('test@example.com')
  })
})
```

### HTTP Testing

Test HTTP endpoints with the controller testing helpers:

```typescript
import { describe, it, expect } from 'bun:test'
import { createControllerContext } from '@guren/testing'
import UserController from '../app/Http/Controllers/UserController'

describe('UserController', () => {
  it('returns user list', async () => {
    const ctx = createControllerContext('/users')
    const controller = new UserController()
    controller.setContext(ctx)

    const response = await controller.index()

    expect(response.status).toBe(200)
  })

  it('creates a new user', async () => {
    const ctx = createControllerContext('/users', {
      method: 'POST',
      body: { email: 'new@example.com', name: 'New User' },
    })
    const controller = new UserController()
    controller.setContext(ctx)

    const response = await controller.store()

    expect(response.status).toBe(201)
  })
})
```

### Best Practices

1. **Reset fakes in beforeEach** - Always start with a clean state.
2. **Use specific assertions** - Prefer `assertSentWith` over `assertSent` when possible.
3. **Test failure cases** - Verify events/emails are NOT sent in error scenarios.
4. **Keep tests isolated** - Each test should be independent.
