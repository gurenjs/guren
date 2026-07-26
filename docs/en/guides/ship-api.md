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
  createdAt: timestamp('created_at').defaultNow().notNull(),
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
import { Model } from '@guren/core'
import { tasks } from '@/db/schema'

export class Task extends Model<typeof tasks> {
  static table = tasks
}
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

For routes that require authentication, add token-based auth:

```bash
bunx guren add auth --api
```

Then protect routes with the `auth:api` middleware:

```typescript
router.middleware('auth:api').group((auth) => {
  auth.post('/api/tasks', [TaskController, 'store']).name('tasks.store')
  auth.put('/api/tasks/:id', [TaskController, 'update']).name('tasks.update')
  auth.delete('/api/tasks/:id', [TaskController, 'destroy']).name('tasks.destroy')
})
```

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
