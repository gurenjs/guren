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
import { pages } from '@/.guren/pages.gen'

type TasksIndexProps = PaginatedPageProps<TaskResourceData>

export default class TaskController extends Controller {
  async index() {
    const { page } = this.validateQuery(ListTasksQuerySchema)
    const result = await Task.paginate({ page, perPage: 20, orderBy: ['createdAt', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/tasks' })

    return this.inertia(pages.tasks.Index, {
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
import { pages } from '@/.guren/pages.gen'

type Props = PageProps<typeof pages.tasks.Index>

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

**Project knowledge that stays connected to code.** Guren links architecture decisions and generated spec views to the entities and paths they govern, validates those relations, and renders the whole corpus as an interactive Docs Graph during development. See [Spec-Anchored Development](./spec-anchored.md) for the complete workflow.

**Batteries included, not forced.** Authentication, validation, caching, queues, mail, events, broadcasting, scheduling — they are all there when you need them. Each subsystem is opt-in through ServiceProviders, so you only load what you use.

**Convention over configuration.** Generate a full feature with `bunx guren add auth` or `bunx guren add resource posts`. The CLI scaffolds the files in the right place with the right structure so you spend time building features, not debating folder layout.

**Router registrars over global state.** Generated apps export route registrars and pass them into `createApp({ routes })`, which keeps routing scoped to each application instance.

For a deeper, honest comparison with Hono, Next.js, and Laravel — and how Guren is designed for AI coding agents — see [Why Guren](./why-guren.md).

## Get Started

Four commands. No Docker, no database server — a fresh app uses SQLite out of the box:

```bash
bunx create-guren-app my-app   # scaffold — accept the default prompts (SSR, SQLite)
cd my-app
bun install                    # usually a no-op: the scaffolder installs for you
bun run dev                    # start the dev server
```

Open `http://localhost:3333` and you have a running Guren app.

## Learn More

Follow this path, in order:

1. **[Quickstart](./getting-started.md)** — scaffold a project and see it running in about five minutes.
2. **[Tutorial: Build a Mini Blog](../tutorials/overview.md)** — **recommended for newcomers.** A hands-on three-part course: create a posts CRUD, add authentication, then wire up comments with relationships. When you finish, you have touched every core concept with working code to show for it.
3. **Topic guides** — deep dives once you know your way around:
   - [Routing](./routing.md) — route groups, middleware, and resource routes.
   - [Controllers](./controllers.md) — request handling, input helpers, and validation.
   - [Database](./database.md) — Drizzle schemas, migrations, QueryBuilder, and relationships.
   - [Frontend](./frontend.md) — Inertia-powered React pages and SSR.
   - [Testing](./testing.md) — TestApp, fluent assertions, and test utilities.
   - [Spec-Anchored Development](./spec-anchored.md) — generated diagrams, architecture decisions, verified links, and the Docs Graph.

Prefer a quick guided tour before the tutorial? [First Steps](./first-steps.md) traces one request through every layer in ten minutes.

For a full reference of CLI commands, see the [CLI Reference](./cli.md). If any term is unfamiliar, check the [Glossary](./glossary.md).
