# Guren at a Glance

The fullstack TypeScript framework that feels like Laravel — powered by Bun.

## See for Yourself

A route, a controller, a typed response — in a few lines:

```ts
// routes/web.ts
import { Router } from '@guren/core'
import TaskController from '@/app/Http/Controllers/TaskController'
import DashboardController from '@/app/Http/Controllers/DashboardController'

export function registerWebRoutes(router: Router): void {
  router.get('/tasks', [TaskController, 'index'])
  router.post('/tasks', [TaskController, 'store'])

  router.middleware('auth').group((auth) => {
    auth.get('/dashboard', [DashboardController, 'index'])
  })
}
```

```ts
// app/Http/Controllers/TaskController.ts
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { Task } from '@/app/Models/Task'
import { TaskResource, type TaskResourceData } from '@/app/Http/Resources/TaskResource'
import { CreateTaskSchema, ListTasksQuerySchema } from '@/app/Http/Validators/TaskValidator'
import { appPages } from '@/resources/js/pages/contracts'

type TasksIndexProps = PaginatedPageProps<TaskResourceData>

export default class TaskController extends Controller {
  async index() {
    const { page } = this.validateQuery(ListTasksQuerySchema)
    const result = await Task.paginate({ page, perPage: 20, orderBy: ['createdAt', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/tasks' })

    return this.inertia(appPages.tasks.index, {
      data: result.data.map((task) => new TaskResource(task).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies TasksIndexProps)
  }

  async store() {
    const data = await this.validateBody(CreateTaskSchema)
    const task = await Task.create(data)
    return this.redirect(`/tasks/${task?.id ?? ''}`)
  }
}
```

Your React page receives typed props directly from the controller — no manual API layer:

```tsx
// resources/js/pages/tasks/Index.tsx
import type { PageProps } from '@guren/inertia-client/contracts'
import { appPages } from '@/resources/js/pages/contracts'

type Props = PageProps<typeof appPages.tasks.index>

export default function TasksIndex({ data, pagination }: Props) {
  return (
    <section>
      <ul>
        {data.map((task) => (
          <li key={task.id}>{task.title}</li>
        ))}
      </ul>
      <p>{pagination.meta.total} tasks</p>
    </section>
  )
}
```

Testing reads like plain English:

```ts
const app = await TestApp.create({ boot })

await app.get('/tasks').assertOk().assertJsonCount(3, 'tasks')
await app.post('/tasks', { title: 'Ship it' }).assertRedirect('/tasks')
await app.actingAs(user).get('/dashboard').assertOk()
```

## What Makes Guren Different

**Bun-native from day one.** Guren runs on Bun's runtime with Hono as the HTTP layer. There is no Node.js compatibility shim — you get Bun's fast startup, native TypeScript execution, and built-in test runner out of the box.

**Laravel's developer experience, in TypeScript.** If you have used Laravel, the patterns are instantly familiar: resource routing, `Controller` base classes with `this.inertia()`, and `Model.where().orderBy().get()`. If you have not, you will find them intuitive anyway — the API reads like what it does.

**End-to-end type safety.** Your Drizzle schema types flow into your Model, through your Controller, and into your React page props. Change a column name and TypeScript catches every place that needs updating — from database to browser.

**Batteries included, not forced.** Authentication, validation, caching, queues, mail, events, broadcasting, scheduling — they are all there when you need them. Each subsystem is opt-in through ServiceProviders, so you only load what you use.

**Convention over configuration.** Generate a full feature with `bunx guren add auth` or `bunx guren add resource posts`. The CLI scaffolds the files in the right place with the right structure so you spend time building features, not debating folder layout.

**Router registrars over global state.** Generated apps export route registrars and pass them into `createApp({ routes })`, which keeps routing scoped to each application instance.

## Get Started

```bash
bunx create-guren-app my-app
cd my-app
bun install
bun run codegen
bun run dev        # visit http://localhost:3333
```

## Learn More

New to Guren? Follow this path:

1. **[First Steps](./first-steps.md)** — Build a working feature in 10 minutes.
2. **[Getting Started](./getting-started.md)** — Environment setup and database configuration.
3. **[Routing Guide](./routing.md)** — Route groups, middleware, and resource routes.
4. **[Controller Guide](./controllers.md)** — Request handling, input helpers, and validation.
5. **[Database Guide](./database.md)** — Drizzle schemas, migrations, QueryBuilder, and relationships.
6. **[Frontend Guide](./frontend.md)** — Inertia-powered React pages and SSR.
7. **[Testing Guide](./testing.md)** — TestApp, fluent assertions, and test utilities.

For a full reference of CLI commands, see the [CLI Reference](./cli.md). If any term is unfamiliar, check the [Glossary](./glossary.md).
