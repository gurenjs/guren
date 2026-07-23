# Authorization

Authorization determines what an authenticated user is allowed to do. Guren provides a policy-based authorization system inspired by Laravel.

The authorization gate is created automatically when your app boots — call `getGate()` anywhere after boot to define abilities and register policies. No manual setup is required.

## Gates

Gates are simple closures that determine if a user is authorized to perform a given action.

### Defining Gates

Define gates in `src/app.ts` (inside the boot callback) or a service provider:

```typescript
import { getGate } from '@guren/core'

const gate = getGate()

// Simple gate
gate.define('view-dashboard', (user) => {
  return user?.isAdmin === true
})

// Gate with a resource
gate.define('update-post', (user, post) => {
  return user?.id === post.userId
})

// Async gate with database check
gate.define('delete-comment', async (user, comment) => {
  const post = await Post.find(comment.postId)
  return user?.id === post?.userId
})
```

### Using Gates

Check authorization with a user bound via `forUser()`:

```typescript
import { getGate } from '@guren/core'

const gate = getGate().forUser(user)

// Check if allowed
const canView = await gate.allows('view-dashboard')

// Check if denied
const cannotView = await gate.denies('view-dashboard')

// With a resource
const canUpdate = await gate.allows('update-post', post)

// Authorize or throw
await gate.authorize('update-post', post)
// Throws AuthorizationException (403) if denied
```

### Before Callbacks

Register a callback that runs before all gate checks:

```typescript
getGate().before((user, ability) => {
  // Super admins can do everything
  if (user?.isSuperAdmin) {
    return true
  }
  // Return undefined to continue to the gate
})
```

### After Callbacks

Register a callback that runs after all gate checks:

```typescript
getGate().after((user, ability, result) => {
  // Log authorization attempts
  logger.info(`User ${user?.id} ${result ? 'allowed' : 'denied'} for ${ability}`)
})
```

## Policies

Policies organize authorization logic around a particular model or resource.

### Creating Policies

Scaffold a policy with the CLI:

```bash
bunx guren make:policy Post
```

Or write one by hand:

```typescript
import { Policy, type AuthUser } from '@guren/core'
import type { PostRecord } from '../Models/Post'

export class PostPolicy extends Policy {
  /**
   * Determine if the user can view any posts.
   */
  viewAny(user: AuthUser | null): boolean {
    return true
  }

  /**
   * Determine if the user can view the post.
   */
  view(user: AuthUser | null, post: PostRecord): boolean {
    return post.published || user?.id === post.userId
  }

  /**
   * Determine if the user can create posts.
   */
  create(user: AuthUser | null): boolean {
    return user !== null
  }

  /**
   * Determine if the user can update the post.
   */
  update(user: AuthUser | null, post: PostRecord): boolean {
    return user?.id === post.userId
  }

  /**
   * Determine if the user can delete the post.
   */
  delete(user: AuthUser | null, post: PostRecord): boolean {
    return user?.id === post.userId
  }
}
```

### Registering Policies

Register policies on the gate in `src/app.ts` (inside the boot callback) or a service provider:

```typescript
import { getGate } from '@guren/core'
import { PostPolicy } from '../app/Policies/PostPolicy'
import { Post } from '../app/Models/Post'

// Register by model class
getGate().policy(Post, PostPolicy)

// Or by string key
getGate().policy('post', PostPolicy)
```

### Using Policies

ORM queries return plain records without constructor information, so pass the model class alongside the record to resolve the policy:

```typescript
import { getGate } from '@guren/core'

const gate = getGate().forUser(user)
const post = await Post.findOrFail(id)

// Pass [ModelClass, record] for ORM records
const canUpdate = await gate.allows('update', [Post, post])

// Abilities without a record take the bare class
const canCreate = await gate.allows('create', Post)

// String keys work the same way
const canDelete = await gate.allows('delete', ['post', post])

// Authorize with exception (throws AuthorizationException, 403)
await gate.authorize('update', [Post, post])
```

Class instances (objects created with `new`) resolve their policy automatically without the tuple:

```typescript
const canView = await gate.allows('view', somePostInstance)
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
export class PostPolicy extends Policy {
  before(user: AuthUser | null, ability: string): boolean | undefined {
    // Admins can do anything with posts
    if (user !== null && (user as { isAdmin?: boolean }).isAdmin) {
      return true
    }
    // Return undefined to continue to specific method
  }
}
```

## Controller Integration

Controllers ship with `authorize()` and `can()` helpers. They resolve the current user from the auth context automatically (guests are `null`):

```typescript
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '@/app/Models/Post'
import { PostResource } from '@/app/Http/Resources/PostResource'

export default class PostController extends Controller {
  async show() {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)

    // Throws AuthorizationException (403) when denied
    await this.authorize('view', [Post, post])

    return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
  }

  async update() {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)

    // Check without throwing
    if (!(await this.can('update', [Post, post]))) {
      return this.json({ error: 'Unauthorized' }, 403)
    }

    // Update logic...
  }
}
```

> **Tip:** `bunx guren make:feature Post --policy` scaffolds the policy and wires `authorize()` calls into `store`/`update`/`destroy` for you.

## Middleware

Create authorization middleware for route-level checks:

```typescript
import { type Router, getGate, AuthorizationException, defineMiddleware } from '@guren/core'

export function authorizeAbility(ability: string) {
  return defineMiddleware(async (ctx, next) => {
    const user = ctx.get('user') ?? null

    if (await getGate().forUser(user).denies(ability)) {
      throw new AuthorizationException()
    }

    await next()
  })
}

// Usage in routes
export function registerWebRoutes(router: Router): void {
  router.get('/admin', [AdminController, 'index'], authorizeAbility('access-admin'))
}
```

## Best Practices

1. **Use policies for model-specific logic** - Keep authorization organized by model.
2. **Keep gates simple** - Use gates for abilities not tied to a specific model.
3. **Cache expensive checks** - If authorization requires database queries, consider caching.
4. **Use before callbacks sparingly** - They can make debugging harder if overused.
5. **Test authorization** - Write tests for your gates and policies.

## Testing Authorization

Instantiate a fresh `Gate` per test instead of relying on the global instance:

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { Gate } from '@guren/core'
import { PostPolicy } from '../app/Policies/PostPolicy'

describe('PostPolicy', () => {
  let gate: Gate

  beforeEach(() => {
    gate = new Gate()
    gate.policy('post', PostPolicy)
  })

  it('allows owner to update post', async () => {
    const user = { id: 1 }
    const post = { id: 1, userId: 1 }

    expect(await gate.forUser(user).allows('update', ['post', post])).toBe(true)
  })

  it('denies non-owner from updating post', async () => {
    const user = { id: 2 }
    const post = { id: 1, userId: 1 }

    expect(await gate.forUser(user).denies('update', ['post', post])).toBe(true)
  })
})
```
