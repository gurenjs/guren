# Part 1: Create a Blog Post App

In this part you build the heart of the blog — creating, listing, editing, and deleting posts. But you will not write the files one by one. The Guren way of working is: **generate with the CLI, read the generated code to understand it, and verify with mechanical checks**. One command generates the full vertical slice (schema → model → validator → resource → controller → routes → pages); then you read each layer, and finally you let `guren check` and `guren audit` verify the app's wiring and its defenses.

**What you'll learn:**

- How to scaffold a fresh Guren app on SQLite (zero configuration)
- What `bunx guren add resource` generates, and what it wires up automatically
- The Guren development loop: **generate → migrate → codegen → check → verify in the browser**
- How to derive project knowledge from the code with `guren context` and spec views
- How to read the generated code: how the pieces connect (schema → model → validator → resource → controller → routes → Inertia pages)
- How to refine generated output: validation messages, error display, `fillable`
- How `guren audit` points out security gaps for you

> [!TIP]
> If you'd rather trace one request through every layer by hand to build a deep mental model first, the 10-minute tour in [First Steps](../guides/first-steps.md) is the better fit. This tutorial follows the generator-driven flow you'll use in day-to-day work.

## 1. Scaffold the app

Create a new project and answer the prompts:

```bash
bunx create-guren-app my-blog
```

The CLI asks two questions:

- **Rendering mode** — keep the default (**SSR**).
- **Database driver** — keep the default (**SQLite**, "zero-config, recommended for getting started").

The scaffolder copies the template, writes a ready-to-use `.env` (with a generated `APP_KEY` and `DATABASE_URL=./data/guren.db`), and installs dependencies. Start the dev server:

```bash
cd my-blog
bun run dev
```

**Checkpoint:** open [http://localhost:3333](http://localhost:3333). You should see the welcome page. No database setup, no containers: the SQLite file is created under `./data/` the moment it's needed.

Keep the dev server running in this terminal and run the following commands in a second one.

## 2. Generate the posts resource with one command

This is where the tutorial takes the Guren path. Generate everything the posts feature needs, all at once:

```bash
bunx guren add resource posts --fields "title:string,body:text" --public
```

- `--fields` defines the columns. List `name:type` pairs separated by commas; types are `string` / `text` / `number` / `boolean` / `date` / `json` (append `?` for nullable, e.g. `published:boolean?`). This single definition drives the schema columns, the Zod schemas, the resource types, and the form fields — consistently.
- `--public` is a temporary opt-out. Guren's generators put a **sign-in guard into store / update / destroy by default** (secure by default). This app has no authentication yet, so we opt out for now and restore the guard in [Part 2](./authentication.md).

The command creates these files:

| File | Purpose |
|------|---------|
| `app/Models/Post.ts` | The `Post` model wrapping the `posts` table |
| `app/Http/Validators/PostValidator.ts` | Three Zod schemas (payload, route params, list query) |
| `app/Http/Resources/PostResource.ts` | `PostResource`, which makes the browser payload explicit |
| `app/Http/Controllers/PostController.ts` | Seven actions (index / show / create / store / edit / update / destroy) |
| `resources/js/pages/posts/Index.tsx` | List page (with pagination) |
| `resources/js/pages/posts/Show.tsx` | Detail page (with Edit / Delete links) |
| `resources/js/pages/posts/New.tsx` | Create form |
| `resources/js/pages/posts/Edit.tsx` | Edit form |

It also **edits existing files**:

- `db/schema.ts` — appends the `posts` table definition (`id`, your fields, `createdAt`).
- `routes/web.ts` — appends the `/posts` route group (seven routes, named, with body schemas attached).

When it finishes, the command itself tells you what comes next: create and apply the migration, then run codegen. Let's do exactly that.

## 3. Generate the migration and the types

```bash
bun run db:make create_posts_table
bun run db:migrate
bun run codegen
```

- `db:make` diffs `db/schema.ts` against the existing migrations and writes a new SQL file into `db/migrations/`.
- `db:migrate` applies it to the SQLite database.
- `codegen` scans your routes and pages and writes typed manifests into `.guren/` — `pages.gen.ts` (page names plus the `Props` extracted from each component, used by `this.inertia()`) and `routes.gen.ts` (a `route()` helper with autocomplete for route names and params). This is why a typo in a page name or a missing prop becomes a **compile-time** error instead of a runtime incident.

**When to re-run codegen:** whenever you add, rename, or delete routes or pages, or change a page's `Props`. In practice you rarely run it by hand — `bun run dev` runs codegen at startup, and the dev server watches `routes/web.ts` and `resources/js/pages/` to regenerate on every change. Reach for the explicit command only when your editor shows stale types.

## 4. Check the wiring

Let the machine verify that everything generated and wired up actually lines up:

```bash
bunx guren check
```

`check` validates route ↔ controller ↔ page consistency, model-to-schema bindings, the presence of the `.guren/` artifacts, and more. Because a generator did the work, everything should be `[ok]` — with one warning:

```
WARN [warn] PostController tests: No test file named after PostController ...
       → If these routes are not already covered, run: bunx guren make:test Post --controller
```

`check` reports not just what's broken but what's *missing*. Tests are out of scope for this tutorial, so we move on — but in real work you'd follow the suggestion, scaffold with `make:test`, and flesh it out using the patterns in the [Testing guide](../guides/testing.md).

## 5. Checkpoint: take the CRUD for a lap

With the dev server running (`bun run dev` if you stopped it):

1. Open [http://localhost:3333/posts](http://localhost:3333/posts) — you'll see an empty list and a **New Post** button.
2. Use **New Post** to submit a title and a body — you're redirected to the new post's detail page.
3. Use **Edit** to change the body and submit — the update sticks.
4. Back on the list, create a second post. **Delete** works too (with a confirmation dialog).

Without writing a line of code, you have a CRUD with validation, pagination, and typed routing. Now let's read what it's made of.

## 6. Derive the big picture: context and spec

Before opening files one by one, survey the vertical slice you just generated:

```bash
bunx guren context Post
```

The model's columns, the seven routes (with typed bodies), the controller actions, the four pages with their `Props`, and the resource — everything about the `Post` entity on one screen. This is not a saved document: it's derived from the code on every run, so it can never rot.

Next, write the project-wide summary views into `docs/spec/`:

```bash
bunx guren spec:generate
```

This generates `er.md` (tables and foreign keys), `domain.md` (models and relationships), `screens.md` (pages mapped to routes), and `modules.md`. These are **specs derived from the code**, and they're artifacts you commit. When the code changes, the views go stale — and the gate that refuses to let that slide silently is `guren check --spec` (you'll watch it trip in Part 2). Guren manages project knowledge not by hand-maintained documents but in three layers: derived, declared, and checked. See [Spec-Anchored Development](../guides/spec-anchored.md) for the full picture.

## 7. Read the generated code

The generator's output is not a sealed black box — it's a starting point written to be read. Follow a request through the layers.

### Schema — `db/schema.ts`

```ts
export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

Your two `--fields` columns plus a primary key and a creation timestamp. This is the single source of truth for the data shape — the model's types and the migration you just ran are both derived from it.

### Model — `app/Models/Post.ts`

```ts
import { defineModel } from '@guren/core'
import { posts } from '../../db/schema.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends defineModel(posts) {
}
```

The model is remarkably thin. It layers a Laravel-style API (`find`, `create`, `paginate`, relationships) on top of the Drizzle table. `PostRecord` is inferred from the table — you never hand-write record types.

### Validator — `app/Http/Validators/PostValidator.ts`

```ts
import { z } from 'zod'

export const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const ListPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})

export const PostPayloadSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
})

export type PostPayload = z.infer<typeof PostPayloadSchema>
```

The three entry points a resource controller validates — request body, route params, list query — live in one file. Route params and query strings arrive as strings, so `z.coerce.number()` converts them before validation.

### Resource — `app/Http/Resources/PostResource.ts`

```ts
export interface PostResourceData extends Record<string, unknown> {
  id: number
  title: string
  body: string
}

export class PostResource extends Resource<PostRecord> {
  toArray(): PostResourceData {
    return {
      id: this.resource.id as number,
      title: this.resource.title as string,
      body: this.resource.body as string,
    }
  }
  // ...
}
```

The resource layer exists to **explicitly choose which fields reach the browser**. The Guren way is to never pass raw model records to `this.inertia()` — always route them through here. With only three columns it looks redundant; once you start handling user data in [Part 2](./authentication.md), this layer is the last line of defense against leaking `passwordHash`.

### Controller — `app/Http/Controllers/PostController.ts`

Of the seven actions, three carry the core ideas:

```ts
type PostsIndexProps = PaginatedPageProps<PostResourceData>

  async index(): Promise<Response> {
    const { page } = this.validateQuery(ListPostsQuerySchema)
    const result = await Post.paginate({ page, perPage: 10, orderBy: ['id', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })

    return this.inertia(pages.posts.Index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies PostsIndexProps)
  }

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)

    return this.inertia(pages.posts.Show, {
      post: new PostResource(post).toJSON(),
    })
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(PostPayloadSchema)
    const post = await Post.create(data)
    return this.redirect('/posts/' + post?.id)
  }
```

- **`index`** validates `?page=` with `validateQuery`, fetches one page of posts, and wraps the result with the `paginate` helper, which builds the page links your React component renders.
- **`show`** validates the `:id` route param and uses `findOrFail` — a missing post automatically becomes a 404, no manual null check.
- **`store`** validates the request body with `validateBody`. On failure it throws a `ValidationException`, and Inertia delivers the field-level messages back to the form as `form.errors` — you never write that error-handling code.
- **`pages.posts.Index`** comes from `.guren/pages.gen.ts`, the generated manifest binding page names to prop types. Your editor will complain until codegen runs — that's expected.

### Routes — `routes/web.ts`

```ts
  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.get('/create', [PostController, 'create']).name('posts.create')
    posts.get('/:id', [PostController, 'show']).name('posts.show')
    posts.get('/:id/edit', [PostController, 'edit']).name('posts.edit')
    posts.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
    posts.put('/:id', { name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
    posts.delete('/:id', { name: 'posts.destroy' }, [PostController, 'destroy'])
  })
```

- Every route carries `.name()` (or a `name` option), so pages can link with the typed `route()` helper instead of hardcoding URLs.
- The `body: PostPayloadSchema` option binds the Zod schema to the route contract, which lets codegen produce typed request bodies for the frontend.
- `/create` is registered **before** `/:id`. Routes match top to bottom, so with `/:id` first, `/posts/create` would try to parse `"create"` as an id. The generator wires this ordering for you.

### Page — `resources/js/pages/posts/New.tsx`

```tsx
import { useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import { route } from '@/.guren/routes.gen'

type PostFormData = RouteBody<ApiRoutes, 'posts.store'>

export default function NewPost() {
  const form = useForm<PostFormData>({ title: '', body: '' })
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <form className="space-y-4" onSubmit={(submitEvent) => { submitEvent.preventDefault(); form.post(route('posts.store')) }}>
        <input value={form.data.title} onChange={(event) => form.setData('title', event.target.value)} placeholder="title" className="w-full rounded border px-3 py-2" />
        <textarea value={form.data.body} onChange={(event) => form.setData('body', event.target.value)} placeholder="body" className="w-full rounded border px-3 py-2" />
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">Create</button>
      </form>
    </main>
  )
}
```

- Inertia pages are ordinary React components under `resources/js/pages/`. The directory path becomes the page name: `posts/New.tsx` is `pages.posts.New` (the URL is `/posts/create` and the route name is `posts.create` — file names and route names are independent).
- Note `RouteBody<ApiRoutes, 'posts.store'>`: the form's data type is **derived from the Zod schema bound to the route**, not hand-written. Add a field to `PostPayloadSchema` on the server and the form's type follows.
- `useForm` handles the whole submission lifecycle: `form.post()` sends the data, and when the server rejects it in validation, the messages land in `form.errors`.

## 8. Refine the output: show the error messages

Generator output is a starting point. Right now the form shows nothing when validation fails — the errors arrive in `form.errors`, but nothing renders them.

First give `app/Http/Validators/PostValidator.ts` human-friendly messages:

```ts
export const PostPayloadSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.'),
  body: z.string().trim().min(1, 'Body is required.'),
})
```

Then add error display under each input in `resources/js/pages/posts/New.tsx`:

```tsx
        <input value={form.data.title} onChange={(event) => form.setData('title', event.target.value)} placeholder="title" className="w-full rounded border px-3 py-2" />
        {form.errors.title && <p className="text-sm text-red-600">{form.errors.title}</p>}
        <textarea value={form.data.body} onChange={(event) => form.setData('body', event.target.value)} placeholder="body" className="w-full rounded border px-3 py-2" />
        {form.errors.body && <p className="text-sm text-red-600">{form.errors.body}</p>}
```

**Checkpoint:** on `/posts/create`, submit the form with **both fields empty** — the page doesn't navigate, and "Title is required." appears under the input. That's your Zod schema speaking: a server-side validation failure made the round trip into `form.errors`. Add the same two lines to `Edit.tsx` while you're at it.

## 9. Run the security audit

Finally, let Guren inspect the app's defenses:

```bash
bunx guren audit
```

Two kinds of warnings deserve attention:

```
WARN [warn] [A01] POST /posts: Mutating route has no authentication check (PostController.store).
WARN [warn] [A01] PUT /posts/:id: Mutating route has no authentication check (PostController.update).
WARN [warn] [A01] DELETE /posts/:id: Mutating route has no authentication check (PostController.destroy).
WARN [warn] [API3] Post mass assignment: Post declares no fillable — all columns except 'id' are mass-assignable.
```

- **A01** is the hole we opened on purpose with `--public`. `audit` keeps pointing at it so that "I'll add auth later" never silently becomes "I forgot". [Part 2](./authentication.md) resolves it by introducing authentication.
- **API3** you can fix right now. Declare a mass-assignment allowlist in `app/Models/Post.ts`:

```ts
export class Post extends defineModel(posts) {
  static fillable = ['title', 'body']
}
```

With `fillable` set, passing a field outside the allowlist to `Post.create()` or `Post.update()` throws a `MassAssignmentException`, so bugs and injection attempts surface immediately instead of being silently dropped. Run `bunx guren audit` again — the API3 warning is gone. See the [Database guide](../guides/database.md) for details.

That's the whole Guren development loop: **generate → migrate → codegen → check → verify → audit**. When the schema changes, `spec:generate` keeps the spec views in tow (and `check --spec` stops you if you skip it — you'll see that in Part 2). The rest of the series keeps turning the same loop.

## Common trip-ups

**`Cannot find module '.guren/pages.gen'`, or `pages.posts.Index` doesn't exist.**
Codegen hasn't run since routes and pages were added. Run `bun run codegen` (or restart `bun run dev`).

**Opening `/posts` says `no such table: posts`.**
The migration was never generated or applied. Run `bun run db:make create_posts_table` then `bun run db:migrate`.

**`bun run db:migrate` fails with "cannot connect to the database".**
You picked PostgreSQL / MySQL instead of SQLite when scaffolding. Start the container first with `bun run db:up`. See [Troubleshooting](../guides/troubleshoot.md).

**Submitting the form returns a 401, or redirects and nothing happens.**
You forgot `--public` on `add resource`. The generated store / update / destroy carry a `this.auth.userOrFail()` guard, which always fails until authentication is installed. Remove the guard lines by hand, or regenerate with `--force` and `--public` (careful: files you've edited will be overwritten).

**Submitting the form does nothing (no errors either).**
Validation rejected it. Make sure you added the error display from step 8 (`form.errors.title` / `form.errors.body`) — the messages are arriving; they're just not rendered.

**Type error at `this.inertia(pages.posts.Index, ...)` after changing props.**
The page manifest is stale. Re-run `bun run codegen` so the extracted `Props` match what the controller sends.

**`Directory "my-blog" is not empty` when scaffolding.**
Pick a fresh directory name, or pass `--force` to scaffold anyway.

## Next

As `guren audit` pointed out, anyone can create, edit, and delete posts right now. Let's fix that in [Part 2: Add Authentication](./authentication.md).
