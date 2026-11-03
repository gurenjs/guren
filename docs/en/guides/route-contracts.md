# Route Contracts

A route contract is the options object you pass as the second argument when you register a route. Its schemas validate the request before the action runs, and the same definitions type the generated route helpers and API client, feed the [OpenAPI document](./openapi.md) and describe the route's agent tool. Registering the route itself (paths, groups, names, middleware, model binding) is covered in [Routing](./routing.md).

## Declaring a Contract

Put the options object between the path and the handler. Write its schemas with the zod 4 API (`import { z } from 'zod'`). Schemas authored with the zod v3 API are refused by the structural tools with a warning (see [Validation](./validation.md)).

```ts
import { z } from 'zod'

const CreatePostSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
})

const PostIdParams = z.object({
  id: z.coerce.number().int().positive(),
})

router.post('/posts', {
  body: CreatePostSchema,
  name: 'posts.store',
}, [PostsController, 'store'])

router.get('/posts/:id', {
  params: PostIdParams,
  name: 'posts.show',
}, [PostsController, 'show'])
```

Available contract fields:

| Field | Purpose |
|-------|---------|
| `name` | Route name for URL generation and codegen |
| `params` | Zod schema for path parameters |
| `query` | Zod schema for query string parameters |
| `body` | Zod schema for the request body |
| `output` | Zod schema for the response body — validated on 2xx answers only, so error responses and redirects pass through as the application wrote them |
| `resource` | Resource class response hint — types the API client without a schema |
| `bind` | [Route model binding](./routing.md#route-model-binding) map — `{ id: Post }` (primary key) or `{ slug: [Post, 'slug'] }` (another column) |
| `middlewares` | Array of middleware handlers |

> [!NOTE]
> Repeated query keys reach the `query` schema as arrays (`?tag=a&tag=b` → `{ tag: ['a', 'b'] }`), while a key that appears once stays a string. See [Array-Style Query Parameters](./validation.md#array-style-query-parameters).

## Reading Validated Input

The `params`, `query` and `body` schemas are checked before the handler runs, for a controller action as much as for an inline handler. A request that fails one gets a 422 and the action never runs; on an Inertia request the errors are flashed back to the form, keyed by field path as `validateBody()` keys them.

The action reads what the schemas parsed with `this.validated()`, passing its own route name:

```ts
import type { UserRecord } from '@/app/Models/User'

export default class PostsController extends Controller {
  async store() {
    const { body } = this.validated('posts.store')
    const user = await this.auth.userOrFail<UserRecord>()
    const post = await Post.create(body, { set: { authorId: user.id } })
    return this.redirect(`/posts/${post.id}`)
  }
}
```

- Values arrive after coercion, defaults and transforms, so a `z.coerce.number()` param is a `number`. A segment the route declares no schema for is `undefined`.
- A field ending in `.transform()` is typed `unknown`, since codegen cannot read what the function returns. Follow it with a schema to type it: `z.string().transform(Number).pipe(z.number())` is a `number`.
- Once `guren codegen` has generated the route types, the route name is checked at compile time and the result is typed from the contract. A name other than the route being served throws at runtime.
- An action mounted on several routes, such as a PUT and a PATCH, passes every name: `this.validated(['posts.update', 'posts.patch'])`.
- The contract runs before the action, so an invalid body gets its 422 before a check inside the action (such as `this.auth.userOrFail()`) runs. When an unauthenticated request must get a 401 first, put the check in route middleware.

A route that declares no contract still validates with `validateBody()`, `validateQuery()` and `validateParams()` (see [Validation](./validation.md)).

## Resource Response Hints

Routes that answer with [API Resources](./api-resources.md) already have a response type: the one codegen extracts from the Resource class into `.guren/data.gen.ts`. Writing an `output` schema for such a route would restate that shape in Zod and leave two copies to drift. Declare the Resource itself instead:

```ts
import { PostResource } from '@/app/Http/Resources/PostResource'

router.get('/api/posts', {
  name: 'posts.index',
  resource: { data: [PostResource] },
}, [PostsController, 'index'])
```

The hint mirrors the JSON the controller builds: a bare class (`resource: PostResource`) for a single resource, a one-element array (`resource: [PostResource]`) for a collection, and a plain object for an envelope, where `{ data: [PostResource] }` matches `this.json({ data: PostResource.collection(posts) })`. Nesting works to any depth.

`guren codegen` resolves each class against `app/Http/Resources` (at the project root and inside every `modules/<name>/`) and types the generated API client's `json()` with the assembled shape (`{ data: Data.Post[] }` here).

| | `output` schema | `resource` hint |
|---|---|---|
| Checked at request time | Yes, on 2xx responses | No |
| Types the API client | Yes | Yes |
| Appears in the OpenAPI document | Yes | No (`openapi:generate` warns) |
| When both are set | Wins | Ignored |

If the hint names a Resource class codegen cannot find, codegen warns and leaves the response untyped.

> [!NOTE]
> Every leaf of the hint must be a Resource class. An envelope that mixes Resources with plain typed objects (a paginated response's `meta` and `links`, for example) cannot be expressed yet; bind an `output` schema for those routes instead.

## Agent Tools

A named route can be exposed to AI agents as an MCP tool by declaring `agent` metadata on it. Everything about the tool (its input schema, its output schema, its authorization) is derived from the contracts above; nothing is restated.

```ts
// Fluent
router
  .post('/posts', { body: CreatePostSchema, output: PostResponseSchema }, [PostsController, 'store'])
  .name('posts.store')
  .agent({ description: 'Create a blog post as the authenticated user.' })

// Or as a contract key
router.post('/posts', {
  name: 'posts.store',
  body: CreatePostSchema,
  agent: { description: 'Create a blog post as the authenticated user.' },
}, [PostsController, 'store'])
```

`resource()` takes the same metadata per action, and **an action not listed is not exposed**:

```ts
router.resource('/posts', PostsController, {
  agent: {
    index: { description: 'List posts.' },
    show: { description: 'Fetch one post by id.' },
  },
})
```

Exposure is opt-in per route, the tool name is the route name used verbatim, and a route with no `.name()` cannot become a tool. Declaring `agent` in the route options *and* chaining `.agent()` throws — declare it once.

`bunx guren tool:list` shows what an agent would see. For the metadata fields, the input/output derivation rules and the MCP endpoint, see the [Agent Interface guide](./agent-interface.md); for token scopes, approvals and the audit trail, see [Control and Audit Agent Tool Access](./agent-tool-governance.md).
