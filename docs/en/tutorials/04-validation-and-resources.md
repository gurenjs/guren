# Chapter 4: Validation and Resources

Chapter 3 put a schema inside the controller and sent raw field maps to the pages. This chapter gives both a proper home: a validator file that the route, the controller and the form all share, with messages a person would write; and a resource class that decides what a post looks like to the browser. Then you specify editing, deleting and pagination with tests, hand them to the agent, and use the `code-review` subagent as a second reader before you accept.

**What you'll learn:**

- Where validation lives, and how one Zod schema types the route contract, the controller, and the form
- What a 422 response carries, and how Inertia puts field messages into `form.errors`
- What a resource is for, and why the pages never see a raw record
- How `Data.Post` in the generated manifests follows the resource
- How to ask a subagent to review a change, and what to do with its answer

Start the dev server if it is not running:

```bash run background
bun run dev
```

## 1. The test first: messages a person would write

Submit an empty form to `POST /posts` today and the schema rejects it, but with Zod's own wording. Say what you want instead. Add one test to `tests/PostController.test.ts`:

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

  it('rejects an empty post with a message per field', async () => {
    await http
      .post('/posts', { title: '', body: '' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
      .assertJsonPath('errors.body.0', 'Body is required')
  })
})
```

```bash run expect-fail
bun test
```

Red on the messages only: the status is already 422. That is the shape every validation failure has in Guren: status 422, a JSON body with `errors` keyed by field, each an array of messages. Inertia forms read exactly that.

## 2. The validator

Move the schema out of the controller into a file of its own, and give it the messages. Create `app/Http/Validators/PostValidator.ts`:

```ts file=app/Http/Validators/PostValidator.ts
import { z } from 'zod'

export const PostPayloadSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(120, 'Title must be 120 characters or fewer'),
  body: z.string().trim().min(1, 'Body is required'),
})

export type PostPayload = z.infer<typeof PostPayloadSchema>
```

Now bind it to the route. Replace `routes/web.ts`:

```ts file=routes/web.ts
import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import { Post } from '../app/Models/Post.js'
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.get('/create', [PostController, 'create']).name('posts.create')
    posts.get('/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])
    posts.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
  })

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

`body: PostPayloadSchema` is a **route contract**. It does not validate the request by itself; for a controller action, validation is the controller's `validateBody()` call, and `guren audit` checks that the call is there. What the contract does is feed codegen: the route's body type becomes part of the generated `ApiRoutes`, which is what types the form in the next section.

And the controller reads the schema from the validator:

```ts file=app/Http/Controllers/PostController.ts
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import { PostPayloadSchema } from '../Validators/PostValidator.js'

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

```bash run
bun test
```

Green. One schema, three readers: the route contract, the controller, and (next) the form.

## 3. Show the messages

Regenerate the manifests so the route contract reaches the frontend:

```bash run
bun run codegen
```

Then replace the form. Two changes: its data type is now derived from the route, and it renders `form.errors`:

```tsx file=resources/js/pages/posts/New.tsx
import { Head, useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import { route } from '@/.guren/routes.gen'

type PostForm = RouteBody<ApiRoutes, 'posts.store'>

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
            <div>
              <input
                value={form.data.title}
                onChange={(event) => form.setData('title', event.target.value)}
                placeholder="Title"
                className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
              />
              {form.errors.title && <p className="mt-1 text-sm text-g-danger">{form.errors.title}</p>}
            </div>
            <div>
              <textarea
                value={form.data.body}
                onChange={(event) => form.setData('body', event.target.value)}
                placeholder="Body"
                rows={8}
                className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
              />
              {form.errors.body && <p className="mt-1 text-sm text-g-danger">{form.errors.body}</p>}
            </div>
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

`RouteBody<ApiRoutes, 'posts.store'>` is `{ title: string; body: string }`, derived from `PostPayloadSchema` through the route contract. Add a field to the schema and the form's type gains it; misspell a route name and the type is `never`. You wrote the shape once, in the validator, and it reached the browser without being written again.

**Checkpoint:** open [http://localhost:3333/posts/create](http://localhost:3333/posts/create) and submit the empty form. "Title is required" under the title, "Body is required" under the body. Inertia took the 422, put the messages into `form.errors`, and re-rendered the same page; you wrote no error handling.

## 4. The resource

Both `index` and `show` build a post-shaped object by hand, and they disagree about which fields it has. That map has a name in Guren: a **resource**. Create `app/Http/Resources/PostResource.ts`:

```ts file=app/Http/Resources/PostResource.ts
import { Resource } from '@guren/core'
import type { PostRecord } from '../../Models/Post.js'

export interface PostResourceData extends Record<string, unknown> {
  id: number
  title: string
  body: string
  createdAt: string
}

export class PostResource extends Resource<PostRecord, PostResourceData> {
  toArray(): PostResourceData {
    return {
      id: this.resource.id,
      title: this.resource.title,
      body: this.resource.body,
      createdAt: this.resource.createdAt,
    }
  }
}
```

A resource is the one place that decides what a post looks like outside the server. With four columns it looks like ceremony. In chapter 5 the app gains users with password hashes, and the resource is what keeps `passwordHash` from ever being a prop. The rule from here on: **pages never receive a raw record**.

Use it in the controller:

```ts file=app/Http/Controllers/PostController.ts
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import { PostResource } from '../Resources/PostResource.js'
import { PostPayloadSchema } from '../Validators/PostValidator.js'

export default class PostController extends Controller {
  async index(): Promise<Response> {
    const posts = await Post.orderBy(['id', 'desc'])

    return this.inertia(pages.posts.Index, {
      posts: posts.map((post) => new PostResource(post).toJSON()),
    })
  }

  async show(): Promise<Response> {
    const post = this.model(Post)

    return this.inertia(pages.posts.Show, {
      post: new PostResource(post).toJSON(),
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

And let the pages import the shape instead of restating it:

```tsx file=resources/js/pages/posts/Index.tsx
import { Head, Link } from '@inertiajs/react'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

interface Props {
  posts: PostResourceData[]
}

export default function PostsIndex({ posts }: Props) {
  return (
    <>
      <Head title="Posts" />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <div className="flex items-center justify-between">
            <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
              <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
              Posts
            </h1>
            <Link href={route('posts.create')} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
              New post
            </Link>
          </div>
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

```tsx file=resources/js/pages/posts/Show.tsx
import { Head, Link } from '@inertiajs/react'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

interface Props {
  post: PostResourceData
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

```bash run
bun run codegen
```

Codegen noticed the resource: `.guren/data.gen.ts` now exports `Data.Post`, the same shape as `PostResourceData`, for any code that wants to name a post without importing the resource. Run everything:

```bash run
bun test
```

Green, and nothing observable changed. That is what a refactor under tests looks like.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: validate posts with messages and shape them with a resource"
```

## 5. Specify the rest of the CRUD

Edit, update, delete, and pagination at ten per page. Replace the test file:

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

  it('paginates ten posts per page', async () => {
    for (let i = 1; i <= 11; i++) {
      await Post.create({ title: `Post ${String(i).padStart(2, '0')}`, body: `Body number ${i}` })
    }

    const firstPage = await http.get('/posts').assertOk()
    await firstPage.assertBodyContains('Post 11')
    await firstPage.assertBodyContains('Post 02')
    expect(await firstPage.text()).not.toContain('Post 01')

    const secondPage = await http.get('/posts?page=2').assertOk()
    await secondPage.assertBodyContains('Post 01')
    expect(await secondPage.text()).not.toContain('Post 02')
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

  it('rejects an empty post with a message per field', async () => {
    await http
      .post('/posts', { title: '', body: '' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
      .assertJsonPath('errors.body.0', 'Body is required')
  })

  it('serves the edit form with the post in it', async () => {
    const post = await Post.create({ title: 'Before', body: 'The old body' })

    const response = await http.get(`/posts/${post.id}/edit`).assertOk()
    await response.assertBodyContains('The old body')
  })

  it('updates a post and redirects to it', async () => {
    const post = await Post.create({ title: 'Before', body: 'The old body' })

    await http.put(`/posts/${post.id}`, { title: 'After', body: 'The new body' }).assertRedirect(`/posts/${post.id}`)

    const updated = await Post.findOrFail(post.id)
    expect(updated.title).toBe('After')
    expect(updated.body).toBe('The new body')
  })

  it('rejects an invalid update with the same messages', async () => {
    const post = await Post.create({ title: 'Before', body: 'The old body' })

    await http
      .put(`/posts/${post.id}`, { title: '', body: 'Still here' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
  })

  it('deletes a post and redirects to the list', async () => {
    const post = await Post.create({ title: 'Doomed', body: 'Gone soon' })

    await http.delete(`/posts/${post.id}`).assertRedirect('/posts')

    expect(await Post.find(post.id)).toBeNull()
  })
})
```

```bash run expect-fail
bun test
```

Five red. Read them once more before delegating: they say the edit page carries the post, that update and delete redirect where a reader would expect, that an invalid update fails the same way an invalid create does, and that the eleventh post falls onto page two. That is a complete specification of the slice.

## 6. Delegate it

Ask your agent:

> Complete the posts CRUD. Add `edit`, `update` and `destroy` actions to `PostController` using route model binding like `show`, and register `GET /posts/:id/edit` (`posts.edit`), `PUT /posts/:id` (`posts.update`, with `body: PostPayloadSchema`) and `DELETE /posts/:id` (`posts.destroy`). Add `resources/js/pages/posts/Edit.tsx` as a form like `New.tsx` that submits with `form.put`, and give `Show.tsx` an Edit link and a Delete button. Paginate `index` at ten posts per page with `Post.paginate` and the `paginate` helper, validating `?page=` with a `ListPostsQuerySchema` in the validator, and render the page links in `Index.tsx`. Use `PostResource` for every post sent to a page. `tests/PostController.test.ts` describes all of it; make it pass.

This is the biggest slice so far, which makes it the right place for this chapter's harness lever: the **`code-review` subagent** in `.claude/agents/code-review.md`. A subagent is an agent with its own brief and its own context, invoked by the main agent; this one's brief is a Guren code review: validation on every mutating route, resources in front of every record, route order, the things `audit` and `check` look for and a few they cannot. When your agent reports done, before you run the rubric yourself, ask:

> Use the code-review subagent to review the uncommitted changes.

Read what comes back beside your own rubric below. A second reader with a fixed brief catches a different set of things than a first reader in the middle of the work, and it costs you one sentence. In chapter 8 you will write that brief yourself.

**No agent handy?** Six files. The validator gains the query schema:

```ts file=app/Http/Validators/PostValidator.ts fallback
import { z } from 'zod'

export const PostPayloadSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(120, 'Title must be 120 characters or fewer'),
  body: z.string().trim().min(1, 'Body is required'),
})

export type PostPayload = z.infer<typeof PostPayloadSchema>

export const ListPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})
```

```ts file=app/Http/Controllers/PostController.ts fallback
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import { PostResource, type PostResourceData } from '../Resources/PostResource.js'
import { ListPostsQuerySchema, PostPayloadSchema } from '../Validators/PostValidator.js'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

export default class PostController extends Controller {
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
    const post = this.model(Post)

    return this.inertia(pages.posts.Show, {
      post: new PostResource(post).toJSON(),
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

  async edit(): Promise<Response> {
    const post = this.model(Post)

    return this.inertia(pages.posts.Edit, {
      post: new PostResource(post).toJSON(),
    })
  }

  async update(): Promise<Response> {
    const post = this.model(Post)
    const data = await this.validateBody(PostPayloadSchema)
    await Post.update({ id: post.id }, data)
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const post = this.model(Post)
    await Post.delete({ id: post.id })
    return this.redirect('/posts')
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
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.get('/create', [PostController, 'create']).name('posts.create')
    posts.get('/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])
    posts.get('/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
    posts.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
    posts.put('/:id', { bind: { id: Post }, name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
    posts.delete('/:id', { bind: { id: Post }, name: 'posts.destroy' }, [PostController, 'destroy'])
  })

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

```tsx file=resources/js/pages/posts/Index.tsx fallback
import { Head, Link } from '@inertiajs/react'
import type { PaginatedPageProps } from '@guren/core'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

interface Props extends PaginatedPageProps<PostResourceData> {}

export default function PostsIndex({ data, pagination }: Props) {
  return (
    <>
      <Head title="Posts" />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <div className="flex items-center justify-between">
            <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
              <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
              Posts
            </h1>
            <Link href={route('posts.create')} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
              New post
            </Link>
          </div>
          {data.length === 0 && <p className="text-g-text-2">No posts yet.</p>}
          <div className="space-y-4">
            {data.map((post) => (
              <article key={post.id} className="rounded-g-card border border-g-line bg-g-panel p-4 shadow-g-card">
                <Link href={route('posts.show', { id: post.id })} className="text-xl font-bold text-g-heading transition hover:text-g-accent-text">
                  {post.title}
                </Link>
                <p className="mt-2 text-sm text-g-text-2">{post.body}</p>
              </article>
            ))}
          </div>
          {pagination?.links?.pages && pagination.links.pages.length > 1 && (
            <nav className="flex gap-2 font-mono text-sm">
              {pagination.links.pages.map((page) => (
                <Link key={page.page} href={page.url ?? '#'} className="rounded-g-ctl border border-g-line px-3 py-1 text-g-text-2 transition hover:border-g-line-strong hover:text-g-heading">
                  {page.page}
                </Link>
              ))}
            </nav>
          )}
        </div>
      </main>
    </>
  )
}
```

```tsx file=resources/js/pages/posts/Show.tsx fallback
import { Head, Link } from '@inertiajs/react'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

interface Props {
  post: PostResourceData
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
          <div className="flex items-center gap-4">
            <Link href={route('posts.edit', { id: post.id })} className="text-g-accent-text transition hover:underline">
              Edit
            </Link>
            <Link
              href={route('posts.destroy', { id: post.id })}
              method="delete"
              as="button"
              onBefore={() => window.confirm('Delete this post?')}
              className="rounded-g-ctl border border-g-danger-chip px-3 py-1 text-sm font-bold text-g-danger transition hover:bg-g-danger-tint"
            >
              Delete
            </Link>
          </div>
        </div>
      </main>
    </>
  )
}
```

```tsx file=resources/js/pages/posts/Edit.tsx fallback
import { Head, useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

type PostForm = RouteBody<ApiRoutes, 'posts.update'>

interface Props {
  post: PostResourceData
}

export default function EditPost({ post }: Props) {
  const form = useForm<PostForm>({ title: post.title, body: post.body })

  return (
    <>
      <Head title={`Edit: ${post.title}`} />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <h1 className="text-3xl font-bold text-g-heading">Edit post</h1>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              form.put(route('posts.update', { id: post.id }))
            }}
          >
            <div>
              <input
                value={form.data.title}
                onChange={(event) => form.setData('title', event.target.value)}
                placeholder="Title"
                className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
              />
              {form.errors.title && <p className="mt-1 text-sm text-g-danger">{form.errors.title}</p>}
            </div>
            <div>
              <textarea
                value={form.data.body}
                onChange={(event) => form.setData('body', event.target.value)}
                placeholder="Body"
                rows={8}
                className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
              />
              {form.errors.body && <p className="mt-1 text-sm text-g-danger">{form.errors.body}</p>}
            </div>
            <button type="submit" className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
              Save
            </button>
          </form>
        </div>
      </main>
    </>
  )
}
```

Regenerate and run the specification:

```bash run
bun run codegen
```

```bash run
bun test
```

The rubric, alongside whatever the subagent said:

- `update` and `destroy` resolve the post through `this.model(Post)`, and `update` validates with the same `PostPayloadSchema` as `store`. The routes for both carry `bind` and, for `update`, `body`.
- `index` validates `?page=` with `validateQuery` and a schema; a bare `Number(query.page)` is a finding.
- Every post that reaches a page goes through `PostResource`. The edit page's form type is `RouteBody<ApiRoutes, 'posts.update'>`.
- `Show.tsx` deletes through a `method="delete"` link with a confirmation, not a `GET` route that deletes.
- All eleven tests are green.

**Checkpoint:** create twelve posts at [http://localhost:3333/posts/create](http://localhost:3333/posts/create) (or fewer, if you are patient with the form), and watch page 2 appear. Edit one; delete one.

```bash run
bunx guren gate
```

```bash run
bunx guren audit
```

Three warnings now: `POST`, `PUT` and `DELETE /posts` have no authentication check. Still correct, still deliberate, still chapter 6.

```bash run
git add -A
git commit -m "feat: complete the posts CRUD with pagination"
```

## Where you are

- A validator file with human-readable messages, bound to the routes, read by the controller, and typing the forms.
- A resource that decides what a post looks like, and a `Data.Post` type that follows it.
- Full CRUD and pagination, specified by eleven tests, built by the agent, reviewed by a subagent and by you.
- Three audit warnings you are carrying on purpose.

## Common trip-ups

- **`RouteBody<ApiRoutes, 'posts.store'>` is `never`.** The route has no `body:` contract, or codegen has not run since you added it. Check `routes/web.ts`, then `bun run codegen`.
- **The 422 test passes but the browser shows no message.** The page renders `form.errors.title`; check the field name matches the schema key exactly. Inertia only fills in errors for keys the server returned.
- **`Post.update` complains about `id`.** `update` takes a `where` object first and the data second: `Post.update({ id }, data)`. The validated data never contains an `id`, and `fillable` would drop one anyway.
- **Page 2 shows nothing.** `perPage` is not 10, or `orderBy` is missing so the pages are in insertion order and the test's expectations about which post lands where do not hold.
- **The Delete button navigates to a 404.** `Link` needs `method="delete"`; without it, the browser issues a `GET` to the destroy URL, which is not a route.

## Next

[Chapter 5: Users and Passwords](./05-users-and-passwords.md) gives the users table a model, hashes passwords, and builds registration, login and logout by hand.
