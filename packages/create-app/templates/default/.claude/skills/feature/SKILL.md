---
name: feature
description: Generate a complete CRUD feature with all related components in one workflow — Model, Controller, Views, Routes, Tests, Factory, Seeder, Resource. Use when user wants to build out an entire entity at once. Triggers include "full feature", "CRUD", "resource for", "complete setup", "everything for", "build out the X feature", "scaffold everything for", or mentions an entity name with the intent of creating all components (e.g., "I need a Product entity"). For creating a single component, use the scaffold skill instead.
---

# Feature Skill

You are a full-feature scaffolding assistant for the Guren framework.

## Your Role

Generate all components needed for a complete CRUD feature in one workflow. This is the "batteries-included" approach — creating everything an entity needs to work end-to-end with full type safety.

## Workflow

When given a feature name (e.g., "Post", "Product"):

### 1. Generate all components

**Preferred:** Use `make:feature` which generates type-safe code with proper imports:

```bash
bunx guren make:feature <Name> --fields "title:string,body:text,published:boolean"
```

This generates Validator, Resource, Controller, Views (Index/Show/New/Edit), and Model in one step with:
- Typed page props (no `any`)
- `route()` helper for all URLs
- `ApiRoutes` for form data types
- `RouteErrors` for validation error types

**Or generate individually:**

```bash
bunx guren make:model <Name>
bunx guren make:migration create_<names>_table
bunx guren make:controller <Name>
bunx guren make:view <names>/Index
bunx guren make:view <names>/Show
bunx guren make:view <names>/New
bunx guren make:view <names>/Edit
bunx guren make:route <names>
bunx guren make:test controllers/<Name>Controller --runner=vitest
bunx guren make:factory <Name> --model=<Name>
bunx guren make:seeder <Name>
bunx guren make:resource <Name> --model=<Name>
```

When using individual commands, you must also create a Validator file manually at `app/Http/Validators/<Name>Validator.ts`:

```typescript
import { z } from 'zod'

export const <Name>PayloadSchema = z.object({
  // Define fields matching your schema
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
})

export type <Name>Payload = z.infer<typeof <Name>PayloadSchema>

export const <Name>IdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})
```

This Validator is needed for both controller validation and route body schema binding.

### 2. Register routes with body schemas

When registering routes in `routes/web.ts`, **always attach Zod body schemas** to mutation routes. This enables codegen to extract types for the frontend:

```typescript
import <Name>Controller from '../app/Http/Controllers/<Name>Controller.js'
import { <Name>PayloadSchema } from '../app/Http/Validators/<Name>Validator.js'

router.group('/<names>', (<names>) => {
  <names>.get('/', [<Name>Controller, 'index']).name('<names>.index')
  <names>.get('/new', [<Name>Controller, 'create']).name('<names>.create')
  <names>.get('/:id', [<Name>Controller, 'show']).name('<names>.show')
  <names>.get('/:id/edit', [<Name>Controller, 'edit']).name('<names>.edit')
  <names>.post('/', { name: '<names>.store', body: <Name>PayloadSchema }, [<Name>Controller, 'store'])
  <names>.put('/:id', { name: '<names>.update', body: <Name>PayloadSchema }, [<Name>Controller, 'update'])
})
```

Where `<Name>` is PascalCase singular (e.g., `Post`) and `<names>` is kebab-case plural (e.g., `posts`).

### 3. Run codegen

```bash
bunx guren codegen
```

This generates typed route helpers and API client types in `.guren/`.

### 4. Report created files and next steps

- Add table schema to `db/schema.ts`
- Run migration: `bun run db:migrate`

## Type Safety Patterns

Generated views follow these patterns for end-to-end type safety:

### Form pages (New/Edit) — derive types from ApiRoutes

```typescript
import type { ApiRoutes } from '../../../../.guren/api-client.gen'
import type { RouteErrors } from '@guren/inertia-client/typed-forms'
import { route } from '../../../../.guren/routes.gen'

type <Name>FormData = ApiRoutes['<names>.store']['body']

// Form submission uses route() helper
form.post(route('<names>.store'))
form.put(route('<names>.update', { id: <name>.id }))
```

### List/Detail pages — typed props from Resource

```typescript
import type { PaginatedPageProps } from '@guren/core'
import type { <Name>ResourceData } from '../../../../app/Http/Resources/<Name>Resource.js'
import { route } from '../../../../.guren/routes.gen'

interface Props extends PaginatedPageProps<<Name>ResourceData> {}

// Navigation uses route() helper
<Link href={route('<names>.show', { id: <name>.id })}>
```

### Error types — RouteErrors with message field

```typescript
interface Props {
  errors?: RouteErrors<<Name>FormData> & { message?: string }
}
```

### Models — define fillable for mass assignment protection

Always add `fillable` to generated models. This is the second defense layer after Zod validation — it prevents unintended fields from reaching the database even if the controller validation is bypassed or misconfigured:

```typescript
export class <Name> extends defineModel(<names>) {
  static fillable = ['title', 'body', 'authorId']  // only these fields pass to create()/update()
}
```

For User models, also define `guarded` to explicitly protect sensitive fields:

```typescript
export class User extends AuthenticatableModel<UserRecord> {
  static fillable = ['name', 'email', 'password']
  static guarded = ['id', 'passwordHash', 'rememberToken']
}
```

## Generated Structure

For feature "Post":

```
app/
├── Http/Controllers/PostController.ts
├── Http/Resources/PostResource.ts
├── Http/Validators/PostValidator.ts
└── Models/Post.ts
db/
├── factories/PostFactory.ts
├── migrations/{timestamp}_create_posts_table.sql
└── seeders/PostSeeder.ts
resources/js/pages/posts/
├── Index.tsx    ← typed props, route() links
├── Show.tsx     ← typed props, route() links
├── New.tsx      ← ApiRoutes form type, route() submit
└── Edit.tsx     ← ApiRoutes form type, RouteErrors, route() submit
tests/controllers/PostController.test.ts
```

## Schema Example

```typescript
// db/schema.ts
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  content: text('content'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
})
```
