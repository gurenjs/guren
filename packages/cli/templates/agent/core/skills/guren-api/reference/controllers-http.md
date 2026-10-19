# Controllers & HTTP: reference

The rule `__RULES_DIR__/controllers-http.md` attaches when you edit `app/Http/**`
and covers validation, Inertia, responses, auth and the common exceptions. This
file holds the rest.

## Non-throwing validation

Non-throwing variants return a discriminated union — note errors flatten to
**one string per field** here (`Record<string, string>`, not `string[]`):

```typescript
protected async validateBodySafe<T>(schema): Promise<SafeValidationResult<T>>
protected validateQuerySafe<T>(schema): SafeValidationResult<T>
protected validateParamsSafe<T>(schema): SafeValidationResult<T>
// SafeValidationResult<T> = { success: true; data: T } | { success: false; errors: Record<string, string> }
```

## Inertia extras

`this.inertia('posts/Show', { post })` is the untyped string overload. An optional
third argument takes `InertiaResponseOptions`, e.g. `{ status: 422 }`.
`shareInertiaProps(resolverFn)` from `@guren/core` injects props (e.g. `auth.user`)
into every Inertia response; read them with `usePage()` only once it is wired.

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

**`Model.findOrFail()` throws `ModelNotFoundException` (exported from `@guren/core`)** — a separate class that does *not* extend `HttpException`; the handler picks it up via its duck-typed `statusCode: 404`. `forModel()` exists only on `NotFoundHttpException`.

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
