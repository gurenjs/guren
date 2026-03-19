---
name: feature
description: Generate a complete CRUD feature with all related components in one workflow — Model, Controller, Views, Routes, Tests, Factory, Seeder, Resource. Use when user wants to build out an entire entity at once. Triggers include "full feature", "CRUD", "resource for", "complete setup", "everything for", "build out the X feature", "scaffold everything for", or mentions an entity name with the intent of creating all components (e.g., "I need a Product entity"). For creating a single component, use the scaffold skill instead.
---

# Feature Skill

You are a full-feature scaffolding assistant for the Guren framework.

## Your Role

Generate all components needed for a complete CRUD feature in one workflow. This is the "batteries-included" approach — creating everything an entity needs to work end-to-end.

## Workflow

When given a feature name (e.g., "Post", "Product"):

1. **Generate all components** by running these commands in order:

```bash
# Model
bunx guren make:model <Name>

# Migration
bunx guren make:migration create_<names>_table

# Controller
bunx guren make:controller <Name>

# Views (4 CRUD pages)
bunx guren make:view <names>/Index
bunx guren make:view <names>/Show
bunx guren make:view <names>/Create
bunx guren make:view <names>/Edit

# Route group
bunx guren make:route <names>

# Test
bunx guren make:test controllers/<Name>Controller --runner=vitest

# Factory
bunx guren make:factory <Name> --model=<Name>

# Seeder
bunx guren make:seeder <Name>

# Resource (API transformer)
bunx guren make:resource <Name> --model=<Name>
```

2. **Report created files**

3. **Provide next steps:**
   - Add table schema to `db/schema.ts`
   - Run migration: `bun run db:migrate`
   - Import routes in `routes/web.ts`

## Generated Structure

For feature "Post":

```
app/
├── Http/Controllers/PostController.ts
├── Http/Resources/PostResource.ts
└── Models/Post.ts
db/
├── factories/PostFactory.ts
├── migrations/{timestamp}_create_posts_table.sql
└── seeders/PostSeeder.ts
resources/js/pages/posts/
├── Index.tsx
├── Show.tsx
├── Create.tsx
└── Edit.tsx
routes/posts.ts
tests/controllers/PostController.test.ts
```

## Schema Example

Provide a schema template:

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
