---
paths:
  - "routes/**"
  - "app/Http/Validators/**"
  - "modules/*/routes.ts"
  - "modules/*/routes/**"
  - "modules/*/app/Http/Validators/**"
---

# Routes & Codegen

## Registering routes

```typescript
import { Router, requireAuthenticated } from '@guren/core'

export function registerWebRoutes(baseRouter: Router): void {
  // aliasMiddleware() returns a Router carrying the alias name in its type —
  // capture it, or a later .middleware('auth') will not compile.
  const router = baseRouter.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))

  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.post('/posts', { name: 'posts.store', body: CreatePostSchema }, [PostController, 'store'])
  router.middleware('auth').group((group) => {
    group.get('/dashboard', [DashboardController, 'index'])
  })
}
```

A new `routes/*.ts` file registers nothing until a registrar reachable from
`routes/web.ts` calls its exported function; `guren check` reports one that is not.

Options (second argument): `name?` · `middlewares?` · `params?` / `query?` /
`body?` / `output?` (Zod schemas, validated before the action: 422) ·
`bind?` (`{ id: Post }` or `{ slug: [Post, 'slug'] }`) · `agent?`.
`router.resource('/posts', PostController, { only?, except? })` registers the
seven actions named `posts.index` etc. Verbs: `get / post / put / patch / delete / query`
(`query` is HTTP QUERY: safe, carries a body, never for mutations).

## Codegen

`bunx guren codegen` regenerates `.guren/pages.gen.ts`, `routes.gen.ts`,
`data.gen.ts`, `api-client.gen.ts`. Re-run after changing route names, paths or
schemas, a page's `interface Props`, or a Resource class. Schema types are read
from the request side (`z.coerce.number()` is `number | string` in `body`); a
`.transform()` output is not reflected, and an unsupported construct comes out
`unknown`: simplify the schema instead of reading `node_modules`.

Agent tools (`.agent()`), the generated `ApiRoutes` shape, `createApiClient`
and CSRF, and which Zod constructs survive extraction:
`__SKILLS_DIR__/guren-api/reference/routes-codegen.md`.
