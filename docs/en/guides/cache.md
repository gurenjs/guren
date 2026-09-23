# Cache Guide

Guren provides a unified caching API with support for multiple storage backends. Caching helps improve application performance by storing expensive computations or database queries for quick retrieval.

The standard path is: import cache APIs from `@guren/core`, configure the stores in `config/cache.ts`, and keep services responsible for cache keys and invalidation.

## Core Concepts

- **CacheStore** – Interface for cache operations (get, set, delete, etc.). All drivers implement this interface.
- **CacheManager** – Central registry for configuring and accessing multiple cache stores.
- **TaggedCache** – Allows grouping cache items by tags for bulk invalidation.
- **Drivers** – Storage backends: Memory (default), Redis, and File.

## Basic Usage

### Quick Start (Container-bound Facade)

The simplest way to use the cache without passing a manager around is to create facades from an application container:

```ts
import { createFacades } from '@guren/core'

const { Cache } = createFacades(app.container)

// Store a value (TTL in seconds)
await Cache.store().set('user:1', { name: 'John' }, 3600)

// Retrieve a value
const user = await Cache.store().get<{ name: string }>('user:1')

// Check if key exists
const exists = await Cache.store().has('user:1')

// Delete a value
await Cache.store().delete('user:1')
```

### Direct Instantiation

You can also create a `CacheManager` directly:

```ts
import { CacheManager } from '@guren/core'

const cache = new CacheManager()

await cache.store().set('user:1', { name: 'John' }, 3600)
const user = await cache.store().get<{ name: string }>('user:1')
```

### Cache Operations

```ts
const store = cache.store()

// Basic operations
await store.set('key', 'value', 3600)  // Set with 3600s TTL
await store.set('key', 'value')         // Set without expiration
const value = await store.get<string>('key')
const exists = await store.has('key')
await store.delete('key')
await store.clear()                     // Clear all items

// Increment/Decrement
await store.set('counter', 0)
await store.increment('counter')        // 1
await store.increment('counter', 5)     // 6
await store.decrement('counter', 2)     // 4

// Get remaining TTL (in seconds)
const ttl = await store.ttl('key')      // -1 = no expiration, -2 = not found

// Batch operations
await store.setMany(new Map([
  ['key1', 'value1'],
  ['key2', 'value2'],
]), 3600)

const values = await store.getMany<string>(['key1', 'key2'])
const deleted = await store.deleteMany(['key1', 'key2'])
```

### Remember Pattern

The `remember` method is ideal for caching database queries or expensive computations:

```ts
// Cache for 1 hour, compute if not cached
const posts = await cache.store().remember('posts:recent', 3600, async () => {
  return await Post.orderBy('createdAt', 'desc').limit(10).get()
})

// Cache forever until manually cleared
const settings = await cache.store().rememberForever('app:settings', async () => {
  return await Settings.all()
})
```

### Concurrent Misses

When several calls in one process miss the same key with the same TTL at the same time, the callback runs once and every one of those callers gets its outcome: the same object, or the same error. A callback that throws caches nothing, so the next call runs it again. Hits are not shared: each concurrent hit gets what `get()` returns.

This applies to `remember` and `rememberForever` on a store from `cache.store()`, including stores added with `registerStore()`, and on tagged caches, including one you build with `new TaggedCache(store, tags)`. Only calls through the same store instance share a callback: two `CacheManager`s, or two store names that point at one Redis, each run their own. A store you construct and call directly, such as `new MemoryStore()` or `new FileStore(...)`, does not share callbacks.

Sharing stops at the process boundary (the isolate, on Cloudflare Workers). Two servers that miss the same key at once each run the callback.

- Callers that missed together share one object, so treat the result as read-only: a change made by one caller is visible to the others. Copy it first (`structuredClone(posts)`) if you need to modify it. The memory store returns the stored object itself on every hit as well, so there a change also alters the cached value.
- The callback runs on behalf of every caller that joins it, so keep it independent of the request that started it. Do not pass that request's `AbortSignal`, and do not read request state such as the signed-in user or the locale unless the key includes it. A failure caused by the first caller's request, such as an abort, reaches every caller that joined.
- Calls with different TTLs do not share a callback, and `rememberForever` counts as a TTL of its own. Each callback stores its result with its own caller's TTL, and the one that finishes last overwrites the others: a `remember(key, 60, ...)` that finishes after a `rememberForever` leaves an entry that expires in 60 seconds.
- A call that arrives 10 seconds or more after the running callback started runs its own callback instead of waiting. Callers already waiting stay with the first callback, so give slow I/O inside a callback its own timeout.
- Writing the key through the same store instance (`set`, `delete`, `setMany`, `deleteMany`, `clear`, or a tagged cache's `set` and `delete`) makes later misses start a new callback instead of joining one that began before the write. The running callback is not cancelled: it still stores its result when it finishes, which can replace the value the write stored.

## Configuration

`bunx guren add cache` writes `config/cache.ts`, declares `CACHE_STORE` in `config/env.ts`, and adds the definition to `createApp({ config })`:

```ts
// config/cache.ts
import { defineCacheConfig } from '@guren/core'

// CACHE_STORE picks the store. `memory` is per-process: correct on one
// long-lived server, wrong on Workers, Lambda and Vercel, where two requests
// can land in different instances.
export default defineCacheConfig((env) => ({
  default: env.CACHE_STORE,
  stores: {
    memory: { driver: 'memory' },
    // For Redis, add `createRedisClient` from '@guren/core/redis' and a
    // `redis: { driver: 'redis', client: () => createRedisClient({ url: env.REDIS_URL }) }`
    // entry, with REDIS_URL declared in config/env.ts. Import it only where you use
    // it, since that module pulls in ioredis. The function runs when the store is
    // first resolved, so no connection opens until CACHE_STORE selects it.
  },
}))
```

```ts
// src/app.ts
import cache from '../config/cache.js'

const app = createApp({
  env,
  config: [database, http, cache],
  routes: registerWebRoutes,
})
```

The callback receives the validated environment, so every key it reads must be declared in `config/env.ts`. See the [configuration guide](./configuration.md) for declaring variables and for how definitions boot.

### Multiple Stores

Declare every backend the app may use under `stores`, and let `CACHE_STORE` pick the default:

```ts
// config/cache.ts
import { defineCacheConfig } from '@guren/core'
import { createRedisClient } from '@guren/core/redis'

export default defineCacheConfig((env) => ({
  default: env.CACHE_STORE,
  stores: {
    memory: {
      driver: 'memory',
      maxSize: 1000,       // Max items (default: Infinity)
      checkPeriod: 60000,  // Cleanup interval in ms (default: 60000)
    },
    redis: {
      driver: 'redis',
      // `client` may be a function: it runs when this store is first used, so a
      // store that is declared but not selected opens no connection.
      client: () => createRedisClient({ url: env.REDIS_URL }),
      prefix: 'myapp:cache:', // Key prefix (default: 'cache:')
    },
    file: {
      driver: 'file',
      path: './storage/cache',
      extension: '.cache',    // File extension (default: '.cache')
    },
  },
}))
```

The name in `CACHE_STORE` is not checked at boot. A name missing from `stores` throws `Cache store not found` the first time the store is resolved.

The definition binds the manager as `cache` in the container:

```ts
const cache = app.container.make('cache') // CacheManager

// Use default store (CACHE_STORE)
await cache.store().set('key', 'value')

// Use specific store
await cache.store('memory').set('temp', 'data', 60)
await cache.store('file').set('persistent', 'data')
```

Apps that configure the cache in a service provider keep working; see [Apps with service providers](./configuration.md#apps-with-service-providers).

### Driver Options

**Memory Store:**
| Option | Default | Description |
|--------|---------|-------------|
| `maxSize` | `Infinity` | Maximum number of items |
| `checkPeriod` | `60000` | Cleanup interval for expired items (ms) |
| `now` | `Date.now` | Clock for TTL calculations (epoch ms); injectable for tests |

**Redis Store:**
| Option | Default | Description |
|--------|---------|-------------|
| `client` | required | An ioredis client, or a function returning one synchronously (called when the store is first used) |
| `prefix` | `'cache:'` | Key prefix for all cache keys |

**File Store:**
| Option | Default | Description |
|--------|---------|-------------|
| `path` | required | Directory path for cache files |
| `extension` | `'.cache'` | File extension for cache files |
| `now` | `Date.now` | Clock for TTL calculations (epoch ms); injectable for tests |

## Tagged Cache

Counters preserve their original expiration when incremented or decremented. File counters use filesystem locks shared by store instances and processes, with atomic file replacement. A lock wait exceeding five seconds throws; remove an abandoned `.lock` directory only after confirming its writer has stopped.

Custom stores used with tags must implement atomic `add(key, value): Promise<boolean>`: insert without expiration only when the key is absent, and return whether insertion succeeded. Built-in stores implement this operation.

Tags allow you to group related cache items for easy invalidation:

```ts
const cache = new CacheManager()

// Store items with tags
await cache.store().tags(['posts', 'user:1']).set('user:1:posts', posts, 3600)
await cache.store().tags(['posts', 'user:2']).set('user:2:posts', posts, 3600)
await cache.store().tags(['comments', 'user:1']).set('user:1:comments', comments)

// Retrieve tagged items
const userPosts = await cache.store().tags(['posts', 'user:1']).get('user:1:posts')

// Flush all items with specific tags
await cache.store().tags(['user:1']).flush()  // Removes user:1:posts and user:1:comments

// Flush all posts
await cache.store().tags(['posts']).flush()   // Removes all post caches
```

### Common Tag Patterns

```ts
// Model-based caching
await cache.store().tags([`posts`, `post:${post.id}`]).set(`post:${post.id}`, post)

// Invalidate on update
await post.save()
await cache.store().tags([`post:${post.id}`]).flush()

// Invalidate all posts
await cache.store().tags(['posts']).flush()

// User-specific caching
await cache.store().tags([`user:${userId}`, 'dashboard']).set(
  `user:${userId}:dashboard`,
  dashboardData,
  300
)

// Clear all user data on logout
await cache.store().tags([`user:${userId}`]).flush()
```

## Use Cases

### Caching Database Queries

```ts
import { CacheManager } from '@guren/core'
import { Post } from '@/app/Models/Post'

const cache = new CacheManager()

export async function getRecentPosts(): Promise<Post[]> {
  return cache.store().remember('posts:recent', 300, async () => {
    return await Post.orderBy('createdAt', 'desc').limit(10).get()
  })
}

export async function getPost(id: number): Promise<Post | null> {
  return cache.store().tags(['posts', `post:${id}`]).remember(
    `post:${id}`,
    3600,
    async () => Post.find(id)
  )
}

// Invalidate when post is updated
export async function updatePost(id: number, data: Partial<Post>): Promise<void> {
  await Post.where('id', id).update(data)
  await cache.store().tags([`post:${id}`]).flush()
}
```

### Rate Limiting Data

```ts
const cache = new CacheManager()

export async function checkRateLimit(ip: string, limit: number): Promise<boolean> {
  const key = `ratelimit:${ip}`
  const current = await cache.store().get<number>(key) ?? 0

  if (current >= limit) {
    return false
  }

  await cache.store().increment(key)

  // Set TTL only on first request
  if (current === 0) {
    await cache.store().set(key, 1, 60) // 1-minute window
  }

  return true
}
```

### Session-like Data

```ts
import { resolve, type CacheManager } from '@guren/core'

// The app's cache as config/cache.ts configures it, with CACHE_STORE=redis
const cache = () => resolve<CacheManager>('cache')

export async function setUserPreferences(
  userId: string,
  preferences: Record<string, unknown>
): Promise<void> {
  await cache().store().set(`user:${userId}:prefs`, preferences, 86400) // 24 hours
}

export async function getUserPreferences(
  userId: string
): Promise<Record<string, unknown> | null> {
  return cache().store().get(`user:${userId}:prefs`)
}
```

## Container Integration

`config/cache.ts` binds the cache manager as a singleton. You can resolve it from the container:

```ts
// Access via app.container or this.container in providers

// Type-safe resolution
const cache = container.make('cache') // CacheManager
await cache.store().get('key')
```

## Testing

### Using `container.fake()`

In tests, you can swap the cache manager with a fake using `container.fake()` and the `using` declaration for automatic cleanup:

```ts
import { describe, test, expect } from 'bun:test'
// Access via app.container or this.container in providers
import { CacheManager } from '@guren/core'

describe('Cache in application code', () => {
  test('uses fake cache manager', async () => {
    const fakeCache = new CacheManager() // in-memory by default

    using _ = container.fake('cache', fakeCache)

    // All code that resolves 'cache' from the container (including facades)
    // now receives fakeCache
    const cache = container.make('cache')
    await cache.store().set('key', 'value', 3600)
    expect(await cache.store().get('key')).toBe('value')
  })
})
```

### Using the Memory Store Directly

Use the Memory store for unit testing cache logic:

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { CacheManager } from '@guren/core'

describe('Cache', () => {
  let cache: CacheManager

  beforeEach(async () => {
    cache = new CacheManager()
    await cache.store().clear()
  })

  test('stores and retrieves values', async () => {
    await cache.store().set('key', 'value', 3600)
    const value = await cache.store().get<string>('key')
    expect(value).toBe('value')
  })

  test('remember caches callback result', async () => {
    let callCount = 0

    const getValue = () => cache.store().remember('computed', 3600, async () => {
      callCount++
      return 'computed-value'
    })

    await getValue()
    await getValue()

    expect(callCount).toBe(1) // Callback only called once
  })

  test('tagged cache flushes correctly', async () => {
    await cache.store().tags(['posts']).set('post:1', 'data1')
    await cache.store().tags(['posts']).set('post:2', 'data2')
    await cache.store().tags(['users']).set('user:1', 'data3')

    await cache.store().tags(['posts']).flush()

    expect(await cache.store().tags(['posts']).get('post:1')).toBeNull()
    expect(await cache.store().tags(['posts']).get('post:2')).toBeNull()
    expect(await cache.store().tags(['users']).get('user:1')).toBe('data3')
  })
})
```

## Best Practices

1. **Use appropriate TTLs**: Set reasonable expiration times based on data volatility.

2. **Use tags for related data**: Group cache items by entity or feature for easy invalidation.

3. **Cache at the right level**: Cache database results, not controller responses.

4. **Handle cache misses gracefully**: Always provide fallback logic for cache misses.

5. **Use typed generics**: Specify types when retrieving values for type safety.

6. **Monitor cache hit rates**: Track cache effectiveness to optimize TTLs and strategies.

7. **Use Redis for production**: Memory cache doesn't persist across restarts; use Redis for production.

8. **Avoid caching sensitive data**: Don't cache passwords, tokens, or other sensitive information.
