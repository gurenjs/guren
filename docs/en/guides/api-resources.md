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

## Best Practices

1. **Keep resources focused** - One resource per model transformation
2. **Use whenLoaded for relations** - Prevents N+1 issues by only including loaded relations
3. **Transform dates consistently** - Use `.toISOString()` for date fields
4. **Hide sensitive data** - Never expose passwords, tokens, or internal IDs
5. **Use cursor pagination for large datasets** - Better performance than offset pagination
