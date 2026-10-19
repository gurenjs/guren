---
paths:
  - "app/Http/**"
  - "modules/*/app/Http/**"
---

# Controllers & HTTP (@guren/core)

Controllers extend `Controller` and expose one async method per route action.

## Validation

A route declaring `params`, `query` or `body` schemas is validated before the
action runs; read the parsed values, do not validate again:
`const { body } = this.validated('posts.store')` (typed after `bunx guren codegen`;
an undeclared segment is `undefined`). Without a contract:
`await this.validateBody(schema)` · `this.validateQuery(schema)` ·
`this.validateParams(schema)` (any schema with `safeParse`).

Failures render **422** with
`{ "message": "The given data was invalid.", "errors": { "field": ["msg"] } }`.
Business-logic errors: `throw ValidationException.withMessages({ email: 'Already registered' })`.

## Inertia responses

```typescript
import { pages } from '@/.guren/pages.gen'
return this.inertia(pages.posts.Show, { post })   // props compile-checked against the page's `interface Props`
```

If props don't type-check after editing a page's `Props`, re-run `bunx guren codegen`.
**No global shared props by default**: a fresh scaffold never calls
`shareInertiaProps()`, so `usePage<{ auth: … }>()` type-checks and is `undefined`
at runtime. Pass everything a page needs through `this.inertia(page, { … })`.

## Responses

- `this.redirect(url)`: 302 for GET, **303 for non-GET** (what Inertia form posts expect)
- `this.json(data, init?)` (`{ status: 201 }` for a created resource) · `this.text(body, init?)`
- `await this.files('avatar')` → `File[]`

## Auth and authorization

`this.auth` methods are all async: `check()` · `guest()` · `user<T>()` ·
`userOrFail<T>()` (throws → 401) · `id()` · `login(user, remember?)` ·
`attempt(credentials, remember?)` · `logout()`.
**Pass the record type**: `await this.auth.userOrFail<UserRecord>()`. The default
`<T>` is `Authenticatable`, which has no `.id`.

`await this.authorize('update', [Post, post])` (throws 403) ·
`await this.can('update', [Post, post])` → boolean ·
`this.apiToken()` → `{ userId, abilities }` or throws 401.

## Exceptions

Throw from the action; the global handler renders them by `statusCode`:
`HttpException.badRequest/unauthorized/forbidden/notFound/conflict/unprocessable(msg?)`,
`AuthorizationException.deny('Comment')` (403, for ownership checks outside policies),
`ValidationException.withMessages({...})` (422). `Model.findOrFail()` throws a 404 on its own.

## Route model binding

With `bind: { id: Post }` (or `{ slug: [Post, 'slug'] }`) on the route,
`this.model(Post)` returns the resolved record (404 on miss). A router-level
`router.bind()` value arrives as a positional argument after the context, never
on `this.ctx.get()`.

Server-rendered content pages (`this.view()`, `app/View/*.tsx`), the safe
(non-throwing) validators, every exception class and constructor, API
Resources (`app/Http/Resources`, `Resource<TRecord, TPayload>`) and binding
precedence: `__SKILLS_DIR__/guren-api/reference/controllers-http.md`.
