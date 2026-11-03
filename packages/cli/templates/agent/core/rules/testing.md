---
paths:
  - "tests/**"
  - "modules/*/tests/**"
---

# Testing (@guren/testing + bun:test)

Requests run in-process through `app.fetch()`: no server, no port. Wrap the
app `src/app.ts` exports, so tests run its real providers, auth and CSRF:

```typescript
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post, type PostRecord } from '../app/Models/Post.js'

describe('posts', () => {
  let http: TestApp
  beforeAll(async () => { http = await TestApp.fromApp(app) })
  beforeEach(async () => { await resetDatabase() })   // drops tables, re-applies migrations

  test('store creates a post for the signed-in user', async () => {
    const csrf = await http.actingAs(user).withCsrf()
    await csrf.post('/posts', { title: 'Hi', body: '...' }).assertRedirect('/posts')
    const rows: PostRecord[] = await Post.where({ title: 'Hi' }).get()
    expect(rows).toHaveLength(1)
  })
})
```

## Client

`http.get / post / put / patch / delete / query(path, body?)` (body auto-JSON
unless FormData) return a `PendingTestResponse`: awaitable and chainable.
`http.actingAs(user)`, `http.json()` (Accept: application/json),
`http.withHeader(name, value)` and `await http.withCsrf()` each return a NEW `TestApp`.

**Under `fromApp()`, every mutating request needs `withCsrf()`**, a JSON one
included: an unprimed POST/PUT/DELETE answers **403**, so a 422 assertion goes
red for the wrong reason and `assertForbidden()` passes whatever the policy
decides. Prime after `actingAs()`, so the token belongs to that user's session.

## Assertions: chain them before `await`

`assertStatus(code)` · `assertOk()` · `assertCreated()` · `assertNoContent()` ·
`assertRedirect(url?)` · `assertNotFound()` · `assertForbidden()` ·
`assertUnauthorized()` · `assertUnprocessable()` · `assertJson(exact)` ·
`assertJsonCount(n, key?)` · `assertJsonStructure(keys)` ·
`assertJsonPath(path, value)` · `assertInertia(component, props?)` ·
`assertCookie(name, value?)` · `assertCookieMissing(name)` ·
`assertHeader(name, value?)` · `assertHeaderMissing(name)`

The awaited `TestResponse` has `status`, `headers`, `raw`, `await text()`,
`await json<T>()`, the status and header asserts, `assertSuccessful()`,
`assertBadRequest()`, `assertServerError()`, and the async
`await res.assertJson / assertJsonPath / assertJsonContains / assertBodyContains`.
`assertInertia`, `assertJsonCount`, `assertJsonStructure` and the cookie asserts
exist only on the chain.

**`assertInertia` reads the page as JSON, so send `http.json()`:**
`await http.json().get(url).assertInertia('posts/Show', { post })`. A plain
GET returns the HTML shell and fails with `JSON Parse error: Unrecognized
token '<'`. Prefer `json()` over `withHeader('X-Inertia', 'true')`: where an
asset version is set (a built client manifest, or `GUREN_INERTIA_VERSION`),
an `X-Inertia` GET without that version answers 409.

Validation failures are 422 with `{ message, errors: Record<string, string[]> }`:
`assertJsonPath('errors.title.0', 'Title is required')`.

## Mistakes that cost a rerun

- **A form post that ends in `this.redirect()` answers 303**, JSON or not:
  assert `assertRedirect('/posts')`, not `assertCreated()`. 201 only comes
  from an action that returns `this.json(data, { status: 201 })`.
- **Type rows as the record type the model file exports** (`PostRecord`,
  `UserRecord`), never as the class: `let post: Post` has no `id`.
- **Read the database through models**, not `getDatabase()` (it returns a
  Promise of the raw driver): `await Post.where({ authorId }).get()`,
  `await Post.where({ authorId }).count()`, `await Post.find(id)`. `count()`
  exists on the query builder only; `Post.count()` does not.
- **Create a user with `password`**, not `passwordHash`, when `User` has
  `base: AuthenticatableModel` (the model `guren add auth` and the blog starter
  write): it hashes the plain value. A `User` from `make:model` hashes nothing,
  and the API template ships none.
- **The response body is `await res.json()`**; `res.response` is private.
- There is no `asInertia()`: Inertia pages are asserted with `assertInertia()`.

## Faking mail and queues

Bind the fake on the `app` that `src/app.ts` exports (the TestApp's container
is private), with `using` inside the test, after `fromApp()` has booted it.
The container holds managers, so wrap the fake in one:

```typescript
import { MailManager, createQueueManager } from '@guren/core'
import { fakeMail, fakeQueue } from '@guren/testing'

const mail = fakeMail()
const mailer = new MailManager({ default: 'fake', from: { email: 'app@example.com', name: 'App' } })
mailer.registerTransport('fake', () => mail.getTransport())
using _mail = app.container.fake('mail', mailer)

const queue = fakeQueue()
using _queue = app.container.fake('queue', createQueueManager({ default: 'fake', drivers: { fake: () => queue.getDriver() } }))

// ...make the request, then:
mail.assertSentTo('ada@example.com')
const [receipt] = mail.sentTo('ada@example.com')   // mail.sent() for every one
expect(receipt?.message.subject).toBe('Your receipt')
queue.assertPushed<ProcessOrderPayload>(ProcessOrderJob, (payload) => payload.sku === 'book')
```

`sent()` / `sentTo(email)` return `{ message, timestamp }[]`, the built
message being `{ to, from?, cc?, bcc?, replyTo?, subject, text?, html?,
attachments?, headers? }` (addresses as `{ email, name? }`). The other
assertions: `assertSent(fn?)`, `assertSentTimes(n)`, `assertNothingSent()`,
`assertSentFrom(email)`, `assertSentWithSubject(exact)`,
`assertSentWithBodyContaining(text)`, `assertSentWithCc/Bcc(email)`,
`assertSentWithAttachment(filename)`.

Events: `const events = fakeEvent()`, then
`using _events = app.container.fake('events', events.getManager())` and
`events.assertDispatched(OrderPlaced)`. Binding the bare fake instead of a
manager answers 500 at first use.

`bunx guren make:test <Name>` writes a test file (`--controller` for
`tests/controllers/`). TestApp variants (`create`, `fromFetch`), CSRF
without the real app, test database isolation and cleanup helpers:
`__SKILLS_DIR__/guren-api/reference/testing.md`.
