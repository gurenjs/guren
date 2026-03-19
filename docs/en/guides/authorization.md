# Authorization

Authorization determines what an authenticated user is allowed to do. Guren provides a powerful policy-based authorization system inspired by Laravel.

## Gates

Gates are simple closures that determine if a user is authorized to perform a given action.

### Defining Gates

Define gates using the `Gate` class:

```typescript
import { Gate } from '@guren/server'

// Simple gate
Gate.define('view-dashboard', (user) => {
  return user.isAdmin
})

// Gate with a resource
Gate.define('update-post', (user, post) => {
  return user.id === post.userId
})

// Async gate with database check
Gate.define('delete-comment', async (user, comment) => {
  const post = await Post.find(comment.postId)
  return user.id === post?.userId
})
```

### Using Gates

Check authorization using gate methods:

```typescript
import { Gate } from '@guren/server'

// Check if allowed
const canView = await Gate.allows('view-dashboard', user)

// Check if denied
const cannotView = await Gate.denies('view-dashboard', user)

// With a resource
const canUpdate = await Gate.allows('update-post', user, post)

// Authorize or throw
await Gate.authorize('update-post', user, post)
// Throws AuthorizationException if denied
```

### Before Callbacks

Register a callback that runs before all gate checks:

```typescript
Gate.before((user, ability) => {
  // Super admins can do everything
  if (user.isSuperAdmin) {
    return true
  }
  // Return undefined to continue to the gate
})
```

### After Callbacks

Register a callback that runs after all gate checks:

```typescript
Gate.after((user, ability, result) => {
  // Log authorization attempts
  logger.info(`User ${user.id} ${result ? 'allowed' : 'denied'} for ${ability}`)
})
```

## Policies

Policies organize authorization logic around a particular model or resource.

### Creating Policies

```typescript
import { Policy } from '@guren/server'
import type { User } from '../Models/User'
import type { Post } from '../Models/Post'

export class PostPolicy extends Policy<User, Post> {
  /**
   * Determine if the user can view any posts.
   */
  viewAny(user: User): boolean {
    return true
  }

  /**
   * Determine if the user can view the post.
   */
  view(user: User, post: Post): boolean {
    return post.published || user.id === post.userId
  }

  /**
   * Determine if the user can create posts.
   */
  create(user: User): boolean {
    return user.verified
  }

  /**
   * Determine if the user can update the post.
   */
  update(user: User, post: Post): boolean {
    return user.id === post.userId
  }

  /**
   * Determine if the user can delete the post.
   */
  delete(user: User, post: Post): boolean {
    return user.id === post.userId
  }

  /**
   * Determine if the user can restore the post.
   */
  restore(user: User, post: Post): boolean {
    return user.id === post.userId
  }

  /**
   * Determine if the user can permanently delete the post.
   */
  forceDelete(user: User, post: Post): boolean {
    return user.isAdmin
  }
}
```

### Registering Policies

Register policies with the Gate class:

```typescript
import { Gate } from '@guren/server'
import { PostPolicy } from './Policies/PostPolicy'
import { Post } from './Models/Post'

// Register by model class
Gate.policy(Post, new PostPolicy())

// Or by string key
Gate.policy('post', new PostPolicy())
```

### Using Policies

```typescript
// Check policy via Gate
const canUpdate = await Gate.allows('update', user, post)

// Or use forUser for chainable checks
const canDelete = await Gate.forUser(user).allows('delete', post)

// Authorize with exception
await Gate.forUser(user).authorize('update', post)
```

### Policy Methods

Policies support these standard methods:

| Method | Description |
|--------|-------------|
| `viewAny` | Can view any/all resources |
| `view` | Can view a specific resource |
| `create` | Can create new resources |
| `update` | Can update a resource |
| `delete` | Can delete a resource |
| `restore` | Can restore a soft-deleted resource |
| `forceDelete` | Can permanently delete a resource |

### Before Method

Add a `before` method to intercept all policy checks:

```typescript
export class PostPolicy extends Policy<User, Post> {
  before(user: User, ability: string): boolean | undefined {
    // Admins can do anything with posts
    if (user.isAdmin) {
      return true
    }
    // Return undefined to continue to specific method
  }
}
```

## Controller Integration

Use authorization in controllers:

```typescript
import { Controller, Gate } from '@guren/server'

export default class PostController extends Controller {
  async show(id: number) {
    const post = await Post.find(id)

    // Authorize using Gate
    await Gate.authorize('view', this.user(), post)

    return this.inertia('posts/Show', { post })
  }

  async update(id: number) {
    const post = await Post.find(id)

    // Check permission manually
    if (await Gate.denies('update', this.user(), post)) {
      return this.json({ error: 'Unauthorized' }, 403)
    }

    // Update logic...
  }
}
```

## Middleware

Create authorization middleware for route-level checks:

```typescript
import { Gate, AuthorizationException } from '@guren/server'

export function authorize(ability: string) {
  return async (ctx, next) => {
    const user = ctx.get('user')

    if (!user || await Gate.denies(ability, user)) {
      throw new AuthorizationException()
    }

    return next()
  }
}

// Usage in routes
Route.get('/admin', AdminController, 'index').middleware(authorize('access-admin'))
```

## Best Practices

1. **Use policies for model-specific logic** - Keep authorization organized by model.
2. **Keep gates simple** - Use gates for abilities not tied to a specific model.
3. **Cache expensive checks** - If authorization requires database queries, consider caching.
4. **Use before callbacks sparingly** - They can make debugging harder if overused.
5. **Test authorization** - Write tests for your gates and policies.

## Testing Authorization

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { Gate } from '@guren/server'

describe('PostPolicy', () => {
  beforeEach(() => {
    Gate.clear()
    Gate.policy('post', new PostPolicy())
  })

  it('allows owner to update post', async () => {
    const user = { id: 1 }
    const post = { id: 1, userId: 1 }

    expect(await Gate.allows('update', user, post)).toBe(true)
  })

  it('denies non-owner from updating post', async () => {
    const user = { id: 2 }
    const post = { id: 1, userId: 1 }

    expect(await Gate.denies('update', user, post)).toBe(true)
  })
})
```
