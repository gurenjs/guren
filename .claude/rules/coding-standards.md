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

Code shows *how*; a comment carries only what the code cannot: a non-obvious
constraint, a deliberate deviation, a pitfall or workaround, a unit or range, a
cross-file sync obligation, a measured number, an RFC or issue reference.

**Do not write**
- Narration of the next line or block (`// Check the user`, `// Return early`), a
  name or type restated, section banners (`// ---- helpers ----`), step labels
- Change history (`used to`, `previously`, `no longer`, "before this PR"): that is
  the commit message's job and it rots the day it lands
- `@param`/`@returns` that only repeat the name and type; `@example` that mirrors
  the signature
- JSDoc on a private or internal symbol that restates its name

**Size**: a comment block keeps to 5 lines of body, a module header to 8. If a
block needs more, it is holding more than one fact per line or explaining what
the code already says. Every distinct fact gets one line; prose around it goes.

**Keep verbatim**: tool directives (`@ts-expect-error`, `eslint-*`, `@vite-ignore`),
tags the framework reads (`@docs`, `@deprecated`, `guren-audit-ignore`), comments a
test reads as source text, and comments inside template literals (they are
generated output, not commentary).

`bun run audit:comments` (`scripts/comment-lint.ts`) enforces the mechanical half,
ratcheted per file against main, and runs as a PostToolUse hook after every edit.
A comment that genuinely must exceed the limit carries `comment-lint-ignore` with
the reason on the same block. Whether a comment merely narrates the code is a
review judgment: the `code-review` agent checks it on every diff.

```typescript
// Bad: restates the code
// Loop over the items and validate each one
for (const item of items) validate(item)

// Good: the one fact the code cannot show
// The API returns at most 100 rows per call regardless of `limit`.
for (const page of pages(100)) ...
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
