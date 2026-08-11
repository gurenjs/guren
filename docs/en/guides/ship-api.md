# Ship an API

This guide walks you through building and shipping a JSON API with Guren. You will scaffold an API-only project, define a database schema, create controllers with validation, and test your endpoints.

> [!NOTE]
> For full details on controllers, validation, and middleware, see [Controllers](./controllers.md) and [Validation](./validation.md).

## Prerequisites

- **Bun 1.1 or later**
- **Docker Desktop (Compose v2)** for Postgres

## 1. Scaffold an API Project

The `api` blueprint skips Inertia and frontend tooling, giving you a lean JSON API starter:

```bash
bunx create-guren-app my-api --blueprint api --db postgres
cd my-api
bun install
```

## 2. Start the Database

```bash
bun run db:up
```

## 3. Define Your Schema

Open `db/schema.ts` and add a table. Here is a simple `tasks` table:

```typescript
import { pgTable, serial, text, boolean, timestamp } from 'drizzle-orm/pg-core'

export const tasks = pgTable('tasks', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  completed: boolean('completed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
```

Generate and run a migration:

```bash
bunx guren db:migrate:generate create_tasks
bunx guren db:migrate
```

## 4. Create the Model

```bash
bunx guren make:model Task
```

Then wire it to your schema:

```typescript
import { defineModel } from '@guren/core'
import { tasks } from '@/db/schema'

export class Task extends defineModel(tasks) {}
```

## 5. Create the Controller

```bash
bunx guren make:controller TaskController
```

Add CRUD actions with Zod validation:

```typescript
import { Controller } from '@guren/core'
import { z } from 'zod'
import { Task } from '@/app/Models/Task'

const CreateTaskSchema = z.object({
  title: z.string().min(1).max(255),
})

const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  completed: z.boolean().optional(),
})

const TaskIdSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export class TaskController extends Controller {
  async index() {
    const tasks = await Task.all()
    return this.json({ tasks })
  }

  async show() {
    const { id } = this.validateParams(TaskIdSchema)
    const task = await Task.findOrFail(id)
    return this.json({ task })
  }

  async store() {
    const data = await this.validateBody(CreateTaskSchema)
    const task = await Task.create(data)
    return this.json({ task }, 201)
  }

  async update() {
    const { id } = this.validateParams(TaskIdSchema)
    const data = await this.validateBody(UpdateTaskSchema)
    const task = await Task.findOrFail(id)
    await task.update(data)
    return this.json({ task })
  }

  async destroy() {
    const { id } = this.validateParams(TaskIdSchema)
    const task = await Task.findOrFail(id)
    await task.delete()
    return this.json({ message: 'Deleted' })
  }
}
```

## 6. Register Routes

Open `routes/web.ts` (or `routes/api.ts` in an API-only project) and add:

```typescript
import { Router } from '@guren/core'
import { TaskController } from '@/app/Http/Controllers/TaskController'

export function registerApiRoutes(router: Router): void {
  router.get('/api/tasks', [TaskController, 'index']).name('tasks.index')
  router.get('/api/tasks/:id', [TaskController, 'show']).name('tasks.show')
  router.post('/api/tasks', [TaskController, 'store']).name('tasks.store')
  router.put('/api/tasks/:id', [TaskController, 'update']).name('tasks.update')
  router.delete('/api/tasks/:id', [TaskController, 'destroy']).name('tasks.destroy')
}
```

## 7. Generate Type Manifests

```bash
bun run codegen
```

Codegen writes no `.guren/pages.gen.ts` here. That manifest imports
`@guren/inertia-client`, which an API-only app does not install, while its
`tsconfig.json` type-checks everything under `.guren/` — so generating one would
break `bun run typecheck` on its first line.

The rule is codegen's, not the scaffolders': if page components ever appear under
`resources/js/pages` — copied in by hand, or arriving with a checkout — codegen
still declines to write the manifest and says so:

```
[warn] 1 page component under resources/js/pages, but this app has no
@guren/inertia-client dependency and no routes/web.ts, so codegen writes no
.guren/pages.gen.ts
```

`guren check` and `guren doctor` report the same thing, and warn more sharply if
a `.guren/pages.gen.ts` generated before the app took this shape is still on
disk — that leftover is what fails `tsc`, so it is reported even after the page
components that produced it are deleted, and `guren check --ci` fails on it
(unused page components alone do not fail CI). Codegen never deletes it, because
removing a file the app might genuinely need would turn a type error into a
mystery. Delete it yourself, or, if the app does render Inertia pages, add its
`@guren/inertia-client` dependency and `routes/web.ts`.

## 8. Test Your Endpoints

Start the dev server:

```bash
bun run dev
```

Then use `curl` or any HTTP client:

```bash
# Create a task
curl -X POST http://localhost:3333/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "Write docs"}'

# List tasks
curl http://localhost:3333/api/tasks

# Show a task
curl http://localhost:3333/api/tasks/1

# Update a task
curl -X PUT http://localhost:3333/api/tasks/1 \
  -H "Content-Type: application/json" \
  -d '{"completed": true}'

# Delete a task
curl -X DELETE http://localhost:3333/api/tasks/1
```

## 9. Add API Token Authentication

For routes that require authentication, wire up API tokens. There is no scaffold
for this — `guren add auth` generates an Inertia sign-in experience and refuses to
run on an API-only app, so build the middleware yourself:

```typescript
import { createBearerTokenMiddleware, DatabaseApiTokenStore } from '@guren/core'
import { apiTokens } from '@/db/schema'

const store = new DatabaseApiTokenStore(apiTokens)

export const requireApiToken = createBearerTokenMiddleware({ store })
```

Then protect the mutating routes with it:

```typescript
router.middleware(requireApiToken).group((auth) => {
  auth.post('/api/tasks', [TaskController, 'store']).name('tasks.store')
  auth.put('/api/tasks/:id', [TaskController, 'update']).name('tasks.update')
  auth.delete('/api/tasks/:id', [TaskController, 'destroy']).name('tasks.destroy')
})
```

See the [API tokens guide](./api-tokens.md) for the `api_tokens` table, issuing
tokens with `createApiToken`, and scoping them with abilities.

Clients include the token in the `Authorization` header:

```bash
curl -X POST http://localhost:3333/api/tasks \
  -H "Authorization: Bearer your-api-token" \
  -H "Content-Type: application/json" \
  -d '{"title": "Authenticated task"}'
```

## Next Steps

- [Rate Limiting](./rate-limiting.md) — protect endpoints from abuse
- [API Resources](./api-resources.md) — shape JSON responses with resource classes
- [Validation](./validation.md) — advanced validation patterns
- [Error Handling](./error-handling.md) — customize API error responses
