---
description: Guren routing & codegen — RouteContractOptions, schema binding, the Zod→ApiRoutes matrix, middleware
globs:
  - "routes/**"
  - "app/Http/Validators/**"
---

# Routes & Codegen

## Registering routes

```typescript
import { Router, requireAuthenticated } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.post('/posts', { name: 'posts.store', body: CreatePostSchema }, [PostController, 'store'])

  router.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
  router.middleware('auth').group((group) => {
    group.get('/dashboard', [DashboardController, 'index'])
  })
  router.group('/admin', (admin) => { /* path-prefixed */ })
}
```

Options object (second arg) is `RouteContractOptions`:
`name?` · `middlewares?: MiddlewareHandler[]` · `params?` / `query?` / `body?` / `output?`
(Zod schemas) · `bind?: Record<string, BindableModel>` · plus OpenAPI metadata
(`summary?`, `description?`, `tags?`, `operationId?`, `deprecated?`).

Schemas attached here do double duty: requests are **validated automatically**
(422 before the controller runs) and `bunx guren codegen` extracts them into typed manifests.

`router.resource('/posts', PostController, { name?, param?, only?, except? })` registers
index/create/store/show/edit/update/destroy (GET/POST/PUT/DELETE, `:id` param) named `posts.index` etc.
Model binding: `bind: { id: Post }` + `this.model(Post)` in the controller.

## Route Schema Binding: concrete input → output

```typescript
const CreatePostSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string(),
  published: z.boolean().optional().default(false),
  tagIds: z.array(z.coerce.number().int()).optional(),
})
router.post('/posts', { name: 'posts.store', body: CreatePostSchema }, [PostController, 'store'])
```

generates this entry in `.guren/api-client.gen.ts`:

```typescript
export interface ApiRoutes {
  'posts.store': {
    method: 'POST'
    path: '/posts'
    params: Record<string, never>          // path params come from ':id' segments, typed string | number
    body: { title: string; body: string; published?: boolean; tagIds?: (number | string)[] }
  }
}
```

`body` is the **request** side of the schema — what a caller has to send, before
validation runs. That is why `tagIds` accepts a string above: `z.coerce.number()`
exists precisely so a form can send `"3"`. The controller still receives a
`number` from `validateBody()`. The most visible case is dates:
`z.coerce.date()` is a `string` in `body` (JSON has no date type) and a `Date`
once parsed.

Only **named** routes are emitted. `output:` schemas add a `response:` field,
which — describing a parsed response — uses the output side instead.
Consume with `createApiClient<ApiRoutes>({ baseUrl })` → `client.request('posts.store', { body })`.
Mutating requests copy the `XSRF-TOKEN` cookie into the `X-XSRF-TOKEN` header, so a
same-origin client passes CSRF protection without extra wiring. The token is never
copied to a `baseUrl` on another origin — that client passes its own `X-XSRF-TOKEN`
header (and `credentials: 'include'` plus CORS if it needs the session cookie sent).

## Which Zod constructs survive type extraction

Codegen walks schemas at runtime (Zod v3 and v4):

- **Typed**: primitives (`string`/`number`/`boolean`/`bigint`/`date`), `literal`, `enum`,
  `array`, nested `object`, `union` / `discriminatedUnion`, `intersection`, `record`,
  `nullable` (`| null`)
- **Unwrapped transparently**: `.optional()` and `.default()` (field becomes `key?:`),
  `.catch()`, `.readonly()`, `.brand()`, `.lazy()`
- **Validation checks don't change the type**: `.min()`, `.max()`, `.trim()`, `.email()`,
  regex etc. stay `string`
- **Coercion follows the side being rendered**: `z.coerce.number()` is `number | string`
  in `body` and `number` in `response`; `z.coerce.date()` is `string` then `Date`
- **`.transform()` extracts the input type**: the output of a transform function is a
  runtime value with no type to read, so it is NOT reflected on either side.
  `z.string().pipe(z.number())` — a real pipe, not a transform — does resolve both sides
- **Degrades**: `tuple` → `unknown[]`, `z.nativeEnum()` → `string | number`,
  unrecognized constructs → `unknown`

So `z.string().trim().min(1).optional().default('x')` survives as `key?: string`.
If a generated type comes out as `unknown`, simplify the construct instead of reading `node_modules`.

## When to re-run codegen

`bunx guren codegen` (or `bun run codegen`) regenerates `.guren/pages.gen.ts`,
`routes.gen.ts`, `data.gen.ts`, `api-client.gen.ts`. Re-run after changing:

- `routes/web.ts` (route names, paths, schemas)
- page components' `interface Props` in `resources/js/pages/`
- Resource classes in `app/Http/Resources/`

`bun run dev` runs codegen on start, and the Vite plugin watches those paths and
regenerates on change. In tests/CI, run it explicitly if generated types are stale.
