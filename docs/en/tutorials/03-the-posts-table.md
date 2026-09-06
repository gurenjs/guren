# Chapter 3: The Posts Table

A blog needs posts, and posts need somewhere to live. In this chapter you define the first table, generate and run its migration, write the model that reads it, and build the two pages that show posts. Then you specify the create form with a test and hand it to the agent, and you see the `scaffold` skill steer it toward the generators instead of typing.

**What you'll learn:**

- How a table is declared once, in `db/schema.ts`, and how the migration and the model's types both derive from it
- What `bun run db:make` and `bun run db:migrate` do, and where the test database comes from
- What a model adds on top of the table: `create`, `all`, `findOrFail`, and mass-assignment protection with `fillable`
- Route model binding: `bind: { id: Post }` on the route, `this.model(Post)` in the controller, and a 404 you never write
- How to test a controller against a real database, reset between tests

Start the dev server if it is not running:

```bash run background
bun run dev
```

## 1. The table

Everything about the shape of a post is written once, in `db/schema.ts`. The scaffold already has a `users` table there (chapter 5 puts it to work). Add `posts` under it:

```ts file=db/schema.ts
import { sqliteTable, integer, text } from '@guren/orm/drizzle/sqlite'

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

Four columns: an auto-incrementing id, a title, a body, and a creation timestamp that fills itself in. `notNull()` is a database constraint, not a hint; a row without a title is refused by SQLite, whatever the application code does.

The schema is TypeScript, but the database does not read TypeScript. It reads SQL, and the SQL is generated:

```bash run
bun run db:make create_posts_table
```

`db:make` diffs `db/schema.ts` against every migration already in `db/migrations/` and writes the SQL that closes the gap. This is the first migration, so it creates both tables. Open the new folder under `db/migrations/`: a `migration.sql` you can read, and that you never edit by hand. Apply it:

```bash run
bun run db:migrate
```

That ran against `./data/guren.db`, the development database. Tests use a separate file, `./data/guren.test.db`, and Guren applies pending migrations to whichever database it opens first, so the test suite does not need a migration step of its own.

## 2. The model

The table describes rows. The model is how the rest of the app talks about them. Create `app/Models/Post.ts`:

```ts file=app/Models/Post.ts
import { defineModel } from '@guren/core'
import { posts } from '../../db/schema.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends defineModel(posts, { fillable: ['title', 'body'] }) {
}
```

That is the whole model, and it is deliberately thin. `defineModel(posts)` gives the class `find`, `findOrFail`, `all`, `create`, `update`, `delete`, `paginate` and a query builder, all typed from the table: `PostRecord` has exactly the four columns above, and you never write that type by hand.

`fillable` is the one line that is about safety rather than convenience. `Post.create(data)` will only write the keys listed here; an `id` or a `createdAt` smuggled into `data` is dropped. In chapter 4 you pass validated request bodies to `create`, and this is what keeps a client from setting fields the form never offered. `guren audit` checks for it.

## 3. The specification

Two pages: a list at `/posts` and one post at `/posts/:id`. Say what they do before they exist:

```ts file=tests/PostController.test.ts
import { beforeAll, beforeEach, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post } from '../app/Models/Post.js'

describe('PostController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('lists posts, newest first', async () => {
    await Post.create({ title: 'First post', body: 'Hello' })
    await Post.create({ title: 'Second post', body: 'Again' })

    const response = await http.get('/posts').assertOk()
    const html = await response.text()
    const first = html.indexOf('First post')
    const second = html.indexOf('Second post')
    if (first === -1 || second === -1 || second > first) {
      throw new Error('expected the newer post to be listed before the older one')
    }
  })

  it('shows one post', async () => {
    const post = await Post.create({ title: 'Read me', body: 'The whole body' })

    const response = await http.get(`/posts/${post.id}`).assertOk()
    await response.assertBodyContains('The whole body')
  })

  it('answers 404 for a post that does not exist', async () => {
    await http.get('/posts/999').assertNotFound()
  })
})
```

Two new things in this test. `resetDatabase()` runs before each test: it drops every table in the test database and re-applies the migrations, so each test starts from nothing and can create exactly the rows it needs. And the tests create rows through the model, `Post.create(...)`, the same way the app will.

```bash run expect-fail
bun test
```

Three new failures, all 404s. Now build what they describe.

## 4. The controller and the routes

Create `app/Http/Controllers/PostController.ts`:

```ts file=app/Http/Controllers/PostController.ts
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'

export default class PostController extends Controller {
  async index(): Promise<Response> {
    const posts = await Post.orderBy(['id', 'desc'])

    return this.inertia(pages.posts.Index, {
      posts: posts.map((post) => ({ id: post.id, title: post.title, body: post.body })),
    })
  }

  async show(): Promise<Response> {
    const post = this.model(Post)

    return this.inertia(pages.posts.Show, {
      post: { id: post.id, title: post.title, body: post.body, createdAt: post.createdAt },
    })
  }
}
```

`index` reads every post, newest first, and maps each row to the three fields the page needs. That map is not busywork: the page gets what you chose to send and nothing else. Chapter 4 gives that mapping a proper home.

`show` has no lookup in it. The route does the lookup. Replace `routes/web.ts`:

```ts file=routes/web.ts
import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import { Post } from '../app/Models/Post.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.get('/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])
  })

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

- `router.group('/posts', ...)` prefixes every route inside it, so `'/:id'` is `/posts/:id`.
- `bind: { id: Post }` is **route model binding**: before the action runs, Guren calls `Post.findOrFail(id)` with the path parameter and hands the record to the controller, where `this.model(Post)` returns it typed as a `PostRecord`. If there is no such post, `findOrFail` throws and the response is a 404. That is the third test, and you wrote no code for it.
- The options object is the second argument when a route has options; `.name()` works either way.

## 5. The pages

Two components. The list:

```tsx file=resources/js/pages/posts/Index.tsx
import { Head, Link } from '@inertiajs/react'
import { route } from '@/.guren/routes.gen'

interface PostSummary {
  id: number
  title: string
  body: string
}

interface Props {
  posts: PostSummary[]
}

export default function PostsIndex({ posts }: Props) {
  return (
    <>
      <Head title="Posts" />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
            <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
            Posts
          </h1>
          {posts.length === 0 && <p className="text-g-text-2">No posts yet.</p>}
          <div className="space-y-4">
            {posts.map((post) => (
              <article key={post.id} className="rounded-g-card border border-g-line bg-g-panel p-4 shadow-g-card">
                <Link href={route('posts.show', { id: post.id })} className="text-xl font-bold text-g-heading transition hover:text-g-accent-text">
                  {post.title}
                </Link>
                <p className="mt-2 text-sm text-g-text-2">{post.body}</p>
              </article>
            ))}
          </div>
        </div>
      </main>
    </>
  )
}
```

`route('posts.show', { id: post.id })` is the typed route helper from `.guren/routes.gen.ts`. It knows every route name and which parameters each takes; `route('posts.shwo', ...)` or a missing `id` is a compile error. The `PostSummary` interface is local to the page, and codegen picks it up along with `Props`.

And one post:

```tsx file=resources/js/pages/posts/Show.tsx
import { Head, Link } from '@inertiajs/react'
import { route } from '@/.guren/routes.gen'

interface Props {
  post: {
    id: number
    title: string
    body: string
    createdAt: string
  }
}

export default function PostShow({ post }: Props) {
  return (
    <>
      <Head title={post.title} />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <Link href={route('posts.index')} className="text-sm text-g-accent-text transition hover:underline">
            All posts
          </Link>
          <h1 className="text-3xl font-bold text-g-heading">{post.title}</h1>
          <p className="font-mono text-xs text-g-text-2">{post.createdAt}</p>
          <p className="whitespace-pre-wrap text-lg">{post.body}</p>
        </div>
      </main>
    </>
  )
}
```

Regenerate the manifests, then run the specification:

```bash run
bun run codegen
```

```bash run
bun test
```

Green. **Checkpoint:** open [http://localhost:3333/posts](http://localhost:3333/posts). "No posts yet." There is no way to write one from the browser; that is the next slice. Gate and commit what you have:

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add the posts table, model, and read pages"
```

## 6. Specify the create form

Two more tests: the form is served, and submitting it creates a post and redirects to it. Replace the test file:

```ts file=tests/PostController.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post } from '../app/Models/Post.js'

describe('PostController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('lists posts, newest first', async () => {
    await Post.create({ title: 'First post', body: 'Hello' })
    await Post.create({ title: 'Second post', body: 'Again' })

    const response = await http.get('/posts').assertOk()
    const html = await response.text()
    const first = html.indexOf('First post')
    const second = html.indexOf('Second post')
    if (first === -1 || second === -1 || second > first) {
      throw new Error('expected the newer post to be listed before the older one')
    }
  })

  it('shows one post', async () => {
    const post = await Post.create({ title: 'Read me', body: 'The whole body' })

    const response = await http.get(`/posts/${post.id}`).assertOk()
    await response.assertBodyContains('The whole body')
  })

  it('answers 404 for a post that does not exist', async () => {
    await http.get('/posts/999').assertNotFound()
  })

  it('serves the form for a new post', async () => {
    await http.get('/posts/create').assertOk()
  })

  it('stores a post and redirects to it', async () => {
    await http.post('/posts', { title: 'Written in a test', body: 'By a test' }).assertRedirect()

    const post = await Post.where('title', 'Written in a test').first()
    expect(post).not.toBeNull()
    expect(post?.body).toBe('By a test')
  })
})
```

```bash run expect-fail
bun test
```

Two red, three green. Notice the order problem the second new test is about to create: `/posts/create` must be registered *before* `/posts/:id`, or the router will try to look up a post with the id `create` and answer 404.

## 7. Delegate it

Ask your agent:

> Add the create form for posts. `GET /posts/create`, named `posts.create`, renders `resources/js/pages/posts/New.tsx` with a title input and a body textarea that submit to `POST /posts`, named `posts.store`. The `store` action validates `title` and `body` as non-empty strings with zod, creates the post, and redirects to its page. Register `/posts/create` before `/posts/:id`. `tests/PostController.test.ts` describes the behaviour; make it pass.

This chapter's harness lever is the **`scaffold` skill** in `.claude/skills/scaffold/`. It tells the agent which `bunx guren make:*` generators exist and when to reach for them instead of typing a file from memory: `make:view posts/New` for the page skeleton, `make:validator Post` for a Zod schema file. Watch whether your agent uses one. Either outcome is acceptable here, but a generator's output is the framework's idiom, verified, and an agent that reaches for it has less room to be wrong.

**No agent handy?** Three files. The controller gains two actions:

```ts file=app/Http/Controllers/PostController.ts fallback
import { Controller } from '@guren/core'
import { z } from 'zod'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'

const PostPayloadSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
})

export default class PostController extends Controller {
  async index(): Promise<Response> {
    const posts = await Post.orderBy(['id', 'desc'])

    return this.inertia(pages.posts.Index, {
      posts: posts.map((post) => ({ id: post.id, title: post.title, body: post.body })),
    })
  }

  async show(): Promise<Response> {
    const post = this.model(Post)

    return this.inertia(pages.posts.Show, {
      post: { id: post.id, title: post.title, body: post.body, createdAt: post.createdAt },
    })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.posts.New, {})
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(PostPayloadSchema)
    const post = await Post.create(data)
    return this.redirect(`/posts/${post.id}`)
  }
}
```

```ts file=routes/web.ts fallback
import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import { Post } from '../app/Models/Post.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.get('/create', [PostController, 'create']).name('posts.create')
    posts.get('/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])
    posts.post('/', [PostController, 'store']).name('posts.store')
  })

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

```tsx file=resources/js/pages/posts/New.tsx fallback
import { Head, useForm } from '@inertiajs/react'
import { route } from '@/.guren/routes.gen'

interface PostForm {
  title: string
  body: string
}

export default function NewPost() {
  const form = useForm<PostForm>({ title: '', body: '' })

  return (
    <>
      <Head title="New post" />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <h1 className="text-3xl font-bold text-g-heading">New post</h1>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              form.post(route('posts.store'))
            }}
          >
            <input
              value={form.data.title}
              onChange={(event) => form.setData('title', event.target.value)}
              placeholder="Title"
              className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
            />
            <textarea
              value={form.data.body}
              onChange={(event) => form.setData('body', event.target.value)}
              placeholder="Body"
              rows={8}
              className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
            />
            <button type="submit" className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
              Publish
            </button>
          </form>
        </div>
      </main>
    </>
  )
}
```

The page uses Inertia's `useForm`: it holds the field values, and `form.post()` submits them and follows the redirect. When the server rejects the submission, the messages land in `form.errors`; the page does not show them yet, and chapter 4 is about exactly that.

Regenerate and run the specification:

```bash run
bun run codegen
```

```bash run
bun test
```

The rubric:

- `routes/web.ts` registers `/create` before `/:id`, and `POST /posts` is named `posts.store`.
- `store` calls `this.validateBody()` with a schema; it does not read the request body any other way. `guren audit` fails the gate on a body read without validation, so this is not a style point.
- `store` passes only the validated data to `Post.create()`, and redirects rather than rendering.
- The page submits through `useForm` and `route('posts.store')`, not a hard-coded URL.
- All five tests are green.

**Checkpoint:** write a post at [http://localhost:3333/posts/create](http://localhost:3333/posts/create). You land on its page; the list shows it first.

```bash run
bunx guren gate
```

The gate is green, but `gate` reports only failures. Run the audit on its own before moving on:

```bash run
bunx guren audit
```

It warns that `POST /posts` has no authentication check: anyone can create a post. The warning does not fail the audit or the gate, and it is correct. Leave it; chapter 6 is about exactly that, and until then the blog has no users to authenticate.

```bash run
git add -A
git commit -m "feat: add the new post form"
```

## What the generator would have done

Everything in this chapter and the next is what `bunx guren add resource` writes in one command: schema, migration, model, validator, resource, a seven-action controller, routes, and four pages. You built it by hand so that you can read that output, which is how you will use it from chapter 5 on. To see the comparison now, on a branch you will throw away:

```bash manual
git switch -c scratch/add-resource
bunx guren add resource Post --fields "title:string,body:text" --force
git diff main --stat
git switch main
git branch -D scratch/add-resource
```

The generated controller differs from yours in two ways worth noticing: it validates the `:id` parameter with a schema instead of binding the model, and its `index` paginates. Both are chapter 4.

## Where you are

- A `posts` table, its migration, and a model with `fillable`.
- A list and a detail page reading real rows, with a 404 the router provides.
- Tests that run against a real database and reset it between cases.
- A create form, specified by you and built by the agent (or by three files), with validation in front of the database.
- One `audit` warning you understand and are leaving on purpose.

## Common trip-ups

- **`db:make` says "No schema changes".** The schema file is unchanged since the last migration, or you edited a different file. Check that `posts` is exported from `db/schema.ts`.
- **Tests fail with "no such table: posts".** The test database is created on first use and migrated then; if a previous run left a half-migrated `data/guren.test.db` behind, delete the file and run the tests again.
- **`/posts/create` returns 404.** It is registered after `/posts/:id`. Order matters: routes match top to bottom.
- **`guren audit` fails with "Request body is read without validation".** The store action reads the body with something other than `validateBody()`. Use the schema.
- **`this.model(Post)` throws "No model binding found".** The route has no `bind` option for that parameter. Binding is declared on the route, not inferred from the controller.

## Next

[Chapter 4: Validation and Resources](./04-validation-and-resources.md) moves the schema into a validator file with a route contract, shows validation errors on the form, introduces the resource layer, and hands editing, deleting and pagination to the agent.
