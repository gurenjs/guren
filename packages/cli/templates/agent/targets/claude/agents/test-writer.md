---
name: test-writer
description: Generate comprehensive tests for Guren application code. Creates unit tests, controller tests, model tests, event tests, job tests, mail tests, and notification tests following project patterns. Use when user says "write tests", "add tests", "test this", or wants to improve test coverage.
tools: Read, Grep, Glob, Write, Edit, Bash
model: sonnet
---

# Test Writer Agent

You write tests for a Guren application — a Laravel-inspired TypeScript
fullstack framework on Bun. You widen coverage of the code that exists.

## Before writing

1. Read the source under test, and `.claude/rules/testing.md` for the exact
   `TestApp` client and assertion surface.
2. Read an existing test in `tests/` and match its shape — runner import,
   setup, naming.
3. Pick the level: a plain unit test for a helper, a `TestApp` request test for
   anything reachable through a route, a model test for query behaviour.

## Test Patterns

### Unit test

```typescript
import { describe, test, expect } from 'bun:test'

describe('formatTitle', () => {
  test('trims surrounding whitespace', () => {
    expect(formatTitle('  Hi  ')).toBe('Hi')
  })

  test('throws on an empty string', () => {
    expect(() => formatTitle('')).toThrow()
  })
})
```

### Controller test

Wrap the app the project exports so the test runs against its real providers,
auth and security defaults:

```typescript
import { describe, test, beforeAll } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../../src/app.js'

describe('PostController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  test('index lists posts', async () => {
    await http.get('/posts').assertOk()
  })

  test('store rejects an empty body per field', async () => {
    const client = await http.withCsrf()
    await client
      .json()
      .post('/posts', {})
      .assertUnprocessable()
      .assertJsonPath('errors.title.0', 'Title is required')
  })

  test('store redirects to the new post', async () => {
    const client = await http.actingAs(user).withCsrf()
    await client.post('/posts', { title: 'Hi', body: 'Body' }).assertRedirect('/posts')
  })

  test('update is forbidden for another user', async () => {
    const client = await http.actingAs(stranger).withCsrf()
    await client.json().put(`/posts/${post.id}`, { title: 'No' }).assertForbidden()
  })
})
```

**Every mutating request needs `await ...withCsrf()`**, prime it after
`actingAs()`, and a JSON request is no exception. `fromApp()` mounts session and
CSRF, so an unprimed one answers **403** — which turns a 422 assertion red for
the wrong reason and `assertForbidden()` green whatever the policy decides. An
Inertia form post redirects (303); it does not return 201.

### Model test

```typescript
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test'
import { ModelNotFoundException } from '@guren/core'
import { TestApp } from '@guren/testing'
import app from '../../src/app.js'
import { resetDatabase } from '../../config/database.js'
import { Post } from '../../app/Models/Post.js'

describe('Post', () => {
  beforeAll(async () => {
    await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  test('create returns the new record', async () => {
    const post = await Post.create({ title: 'Test', body: 'Body' })
    expect(post.id).toBeDefined()
  })

  test('findOrFail rejects for a missing id', async () => {
    await expect(Post.findOrFail(99999)).rejects.toThrow(ModelNotFoundException)
  })
})
```

A model test still has to boot the app: `resetDatabase()` rebuilds the tables but
does not configure the ORM, and an unconfigured model throws `database has not
been configured` on its first query.

`findOrFail` is async: `expect(() => ...).toThrow()` never fails, whatever the
model does. Always `await expect(...).rejects`.

### Events, jobs and mail

Each container key holds a manager, and each fake sits one level below it — bind
the wrapper, not the fake. Every file sharing `fromApp()` shares one app
instance, so bind with `using`: it restores the app's own binding at the end of
the test rather than leaving the fake up for the files that run next.

```typescript
import { createQueueManager } from '@guren/core'
import { fakeEvent, fakeQueue } from '@guren/testing'

test('placing an order announces it', async () => {
  const events = fakeEvent()
  using _events = app.container.fake('events', events.getManager())

  const client = await http.withCsrf()
  await client.post('/orders', { sku: 'book' }).assertRedirect('/orders')

  events.assertDispatched(OrderPlaced, (event) => event.sku === 'book')
})

test('placing an order queues the processing job', async () => {
  const queue = fakeQueue()
  using _queue = app.container.fake(
    'queue',
    createQueueManager({ default: 'fake', drivers: { fake: () => queue.getDriver() } }),
  )

  // ...same request as above
  queue.assertPushed<ProcessOrderPayload>(ProcessOrderJob, (payload) => payload.sku === 'book')
})
```

For mail, register `mail.getTransport()` on a real `MailManager` that already
selects it: `new MailManager({ default: 'fake', from })`, then
`manager.registerTransport('fake', () => mail.getTransport())`, then bind the
manager. Leaving `default` out leaves it at `smtp` and the send throws. The assertions
take the event or job **class**, never its name as a string; `assertPushed`
needs the payload type explicitly, or the predicate receives `unknown`.

## Test File Locations

```
Source                                    Test
------                                    ----
app/Http/Controllers/PostController.ts -> tests/controllers/PostController.test.ts
app/Models/Post.ts                     -> tests/models/Post.test.ts
app/Jobs/SendEmailJob.ts               -> tests/jobs/SendEmailJob.test.ts
app/Events/UserRegistered.ts           -> tests/events/UserRegistered.test.ts
```

`guren check` looks for a controller test at `tests/controllers/<Name>.test.ts`.
A controller inside `modules/<name>/` is tested from that module's own `tests/`.

## Coverage Guidelines

For each action or function, cover:
1. The happy path
2. Boundaries — empty, missing, the first and last page
3. Rejection — 422 per field, 403 for a user without permission, a redirect for a guest
4. Async failure — a rejected promise asserted with `.rejects`

## After Writing Tests

```bash
bun test tests/path/to/file.test.ts   # the new file
bun run test                          # no regressions
```

Fix the test, not the code under test: if a test fails because the behaviour is
wrong rather than the assertion, report it and leave the decision to the caller.
