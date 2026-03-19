# Build Your First Feature in 10 Minutes

You are going to build a task tracker: create tasks, list them, and mark them complete. By the end, you will understand how Guren's MVC loop works — from database to browser.

## What You Will Build

A single page where you can type a task, hit enter, and see it appear in a list. Each task has a checkbox to mark it done. Simple, but it touches every layer of the framework: schema, model, controller, route, and React page.

## 1. Generate the Project

```bash
bunx create-guren-app tasks-app
cd tasks-app
bun install
```

When prompted, choose **SSR** mode. The scaffolded project includes a working Bun server, Vite for frontend builds, and a PostgreSQL-ready Drizzle setup.

> [!NOTE]
> You need PostgreSQL running locally. Run `bun run db:up` to start a Docker container, or point `DATABASE_URL` in `.env` to your own instance.

## 2. Define the Schema

Open `db/schema.ts` and add a `tasks` table:

```ts
import { pgTable, serial, text, boolean, timestamp } from 'drizzle-orm/pg-core'

export const tasks = pgTable('tasks', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  completed: boolean('completed').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
```

Now generate and run the migration:

```bash
bunx guren db:migrate
```

## 3. Create the Model

```bash
bunx guren make:model Task
```

Open the generated `app/Models/Task.ts` and link it to your schema:

```ts
import { Model } from '@guren/orm'
import { tasks } from '@/db/schema'

export type TaskRecord = typeof tasks.$inferSelect

export class Task extends Model<TaskRecord> {
  static override table = tasks
  static override readonly recordType = {} as TaskRecord
}
```

That is your entire data layer. `Task` now has `find()`, `create()`, `where()`, `update()`, `delete()`, `paginate()`, and a full fluent QueryBuilder — all type-safe from your Drizzle schema.

## 4. Create the Controller

```bash
bunx guren make:controller TaskController
```

Open `app/Http/Controllers/TaskController.ts` and replace the contents:

```ts
import { Controller } from '@guren/server'
import { Task } from '@/app/Models/Task'

export default class TaskController extends Controller {
  async index() {
    const tasks = await Task.where('completed', false)
      .orderBy('createdAt', 'desc')
      .get()

    const completed = await Task.where('completed', true)
      .orderBy('createdAt', 'desc')
      .get()

    return this.inertia('Tasks/Index', { tasks, completed })
  }

  async store() {
    const title = await this.input<string>('title')

    if (!title || title.trim().length === 0) {
      return this.redirect('/tasks')
    }

    await Task.create({ title: title.trim() })
    return this.redirect('/tasks')
  }

  async update() {
    const id = Number(this.request.param('id'))
    const completed = await this.input<boolean>('completed')

    await Task.update({ id }, { completed: completed ?? true })
    return this.redirect('/tasks')
  }
}
```

Three methods, each a few lines. `this.input()` reads from the request body. `this.inertia()` renders a React page with typed props. `this.redirect()` sends the user back.

## 5. Define Routes

Open `routes/web.ts` and add:

```ts
import TaskController from '@/app/Http/Controllers/TaskController'

Route.get('/tasks', [TaskController, 'index']).name('tasks.index')
Route.post('/tasks', [TaskController, 'store']).name('tasks.store')
Route.put('/tasks/:id', [TaskController, 'update']).name('tasks.update')
```

Three routes, three controller methods. The `[Controller, 'method']` tuple syntax gives you autocompletion on the method name.

## 6. Create the Page

Create `resources/js/pages/Tasks/Index.tsx`:

```tsx
import { useForm } from '@inertiajs/react'

type Task = {
  id: number
  title: string
  completed: boolean
  createdAt: string
}

type Props = {
  tasks: Task[]
  completed: Task[]
}

export default function TasksIndex({ tasks, completed }: Props) {
  const form = useForm({ title: '' })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    form.post('/tasks', { onSuccess: () => form.reset() })
  }

  function toggleTask(task: Task) {
    form.put(`/tasks/${task.id}`, {
      data: { completed: !task.completed },
    })
  }

  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <h1 className="text-2xl font-bold">Tasks</h1>

      <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <input
          type="text"
          value={form.data.title}
          onChange={(e) => form.setData('title', e.target.value)}
          placeholder="What needs to be done?"
          className="flex-1 rounded border px-3 py-2"
        />
        <button
          type="submit"
          disabled={form.processing}
          className="rounded bg-blue-600 px-4 py-2 text-white"
        >
          Add
        </button>
      </form>

      <ul className="mt-6 space-y-2">
        {tasks.map((task) => (
          <li key={task.id} className="flex items-center gap-3">
            <input
              type="checkbox"
              onChange={() => toggleTask(task)}
              className="h-4 w-4"
            />
            <span>{task.title}</span>
          </li>
        ))}
      </ul>

      {completed.length > 0 && (
        <>
          <h2 className="mt-8 text-lg font-semibold text-gray-500">
            Completed ({completed.length})
          </h2>
          <ul className="mt-2 space-y-2">
            {completed.map((task) => (
              <li key={task.id} className="flex items-center gap-3 text-gray-400">
                <input
                  type="checkbox"
                  checked
                  onChange={() => toggleTask(task)}
                  className="h-4 w-4"
                />
                <span className="line-through">{task.title}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  )
}
```

Inertia handles the communication between server and client. No fetch calls, no API routes, no loading states. Submit a form and the page updates with fresh server data.

## 7. Run It

```bash
bun run dev
```

Open `http://localhost:3333/tasks`. Type a task, hit **Add**, and watch it appear. Check the box and it moves to the completed section.

## What Just Happened?

Here is the flow you just built:

1. **Browser** requests `GET /tasks`
2. **Route** maps the URL to `TaskController.index`
3. **Controller** queries tasks through the **Model** and calls `this.inertia()`
4. **Inertia** renders the React page with the data as props
5. User submits the form — Inertia sends `POST /tasks` without a full page reload
6. **Controller** creates the task and redirects back
7. Inertia follows the redirect, fetches fresh props, and updates the page

This is the core loop for everything you build in Guren. The same pattern scales from this task list to a full application with authentication, validation, file uploads, and background jobs.

## Next Steps

You have a working feature. Here is where to go deeper:

- **[Routing Guide](./routing.md)** — Middleware groups, resource routes, route model binding.
- **[Controller Guide](./controllers.md)** — Validation with FormRequest, response helpers, dependency injection.
- **[Database Guide](./database.md)** — Relationships, scopes, pagination, hooks, and seeders.
- **[Frontend Guide](./frontend.md)** — Layouts, shared props, SSR, and asset handling.
- **[Authentication Guide](./authentication.md)** — Add login and protect routes.
- **[Testing Guide](./testing.md)** — Write tests for everything you just built.
