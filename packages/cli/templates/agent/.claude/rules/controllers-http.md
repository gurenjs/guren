---
description: Guren controllers — validation signatures, 422 shape, Inertia pages, auth helpers, resources
globs:
  - "app/Http/**"
---

# Controllers & HTTP (@guren/core)

Controllers extend `Controller` and expose one async method per route action.

## Validation — exact signatures

Any Zod-like schema (anything with `safeParse`) is accepted:

```typescript
protected async validateBody<T>(schema: ZodLikeSchema<T>): Promise<T>   // request body
protected validateQuery<T>(schema: ZodLikeSchema<T>): T                 // query string
protected validateParams<T>(schema: ZodLikeSchema<T>): T                // route params
```

All throw `ValidationException` on failure, rendered as **HTTP 422** with body:

```json
{ "message": "The given data was invalid.", "errors": { "field": ["msg1", "msg2"] } }
```

Non-throwing variants return a discriminated union — note errors flatten to
**one string per field** here (`Record<string, string>`, not `string[]`):

```typescript
protected async validateBodySafe<T>(schema): Promise<SafeValidationResult<T>>
protected validateQuerySafe<T>(schema): SafeValidationResult<T>
protected validateParamsSafe<T>(schema): SafeValidationResult<T>
// SafeValidationResult<T> = { success: true; data: T } | { success: false; errors: Record<string, string> }
```

Business-logic errors: `throw ValidationException.withMessages({ email: 'Already registered' })`
(values may be `string` or `string[]`).

## Inertia responses

```typescript
import { pages } from '@/.guren/pages.gen'
return this.inertia(pages.posts.Show, { post })   // props compile-checked via PagePropsMap
return this.inertia('posts/Show', { post })       // string overload, untyped props
```

Page prop types come from each page component's `interface Props`, extracted by
`bunx guren codegen` into `PagePropsMap`. If props don't type-check, re-run codegen.
Optional third arg: `InertiaResponseOptions` (e.g. `{ status: 422 }`).

**No global shared props by default.** `shareInertiaProps(resolverFn)` (from `@guren/core`) can inject data (e.g. `auth.user`) into every Inertia response, but a fresh scaffold never calls it. `usePage<{ auth: {...} }>()` on the frontend silently resolves to `undefined` — it type-checks but is wrong at runtime. Pass everything a page needs explicitly through `this.inertia(page, { ... })` and declare it in that page's `interface Props`; only reach for `usePage()` for props you have actually wired up via `shareInertiaProps`.

## Route model binding

```typescript
// routes: router.get('/posts/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])
async show() {
  const post = this.model(Post)   // typed record, already resolved via findOrFail (404 on miss)
}
```

## Auth helpers

`this.auth` (requires `AuthServiceProvider`) exposes:
`check(): Promise<boolean>` · `guest(): Promise<boolean>` · `user<T>(): Promise<T | null>` ·
`userOrFail<T>(): Promise<T>` (throws → 401) · `id(): Promise<unknown>` ·
`login(user, remember?)` · `attempt(credentials, remember?): Promise<boolean>` · `logout()`

Authorization (policies/gates):
`await this.authorize('update', [Post, post])` (throws 403) ·
`await this.can('update', [Post, post]): Promise<boolean>` ·
API tokens: `this.apiToken()` → `{ userId, abilities }` or throws 401.

**`<T>` defaults to `Authenticatable`** (`{ getAuthIdentifier(): unknown; getAuthPassword(): string; ... }`) — it does **not** have `.id`. Pass your record type explicitly when you need field access: `const user = await this.auth.userOrFail<UserRecord>(); user.id` — omitting `<T>` type-checks until the first `.id`/`.email` access.

## Exceptions

All extend `HttpException` (import from `@guren/core`) and are rendered automatically by the global handler via their `statusCode` — throw directly from a controller method, no try/catch needed:

```typescript
HttpException.badRequest(msg?)      // 400
HttpException.unauthorized(msg?)    // 401
HttpException.forbidden(msg?)       // 403
HttpException.notFound(msg?)        // 404
HttpException.conflict(msg?)        // 409
HttpException.unprocessable(msg?, errors?)  // 422 — same errors shape as validateBody()
HttpException.internal(msg?)        // 500
// also: methodNotAllowed / gone / tooManyRequests / notImplemented / badGateway / serviceUnavailable / gatewayTimeout

new ValidationException({ email: ['Already registered'] })          // 422
ValidationException.withMessages({ email: 'Already registered' })   // string | string[] values

new AuthenticationException(message?, guard?, redirectTo?)          // 401
AuthenticationException.withRedirect(redirectTo, message?)

new AuthorizationException(message?, action?, resource?)            // 403
AuthorizationException.deny(resource?)              // e.g. AuthorizationException.deny('Comment')
AuthorizationException.forAction(action, resource?)

new NotFoundHttpException(message?)                                 // 404
NotFoundHttpException.forModel('User', 123)
```

Use `AuthorizationException.deny(...)` for manual ownership checks that don't go through `this.authorize()`/policies.

**`Model.findOrFail()` throws `ModelNotFoundException` from `@guren/orm`** — a separate class that does *not* extend `HttpException`; the handler picks it up via its duck-typed `statusCode: 404`. `forModel()` exists only on `NotFoundHttpException`.

## Response helpers

- `this.json(data, init?)` / `this.text(body, init?)`
- `this.redirect(url, { status?, headers? })` — defaults 302 for GET, **303 for non-GET** (correct for Inertia form posts)
- `await this.files('avatar')` → `File[]` (uploaded files, empties filtered)

## API Resources (app/Http/Resources)

```typescript
import { Resource } from '@guren/core'

export class PostResource extends Resource<PostRecord> {
  toArray() {                       // abstract — must implement; typed toArray is exported as Data.Post by codegen
    return { id: this.resource.id, title: this.resource.title }
  }
}
new PostResource(post).toJSON()          // toArray() + additional() data
PostResource.collection(posts)           // ResourceData[]
new PostResource(post).additional({ meta: 1 })
this.when(cond, value)                   // conditional field inside toArray()
```

`JsonResource<T>` is a no-transform passthrough (`toArray()` returns `{ ...resource }`).
