# API Resources

API Resources provide a transformation layer between your models and API responses. They give you fine-grained control over how data is serialized to JSON.

## Basic Usage

Create a resource by extending the `Resource` class:

```typescript
import { Resource } from '@guren/core'
import type { User } from '../Models/User'

export class UserResource extends Resource<User> {
  toArray() {
    return {
      id: this.resource.id,
      name: this.resource.name,
      email: this.resource.email,
      createdAt: this.resource.createdAt?.toISOString(),
    }
  }
}
```

### Using Resources in Controllers

```typescript
import { Controller } from '@guren/core'
import { UserResource } from '../Resources/UserResource'

export default class UserController extends Controller {
  async show(id: number) {
    const user = await User.find(id)

    return this.json({
      data: new UserResource(user).toJSON(),
    })
  }

  async index() {
    const users = await User.all()

    return this.json({
      data: UserResource.collection(users),
    })
  }
}
```

## Conditional Fields

Resources provide helper methods for conditionally including fields.

### when()

Include a field only when a condition is true:

```typescript
export class UserResource extends Resource<User> {
  toArray() {
    return {
      id: this.resource.id,
      name: this.resource.name,
      // Only include email for verified users
      email: this.when(this.resource.verified, this.resource.email),
      // Use a callback for computed values
      role: this.when(this.resource.isAdmin, () => 'admin'),
    }
  }
}
```

### whenLoaded()

Include a field only when a relation is loaded:

```typescript
export class PostResource extends Resource<Post> {
  toArray() {
    return {
      id: this.resource.id,
      title: this.resource.title,
      // Only include if author relation is loaded
      author: this.whenLoaded('author', () => ({
        id: this.resource.author?.id,
        name: this.resource.author?.name,
      })),
      // Include nested resource when loaded
      comments: this.whenLoaded('comments', () =>
        CommentResource.collection(this.resource.comments)
      ),
    }
  }
}
```

### whenNotNull()

Include a field only if it's not null:

```typescript
export class ProfileResource extends Resource<Profile> {
  toArray() {
    return {
      id: this.resource.id,
      bio: this.whenNotNull(this.resource.bio),
      avatarUrl: this.whenNotNull(this.resource.avatarUrl),
    }
  }
}
```

### whenOr()

Include a field with a default value:

```typescript
export class SettingsResource extends Resource<Settings> {
  toArray() {
    return {
      theme: this.whenOr(
        this.resource.theme !== undefined,
        this.resource.theme,
        'light' // default value
      ),
    }
  }
}
```

## Additional Data

Add extra data to the resource response:

```typescript
const resource = new UserResource(user)
  .additional({
    permissions: ['read', 'write'],
    meta: { version: '1.0' },
  })

return this.json({ data: resource.toJSON() })
// { id: 1, name: 'John', ..., permissions: [...], meta: {...} }
```

## Resource Collections

Transform an array of models into resources:

```typescript
// Static method
const users = await User.all()
const data = UserResource.collection(users)

// Or use the collect helper
import { collect } from '@guren/core'
const data = collect(users, UserResource)
```

## Pagination

Guren provides two pagination strategies.

### Offset-Based Pagination

Traditional pagination with page numbers:

```typescript
import { paginate, Paginator } from '@guren/core'

export default class UserController extends Controller {
  async index() {
    const page = Number(this.request.query('page') ?? 1)
    const perPage = Number(this.request.query('per_page') ?? 15)

    const result = await User.paginate({ page, perPage })

    const paginator = paginate(result, {
      path: '/api/users',
      query: { per_page: String(result.meta.perPage) },
    })

    return this.json(paginator.toResource(UserResource))
  }
}
```

**Response format:**

```json
{
  "data": [
    { "id": 1, "name": "John" },
    { "id": 2, "name": "Jane" }
  ],
  "meta": {
    "currentPage": 1,
    "lastPage": 5,
    "perPage": 15,
    "total": 75,
    "from": 1,
    "to": 15
  },
  "links": {
    "first": "/api/users?page=1&per_page=15",
    "last": "/api/users?page=5&per_page=15",
    "prev": null,
    "next": "/api/users?page=2&per_page=15",
    "pages": [
      { "page": 1, "url": "/api/users?page=1&per_page=15", "active": true },
      { "page": 2, "url": "/api/users?page=2&per_page=15", "active": false }
    ]
  }
}
```

### Cursor-Based Pagination

Ideal for infinite scroll and real-time data:

```typescript
import { cursorPaginate, CursorPaginator } from '@guren/core'

export default class PostController extends Controller {
  async index() {
    const cursor = this.request.query('cursor')
    const perPage = Number(this.request.query('per_page') ?? 20)

    const posts = await Post.query()
      .where('id', '>', decodeCursor(cursor) ?? 0)
      .orderBy('id', 'asc')
      .limit(perPage + 1)
      .all()

    const hasMore = posts.length > perPage
    const items = hasMore ? posts.slice(0, perPage) : posts

    const paginator = CursorPaginator.fromArray(items, cursor, perPage)

    return this.json(paginator.toResource(PostResource))
  }
}
```

**Response format:**

```json
{
  "data": [
    { "id": 101, "title": "Post 1" },
    { "id": 102, "title": "Post 2" }
  ],
  "meta": {
    "perPage": 20,
    "nextCursor": "MTAy",
    "prevCursor": null,
    "hasMore": true
  }
}
```

## Paginator Methods

### Offset Paginator

| Method | Description |
|--------|-------------|
| `items()` | Get paginated items |
| `total()` | Get total item count |
| `perPage()` | Get items per page |
| `currentPage()` | Get current page number |
| `lastPage()` | Get last page number |
| `hasMorePages()` | Check if more pages exist |
| `onFirstPage()` | Check if on first page |
| `onLastPage()` | Check if on last page |
| `firstItem()` | Get first item index (1-based) |
| `lastItem()` | Get last item index (1-based) |
| `meta()` | Get pagination metadata |
| `links()` | Get pagination links |
| `withPath(path)` | Set base URL path |
| `withQuery(query)` | Add query parameters |
| `toResource(Class)` | Transform with resource class |
| `toJSON()` | Get raw paginated response |

### Cursor Paginator

| Method | Description |
|--------|-------------|
| `items()` | Get paginated items |
| `perPage()` | Get items per page |
| `currentCursor()` | Get current cursor |
| `nextCursor()` | Get next page cursor |
| `prevCursor()` | Get previous page cursor |
| `hasMorePages()` | Check if more pages exist |
| `meta()` | Get cursor pagination metadata |
| `toResource(Class)` | Transform with resource class |

## JsonResource

For simple transformations without a custom class:

```typescript
import { JsonResource } from '@guren/core'

const user = { id: 1, name: 'John', password: 'secret' }
const resource = new JsonResource(user)
// Returns: { id: 1, name: 'John', password: 'secret' }
```

## Generating Resources

Use the CLI to generate a new resource:

```bash
bunx guren make:resource User
# Creates: app/Http/Resources/UserResource.ts
```

## Typing API Responses from Resources

`guren codegen` extracts each Resource's shape into `.guren/data.gen.ts` (as `Data.Post`, `Data.User`, …). A route that answers with a Resource can declare that shape as its response type — no Zod schema, no restating the fields — by naming the Resource in its route contract:

```ts
router.query('/posts/search', {
  name: 'posts.search',
  body: PostSearchSchema,
  resource: { data: [PostResource] },
}, [PostController, 'search'])
```

The generated API client then types `json()` for that route as `{ data: Data.Post[] }`. See [Resource Response Hints](./routing.md#resource-response-hints) for the hint syntax.

### Declaring the shape codegen reads

Extraction is source-level, so a Resource has to state its payload type in its own file — an object literal returned from an unannotated `toArray()` is correct TypeScript that codegen cannot read. Declare an interface named after the class and annotate `toArray()` with it, which is what `make:resource` scaffolds:

```ts
export interface UserResourceData {
  id: number
  name: string
}

export class UserResource extends Resource<User, UserResourceData> {
  toArray(): UserResourceData {
    return { id: this.resource.id, name: this.resource.name }
  }
}
```

The second type argument is the payload type, and passing it makes `toJSON()` report the same type. It defaults to `Record<string, unknown>`, so declare it whenever the result of `toJSON()` is handed straight to a page or an API client.

The interface must be declared in the resource's own file — one imported from a shared types module is not read. A Resource codegen cannot extract a type from is named in a `guren codegen` warning rather than dropped in silence, so a missing `Data.*` member always says why.

The payload type does not have to be a plain interface. An **exported** alias whose shape codegen cannot copy — one derived from a Zod schema, an intersection, a merged interface — is emitted as a reference to the declaration itself, so one schema can be the single source of truth for the runtime contract and the payload type alike:

```ts
export const UserResourceSchema = z.object({ id: z.number(), name: z.string() })
export type UserResourceData = z.infer<typeof UserResourceSchema>

export class UserResource extends Resource<User> {
  toArray(): UserResourceData {
    return UserResourceSchema.parse(this.resource)
  }
}
```

The declaration must be exported — `data.gen.ts` names it through the resource's module — and a generic type stays unsupported either way, since a reference has no type arguments to pass it.

### Resources inside modules

Codegen scans `app/Http/Resources` at the project root and inside every `modules/<name>/` directory. A module's Resource is emitted under a name qualified with its module, so `modules/billing/app/Http/Resources/InvoiceResource.ts` becomes `Data.BillingInvoice`. The qualifier is always applied, never only on collision — that way a type's name depends solely on where its class lives, and adding a second `InvoiceResource` elsewhere cannot rename one the frontend already imports.

A response hint carries only the Resource's class name, so two app roots that both declare an `InvoiceResource` make the hint unresolvable: codegen warns, naming both files, and leaves that route's response untyped rather than guessing which module's payload the route returns. Rename one of the classes to resolve it.

## Best Practices

1. **Keep resources focused** - One resource per model transformation
2. **Use whenLoaded for relations** - Prevents N+1 issues by only including loaded relations
3. **Transform dates consistently** - Use `.toISOString()` for date fields
4. **Hide sensitive data** - Never expose passwords, tokens, or internal IDs
5. **Use cursor pagination for large datasets** - Better performance than offset pagination
