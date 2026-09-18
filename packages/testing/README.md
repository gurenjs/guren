# @guren/testing

Testing utilities for [Guren](https://guren.dev/) applications: `TestApp` with HTTP and Inertia assertions, plus fakes for auth, mail, queues, events, and AI agents. Runs on `bun test`.

```bash
bun add -d @guren/testing
```

Scaffolded apps already depend on it.

## Testing a controller

```typescript
import { describe, test, beforeAll } from 'bun:test'
import { TestApp } from '@guren/testing'

describe('PostController', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await TestApp.create()
  })

  test('lists posts', async () => {
    await app.get('/posts').assertOk()
  })

  test('creates a post', async () => {
    await app
      .post('/posts', { title: 'Hello', content: 'World' })
      .assertStatus(201)
      .assertJsonPath('post.title', 'Hello')
  })

  test('returns 404 for a missing post', async () => {
    await app.get('/posts/999').assertNotFound()
  })
})
```

`TestApp.create()` assembles an app from the parts you pass, which suits an isolated slice but can drift from what the server actually runs. To exercise the real configuration, wrap the app your project exports:

```typescript
import app from '../src/app.js'

const http = await TestApp.fromApp(app)
await http.get('/').assertOk()
```

## Fakes

Each one swaps a subsystem for an inspectable double, so a test asserts on what the app tried to do rather than on a side effect. `fakeEvent()`, `fakeMail()` and `fakeQueue()` are bound on the app with `app.container.fake()`, inside the test that needs them, and each binding wants the shape that subsystem resolves: the [testing guide](https://guren.dev/docs/guides/testing) gives the exact form for each, and the error you get when a fake is bound one level off.

| Fake | Asserts on |
|------|-----------|
| `fakeMail()` | Mailables that would have been sent |
| `fakeQueue()` | Jobs that would have been dispatched |
| `fakeEvent()` | Events that would have been dispatched |

Two more are methods on `TestApp`, because they change how the request itself is made:

```typescript
await app.actingAs(user).get('/dashboard').assertOk()   // authenticated request
using ai = app.fakeAi()                                  // script an in-process AI agent
```

## Subpath exports

| Import | Contents |
|--------|----------|
| `@guren/testing/vitest` | The same helpers for React component tests running under Vitest |

## Documentation

The [testing guide](https://guren.dev/docs/guides/testing) covers controller, model, event, job, mail, and notification tests.

## License

MIT
