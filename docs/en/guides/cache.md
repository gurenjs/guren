# Cache Guide

Guren provides a unified caching API with support for multiple storage backends. Caching helps improve application performance by storing expensive computations or database queries for quick retrieval.

## Core Concepts

- **CacheStore** – Interface for cache operations (get, set, delete, etc.). All drivers implement this interface.
- **CacheManager** – Central registry for configuring and accessing multiple cache stores.
- **TaggedCache** – Allows grouping cache items by tags for bulk invalidation.
- **Drivers** – Storage backends: Memory (default), Redis, and File.

## Basic Usage

### Quick Start

```ts
import { CacheManager } from '@guren/core'

const cache = new CacheManager()

// Store a value (TTL in seconds)
await cache.store().set('user:1', { name: 'John' }, 3600)

// Retrieve a value
const user = await cache.store().get<{ name: string }>('user:1')

// Check if key exists
const exists = await cache.store().has('user:1')

// Delete a value
await cache.store().delete('user:1')
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

## Configuration

### Multiple Stores

Configure multiple cache backends in your application:

```ts
import { CacheManager } from '@guren/core'
import { createRedisClient } from '@guren/core'

const redis = createRedisClient({ url: process.env.REDIS_URL })

const cache = new CacheManager({
  default: 'redis',
  stores: {
    memory: {
      driver: 'memory',
      maxSize: 1000,       // Max items (default: Infinity)
      checkPeriod: 60000,  // Cleanup interval in ms (default: 60000)
    },
    redis: {
      driver: 'redis',
      client: redis,
      prefix: 'myapp:cache:', // Key prefix (default: 'cache:')
    },
    file: {
      driver: 'file',
      path: './storage/cache',
      extension: '.cache',    // File extension (default: '.cache')
    },
  },
})

// Use default store (redis)
await cache.store().set('key', 'value')

// Use specific store
await cache.store('memory').set('temp', 'data', 60)
await cache.store('file').set('persistent', 'data')
```

### Driver Options

**Memory Store:**
| Option | Default | Description |
|--------|---------|-------------|
| `maxSize` | `Infinity` | Maximum number of items |
| `checkPeriod` | `60000` | Cleanup interval for expired items (ms) |

**Redis Store:**
| Option | Default | Description |
|--------|---------|-------------|
| `client` | required | Redis client instance |
| `prefix` | `'cache:'` | Key prefix for all cache keys |

**File Store:**
| Option | Default | Description |
|--------|---------|-------------|
| `path` | required | Directory path for cache files |
| `extension` | `'.cache'` | File extension for cache files |

## Tagged Cache

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
const cache = new CacheManager({
  default: 'redis',
  stores: {
    redis: { driver: 'redis', client: redis },
  },
})

export async function setUserPreferences(
  userId: string,
  preferences: Record<string, unknown>
): Promise<void> {
  await cache.store().set(`user:${userId}:prefs`, preferences, 86400) // 24 hours
}

export async function getUserPreferences(
  userId: string
): Promise<Record<string, unknown> | null> {
  return cache.store().get(`user:${userId}:prefs`)
}
```

## Testing

Use the Memory store for testing:

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
