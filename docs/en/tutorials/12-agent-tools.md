# Chapter 12: Your App as an Agent's Tool

Eleven chapters of building a blog for people. This chapter opens the same app to a different kind of caller: an agent that reads your posts and publishes a draft, through the routes you already wrote.

Nothing here is a second API. A tool is a route you have already built, plus a name, a contract an agent can read, and a claim about what calling it does. The interesting part is what happens to that route once you make the claim: the checks get stricter, and one of them finally fails on the gap chapter 7 could only warn about.

**What you'll learn:**

- What a tool is made of: name, input schema, output shape, annotations
- Why a page route and a tool-first route describe their output differently, and what breaks if you swap them
- The rule that turns "a mutating tool with no authorization" into a failing build
- How to call your own tools from a test, exactly as an agent would
- The two MCP endpoints in a Guren app, and which one is which

Start the dev server if it is not running:

```bash run background
bun run dev
```

## 1. One route, declared

`posts.show` already has everything a tool needs except the declaration. Add it:

```ts file=routes/web.ts
import { Router, registerAttachmentRoutes, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import CommentController from '../app/Http/Controllers/CommentController.js'
import LinkController from '../app/Http/Controllers/LinkController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { Comment } from '../app/Models/Comment.js'
import { Link } from '../app/Models/Link.js'
import { PostResource } from '../app/Http/Resources/PostResource.js'
import { CommentResource } from '../app/Http/Resources/CommentResource.js'
import { PostIdParamSchema, PostImageParamSchema, PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { CommentPayloadSchema } from '../app/Http/Validators/CommentValidator.js'
import { LinkPayloadSchema } from '../app/Http/Validators/LinkValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
  // The signed delivery route for private attachments (config/attachments.ts).
  registerAttachmentRoutes(baseRouter)

  // aliasMiddleware() returns a Router carrying the alias name in its type;
  // capture it, or `.middleware('auth')` below will not compile.
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
    .aliasMiddleware('guest', requireGuest({ redirectTo: '/' }))

  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.middleware('guest').group((guest) => {
    guest.get('/register', [RegisterController, 'show']).name('register')
    guest.post('/register', { name: 'register.store', body: RegisterSchema }, [RegisterController, 'store'])
    guest.get('/login', [LoginController, 'show']).name('login')
    guest.post('/login', { name: 'login.store', body: LoginSchema }, [LoginController, 'store'])
  })

  router.middleware('auth').group((auth) => {
    auth.post('/logout', [LoginController, 'destroy']).name('logout')
    auth.get('/profile', [ProfileController, 'show']).name('profile')
    auth.get('/posts/create', [PostController, 'create']).name('posts.create')
    auth.get('/posts/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
    auth.post('/posts', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
    auth.put('/posts/:id', { bind: { id: Post }, name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
    auth.delete('/posts/:id', { bind: { id: Post }, name: 'posts.destroy' }, [PostController, 'destroy'])
    auth.post('/posts/:id/publish', { bind: { id: Post }, name: 'posts.publish' }, [PostController, 'publish'])
    auth.post('/posts/:id/unpublish', { bind: { id: Post }, name: 'posts.unpublish' }, [PostController, 'unpublish'])
    auth.post('/posts/:id/cover', { bind: { id: Post }, name: 'posts.cover' }, [PostController, 'cover'])
    auth.delete('/posts/:id/images/:attachment', { bind: { id: Post }, name: 'posts.images.destroy', params: PostImageParamSchema }, [PostController, 'destroyImage'])
    auth.post('/posts/:id/comments', { bind: { id: Post }, name: 'comments.store', body: CommentPayloadSchema }, [CommentController, 'store'])
    auth.delete('/comments/:id', { bind: { id: Comment }, name: 'comments.destroy' }, [CommentController, 'destroy'])
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
  })

  router.get('/posts', [PostController, 'index']).name('posts.index')
  router
    .get('/posts/:id', {
      name: 'posts.show',
      params: PostIdParamSchema,
      // Type-level only: nothing runs at request time. It tells codegen and the
      // agent surface what this route answers with, which is what keeps the
      // Inertia page working while the tool still advertises a shape.
      resource: { post: PostResource, comments: [CommentResource] },
    }, [PostController, 'show'])
    .agent({ description: 'Read one post by id, with its author, tags and comments.' })
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

`.agent()` takes the tool's description and its annotations; it does not take schemas. Everything an agent needs to *call* the route comes from the contract the route already carries: `params`, `query` and `body` become one flat input object, and `resource` or `output` describes what comes back. That is the design: a tool is a view of a route, not a second definition of it.

The tool manifest is generated code, so regenerate it:

```bash run
bun run codegen
```

Now look at what you declared:

```bash run
bunx guren tool:list
```

One row, seven columns: the tool name, the method and path behind it, whether it appears on each protocol surface, the ability that authorizes it, and its annotations. `posts.show` is `read-only, idempotent` because it is a `GET`, and `guren` resolved those from the method rather than making you write them.

```bash run
bunx guren tool:inspect posts.show
```

```bash manual
posts.show     GET /posts/:id
Description:   Read one post by id, with its author, tags and comments.
Exposure:      mcp=yes webMcp=yes
Annotations:   read-only, idempotent
Authorization: (not statically derivable)

Input
  id: integer

Output
  (no output schema; response declared by PostResource, CommentResource)
```

`id: integer`, not `id: string`, because `PostIdParamSchema` coerces it. That schema was written in chapter 9 for the controller's benefit; it now doubles as the tool's argument list, which is the whole argument for putting contracts on routes rather than only inside actions.

## 2. Specify the tools

A tool is testable without a model client and without a network. `TestApp` exposes the same derivation the server uses, and calls go out through the same `fetch` as every other test request:

```ts file=tests/AgentTools.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post, type PostRecord } from '../app/Models/Post.js'
import { User, type UserRecord } from '../app/Models/User.js'

describe('agent tools', () => {
  let http: TestApp
  let ada: UserRecord
  let grace: UserRecord
  let post: PostRecord

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
    post = await Post.forceCreate({ title: 'On tools', body: 'A body', authorId: ada.id })
  })

  it('exposes the reading tools to anyone', async () => {
    const names = (await http.agent().tools()).map((tool) => tool.toolName)
    expect(names).toContain('posts.index')
    expect(names).toContain('posts.show')

    const result = await http.agent().call('posts.show', { id: post.id }).assertOk()
    expect(result.text).toContain('On tools')
  })

  it('publishes through a tool, and answers with the post', async () => {
    const asAda = await http.actingAs(ada).withCsrf()

    const published = await asAda.agent().call('posts.publish', { id: post.id }).assertOk()

    expect(published.structuredContent?.post).toMatchObject({ id: post.id, title: 'On tools' })
    const fresh = await Post.findOrFail(post.id)
    expect(fresh.publishedAt).not.toBeNull()
  })

  it('refuses to publish someone else\'s post', async () => {
    const asGrace = await http.actingAs(grace).withCsrf()

    await asGrace.agent().call('posts.publish', { id: post.id }).assertStatus(403)

    const fresh = await Post.findOrFail(post.id)
    expect(fresh.publishedAt).toBeNull()
  })
})
```

The last test is the one to read twice. It is the same 403 chapter 7 wrote, reached through a tool call instead of an HTTP request, and it passes for the same reason: the policy runs because the route runs. A tool call is not a side door. It is a real request through the real middleware chain, and every guard you wrote is still in front of it.

```bash run expect-fail
bun test
```

Red: `posts.publish` and `posts.index` are not tools yet.

## 3. A mutating tool

Two routes to declare, and they need different things.

`posts.index` is another page route, so it takes the same treatment as `posts.show`: a `query` contract so the agent knows about paging, and a `resource` hint so it advertises a shape.

`posts.publish` is different, and the difference is the lesson. It answers a browser with a redirect, which is exactly right for a form and useless to an agent: a redirect carries no post. So the action learns to answer twice, and the route promises the agent the JSON version:

```ts file=app/Http/Validators/PostValidator.ts
import { z } from 'zod'

export const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const PostImageParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  attachment: z.string().min(1),
})

export const PostPayloadSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(120, 'Title must be 120 characters or fewer'),
  body: z.string().trim().min(1, 'Body is required'),
  tags: z
    .string()
    .default('')
    .transform((value) => [...new Set(value.split(',').map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))]),
})

export type PostPayload = z.infer<typeof PostPayloadSchema>

export const ListPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})

/** The action takes no payload; the empty object is what an agent is told to send. */
export const PublishPayloadSchema = z.object({})

/**
 * What `posts.publish` answers a tool call with. An `output` schema is enforced:
 * a 2xx body that does not match it becomes a 500 rather than reaching the
 * caller, and keys it does not name are stripped from the response.
 */
export const PublishResponseSchema = z.object({
  post: z.object({
    id: z.number(),
    title: z.string(),
    publishedAt: z.string().nullable(),
    author: z.object({ id: z.number(), name: z.string() }).nullable(),
    tags: z.array(z.string()),
  }),
})
```

The action picks its answer from the request:

```ts file=app/Http/Controllers/PostController.ts
import { Controller, ValidationException, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import { Comment } from '../../Models/Comment.js'
import { Tag } from '../../Models/Tag.js'
import { PostTag } from '../../Models/PostTag.js'
import type { UserRecord } from '../../Models/User.js'
import { PostPublished } from '../../Events/PostPublished.js'
import { PostResource, type PostResourceData } from '../Resources/PostResource.js'
import { CommentResource } from '../Resources/CommentResource.js'
import { ListPostsQuerySchema, PostIdParamSchema, PostImageParamSchema, PostPayloadSchema } from '../Validators/PostValidator.js'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

async function syncTags(postId: number, names: string[]): Promise<void> {
  await PostTag.delete({ postId })
  for (const name of names) {
    const tag = (await Tag.first({ name })) ?? (await Tag.create({ name }))
    await PostTag.forceCreate({ postId, tagId: tag.id })
  }
}

export default class PostController extends Controller {
  /**
   * A tool call is an ordinary request carrying this header (the agent surface
   * sets it); a browser never does. Every guard still runs either way.
   */
  private isToolCall(): boolean {
    return this.ctx.req.header('X-Guren-Agent-Surface') !== undefined
  }

  async index(): Promise<Response> {
    const { page } = this.validateQuery(ListPostsQuerySchema)
    const result = await Post.withPaginate('author', { page, perPage: 10, orderBy: ['id', 'desc'] })
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
    const post = await Post.findWithOrFail(id, ['author', 'tags'])
    const [withFiles] = await Post.withAttachments([post], ['cover', 'images'])
    const comments = await Comment.where('postId', post.id).with('author').orderBy('id', 'asc').get()

    return this.inertia(pages.posts.Show, {
      post: new PostResource(withFiles!).toJSON(),
      canManage: await this.can('update', [Post, post]),
      comments: await Promise.all(
        comments.map(async (comment) => ({
          ...new CommentResource(comment).toJSON(),
          canDelete: await this.can('delete', [Comment, comment]),
        })),
      ),
    })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.posts.New, {})
  }

  async store(): Promise<Response> {
    const author = await this.auth.userOrFail<UserRecord>()
    const { tags, ...data } = await this.validateBody(PostPayloadSchema)
    const post = await Post.forceCreate({ ...data, authorId: author.id })
    await syncTags(post.id, tags)
    const cover = await this.file('cover')
    if (cover) {
      await Post.attach(post.id, 'cover', cover)
    }
    for (const file of await this.files('images')) {
      await Post.attach(post.id, 'images', file)
    }
    return this.redirect(`/posts/${post.id}`)
  }

  async edit(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const withTags = await Post.findWithOrFail(post.id, 'tags')

    return this.inertia(pages.posts.Edit, {
      post: new PostResource(withTags).toJSON(),
    })
  }

  async update(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const { tags, ...data } = await this.validateBody(PostPayloadSchema)
    await Post.update({ id: post.id }, data)
    await syncTags(post.id, tags)
    return this.redirect(`/posts/${post.id}`)
  }

  async cover(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const cover = await this.file('cover')
    if (!cover) {
      throw new ValidationException({ cover: ['Choose an image.'] })
    }
    await Post.attach(post.id, 'cover', cover)
    return this.redirect(`/posts/${post.id}`)
  }

  async destroyImage(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const { attachment } = this.validateParams(PostImageParamSchema)
    await Post.detach(post.id, 'images', attachment)
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('delete', [Post, post])
    await Post.purgeAttachments(post.id)
    await Post.delete({ id: post.id })
    return this.redirect('/posts')
  }

  async publish(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('publish', [Post, post])
    await Post.forceUpdate({ id: post.id }, { publishedAt: new Date().toISOString() })
    await this.make('events').emit(new PostPublished(post.id))

    if (this.isToolCall()) {
      const fresh = await Post.findWithOrFail(post.id, ['author', 'tags'])
      return this.json({ post: new PostResource(fresh).toJSON() })
    }
    return this.redirect(`/posts/${post.id}`)
  }

  async unpublish(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('publish', [Post, post])
    await Post.forceUpdate({ id: post.id }, { publishedAt: null })
    return this.redirect(`/posts/${post.id}`)
  }
}
```

One action, two audiences, one policy. The authorization, the update and the event are above the branch; only the last line differs. That is the shape to reach for whenever an existing action becomes a tool, and it is why this chapter is not building a second controller.

Now the routes:

```ts file=routes/web.ts
import { Router, registerAttachmentRoutes, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import CommentController from '../app/Http/Controllers/CommentController.js'
import LinkController from '../app/Http/Controllers/LinkController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { Comment } from '../app/Models/Comment.js'
import { Link } from '../app/Models/Link.js'
import { PostResource } from '../app/Http/Resources/PostResource.js'
import { CommentResource } from '../app/Http/Resources/CommentResource.js'
import {
  ListPostsQuerySchema,
  PostIdParamSchema,
  PostImageParamSchema,
  PostPayloadSchema,
  PublishPayloadSchema,
  PublishResponseSchema,
} from '../app/Http/Validators/PostValidator.js'
import { CommentPayloadSchema } from '../app/Http/Validators/CommentValidator.js'
import { LinkPayloadSchema } from '../app/Http/Validators/LinkValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
  // The signed delivery route for private attachments (config/attachments.ts).
  registerAttachmentRoutes(baseRouter)

  // aliasMiddleware() returns a Router carrying the alias name in its type;
  // capture it, or `.middleware('auth')` below will not compile.
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
    .aliasMiddleware('guest', requireGuest({ redirectTo: '/' }))

  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.middleware('guest').group((guest) => {
    guest.get('/register', [RegisterController, 'show']).name('register')
    guest.post('/register', { name: 'register.store', body: RegisterSchema }, [RegisterController, 'store'])
    guest.get('/login', [LoginController, 'show']).name('login')
    guest.post('/login', { name: 'login.store', body: LoginSchema }, [LoginController, 'store'])
  })

  router.middleware('auth').group((auth) => {
    auth.post('/logout', [LoginController, 'destroy']).name('logout')
    auth.get('/profile', [ProfileController, 'show']).name('profile')
    auth.get('/posts/create', [PostController, 'create']).name('posts.create')
    auth.get('/posts/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
    auth.post('/posts', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
    auth.put('/posts/:id', { bind: { id: Post }, name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
    auth.delete('/posts/:id', { bind: { id: Post }, name: 'posts.destroy' }, [PostController, 'destroy'])
    auth
      .post('/posts/:id/publish', {
        bind: { id: Post },
        name: 'posts.publish',
        params: PostIdParamSchema,
        body: PublishPayloadSchema,
        output: PublishResponseSchema,
      }, [PostController, 'publish'])
      .agent({ description: 'Publish a draft post. Only the post\'s author may call it.' })
    auth.post('/posts/:id/unpublish', { bind: { id: Post }, name: 'posts.unpublish' }, [PostController, 'unpublish'])
    auth.post('/posts/:id/cover', { bind: { id: Post }, name: 'posts.cover' }, [PostController, 'cover'])
    auth.delete('/posts/:id/images/:attachment', { bind: { id: Post }, name: 'posts.images.destroy', params: PostImageParamSchema }, [PostController, 'destroyImage'])
    auth.post('/posts/:id/comments', { bind: { id: Post }, name: 'comments.store', body: CommentPayloadSchema }, [CommentController, 'store'])
    auth.delete('/comments/:id', { bind: { id: Comment }, name: 'comments.destroy' }, [CommentController, 'destroy'])
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
  })

  router
    .get('/posts', { name: 'posts.index', query: ListPostsQuerySchema, resource: { data: [PostResource] } }, [PostController, 'index'])
    .agent({ description: 'List posts, newest first, ten to a page.' })
  router
    .get('/posts/:id', {
      name: 'posts.show',
      params: PostIdParamSchema,
      // Type-level only: nothing runs at request time. It tells codegen and the
      // agent surface what this route answers with, which is what keeps the
      // Inertia page working while the tool still advertises a shape.
      resource: { post: PostResource, comments: [CommentResource] },
    }, [PostController, 'show'])
    .agent({ description: 'Read one post by id, with its author, tags and comments.' })
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

Three contracts on `posts.publish` and each one is load-bearing. `params` types the id an agent sends. `body`, an empty object, is how the tool says "this action takes no payload"; without it the check warns that an agent cannot see what to send. `output` is the promise, and it is the one that runs: a 2xx response that does not match it becomes a 500 instead of reaching the caller, and fields it does not name are stripped. The page routes use `resource` instead, which is type-level only, because an `output` schema on a route that answers a browser with an Inertia page would try to validate that page.

```bash run
bun run codegen
```

```bash run
bun test
```

Green.

```bash run
bunx guren tool:list
```

Three tools. `posts.publish` is `destructive`, with `publish` nowhere in its `Auth` column: the ability is decided inside the action, and a column that reads `-` means "not statically derivable", never "not authorized".

## 4. The check that finally fails

Commit what you have, because the next step deliberately breaks it:

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: expose reading and publishing as agent tools"
```

Chapter 7 ended on an uncomfortable note. You wrote a policy, and then found that `guren audit` stayed green on a route with no policy call at all, because audit asks whether a mutating route requires *a user*, not whether it decides *which* user. The tests were the only thing between you and a blog anyone could edit.

Declaring the route a tool changes that. Take the authorization out of `publish`:

```bash run
sed -i.bak "/this.authorize('publish'/d" app/Http/Controllers/PostController.ts && rm app/Http/Controllers/PostController.ts.bak
```

```bash run expect-fail
bunx guren check --ci
```

```bash manual
ERROR  [fail] POST /posts/:id/publish agent tool: Authenticated but not authorized: the route
establishes who the caller is, but nothing decides whether that caller may perform this action.
A non-read-only tool hands every authenticated principal — every agent holding any token — the
whole action.
       → Add authorize()/authorizeResource() middleware to the route, or call
await this.authorize(ability, ...) in the action. Mark the tool agent: { readOnlyHint: true }
only if it truly changes nothing — that claim is itself checked against the action's body.

Results: 25 passed, 0 warnings, 1 failures
```

Read what changed and what did not. `guren audit` still passes this route: it sits inside the `auth` group, so a user is required, which is all audit ever asked. The route's tests would catch it, and these are tests you wrote. What the check adds is that the *build* now refuses, without running a single test, because a mutating tool is a different kind of promise. It is an action offered to a caller you will never meet, and "some authenticated principal" is not a person.

Put it back:

```bash run
git checkout -- app/Http/Controllers/PostController.ts
```

```bash run
bunx guren check --ci
```

Green again. This chapter's harness lever is that `--ci`: it is what `guren gate` runs, and what the `Stop` hook runs when an agent says it is finished. An agent that exposes a route as a tool and forgets the policy does not get to call the work done.


## 5. Specify the comment tools

An agent that can read a post should be able to answer it, under the same rules a person gets:

```ts file=tests/AgentComments.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Comment } from '../app/Models/Comment.js'
import { Post, type PostRecord } from '../app/Models/Post.js'
import { User, type UserRecord } from '../app/Models/User.js'

describe('comment tools', () => {
  let http: TestApp
  let ada: UserRecord
  let grace: UserRecord
  let post: PostRecord

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
    post = await Post.forceCreate({ title: 'On tools', body: 'A body', authorId: ada.id })
  })

  it('writes a comment through a tool and answers with it', async () => {
    const asGrace = await http.actingAs(grace).withCsrf()

    const result = await asGrace.agent().call('comments.store', { id: post.id, body: 'Read it twice' }).assertOk()

    expect(result.structuredContent?.comment).toMatchObject({ body: 'Read it twice' })
    const stored = await Comment.where('postId', post.id).first()
    expect(stored?.authorId).toBe(grace.id)
  })

  it('validates the comment it is given', async () => {
    const asGrace = await http.actingAs(grace).withCsrf()

    const result = await asGrace.agent().call('comments.store', { id: post.id, body: '   ' }).assertStatus(422)

    expect(result.isError).toBe(true)
    expect(result.text).toContain('Say something')
  })

  it('refuses to delete someone else\'s comment', async () => {
    const comment = await Comment.forceCreate({ body: 'Mine', postId: post.id, authorId: ada.id })
    const asGrace = await http.actingAs(grace).withCsrf()

    await asGrace.agent().call('comments.destroy', { id: comment.id }).assertStatus(403)

    expect(await Comment.find(comment.id)).not.toBeNull()
  })
})
```

The middle test is the one worth keeping. A tool call that sends a bad argument comes back as an error result carrying the validator's own message, not a protocol fault. The agent is told what a person would be told, in the same words, by the same schema.

```bash run expect-fail
bun test
```

Two red, one passing by accident.

## 6. Delegate it

> Expose the comment routes as agent tools. `comments.store` and `comments.destroy` should be callable by an agent, follow the same pattern `posts.publish` uses (a `params` schema, a `body` schema where the action takes one, an `output` schema, and a JSON answer for a tool call while the browser keeps its redirect), and keep the policies they already have. `tests/AgentComments.test.ts` describes them; make it pass.

The prompt says nothing about authorization, and it does not have to. Two things are watching now: the ownership rule from chapter 8, and `guren check --ci`, which will fail the build outright if the agent exposes `comments.destroy` without a policy call. Read the diff for the `output` schemas, then run the check.

**No agent handy?** The validator gains the two contracts:

```ts file=app/Http/Validators/CommentValidator.ts fallback
import { z } from 'zod'

export const CommentIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const CommentPayloadSchema = z.object({
  body: z.string().trim().min(1, 'Say something').max(2000, 'Comments are 2000 characters or fewer'),
})

const CommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  createdAt: z.string(),
  author: z.object({ id: z.number(), name: z.string() }).nullable(),
})

export const CommentResponseSchema = z.object({ comment: CommentSchema })

export const CommentDeletedSchema = z.object({ deleted: z.number() })
```

```ts file=app/Http/Controllers/CommentController.ts fallback
import { Controller } from '@guren/core'
import { Post } from '../../Models/Post.js'
import { Comment } from '../../Models/Comment.js'
import type { UserRecord } from '../../Models/User.js'
import { CommentPosted } from '../../Events/CommentPosted.js'
import { CommentResource } from '../Resources/CommentResource.js'
import { CommentPayloadSchema } from '../Validators/CommentValidator.js'

export default class CommentController extends Controller {
  private isToolCall(): boolean {
    return this.ctx.req.header('X-Guren-Agent-Surface') !== undefined
  }

  async store(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('create', Comment)
    const author = await this.auth.userOrFail<UserRecord>()
    const data = await this.validateBody(CommentPayloadSchema)
    const comment = await Comment.forceCreate({ ...data, postId: post.id, authorId: author.id })
    await this.make('events').emit(new CommentPosted(comment.id))

    if (this.isToolCall()) {
      const fresh = await Comment.findWithOrFail(comment.id, 'author')
      return this.json({ comment: new CommentResource(fresh).toJSON() })
    }
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const comment = this.model(Comment)
    await this.authorize('delete', [Comment, comment])
    await Comment.delete({ id: comment.id })

    if (this.isToolCall()) {
      return this.json({ deleted: comment.id })
    }
    return this.redirect(`/posts/${comment.postId}`)
  }
}
```

```ts file=routes/web.ts fallback
import { Router, registerAttachmentRoutes, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import CommentController from '../app/Http/Controllers/CommentController.js'
import LinkController from '../app/Http/Controllers/LinkController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { Comment } from '../app/Models/Comment.js'
import { Link } from '../app/Models/Link.js'
import { PostResource } from '../app/Http/Resources/PostResource.js'
import { CommentResource } from '../app/Http/Resources/CommentResource.js'
import {
  ListPostsQuerySchema,
  PostIdParamSchema,
  PostImageParamSchema,
  PostPayloadSchema,
  PublishPayloadSchema,
  PublishResponseSchema,
} from '../app/Http/Validators/PostValidator.js'
import {
  CommentDeletedSchema,
  CommentIdParamSchema,
  CommentPayloadSchema,
  CommentResponseSchema,
} from '../app/Http/Validators/CommentValidator.js'
import { LinkPayloadSchema } from '../app/Http/Validators/LinkValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
  // The signed delivery route for private attachments (config/attachments.ts).
  registerAttachmentRoutes(baseRouter)

  // aliasMiddleware() returns a Router carrying the alias name in its type;
  // capture it, or `.middleware('auth')` below will not compile.
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
    .aliasMiddleware('guest', requireGuest({ redirectTo: '/' }))

  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.middleware('guest').group((guest) => {
    guest.get('/register', [RegisterController, 'show']).name('register')
    guest.post('/register', { name: 'register.store', body: RegisterSchema }, [RegisterController, 'store'])
    guest.get('/login', [LoginController, 'show']).name('login')
    guest.post('/login', { name: 'login.store', body: LoginSchema }, [LoginController, 'store'])
  })

  router.middleware('auth').group((auth) => {
    auth.post('/logout', [LoginController, 'destroy']).name('logout')
    auth.get('/profile', [ProfileController, 'show']).name('profile')
    auth.get('/posts/create', [PostController, 'create']).name('posts.create')
    auth.get('/posts/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
    auth.post('/posts', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
    auth.put('/posts/:id', { bind: { id: Post }, name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
    auth.delete('/posts/:id', { bind: { id: Post }, name: 'posts.destroy' }, [PostController, 'destroy'])
    auth
      .post('/posts/:id/publish', {
        bind: { id: Post },
        name: 'posts.publish',
        params: PostIdParamSchema,
        body: PublishPayloadSchema,
        output: PublishResponseSchema,
      }, [PostController, 'publish'])
      .agent({ description: 'Publish a draft post. Only the post\'s author may call it.' })
    auth.post('/posts/:id/unpublish', { bind: { id: Post }, name: 'posts.unpublish' }, [PostController, 'unpublish'])
    auth.post('/posts/:id/cover', { bind: { id: Post }, name: 'posts.cover' }, [PostController, 'cover'])
    auth.delete('/posts/:id/images/:attachment', { bind: { id: Post }, name: 'posts.images.destroy', params: PostImageParamSchema }, [PostController, 'destroyImage'])
    auth
      .post('/posts/:id/comments', {
        bind: { id: Post },
        name: 'comments.store',
        params: PostIdParamSchema,
        body: CommentPayloadSchema,
        output: CommentResponseSchema,
      }, [CommentController, 'store'])
      .agent({ description: 'Add a comment to a post, as the calling user.' })
    auth
      .delete('/comments/:id', {
        bind: { id: Comment },
        name: 'comments.destroy',
        params: CommentIdParamSchema,
        output: CommentDeletedSchema,
      }, [CommentController, 'destroy'])
      .agent({ description: 'Delete one comment. Only its author may call it.' })
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
  })

  router
    .get('/posts', { name: 'posts.index', query: ListPostsQuerySchema, resource: { data: [PostResource] } }, [PostController, 'index'])
    .agent({ description: 'List posts, newest first, ten to a page.' })
  router
    .get('/posts/:id', {
      name: 'posts.show',
      params: PostIdParamSchema,
      // Type-level only: nothing runs at request time. It tells codegen and the
      // agent surface what this route answers with, which is what keeps the
      // Inertia page working while the tool still advertises a shape.
      resource: { post: PostResource, comments: [CommentResource] },
    }, [PostController, 'show'])
    .agent({ description: 'Read one post by id, with its author, tags and comments.' })
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

```bash run
bun run codegen
```

```bash run
bun test
```

The rubric:

- Both comment routes carry a `params` schema, an `output` schema, and `comments.store` keeps its `body` contract. `guren check --ci` is green, which means no tool is missing an input or output description.
- Each action keeps its `authorize()` call, and the JSON branch is *after* it. An agent-shaped answer above the policy would be a policy that runs for browsers only.
- The browser still redirects. Post a comment in the browser and you land back on the post.
- The five agent tests pass, including the 422 that carries `Say something` and the 403 on someone else's comment.

```bash run
bunx guren tool:list
```

Five tools: two that read, three that change something, each with the ability the framework could see or the policy the action enforces.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: expose the comment routes as agent tools"
```

## 7. Two endpoints, and which is which

Your app now has tools. Handing them to a real agent is one plugin:

```bash manual
bunx guren plugin @guren/plugin-mcp
```

```ts manual
// src/app.ts
import { mcpPlugin } from '@guren/plugin-mcp'
import { DatabaseApiTokenStore } from '@guren/core'
import { apiTokens } from '../db/schema.js'

const app = createApp({
  routes: registerWebRoutes,
  providers: [DatabaseProvider, AuthProvider, /* … */ mcpPlugin()],
})

// The endpoint verifies bearer tokens against this store, and a token's
// scopes decide which of your tools it may call.
app.auth.useTokens(new DatabaseApiTokenStore(apiTokens))
```

That mounts `/mcp`: a real endpoint, in production, that answers `tools/list` with the tools you declared and runs each call as an ordinary request through your middleware. It is gated by a bearer token, per-token tool scopes and a rate limit, and it needs a token store, which needs a table. That is chapter 14's work, alongside the rest of going live.

Do not confuse it with the endpoint your editor already talks to. `GUREN_MCP=1` mounts `/_guren/mcp` in development only, refuses any caller that is not on the loopback interface, and its tools are `guren_check`, `guren_gate`, `guren_get_context` and friends. Those act on your *project*: they are for the agent writing the app. The plugin's tools are your *application's*: they are for an agent using the app. Same protocol, opposite direction, and the harness in chapter 8 configured the first one for you.

## Where you are

- Five routes that are also tools, each with the input schema an agent reads and an output shape it can rely on.
- One action that answers a browser and an agent differently in its last line and identically everywhere else.
- A build that fails on a mutating tool with no authorization, which is the hole chapter 7 could only cover with tests.
- Tool calls in your test suite, going through the same middleware, policies and validators as everything else.

## Common trip-ups

- **`guren check` says the manifest is missing.** Declaring `.agent()` makes `.guren/agents.gen.ts` part of the app. Run `bun run codegen`.
- **A tool warns that an agent cannot see what to send.** Any `POST`, `PUT` or `PATCH` tool needs a `body` schema, even one that takes no payload. `z.object({})` is the honest answer there.
- **`Response validation failed`, 500, on a tool call.** The `output` schema and the JSON the action returns disagree. The schema is enforced on 2xx responses, which is the point of it; fix whichever is wrong.
- **A tool call returns `HTTP 302 (Location: …)`.** The action redirected, so there is nothing for the agent to read. Give it a JSON branch, as `publish` has.
- **The Inertia page breaks after adding a schema.** An `output` schema on a page route validates the page JSON too. Page routes describe themselves with `resource`, which is type-level only.
- **A tool call gets a 419 or a CSRF error.** Build the acting app with `withCsrf()` before calling `agent()`; a tool call in a test is a cookie-session request like any other.

## Next

Chapter 13, *The System, Documented* (coming), makes the app describe itself: generated ER and domain views, docs an agent reads before it touches an entity, and a gate that fails when either drifts from the code.
