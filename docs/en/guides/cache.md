# Cache Guide

The cache stores the result of slow work, such as a database query or a computation, under a key so the next request can read it back. Add it with `bunx guren add cache`, pick a backend with `CACHE_STORE`, and read the cache from the container as `cache`.

## Core Concepts

- **CacheManager**: the registry of configured stores. `config/cache.ts` binds it in the container as `cache`.
- **CacheStore**: one backend's operations (get, set, delete, and so on). `cache.store()` returns the default one.
- **Drivers**: the backends. `memory` (the default), `redis` and `file`.
- **TaggedCache**: a view of a store that groups keys under tags, so you can delete them together.

## Setup

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

The callback receives the validated environment, so every key it reads must be declared in `config/env.ts`. See the [configuration guide](./configuration.md) for declaring variables and for how definitions boot. Apps that configure the cache in a service provider keep working; see [Apps with service providers](./configuration.md#apps-with-service-providers).

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

## Getting the Cache

Resolve the manager the definition binds as `cache`, then pick a store from it:

| Where you are | How to get it |
|---------------|---------------|
| A controller | `this.make('cache')` |
| A service provider | `this.container.make('cache')` |
| Anywhere else (a service, a job) | `resolve<CacheManager>('cache')`, imported from `@guren/core` |

```ts
const cache = this.make('cache') // CacheManager

await cache.store().set('key', 'value')             // the default store (CACHE_STORE)
await cache.store('memory').set('temp', 'data', 60) // a named store
```

The rest of this page writes `cache` for that manager.

A facade gives the same manager without resolving it each time:

```ts
import { createFacades } from '@guren/core'

const { Cache } = createFacades(app.container)

await Cache.store().set('user:1', { name: 'John' }, 3600)
```

`new CacheManager()` builds a separate manager with one in-memory store and no configuration. It suits a script or a unit test, not application code, which should share the configured one.

## Basic Usage

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

TTLs are in seconds. Incrementing or decrementing a counter keeps its original expiration.

### Remember Pattern

`remember` returns the cached value, or runs the callback, stores its result and returns it:

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

When several requests miss the same key at once, the callback runs only once; see [Concurrent Misses](#concurrent-misses) for what they share.

## Tagged Cache

Tags group related keys so you can delete them together:

```ts
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

The built-in stores all support tags. A custom store used with tags must implement an atomic `add(key, value): Promise<boolean>`: insert without expiration only when the key is absent, and return whether it inserted.

## Use Cases

### Caching Database Queries

```ts
import { resolve, type CacheManager } from '@guren/core'
import { Post } from '@/app/Models/Post'

const cache = () => resolve<CacheManager>('cache')

export async function getRecentPosts(): Promise<Post[]> {
  return cache().store().remember('posts:recent', 300, async () => {
    return await Post.orderBy('createdAt', 'desc').limit(10).get()
  })
}

export async function getPost(id: number): Promise<Post | null> {
  return cache().store().tags(['posts', `post:${id}`]).remember(
    `post:${id}`,
    3600,
    async () => Post.find(id)
  )
}

// Invalidate when post is updated
export async function updatePost(id: number, data: Partial<Post>): Promise<void> {
  await Post.where('id', id).update(data)
  await cache().store().tags([`post:${id}`]).flush()
}
```

### Rate Limiting Data

```ts
import { resolve, type CacheManager } from '@guren/core'

const cache = () => resolve<CacheManager>('cache')

export async function checkRateLimit(ip: string, limit: number): Promise<boolean> {
  const key = `ratelimit:${ip}`
  const current = await cache().store().get<number>(key) ?? 0

  if (current >= limit) {
    return false
  }

  await cache().store().increment(key)

  // Set TTL only on first request
  if (current === 0) {
    await cache().store().set(key, 1, 60) // 1-minute window
  }

  return true
}
```

For request throttling, the [rate limiting middleware](./rate-limiting.md) already does this.

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

## Concurrent Misses

When several calls in one process miss the same key with the same TTL at the same time, the callback runs once and every one of those callers gets its outcome: the same object, or the same error. A callback that throws caches nothing, so the next call runs it again. Hits are not shared: each concurrent hit gets what `get()` returns.

Which calls share a callback:

- `remember` and `rememberForever` on a store from `cache.store()`, including stores added with `registerStore()`, and on tagged caches, including one built with `new TaggedCache(store, tags)`.
- Only calls through the same store instance. Two `CacheManager`s, or two store names that point at one Redis, each run their own callback.
- Not a store you construct and call directly, such as `new MemoryStore()` or `new FileStore(...)`.
- Not across processes (or isolates, on Cloudflare Workers). Two servers that miss the same key at once each run the callback.

What to keep in mind:

- **Treat the result as read-only.** Callers that missed together share one object, so a change made by one is visible to the others; copy it first (`structuredClone(posts)`) if you need to modify it. The memory store also returns the stored object itself on every hit, so there a change alters the cached value too.
- **Keep the callback independent of the request.** It runs on behalf of every caller that joins it, so do not pass the first request's `AbortSignal` or read request state (the signed-in user, the locale) unless the key includes it. A failure caused by the first caller's request, such as an abort, reaches every caller that joined.
- **Different TTLs do not share.** `rememberForever` counts as a TTL of its own. Each callback stores its result with its own caller's TTL, and the last to finish wins: a `remember(key, 60, ...)` that finishes after a `rememberForever` leaves an entry that expires in 60 seconds.
- **Slow callbacks stop being shared after 10 seconds.** A call that arrives 10 seconds or more after the running callback started runs its own instead of waiting. Callers already waiting stay with the first, so give slow I/O inside a callback its own timeout.
- **A write starts a new round.** Writing the key through the same store instance (`set`, `delete`, `setMany`, `deleteMany`, `clear`, or a tagged cache's `set` and `delete`) makes later misses start a new callback. The running callback is not cancelled: it still stores its result when it finishes, which can replace the value the write stored.

## Driver Options

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

### Cleaning up the file store

Reading an expired entry with `get()`, `has()` or `ttl()` reports it as missing but leaves its file on disk. Call `cleanup()` periodically to delete expired files, for example from a [scheduled callback](./scheduling.md#callbacks), on a store with the same `path` and `extension` as the configured one (files with another extension are skipped):

```ts
import { FileCacheStore } from '@guren/core'

const removed = await new FileCacheStore({ path: './storage/cache', extension: '.cache' }).cleanup()
```

`cleanup()` is safe to run beside live writes. It takes the same per-key lock as `add()`, `increment()`, `decrement()` and `delete()`, moves each expired file aside and checks it again, and puts back an entry that `set()` wrote in the meantime. Reads of that key miss while its file is aside.

### Counters on the file store

On the file store, `add()`, `increment()` and `decrement()` take a filesystem lock that store instances and processes share. A lock held for five seconds is treated as abandoned by a crashed process and taken over, so a key never stays locked. A writer that was only slow (a suspended process, a stalled disk) then runs alongside the one that took over, and one of their updates can be lost. Keep counters that several processes update, and that must not lose an update, on the Redis store.

## Testing

### Using `container.fake()`

To give the app a fresh in-memory cache for one test, bind a new `CacheManager` over `cache` with `container.fake()`. The `using` declaration restores the real one when the test ends:

```ts
import { beforeAll, describe, expect, test } from 'bun:test'
import { CacheManager } from '@guren/core'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

describe('Cache in application code', () => {
  beforeAll(async () => {
    await TestApp.fromApp(app)
  })

  test('uses a fake cache manager', async () => {
    using _ = app.container.fake('cache', new CacheManager())

    // Everything that resolves 'cache' (including facades) now gets the fake
    const cache = app.container.make('cache')
    await cache.store().set('key', 'value', 3600)
    expect(await cache.store().get('key')).toBe('value')
  })
})
```

### Using the Memory Store Directly

To unit-test cache logic on its own, build a manager per test:

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

1. **Set TTLs from how often the data changes.** Short for feeds, long for settings.
2. **Tag related data** by entity or feature, so one `flush()` invalidates it.
3. **Cache data, not responses.** Cache query results and computations rather than whole controller responses.
4. **Use Redis in production.** The memory store is per process and empties on restart.
5. **Do not cache secrets.** Keep passwords, tokens and other credentials out of the cache.
