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

## Server-rendered content pages (`this.view()`)

The non-hydrating counterpart to `this.inertia()` for public, read-mostly
pages (blog posts, docs, marketing) — plain SSR HTML, no client framework,
no Inertia page-payload script in the document:

```typescript
import { ShowPage } from '../../View/ShowPage.js'
return this.view(ShowPage, { post })                       // props compile-checked at the call site
return this.view(ShowPage, { post: null }, { status: 404 })
```

- **View components live in `app/View/*.tsx` (module-local:
  `modules/<name>/app/View/`), never under `resources/js/pages/`**
  (codegen claims that directory for Inertia pages). They start with the
  pragma `/** @jsxImportSource @guren/core */` and import
  `type { FC, PropsWithChildren }` and `viteAsset` from `@guren/core` — the
  app never declares `hono`.
- **Pass page metadata through a Layout `head` slot, not the body.** Tags
  rendered literally inside `<head>` skip hono's hoisting pass; hoisting
  (`<title>`/`<meta>`/`<link>` from anywhere) still works as the safety net
  for deeply nested tags, but it rescans the document per hoisted tag —
  measured quadratic in tag count, so a 15-tag SEO block in the body costs
  ~1 ms per render and grows with page size. The Layout's own `<head>` must
  carry only what pages never restate (charset, viewport, stylesheet) — a
  hard-coded default `<title>` there silently shadows every page's.
- **`viteAsset('resources/css/app.css')`** resolves the stylesheet URL in
  both dev and production; the CSS file must be an explicit Vite build input.
- **A page that forgets its Layout throws** a descriptive error instead of
  shipping an unstyled document; pass `{ doctype: false }` for intentional
  fragments.
- **Escaping covers markup, not URL schemes** — a `javascript:` href from
  user data passes through verbatim; sanitize upstream
  (`@guren/plugin-markdown`'s allowlist).
- Inline JSON-LD needs `dangerouslySetInnerHTML` with `<` escaped as
  `\u003c` (text children are HTML-escaped).

## Route model binding

```typescript
// routes: router.get('/posts/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])
async show() {
  const post = this.model(Post)   // typed record, already resolved via findOrFail (404 on miss)
}
```

`bind: { id: Post }` always looks up by primary key. For a slug (or any other unique column) bind a
`[Model, column]` tuple — `bind: { slug: [Post, 'slug'] }` — and `this.model(Post)` returns the record
resolved by that column. Never adapt around this with a custom `{ findOrFail }` object.

Router-level `router.bind('post', Post | [Post, 'slug'] | async (value) => ...)` binds every
controller-action route whose path has `:post` (inline handlers never receive bindings); the resolved
value reaches the action as a **positional argument after the context**
(`async show(_ctx: Context, post: PostRecord)`), and model bindings are also available via `this.model(Post)`.
A custom resolver's value is positional-only. Nothing is stored on the Hono context — `this.ctx.get('post')` is `undefined`.
When a param is bound at both levels, or two params bind the same model class, the route's own `bind` is what `this.model()` returns.

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
- `this.view(Component, props, options?)` — server-rendered content page (see the section above)
- `this.redirect(url, { status?, headers? })` — defaults 302 for GET, **303 for non-GET** (correct for Inertia form posts)
- `await this.files('avatar')` → `File[]` (uploaded files, empties filtered)

## API Resources (app/Http/Resources)

```typescript
import { Resource } from '@guren/core'

export interface PostResourceData extends Record<string, unknown> {
  id: PostRecord['id']
  title: string
}

// Resource<TRecord, TPayload> — the second argument makes toJSON() report the
// payload type too; it defaults to Record<string, unknown> when omitted.
export class PostResource extends Resource<PostRecord, PostResourceData> {
  toArray(): PostResourceData {     // abstract — must implement; the annotated type is exported as Data.Post by codegen
    return { id: this.resource.id, title: this.resource.title }
  }
}
new PostResource(post).toJSON()          // PostResourceData: toArray() + additional() data
PostResource.collection(posts)           // ResourceData[]
new PostResource(post).additional({ meta: 1 })
this.when(cond, value)                   // conditional field inside toArray()
```

`JsonResource<T>` is a no-transform passthrough (`toArray()` returns `{ ...resource }`).
