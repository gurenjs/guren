# Guren at a Glance

The fullstack TypeScript framework that feels like Laravel — powered by Bun.

## See for Yourself

A route, a controller, a typed response — in a few lines:

```ts
// routes/web.ts
import TaskController from '@/app/Http/Controllers/TaskController'

Route.get('/tasks', [TaskController, 'index'])
Route.post('/tasks', [TaskController, 'store'])

Route.middleware('auth').group(() => {
  Route.get('/dashboard', [DashboardController, 'index'])
})
```

```ts
// app/Http/Controllers/TaskController.ts
import { Controller } from '@guren/server'
import { Task } from '@/app/Models/Task'

export default class TaskController extends Controller {
  async index() {
    const tasks = await Task.where('completed', false)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get()

    return this.inertia('Tasks/Index', { tasks })
  }

  async store() {
    const data = await this.only('title', 'description')
    const task = await Task.create(data)
    return this.redirect('/tasks')
  }
}
```

Your React page receives typed props directly from the controller — no manual API layer:

```tsx
// resources/js/pages/Tasks/Index.tsx
import type { ControllerInertiaProps } from '@guren/server'
import type TaskController from '@/app/Http/Controllers/TaskController'

type Props = ControllerInertiaProps<TaskController, 'index'>

export default function TasksIndex({ tasks }: Props) {
  return (
    <ul>
      {tasks.map((task) => (
        <li key={task.id}>{task.title}</li>
      ))}
    </ul>
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

**Laravel's developer experience, in TypeScript.** If you have used Laravel, the patterns are instantly familiar: `Route.resource`, `Controller` base class with `this.inertia()`, `Model.where().orderBy().get()`. If you have not, you will find them intuitive anyway — the API reads like what it does.

**End-to-end type safety.** Your Drizzle schema types flow into your Model, through your Controller, and into your React page props. Change a column name and TypeScript catches every place that needs updating — from database to browser.

**Batteries included, not forced.** Authentication, validation, caching, queues, mail, events, broadcasting, scheduling — they are all there when you need them. Each subsystem is opt-in through ServiceProviders, so you only load what you use.

**Convention over configuration.** Generate a controller with `bunx guren make:controller`, a model with `make:model`, routes with `make:route`. The CLI scaffolds files in the right place with the right structure so you spend time building features, not debating folder layout.

## Get Started

```bash
bunx create-guren-app my-app
cd my-app
bun install
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
