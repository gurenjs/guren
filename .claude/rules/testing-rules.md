# Testing Rules

## Test Framework

- **Framework tests:** Bun's native test runner (`bun:test`)
- **React components:** Vitest with React Testing Library
- **Test files:** `*.test.ts` in same directory as source

## Test File Structure

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'

describe('FeatureName', () => {
  // Setup/teardown if needed
  beforeEach(() => {
    // Reset state
  })

  afterEach(() => {
    // Cleanup
  })

  describe('methodName', () => {
    test('should do expected behavior', () => {
      // Arrange
      const input = createTestInput()

      // Act
      const result = methodName(input)

      // Assert
      expect(result).toBe(expected)
    })

    test('should handle edge case', () => {
      // ...
    })
  })
})
```

## Naming Conventions

### Test Files
- Mirror source file name: `Model.ts` → `Model.test.ts`
- Place in same directory as source file
- For integration tests: `tests/` directory at package root

### Test Names
```typescript
// Use descriptive names that explain the behavior
test('should return null when user is not found', () => {})
test('should throw ValidationError when email is invalid', () => {})
test('should create user with hashed password', () => {})

// Avoid vague names
test('works correctly', () => {}) // Bad
test('handles error', () => {}) // Bad
```

## Test Patterns

### Unit Tests
```typescript
import { describe, test, expect } from 'bun:test'
import { formatDate } from './date-utils'

describe('formatDate', () => {
  test('should format ISO date to readable string', () => {
    const date = new Date('2024-01-15T10:30:00Z')
    expect(formatDate(date)).toBe('January 15, 2024')
  })
})
```

### Controller Tests
```typescript
import { describe, test, beforeAll } from 'bun:test'
import { TestApp } from '@guren/testing'

describe('PostController', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await TestApp.create()
  })

  test('index returns list of posts', async () => {
    await app.get('/posts')
      .assertOk()
      .assertJsonStructure(['posts'])
  })

  test('store creates new post', async () => {
    await app.post('/posts', {
      title: 'Test Post',
      content: 'Test content'
    }).assertStatus(201)
  })
})
```

### Model Tests
```typescript
import { describe, test, expect, beforeEach } from 'bun:test'
import { User } from './User'

describe('User Model', () => {
  beforeEach(async () => {
    // Clean up test data
    await User.query().delete()
  })

  test('should create user with valid data', async () => {
    const user = await User.create({
      email: 'test@example.com',
      name: 'Test User'
    })

    expect(user.id).toBeDefined()
    expect(user.email).toBe('test@example.com')
  })

  test('should find user by email', async () => {
    await User.create({ email: 'find@example.com', name: 'Find Me' })

    const user = await User.where('email', 'find@example.com').first()

    expect(user).not.toBeNull()
    expect(user?.name).toBe('Find Me')
  })
})
```

## Assertions

### Common Matchers
```typescript
// Equality
expect(value).toBe(expected)        // Strict equality
expect(value).toEqual(expected)     // Deep equality

// Truthiness
expect(value).toBeTruthy()
expect(value).toBeFalsy()
expect(value).toBeNull()
expect(value).toBeDefined()

// Numbers
expect(value).toBeGreaterThan(n)
expect(value).toBeLessThan(n)

// Strings
expect(str).toContain('substring')
expect(str).toMatch(/pattern/)

// Arrays/Objects
expect(arr).toContain(item)
expect(obj).toHaveProperty('key')
expect(arr).toHaveLength(n)

// Errors
expect(() => fn()).toThrow()
expect(() => fn()).toThrow(ErrorType)
expect(() => fn()).toThrow('error message')

// Async
await expect(promise).resolves.toBe(value)
await expect(promise).rejects.toThrow()
```

## Test Database

- Tests use a separate test database
- Each test should clean up its own data
- Use transactions for isolation when possible

```typescript
import { db } from '@/db'

beforeEach(async () => {
  await db.transaction(async (tx) => {
    await tx.delete(users)
    await tx.delete(posts)
  })
})
```

## Running Tests

```bash
# All tests
bun run test

# Framework tests only
bun run test:bun

# Example app tests only
bun run test:examples

# Single file
bun test path/to/file.test.ts

# Watch mode (vitest packages)
bun run test:watch
```
