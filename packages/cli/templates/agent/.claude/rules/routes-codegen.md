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
    body: { title: string; body: string; published?: boolean; tagIds?: number[] }
  }
}
```

Only **named** routes are emitted. `output:` schemas add a `response:` field.
Consume with `createApiClient<ApiRoutes>({ baseUrl })` → `client.request('posts.store', { body })`.

## Which Zod constructs survive type extraction

Codegen walks schemas at runtime (Zod v3 and v4):

- **Typed**: primitives (`string`/`number`/`boolean`/`bigint`/`date`), `literal`, `enum`,
  `array`, nested `object`, `union` / `discriminatedUnion`, `intersection`, `record`,
  `nullable` (`| null`)
- **Unwrapped transparently**: `.optional()` and `.default()` (field becomes `key?:`),
  `.catch()`, `.readonly()`, `.brand()`, `.lazy()`
- **Validation checks don't change the type**: `.min()`, `.max()`, `.trim()`, `.email()`,
  regex etc. stay `string`; `z.coerce.number()` is `number`
- **Input side only**: `.transform()` / `.refine()` chains extract the schema's *input*
  type — transform output types are NOT reflected
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
