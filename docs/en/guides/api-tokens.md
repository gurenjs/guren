# API Tokens Guide

Guren provides a secure API token system for authenticating API requests. Tokens are hashed before storage, support abilities (scopes), and can have expiration times.

## Core Concepts

- **ApiToken** – Token data stored in the database (hashed, never stores plain text).
- **ApiTokenStore** – Interface for token storage (memory or database).
- **Bearer Token Middleware** – Authenticates requests using Authorization headers.
- **Abilities** – Scopes that define what actions a token can perform.

## Basic Usage

### Creating Tokens

```ts
import { createApiToken, MemoryApiTokenStore } from '@guren/core'

const store = new MemoryApiTokenStore() // Use database in production

// Create a token for a user
const { plainTextToken, token } = await createApiToken(store, {
  name: 'Mobile App Token',
  userId: user.id,
  abilities: ['posts:read', 'posts:write'],
  expiresIn: 30 * 24 * 60 * 60 * 1000, // 30 days
})

// Return plainTextToken to the user - this is the ONLY time it's available!
return ctx.json({ token: plainTextToken })
```

### Token Format

Tokens are returned in the format `{id}|{token}`:

```
abc123def456...|xyz789ghi012...
```

The token part is hashed before storage – the plain text token can never be recovered.

### Verifying Tokens

```ts
import { verifyApiToken } from '@guren/core'

const result = await verifyApiToken(plainTextToken, store)

if (!result) {
  return ctx.json({ error: 'Invalid token' }, 401)
}

console.log(result.userId)     // User ID
console.log(result.abilities)  // ['posts:read', 'posts:write']
console.log(result.token)      // Token metadata (without plain text)
```

## Token Abilities

### Checking Abilities

```ts
import { tokenCan, tokenCanAll, tokenCanAny } from '@guren/core'

const token = { abilities: ['posts:read', 'posts:write'] }

// Check single ability
tokenCan(token, 'posts:read')    // true
tokenCan(token, 'posts:delete')  // false

// Check all abilities
tokenCanAll(token, ['posts:read', 'posts:write'])   // true
tokenCanAll(token, ['posts:read', 'posts:delete'])  // false

// Check any ability
tokenCanAny(token, ['posts:read', 'posts:delete'])  // true
tokenCanAny(token, ['users:read', 'users:write'])   // false
```

### Wildcard Ability

Use `*` to grant all abilities:

```ts
const { plainTextToken } = await createApiToken(store, {
  name: 'Admin Token',
  userId: user.id,
  abilities: ['*'], // Can do anything
})

tokenCan({ abilities: ['*'] }, 'anything')  // true
```

## Bearer Token Middleware

### Basic Setup

```ts
import { createBearerTokenMiddleware } from '@guren/core'

// Protect all API routes
app.use('/api/*', createBearerTokenMiddleware({ store }))
```

### With Ability Requirements

```ts
import { Router } from '@guren/core'

// Require specific abilities for routes
export function registerApiRoutes(router: Router): void {
  router.delete('/api/posts/:id', [PostController, 'destroy']).middleware(
    createBearerTokenMiddleware({
      store,
      abilities: ['posts:delete'],
    }),
  )
}
```

### With User Loading

```ts
app.use('/api/*', createBearerTokenMiddleware({
  store,
  loadUser: async (userId) => {
    return User.find(userId)
  },
}))

// User is now available in the context
router.get('/api/me', (ctx) => {
  const user = ctx.get('guren:user')
  return ctx.json(user)
})
```

### Custom Error Handlers

```ts
app.use('/api/*', createBearerTokenMiddleware({
  store,
  onUnauthorized: (ctx) => {
    return ctx.json({ error: 'Please provide a valid API token' }, 401)
  },
  onForbidden: (ctx, requiredAbilities) => {
    return ctx.json({
      error: 'Insufficient permissions',
      required: requiredAbilities,
    }, 403)
  },
}))
```

### Accessing Token in Routes

```ts
import { getApiToken } from '@guren/core'

router.get('/api/token-info', (ctx) => {
  const tokenInfo = getApiToken(ctx)

  if (!tokenInfo) {
    return ctx.json({ error: 'Not authenticated' }, 401)
  }

  return ctx.json({
    userId: tokenInfo.userId,
    tokenName: tokenInfo.token.name,
    abilities: tokenInfo.abilities,
    lastUsedAt: tokenInfo.token.lastUsedAt,
  })
})
```

## Token Management

### Listing User Tokens

```ts
import { getUserApiTokens } from '@guren/core'

router.get('/api/tokens', async (ctx) => {
  const user = ctx.get('guren:user')
  const tokens = await getUserApiTokens(user.id, store)

  return ctx.json({
    tokens: tokens.map(t => ({
      id: t.id,
      name: t.name,
      abilities: t.abilities,
      lastUsedAt: t.lastUsedAt,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
    })),
  })
})
```

### Revoking Tokens

```ts
import { revokeApiToken, revokeAllApiTokens } from '@guren/core'

// Revoke a specific token
router.delete('/api/tokens/:id', async (ctx) => {
  const tokenId = ctx.req.param('id')
  await revokeApiToken(tokenId, store)
  return ctx.json({ message: 'Token revoked' })
})

// Revoke all tokens (e.g., on password change)
router.post('/api/tokens/revoke-all', async (ctx) => {
  const user = ctx.get('guren:user')
  await revokeAllApiTokens(user.id, store)
  return ctx.json({ message: 'All tokens revoked' })
})
```

## Database Storage

### Built-in DatabaseApiTokenStore

For production, use the built-in `DatabaseApiTokenStore`. Pass it the Drizzle table for your `api_tokens` schema — no custom store code needed:

```ts
import { DatabaseApiTokenStore } from '@guren/core'
import { apiTokens } from '@/db/schema'

const store = new DatabaseApiTokenStore(apiTokens)

// Works with every token helper
const { plainTextToken } = await createApiToken(store, {
  name: 'Mobile App Token',
  userId: user.id,
})
```

The store uses the app's configured ORM connection (the standard `DatabaseProvider` setup), so it needs no extra wiring. Expired tokens are already rejected by `verifyApiToken`; call `store.deleteExpired()` from a scheduled job to prune them from the table.

### Database Schema

Column property names must match the `ApiToken` fields:

```ts
// db/schema.ts
import { pgTable, text, timestamp, jsonb } from '@guren/orm/drizzle/pg'

export const apiTokens = pgTable('api_tokens', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hashedToken: text('hashed_token').notNull().unique(),
  userId: text('user_id').notNull(),
  abilities: jsonb('abilities').$type<string[]>().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

If your `abilities` column is a plain text column holding a JSON string instead of `jsonb`, pass `{ abilitiesMode: 'text' }`:

```ts
const store = new DatabaseApiTokenStore(apiTokens, { abilitiesMode: 'text' })
```

### Custom Stores

Any object implementing the `ApiTokenStore` interface works — implement it yourself when tokens live in an external system:

```ts
import type { ApiTokenStore, ApiToken } from '@guren/core'

export class ExternalApiTokenStore implements ApiTokenStore {
  async store(token: ApiToken): Promise<void> { /* ... */ }
  async findByHashedToken(hashedToken: string): Promise<ApiToken | null> { /* ... */ }
  async findByUserId(userId: string | number): Promise<ApiToken[]> { /* ... */ }
  async delete(id: string): Promise<void> { /* ... */ }
  async deleteForUser(userId: string | number): Promise<void> { /* ... */ }
  async updateLastUsed(id: string, timestamp: Date): Promise<void> { /* ... */ }
}
```

## Configuration Options

### Token Creation Options

```ts
interface CreateApiTokenOptions {
  name: string                // Human-readable token name
  userId: string | number     // Owner user ID
  abilities?: string[]        // Token scopes (default: ['*'])
  expiresIn?: number | null   // Milliseconds until expiration
  tokenLength?: number        // Token bytes (default: 32)
}
```

### Middleware Options

```ts
interface BearerTokenMiddlewareOptions {
  store: ApiTokenStore                                     // Token storage
  loadUser?: (userId: string | number) => Promise<unknown> // User loader
  abilities?: string[]                                     // Required abilities
  onUnauthorized?: (ctx: Context) => Response             // 401 handler
  onForbidden?: (ctx: Context, required: string[]) => Response  // 403 handler
  headerName?: string                                      // Header name (default: 'Authorization')
  updateLastUsed?: boolean                                 // Track usage (default: true)
}
```

## Testing

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  createApiToken,
  verifyApiToken,
  MemoryApiTokenStore,
  createBearerTokenMiddleware,
} from '@guren/core'
import { Hono } from 'hono'

describe('API Tokens', () => {
  let store: MemoryApiTokenStore

  beforeEach(() => {
    store = new MemoryApiTokenStore()
  })

  test('creates and verifies token', async () => {
    const { plainTextToken, token } = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
      abilities: ['read'],
    })

    expect(plainTextToken).toMatch(/^[a-f0-9]+\|[a-f0-9]+$/)

    const result = await verifyApiToken(plainTextToken, store)
    expect(result?.userId).toBe(1)
    expect(result?.abilities).toEqual(['read'])
  })

  test('rejects expired token', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
      expiresIn: -1000, // Already expired
    })

    const result = await verifyApiToken(plainTextToken, store)
    expect(result).toBeNull()
  })

  test('middleware authenticates request', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
    })

    const app = new Hono()
    app.use('*', createBearerTokenMiddleware({ store }))
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/', {
      headers: { Authorization: `Bearer ${plainTextToken}` },
    })

    expect(res.status).toBe(200)
  })

  test('middleware checks abilities', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
      abilities: ['read'],
    })

    const app = new Hono()
    app.use('*', createBearerTokenMiddleware({
      store,
      abilities: ['write'],
    }))
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/', {
      headers: { Authorization: `Bearer ${plainTextToken}` },
    })

    expect(res.status).toBe(403)
  })
})
```

## Best Practices

1. **Never store plain tokens**: Only the hashed token is stored. The plain text is shown once at creation.

2. **Use specific abilities**: Prefer `['posts:read', 'posts:write']` over `['*']` for better security.

3. **Set expiration times**: Tokens should expire for security. 30-90 days is common.

4. **Revoke on password change**: When a user changes their password, revoke all their tokens.

5. **Use database storage in production**: `MemoryApiTokenStore` is only for testing.

6. **Track last used**: The `lastUsedAt` field helps identify unused tokens.

7. **Name tokens meaningfully**: Use names like "Mobile App" or "CI/CD Pipeline" for easy identification.

8. **Implement token rotation**: Allow users to regenerate tokens periodically.
