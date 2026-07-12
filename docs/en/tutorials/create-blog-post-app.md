# Part 1: Create a Blog Post App

In this part you build the heart of the blog: creating, listing, and reading posts. You write every file by hand — table, model, validator, controller, routes, and pages — so you see exactly how a request travels through a Guren application.

**What you'll learn:**

- How to scaffold a new Guren app with SQLite (zero configuration)
- How the pieces connect: schema → model → validator → controller → routes → Inertia pages
- How to validate requests with Zod and `validateBody` / `validateQuery` / `validateParams`
- How to build forms with Inertia's `useForm` and display validation errors
- Why `bun run codegen` exists and when to re-run it

> [!TIP]
> Everything in this part can be generated with a single command: `bunx guren add resource posts --fields "title:string,body:text"`. We build it manually so you understand what that generator produces — after this tutorial, you can decide when to reach for the shortcut.

## 1. Scaffold the app

Create a new project and answer the prompts:

```bash
bunx create-guren-app my-blog
```

The CLI asks two questions:

- **Rendering mode** — keep the default (**SSR**).
- **Database driver** — keep the default (**SQLite**, "zero-config, recommended for getting started").

The scaffolder copies the template, writes a ready-to-use `.env` (including a generated `APP_KEY` and `DATABASE_URL=./data/guren.db`), and installs dependencies for you. Then start the dev server:

```bash
cd my-blog
bun run dev
```

**Checkpoint:** open [http://localhost:3333](http://localhost:3333). You should see the welcome page — a "Welcome to My Blog!" heading, a grid of feature cards, and a "Next steps" box with suggested commands. No database setup, no containers: the SQLite file is created on demand under `./data/`.

Leave the dev server running in this terminal and use a second one for the commands below.

## 2. Define the posts table

The scaffold uses SQLite, so tables are declared with `sqliteTable` and the SQLite column helpers. Add a `posts` table to your schema.

Edit `db/schema.ts` and add the highlighted table below the existing `users` table:

```ts
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

Generate a migration from the schema, then apply it:

```bash
bun run db:make create_posts_table
bun run db:migrate
```

`db:make` diffs `db/schema.ts` against your existing migrations and writes a new SQL file into `db/migrations/`. `db:migrate` applies it to the SQLite database.

## 3. Create the Post model

Models give you a Laravel-style API (`find`, `create`, `paginate`, relationships) on top of your Drizzle tables.

Create `app/Models/Post.ts`:

```ts
import { defineModel } from '@guren/core'
import { posts } from '../../db/schema.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends defineModel(posts) {
  static fillable = ['title', 'body']
}
```

Two things to note:

- `PostRecord` is inferred from the table — you never write the record type by hand.
- `fillable` is a mass-assignment allowlist: passing any field outside it to `Post.create()` or `Post.update()` throws a `MassAssignmentException`, so bugs and injection attempts surface immediately instead of being silently discarded. For trusted server-side data (seeders, system records), `forceCreate()` bypasses the allowlist — see the [Database guide](../guides/database.md) for details.

## 4. Add a validator

Keep your Zod schemas in one file per resource so controllers and routes can share them.

Create `app/Http/Validators/PostValidator.ts`:

```ts
import { z } from 'zod'

export const PostPayloadSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.'),
  body: z.string().trim().min(1, 'Body is required.'),
})

export type PostPayload = z.infer<typeof PostPayloadSchema>

export const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const ListPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})
```

Route params and query strings arrive as strings, so `z.coerce.number()` converts them before validating.

## 5. Build the controller

Create `app/Http/Controllers/PostController.ts`:

```ts
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '../../../.guren/pages.gen.js'
import { Post, type PostRecord } from '../../Models/Post.js'
import {
  ListPostsQuerySchema,
  PostIdParamSchema,
  PostPayloadSchema,
} from '../Validators/PostValidator.js'

type PostsIndexProps = PaginatedPageProps<PostRecord>

export default class PostController extends Controller {
  async index(): Promise<Response> {
    const { page } = this.validateQuery(ListPostsQuerySchema)
    const result = await Post.paginate({ page, perPage: 10, orderBy: ['id', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })

    return this.inertia(pages.posts.Index, {
      data: result.data,
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies PostsIndexProps)
  }

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)

    return this.inertia(pages.posts.Show, { post })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.posts.Create, {})
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(PostPayloadSchema)
    const post = await Post.create(data)

    return this.redirect(post ? `/posts/${post.id}` : '/posts')
  }
}
```

How each action works:

- **`index`** validates `?page=` with `validateQuery`, fetches a page of posts, and wraps the result with the `paginate` helper, which builds the page links your React component renders.
- **`show`** validates the `:id` route param and uses `findOrFail`, which automatically responds with 404 when the post does not exist — no manual null check.
- **`create`** just renders the form page.
- **`store`** validates the request body with `validateBody`. On failure it throws a 422 with field-level messages, and Inertia feeds those back into your form as `form.errors` — you write no error-handling code for that.
- **`pages.posts.Index`** comes from `.guren/pages.gen.ts`, a generated manifest that ties page names to their prop types. Your editor will complain until you run codegen in step 8 — that's expected.

## 6. Register the routes

Edit `routes/web.ts`:

```ts
import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.get('/create', [PostController, 'create']).name('posts.create')
    posts.get('/:id', [PostController, 'show']).name('posts.show')
    posts.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
  })
}
```

Details worth noticing:

- Every route gets a `.name()` (or a `name` option) so pages can link with the typed `route()` helper instead of hard-coded URLs.
- The `body: PostPayloadSchema` option attaches the Zod schema to the route contract, so codegen can generate a typed request body for the frontend.
- `/create` is registered **before** `/:id`. Routes match top to bottom — if `/:id` came first, `/posts/create` would try to parse `"create"` as an id.

## 7. Create the pages

Inertia pages are plain React components under `resources/js/pages/`. The directory path becomes the page name: `resources/js/pages/posts/Index.tsx` is `pages.posts.Index`. Declaring an `interface Props` lets codegen extract the prop types so `this.inertia()` is type-checked end to end.

Create `resources/js/pages/posts/Index.tsx`:

```tsx
import { Link } from '@inertiajs/react'
import type { PaginatedPageProps } from '@guren/core'
import type { PostRecord } from '../../../../app/Models/Post.js'
import { route } from '../../../../.guren/routes.gen'

interface Props extends PaginatedPageProps<PostRecord> {}

export default function PostsIndex({ data: posts, pagination }: Props) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold">Posts</h1>
        <Link href={route('posts.create')} className="rounded bg-black px-4 py-2 text-white">
          New post
        </Link>
      </div>

      {posts.length === 0 ? (
        <p className="text-zinc-500">No posts yet. Write the first one!</p>
      ) : (
        <div className="space-y-4">
          {posts.map((post) => (
            <article key={post.id} className="rounded border p-4">
              <Link
                href={route('posts.show', { id: post.id })}
                className="text-xl font-medium hover:underline"
              >
                {post.title}
              </Link>
              <p className="mt-1 text-sm text-zinc-500">
                {new Date(post.createdAt).toLocaleDateString()}
              </p>
            </article>
          ))}
        </div>
      )}

      {pagination.meta.lastPage > 1 && (
        <nav className="flex gap-2" aria-label="Pagination">
          {pagination.links.pages.map((page) => (
            <Link
              key={page.page}
              href={page.url ?? '#'}
              className={`rounded border px-3 py-1 ${page.active ? 'bg-black text-white' : ''}`}
            >
              {page.page}
            </Link>
          ))}
        </nav>
      )}
    </main>
  )
}
```

The `import type { PostRecord }` line pulls a type from server-side code — that's fine, because type-only imports are erased at build time.

Create `resources/js/pages/posts/Show.tsx`:

```tsx
import { Link } from '@inertiajs/react'
import type { PostRecord } from '../../../../app/Models/Post.js'
import { route } from '../../../../.guren/routes.gen'

interface Props {
  post: PostRecord
}

export default function PostsShow({ post }: Props) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <Link href={route('posts.index')} className="text-sm text-zinc-500 hover:underline">
        &larr; Back to posts
      </Link>
      <h1 className="text-3xl font-semibold">{post.title}</h1>
      <p className="text-sm text-zinc-500">{new Date(post.createdAt).toLocaleDateString()}</p>
      <div className="space-y-4 leading-relaxed">
        {post.body.split('\n').map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
    </main>
  )
}
```

Create `resources/js/pages/posts/Create.tsx`:

```tsx
import { Link, useForm } from '@inertiajs/react'
import { route } from '../../../../.guren/routes.gen'

type PostFormData = {
  title: string
  body: string
}

export default function PostsCreate() {
  const form = useForm<PostFormData>({ title: '', body: '' })

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <Link href={route('posts.index')} className="text-sm text-zinc-500 hover:underline">
        &larr; Back to posts
      </Link>
      <h1 className="text-3xl font-semibold">New post</h1>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          form.post(route('posts.store'))
        }}
      >
        <div>
          <label htmlFor="title" className="block text-sm font-medium">
            Title
          </label>
          <input
            id="title"
            value={form.data.title}
            onChange={(event) => form.setData('title', event.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
          {form.errors.title && <p className="mt-1 text-sm text-red-600">{form.errors.title}</p>}
        </div>

        <div>
          <label htmlFor="body" className="block text-sm font-medium">
            Body
          </label>
          <textarea
            id="body"
            rows={8}
            value={form.data.body}
            onChange={(event) => form.setData('body', event.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
          {form.errors.body && <p className="mt-1 text-sm text-red-600">{form.errors.body}</p>}
        </div>

        <button
          type="submit"
          disabled={form.processing}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          Create post
        </button>
      </form>
    </main>
  )
}
```

`useForm` handles the whole submit lifecycle: `form.post()` sends the data, `form.processing` disables the button in flight, and when the server rejects with a 422, `form.errors.title` / `form.errors.body` hold the messages from your Zod schema.

## 8. Run codegen

```bash
bun run codegen
```

**Why:** codegen scans your routes and pages and writes typed manifests into `.guren/` — `pages.gen.ts` (page names plus the `Props` extracted from each component, used by `this.inertia()`) and `routes.gen.ts` (the `route()` helper with autocomplete for route names and params). This is what makes a typo like `pages.posts.Idnex` or a missing prop a **compile-time** error instead of a runtime surprise.

**When to re-run:** whenever you add, rename, or remove a route or page, or change a page's `Props`. In practice you rarely run it by hand — `bun run dev` runs codegen on startup, and the dev server watches `routes/web.ts` and `resources/js/pages/` and regenerates on change. Reach for the explicit command when your editor shows stale types.

## 9. Checkpoint: create your first post

With the dev server running (`bun run dev` if you stopped it):

1. Open [http://localhost:3333/posts](http://localhost:3333/posts) — you see the empty state ("No posts yet").
2. Click **New post**, submit the form with both fields **empty** — the page stays put and shows "Title is required." under the input. That's your Zod schema talking, round-tripped through the 422 response into `form.errors`.
3. Fill in a title and body and submit — you are redirected to the new post's page.
4. Go back to `/posts` — your post is in the list.

You built a complete request cycle: route → validation → model → database → Inertia page, all type-checked.

## Common problems

**`Cannot find module '.guren/pages.gen'` or `pages.posts.Index` does not exist.**
Codegen hasn't run since you added the pages. Run `bun run codegen` (or restart `bun run dev`).

**`no such table: posts` when opening `/posts`.**
The migration was never generated or applied. Run `bun run db:make create_posts_table` and then `bun run db:migrate`.

**Submitting the form does nothing.**
It almost certainly returned a 422. Check that your page renders `form.errors.title` and `form.errors.body` — the messages are there, you're just not showing them. The network tab (an `X-Inertia` POST to `/posts`) confirms it.

**`/posts/create` responds with 404 or a validation error about `id`.**
Your `/:id` route is registered before `/create`. Declare `posts.get('/create', ...)` above `posts.get('/:id', ...)`.

**Type error in `this.inertia(pages.posts.Index, ...)` after changing props.**
The page manifest is stale. Re-run `bun run codegen` so the extracted `Props` match what the controller sends.

**`Directory "my-blog" is not empty` when scaffolding.**
Pick a fresh directory name or pass `--force` to scaffold anyway.

## Next

Right now anyone can publish a post. Fix that in [Part 2: Add Authentication](./authentication.md).
