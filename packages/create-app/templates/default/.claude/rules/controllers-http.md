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
