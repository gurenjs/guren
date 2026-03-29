# Coding Standards

## TypeScript Configuration

- **Strict mode** is enabled - do not use `any` type unless absolutely necessary
- **ES2022** target - use modern JavaScript features
- **ESM only** - no CommonJS (`require`, `module.exports`)
- **Bundler resolution** - imports can omit `.js` extensions

## Naming Conventions

### Files
- **Classes/Components:** PascalCase (`UserController.ts`, `PostModel.ts`)
- **Utilities/helpers:** kebab-case (`string-utils.ts`, `date-helpers.ts`)
- **Test files:** Same name with `.test.ts` suffix (`Model.test.ts`)
- **Types:** Can be in same file or separate `.types.ts` file

### Code
```typescript
// Classes - PascalCase
class UserController {}

// Functions/methods - camelCase
function getUserById() {}

// Variables - camelCase
const userData = {}

// Constants - UPPER_SNAKE_CASE for true constants
const MAX_RETRY_COUNT = 3

// Interfaces/Types - PascalCase
interface UserRecord {}
type PostData = {}
```

## Import Order

Organize imports in this order with blank lines between groups:

```typescript
// 1. External packages
import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm'

// 2. Internal packages (@guren/*)
import { Controller } from '@guren/server'
import { Model } from '@guren/orm'

// 3. Relative imports
import { UserService } from './services/UserService'
import { formatDate } from './utils'
```

## Export Patterns

### Package Entry Points (`src/index.ts`)
```typescript
// Re-export public API
export { Controller } from './mvc/Controller'
export { Route } from './mvc/Route'
export type { ControllerContext } from './types'
```

### Internal Modules
```typescript
// Prefer named exports
export class MyClass {}
export function myFunction() {}

// Avoid default exports except for main entry points
```

## Function Patterns

### Async Functions
```typescript
// Always use async/await over .then()
async function fetchUser(id: number) {
  const user = await User.find(id)
  return user
}

// Handle errors explicitly
async function createUser(data: UserData) {
  try {
    return await User.create(data)
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new BadRequestError(error.message)
    }
    throw error
  }
}
```

### Type Safety
```typescript
// Prefer explicit return types for public APIs
function getConfig(): AppConfig {
  return { ... }
}

// Use generics for reusable utilities
function first<T>(items: T[]): T | undefined {
  return items[0]
}
```

## Comments

- Write self-documenting code - minimize comments
- Use JSDoc for public APIs that need documentation
- TODO comments should reference issue numbers when applicable

```typescript
/**
 * Creates a new user in the database.
 * @param data - User creation data
 * @returns The created user record
 */
async function createUser(data: CreateUserData): Promise<User> {
  // Implementation
}

// TODO(#123): Add email validation
```

## Error Handling

- Use custom error classes for domain-specific errors
- Always include meaningful error messages
- Preserve error stack traces when re-throwing

```typescript
class NotFoundError extends Error {
  constructor(resource: string, id: number | string) {
    super(`${resource} with id ${id} not found`)
    this.name = 'NotFoundError'
  }
}
```
