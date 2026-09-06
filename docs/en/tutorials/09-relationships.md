# Chapter 9: Relationships

Chapter 6 left you with `authorsOf`, a helper that collects author ids and runs one `IN` query. It works, and it is what a relationship does under the hood. This chapter replaces it with the real thing: `belongsTo` and `hasMany` declared once on the models, loaded with `with()`. Then it adds comments, the first table that points at two others, and hands the agent the one shape you have not built yet: a many-to-many, tags, through a pivot table.

**What you'll learn:**

- How a relationship is declared on a model, typed, and loaded, and what the loaded record looks like
- Why `findWithOrFail` and `withPaginate` exist beside `findOrFail` and `paginate`
- How a table that references two others (comments) is modelled from both sides
- What a pivot table is, and why Guren has no `attach()`: the pivot is a model like any other
- How the `orm-models.md` rule and the API digest keep an agent from inventing a query method

Start the dev server if it is not running:

```bash run background
bun run dev
```

## 1. The author, as a relationship

Nothing observable changes in this section; all fourteen post tests stay green while `authorsOf` disappears. Declare the relation on `Post`:

```ts file=app/Models/Post.ts
import { defineModel, type BelongsToRecord } from '@guren/core'
import { posts } from '../../db/schema.js'
import type { UserRecord } from './User.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends defineModel(posts, { fillable: ['title', 'body'] }) {
  static override relationTypes: {
    author: BelongsToRecord<UserRecord>
  } = { author: null }
}

Post.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
```

Two halves. `relationTypes` is the type side: it says a loaded `author` is a `UserRecord` or `null`, and the placeholder value (`null` for a to-one, `[]` for a to-many) has to match. `Post.belongsTo(...)` after the class is the runtime side: the relation's name, the model on the other end, the foreign key on this table, the key it points to. The other model is imported lazily inside a function because `User` will soon point back at `Post`, and two modules cannot import each other at load time.

The inverse, on `User`:

```ts file=app/Models/User.ts
import { AuthenticatableModel, defineModel, type HasManyRecord } from '@guren/core'
import { users } from '../../db/schema.js'
import type { PostRecord } from './Post.js'

export type UserRecord = typeof users.$inferSelect

export class User extends defineModel(users, {
  base: AuthenticatableModel,
  // Derived from the plain `password`, so callers never set it directly
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
  // Never serialized by Model.serialize() and stripped from auth.user()
  hidden: ['passwordHash', 'rememberToken'],
}) {
  static override relationTypes: {
    posts: HasManyRecord<PostRecord>
  } = { posts: [] }
}

User.hasMany('posts', () => import('./Post.js').then((m) => m.Post), 'authorId', 'id')
```

Now load it. The controller stops building its own map:

```ts file=app/Http/Validators/PostValidator.ts
import { z } from 'zod'

export const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const PostPayloadSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(120, 'Title must be 120 characters or fewer'),
  body: z.string().trim().min(1, 'Body is required'),
})

export type PostPayload = z.infer<typeof PostPayloadSchema>

export const ListPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})
```

```ts file=app/Http/Controllers/PostController.ts
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'
import { PostResource, type PostResourceData } from '../Resources/PostResource.js'
import { ListPostsQuerySchema, PostIdParamSchema, PostPayloadSchema } from '../Validators/PostValidator.js'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

export default class PostController extends Controller {
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
    const post = await Post.findWithOrFail(id, 'author')

    return this.inertia(pages.posts.Show, {
      post: new PostResource(post).toJSON(),
      canManage: await this.can('update', [Post, post]),
    })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.posts.New, {})
  }

  async store(): Promise<Response> {
    const author = await this.auth.userOrFail<UserRecord>()
    const data = await this.validateBody(PostPayloadSchema)
    const post = await Post.forceCreate({ ...data, authorId: author.id })
    return this.redirect(`/posts/${post.id}`)
  }

  async edit(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])

    return this.inertia(pages.posts.Edit, {
      post: new PostResource(post).toJSON(),
    })
  }

  async update(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const data = await this.validateBody(PostPayloadSchema)
    await Post.update({ id: post.id }, data)
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('delete', [Post, post])
    await Post.delete({ id: post.id })
    return this.redirect('/posts')
  }

  async publish(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('publish', [Post, post])
    await Post.forceUpdate({ id: post.id }, { publishedAt: new Date().toISOString() })
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

- `Post.withPaginate('author', options)` is `paginate` with a relation: one page of posts, then one `IN` query for their authors, the same two queries `authorsOf` ran, and every record in `result.data` has an `author` property typed by `relationTypes`.
- `Post.findWithOrFail(id, 'author')` is `findOrFail` with a relation. Because it does the lookup and the 404 in one call, `show` resolves the id itself now, with `PostIdParamSchema`, rather than through route model binding. The other actions keep `bind`; they want the bare record for the policy, and a second query for the author would be waste.
- `PostResource` does not change: it already accepted a post that might carry its author, and now it always does.

The `show` route loses its `bind`:

```ts file=routes/web.ts
import { Router, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import LinkController from '../app/Http/Controllers/LinkController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { Link } from '../app/Models/Link.js'
import { PostIdParamSchema, PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { LinkPayloadSchema } from '../app/Http/Validators/LinkValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
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
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
  })

  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.get('/posts/:id', { name: 'posts.show', params: PostIdParamSchema }, [PostController, 'show'])
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

```bash run
bun test
```

Green, and the same twenty post tests as before. A refactor with a relation is still a refactor.

Something changed that no test can see. `bunx guren spec:generate` would now draw `User ||--o{ Post`: the ER and domain views it writes are derived from `relationTypes`, which is one more reason to type a relation with the record type (`BelongsToRecord<UserRecord>`) rather than a narrower alias. Chapter 13 generates those views, links them to your docs, and makes them a gate. Leave them ungenerated until then; a committed view that nobody regenerates is a view the gate fails on.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "refactor: load post authors through a belongsTo relation"
```

## 2. Specify comments

A comment belongs to a post and to a user, and a post has many comments. The specification, in its own file:

```ts file=tests/CommentController.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post, type PostRecord } from '../app/Models/Post.js'
import { Comment } from '../app/Models/Comment.js'
import { User, type UserRecord } from '../app/Models/User.js'

describe('CommentController', () => {
  let http: TestApp
  let ada: UserRecord
  let grace: UserRecord
  let asAda: TestApp
  let asGrace: TestApp
  let post: PostRecord

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
    asAda = await http.actingAs(ada).withCsrf()
    asGrace = await http.actingAs(grace).withCsrf()
    post = await Post.forceCreate({ title: 'Discuss', body: 'Thoughts?', authorId: ada.id })
  })

  it('shows comments with their authors on the post page', async () => {
    await Comment.forceCreate({ body: 'First!', postId: post.id, authorId: grace.id })

    const response = await http.get(`/posts/${post.id}`).assertOk()
    await response.assertBodyContains('First!')
    await response.assertBodyContains('Grace')
  })

  it('loads a post with its comments through the relation', async () => {
    await Comment.forceCreate({ body: 'One', postId: post.id, authorId: grace.id })
    await Comment.forceCreate({ body: 'Two', postId: post.id, authorId: ada.id })

    const loaded = await Post.findWithOrFail(post.id, 'comments')
    expect(loaded.comments).toHaveLength(2)
  })

  it('lets a signed-in user comment', async () => {
    await asGrace.post(`/posts/${post.id}/comments`, { body: 'Well put.' }).assertRedirect(`/posts/${post.id}`)

    const comment = await Comment.where('postId', post.id).first()
    expect(comment?.body).toBe('Well put.')
    expect(comment?.authorId).toBe(grace.id)
  })

  it('rejects an empty comment with a message', async () => {
    await asGrace
      .post(`/posts/${post.id}/comments`, { body: '   ' })
      .assertStatus(422)
      .assertJsonPath('errors.body.0', 'Say something')
  })

  it('sends a guest to the login page instead of commenting', async () => {
    const guest = await http.withCsrf()
    await guest.post(`/posts/${post.id}/comments`, { body: 'Anon' }).assertRedirect('/login')
    expect(await Comment.where('postId', post.id).first()).toBeNull()
  })

  it('lets the comment author delete it, and nobody else', async () => {
    const comment = await Comment.forceCreate({ body: 'Mine', postId: post.id, authorId: grace.id })

    await asAda.delete(`/comments/${comment.id}`).assertForbidden()
    expect(await Comment.find(comment.id)).not.toBeNull()

    await asGrace.delete(`/comments/${comment.id}`).assertRedirect(`/posts/${post.id}`)
    expect(await Comment.find(comment.id)).toBeNull()
  })
})
```

Note the last test: Ada wrote the post and still cannot delete Grace's comment. Ownership belongs to the comment, and the ownership rule from chapter 8 applies to it exactly as it applied to posts and links.

```bash run expect-fail
bun test
```

The file fails to load: there is no `Comment` model.

## 3. Comments, by hand

The table references two others. `onDelete: 'cascade'` on the post side says a comment cannot outlive its post:

```ts file=db/schema.ts
import { sqliteTable, integer, text } from '@guren/orm/drizzle/sqlite'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  rememberToken: text('remember_token'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  authorId: integer('author_id').notNull().references(() => users.id),
  publishedAt: text('published_at'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const comments = sqliteTable('comments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  body: text('body').notNull(),
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  authorId: integer('author_id').notNull().references(() => users.id),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const links = sqliteTable('links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  url: text('url').notNull(),
  userId: integer('user_id').notNull().references(() => users.id),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

```bash run
bun run db:make create_comments
```

```bash run
bun run db:migrate
```

The model, with both of its `belongsTo` sides:

```ts file=app/Models/Comment.ts
import { defineModel, type BelongsToRecord } from '@guren/core'
import { comments } from '../../db/schema.js'
import type { PostRecord } from './Post.js'
import type { UserRecord } from './User.js'

export type CommentRecord = typeof comments.$inferSelect

export class Comment extends defineModel(comments, { fillable: ['body'] }) {
  static override relationTypes: {
    post: BelongsToRecord<PostRecord>
    author: BelongsToRecord<UserRecord>
  } = { post: null, author: null }
}

Comment.belongsTo('post', () => import('./Post.js').then((m) => m.Post), 'postId', 'id')
Comment.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
```

Only `body` is fillable. Both foreign keys are set by the server: the post from the URL, the author from the session.

And `Post` gains the `hasMany` side:

```ts file=app/Models/Post.ts
import { defineModel, type BelongsToRecord, type HasManyRecord } from '@guren/core'
import { posts } from '../../db/schema.js'
import type { UserRecord } from './User.js'
import type { CommentRecord } from './Comment.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends defineModel(posts, { fillable: ['title', 'body'] }) {
  static override relationTypes: {
    author: BelongsToRecord<UserRecord>
    comments: HasManyRecord<CommentRecord>
  } = { author: null, comments: [] }
}

Post.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
Post.hasMany('comments', () => import('./Comment.js').then((m) => m.Comment), 'postId', 'id')
```

The rule from chapter 8 says an owned record gets a policy before anything else. Scaffold and edit it:

```bash run
bunx guren make:policy Comment
```

```ts file=app/Policies/CommentPolicy.ts
import { Policy, type AuthUser } from '@guren/core'
import type { CommentRecord } from '../Models/Comment.js'

export class CommentPolicy extends Policy {
  create(user: AuthUser | null): boolean {
    return user !== null
  }

  delete(user: AuthUser | null, comment: CommentRecord): boolean {
    return user !== null && user.id === comment.authorId
  }
}
```

```ts file=app/Providers/AuthProvider.ts
import { ServiceProvider, shareInertiaProps, getGate, AUTH_CONTEXT_KEY } from '@guren/core'
import type { AuthContext, AuthManager } from '@guren/core'
import { User } from '../Models/User.js'
import { Post } from '../Models/Post.js'
import { Link } from '../Models/Link.js'
import { Comment } from '../Models/Comment.js'
import { PostPolicy } from '../Policies/PostPolicy.js'
import { LinkPolicy } from '../Policies/LinkPolicy.js'
import { CommentPolicy } from '../Policies/CommentPolicy.js'

export default class AuthProvider extends ServiceProvider {
  register(): void {
    const auth = this.container.make<AuthManager>('auth')
    auth.useModel(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    })
  }

  boot(): void {
    getGate().policy(Post, PostPolicy)
    getGate().policy(Link, LinkPolicy)
    getGate().policy(Comment, CommentPolicy)

    shareInertiaProps(async (ctx) => {
      const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
      return { auth: { user: await auth?.user() } }
    }, this.container)
  }
}
```

The validator, the resource, and the controller:

```ts file=app/Http/Validators/CommentValidator.ts
import { z } from 'zod'

export const CommentPayloadSchema = z.object({
  body: z.string().trim().min(1, 'Say something').max(2000, 'Comments are limited to 2000 characters'),
})

export type CommentPayload = z.infer<typeof CommentPayloadSchema>
```

```ts file=app/Http/Resources/CommentResource.ts
import { Resource } from '@guren/core'
import type { CommentRecord } from '../../Models/Comment.js'
import type { UserRecord } from '../../Models/User.js'

export type CommentWithAuthor = CommentRecord & { author?: UserRecord | null }

export interface CommentResourceData extends Record<string, unknown> {
  id: number
  body: string
  createdAt: string
  author: { id: number; name: string } | null
}

export class CommentResource extends Resource<CommentWithAuthor, CommentResourceData> {
  toArray(): CommentResourceData {
    const author = this.resource.author
    return {
      id: this.resource.id,
      body: this.resource.body,
      createdAt: this.resource.createdAt,
      author: author ? { id: author.id, name: author.name } : null,
    }
  }
}
```

```ts file=app/Http/Controllers/CommentController.ts
import { Controller } from '@guren/core'
import { Post } from '../../Models/Post.js'
import { Comment } from '../../Models/Comment.js'
import type { UserRecord } from '../../Models/User.js'
import { CommentPayloadSchema } from '../Validators/CommentValidator.js'

export default class CommentController extends Controller {
  async store(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('create', Comment)
    const author = await this.auth.userOrFail<UserRecord>()
    const data = await this.validateBody(CommentPayloadSchema)
    await Comment.forceCreate({ ...data, postId: post.id, authorId: author.id })
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const comment = this.model(Comment)
    await this.authorize('delete', [Comment, comment])
    await Comment.delete({ id: comment.id })
    return this.redirect(`/posts/${comment.postId}`)
  }
}
```

`this.authorize('create', Comment)` with the bare class: there is no record yet, so the policy's `create` is asked about the user alone. The post page loads the comments with their authors in one relation query, and asks the policy about each one so the page can show a delete button only where it would work:

```ts file=app/Http/Controllers/PostController.ts
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import { Comment } from '../../Models/Comment.js'
import type { UserRecord } from '../../Models/User.js'
import { PostResource, type PostResourceData } from '../Resources/PostResource.js'
import { CommentResource } from '../Resources/CommentResource.js'
import { ListPostsQuerySchema, PostIdParamSchema, PostPayloadSchema } from '../Validators/PostValidator.js'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

export default class PostController extends Controller {
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
    const post = await Post.findWithOrFail(id, 'author')
    const comments = await Comment.where('postId', post.id).with('author').orderBy('id', 'asc').get()

    return this.inertia(pages.posts.Show, {
      post: new PostResource(post).toJSON(),
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
    const data = await this.validateBody(PostPayloadSchema)
    const post = await Post.forceCreate({ ...data, authorId: author.id })
    return this.redirect(`/posts/${post.id}`)
  }

  async edit(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])

    return this.inertia(pages.posts.Edit, {
      post: new PostResource(post).toJSON(),
    })
  }

  async update(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const data = await this.validateBody(PostPayloadSchema)
    await Post.update({ id: post.id }, data)
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('delete', [Post, post])
    await Post.delete({ id: post.id })
    return this.redirect('/posts')
  }

  async publish(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('publish', [Post, post])
    await Post.forceUpdate({ id: post.id }, { publishedAt: new Date().toISOString() })
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

`Comment.where('postId', post.id).with('author').orderBy('id', 'asc').get()` is the query-builder form: filter, then load a relation on the results, then order. It is one query for the comments and one for their authors, whatever the count. Compare it with `Post.findWithOrFail(id, 'comments')`, which the second test uses: that loads the same comments through the `hasMany`, and is the right call when you want the post first and its children as a property; the builder form is the right call when the children are the thing you are listing and you want to say how.

Two routes, both signed-in only:

```ts file=routes/web.ts
import { Router, requireAuthenticated, requireGuest } from '@guren/core'
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
import { PostIdParamSchema, PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { CommentPayloadSchema } from '../app/Http/Validators/CommentValidator.js'
import { LinkPayloadSchema } from '../app/Http/Validators/LinkValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
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
    auth.post('/posts/:id/comments', { bind: { id: Post }, name: 'comments.store', body: CommentPayloadSchema }, [CommentController, 'store'])
    auth.delete('/comments/:id', { bind: { id: Comment }, name: 'comments.destroy' }, [CommentController, 'destroy'])
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
  })

  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.get('/posts/:id', { name: 'posts.show', params: PostIdParamSchema }, [PostController, 'show'])
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

And the page: the comment list, a form for anyone signed in, a delete button where the policy allows it.

```tsx file=resources/js/pages/posts/Show.tsx
import { Head, Link, useForm, usePage } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import type { CommentResourceData } from '@/app/Http/Resources/CommentResource'
import { route } from '@/.guren/routes.gen'

type CommentForm = RouteBody<ApiRoutes, 'comments.store'>

interface Props {
  post: PostResourceData
  canManage: boolean
  comments: (CommentResourceData & { canDelete: boolean })[]
}

export default function PostShow({ post, canManage, comments }: Props) {
  const { props } = usePage<{ auth?: { user?: { name?: string } | null } }>()
  const signedIn = Boolean(props.auth?.user)
  const form = useForm<CommentForm>({ body: '' })

  return (
    <>
      <Head title={post.title} />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <Link href={route('posts.index')} className="text-sm text-g-accent-text transition hover:underline">
            All posts
          </Link>
          <h1 className="text-3xl font-bold text-g-heading">{post.title}</h1>
          <p className="font-mono text-xs text-g-text-2">
            by {post.author?.name ?? 'unknown'} · {post.publishedAt ? `Published ${post.publishedAt}` : 'Draft'}
          </p>
          <p className="whitespace-pre-wrap text-lg">{post.body}</p>
          {canManage && (
            <div className="flex items-center gap-4">
              <Link href={route('posts.edit', { id: post.id })} className="text-g-accent-text transition hover:underline">
                Edit
              </Link>
              {post.publishedAt ? (
                <Link href={route('posts.unpublish', { id: post.id })} method="post" as="button" className="rounded-g-ctl border border-g-line-strong px-3 py-1 text-sm text-g-text transition hover:border-g-muted">
                  Unpublish
                </Link>
              ) : (
                <Link href={route('posts.publish', { id: post.id })} method="post" as="button" className="rounded-g-ctl bg-g-accent px-3 py-1 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
                  Publish
                </Link>
              )}
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
          )}

          <section className="space-y-4 border-t border-g-line pt-6">
            <h2 className="text-xl font-bold text-g-heading">Comments</h2>
            {comments.length === 0 && <p className="text-g-text-2">No comments yet.</p>}
            {comments.map((comment) => (
              <article key={comment.id} className="rounded-g-card border border-g-line bg-g-panel p-4">
                <p className="whitespace-pre-wrap">{comment.body}</p>
                <p className="mt-2 flex items-center gap-3 font-mono text-xs text-g-text-2">
                  <span>{comment.author?.name ?? 'unknown'} · {comment.createdAt}</span>
                  {comment.canDelete && (
                    <Link href={route('comments.destroy', { id: comment.id })} method="delete" as="button" className="text-g-danger hover:underline">
                      Delete
                    </Link>
                  )}
                </p>
              </article>
            ))}
            {signedIn ? (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  form.post(route('comments.store', { id: post.id }), { onSuccess: () => form.reset() })
                }}
              >
                <textarea
                  value={form.data.body}
                  onChange={(event) => form.setData('body', event.target.value)}
                  placeholder="Add a comment"
                  rows={3}
                  className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
                />
                {form.errors.body && <p className="text-sm text-g-danger">{form.errors.body}</p>}
                <button type="submit" disabled={form.processing} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
                  Comment
                </button>
              </form>
            ) : (
              <p className="text-sm text-g-text-2">
                <Link href={route('login')} className="text-g-accent-text hover:underline">Sign in</Link> to comment.
              </p>
            )}
          </section>
        </div>
      </main>
    </>
  )
}
```

`usePage()` reads the shared props from chapter 5; `auth.user` is how any page learns whether someone is signed in without the controller passing it.

```bash run
bun run codegen
```

```bash run
bun test
```

Green. **Checkpoint:** open a post, comment on it, sign in as someone else in a private window and comment again; only your own comment has a delete button, and the other one still answers 403 if you post to its URL.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add comments with a hasMany and two belongsTo relations"
```

## 4. Specify tags

A post has many tags and a tag has many posts: a many-to-many, which needs a table in the middle. Two tests, both reading the relation the agent will have to declare, added to the post tests:

```ts file=tests/PostController.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { posts } from '../db/schema.js'
import { Post } from '../app/Models/Post.js'
import { User, type UserRecord } from '../app/Models/User.js'

describe('PostController', () => {
  let http: TestApp
  let ada: UserRecord
  let grace: UserRecord
  let asAda: TestApp
  let asGrace: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
    asAda = await http.actingAs(ada).withCsrf()
    asGrace = await http.actingAs(grace).withCsrf()
  })

  it('requires an author at the schema level', () => {
    expect(posts.authorId.notNull).toBe(true)
  })

  it('lists posts, newest first, each with its author', async () => {
    await Post.forceCreate({ title: 'First post', body: 'Hello', authorId: ada.id })
    await Post.forceCreate({ title: 'Second post', body: 'Again', authorId: grace.id })

    const response = await http.get('/posts').assertOk()
    const html = await response.text()
    const first = html.indexOf('First post')
    const second = html.indexOf('Second post')
    if (first === -1 || second === -1 || second > first) {
      throw new Error('expected the newer post to be listed before the older one')
    }
    await response.assertBodyContains('Ada')
    await response.assertBodyContains('Grace')
  })

  it('paginates ten posts per page', async () => {
    for (let i = 1; i <= 11; i++) {
      await Post.forceCreate({ title: `Post ${String(i).padStart(2, '0')}`, body: `Body number ${i}`, authorId: ada.id })
    }

    const firstPage = await http.get('/posts').assertOk()
    await firstPage.assertBodyContains('Post 11')
    await firstPage.assertBodyContains('Post 02')
    expect(await firstPage.text()).not.toContain('Post 01')

    const secondPage = await http.get('/posts?page=2').assertOk()
    await secondPage.assertBodyContains('Post 01')
    expect(await secondPage.text()).not.toContain('Post 02')
  })

  it('shows one post with its author', async () => {
    const post = await Post.forceCreate({ title: 'Read me', body: 'The whole body', authorId: ada.id })

    const response = await http.get(`/posts/${post.id}`).assertOk()
    await response.assertBodyContains('The whole body')
    await response.assertBodyContains('Ada')
  })

  it('answers 404 for a post that does not exist', async () => {
    await http.get('/posts/999').assertNotFound()
  })

  it('sends a guest to the login page instead of the form', async () => {
    await http.get('/posts/create').assertRedirect('/login')
  })

  it('sends a guest to the login page instead of storing', async () => {
    const guest = await http.withCsrf()
    await guest.post('/posts', { title: 'Sneaky', body: 'No account' }).assertRedirect('/login')
    expect(await Post.where('title', 'Sneaky').first()).toBeNull()
  })

  it('serves the form for a new post to a signed-in user', async () => {
    await asAda.get('/posts/create').assertOk()
  })

  it('stores a post with the signed-in user as its author and redirects to it', async () => {
    await asAda.post('/posts', { title: 'Written in a test', body: 'By a test' }).assertRedirect()

    const post = await Post.where('title', 'Written in a test').first()
    expect(post).not.toBeNull()
    expect(post?.body).toBe('By a test')
    expect(post?.authorId).toBe(ada.id)
  })

  it('rejects an empty post with a message per field', async () => {
    await asAda
      .post('/posts', { title: '', body: '' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
      .assertJsonPath('errors.body.0', 'Body is required')
  })

  it('serves the edit form to the author', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    const response = await asAda.get(`/posts/${post.id}/edit`).assertOk()
    await response.assertBodyContains('The old body')
  })

  it('refuses the edit form to anyone else', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    await asGrace.get(`/posts/${post.id}/edit`).assertForbidden()
  })

  it('updates a post for its author and redirects to it', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    await asAda.put(`/posts/${post.id}`, { title: 'After', body: 'The new body' }).assertRedirect(`/posts/${post.id}`)

    const updated = await Post.findOrFail(post.id)
    expect(updated.title).toBe('After')
    expect(updated.body).toBe('The new body')
  })

  it('refuses to update a post for anyone else', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    await asGrace.put(`/posts/${post.id}`, { title: 'Hijacked', body: 'By Grace' }).assertForbidden()

    expect((await Post.findOrFail(post.id)).title).toBe('Before')
  })

  it('rejects an invalid update with the same messages', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    await asAda
      .put(`/posts/${post.id}`, { title: '', body: 'Still here' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
  })

  it('deletes a post for its author and redirects to the list', async () => {
    const post = await Post.forceCreate({ title: 'Doomed', body: 'Gone soon', authorId: ada.id })

    await asAda.delete(`/posts/${post.id}`).assertRedirect('/posts')

    expect(await Post.find(post.id)).toBeNull()
  })

  it('refuses to delete a post for anyone else', async () => {
    const post = await Post.forceCreate({ title: 'Doomed', body: 'Gone soon', authorId: ada.id })

    await asGrace.delete(`/posts/${post.id}`).assertForbidden()

    expect(await Post.find(post.id)).not.toBeNull()
  })

  it('lets the author publish and unpublish a post', async () => {
    const post = await Post.forceCreate({ title: 'Draft', body: 'Not yet', authorId: ada.id })

    await asAda.post(`/posts/${post.id}/publish`).assertRedirect(`/posts/${post.id}`)
    expect((await Post.findOrFail(post.id)).publishedAt).not.toBeNull()

    await asAda.post(`/posts/${post.id}/unpublish`).assertRedirect(`/posts/${post.id}`)
    expect((await Post.findOrFail(post.id)).publishedAt).toBeNull()
  })

  it('refuses to let anyone else publish a post', async () => {
    const post = await Post.forceCreate({ title: 'Draft', body: 'Not yet', authorId: ada.id })

    await asGrace.post(`/posts/${post.id}/publish`).assertForbidden()

    expect((await Post.findOrFail(post.id)).publishedAt).toBeNull()
  })

  it('sends a guest to the login page instead of publishing', async () => {
    const post = await Post.forceCreate({ title: 'Draft', body: 'Not yet', authorId: ada.id })
    const guest = await http.withCsrf()

    await guest.post(`/posts/${post.id}/publish`).assertRedirect('/login')
  })

  it('stores tags with a post and shows them on its page', async () => {
    await asAda.post('/posts', { title: 'Tagged', body: 'With tags', tags: 'Guren, bun, guren' }).assertRedirect()

    const post = await Post.where('title', 'Tagged').first()
    const loaded = await Post.findWithOrFail(post!.id, 'tags')
    expect(loaded.tags.map((tag) => tag.name).sort()).toEqual(['bun', 'guren'])

    const response = await http.get(`/posts/${post!.id}`).assertOk()
    await response.assertBodyContains('guren')
  })

  it('replaces the tags of a post on update', async () => {
    await asAda.post('/posts', { title: 'Retagged', body: 'Body', tags: 'old' }).assertRedirect()
    const post = await Post.where('title', 'Retagged').first()

    await asAda.put(`/posts/${post!.id}`, { title: 'Retagged', body: 'Body', tags: 'new, newer' }).assertRedirect()

    const loaded = await Post.findWithOrFail(post!.id, 'tags')
    expect(loaded.tags.map((tag) => tag.name).sort()).toEqual(['new', 'newer'])
  })
})
```

```bash run expect-fail
bun test
```

Two red: `findWithOrFail` throws because `Post` has no relation called `tags`. Read the first test once more: it sends `Guren, bun, guren` and expects `bun` and `guren`. Lower-cased, de-duplicated, comma-separated. That is the whole contract for the form.

## 5. Delegate it

Ask your agent:

> Add tags to posts as a many-to-many. Tables `tags` (unique `name`) and `post_tags` (`postId`, `tagId`, composite primary key, cascade on delete) with a migration; models `Tag` and `PostTag`; a `tags` relation on `Post` declared with `belongsToMany` through the `postTags` table and typed in `relationTypes`. The post forms get a `tags` text field: a comma-separated list, lower-cased, trimmed, de-duplicated, empty allowed. `store` and `update` replace the post's tags with the list, creating tag rows that do not exist yet; the post page shows the tag names; `PostResource` carries `tags` as names. `tests/PostController.test.ts` describes it; make it pass.

The harness lever here is the **`orm-models.md` rule** and the API digest that `guren context` puts in front of the agent at session start. Both say, in as many words, that there is no `attach()`, `detach()` or `sync()` in Guren: a pivot table is a model, and you write to it with `create` and `delete` like any other. An agent that has worked with other ORMs has those methods in its memory, and would happily write `post.tags().sync(ids)`. Watch whether yours reaches for a `PostTag` model instead. If it does, the rule and the digest are why.

**No agent handy?** The schema first; `primaryKey` from the same module as `sqliteTable`:

```ts file=db/schema.ts fallback
import { sqliteTable, integer, text, primaryKey } from '@guren/orm/drizzle/sqlite'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  rememberToken: text('remember_token'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  authorId: integer('author_id').notNull().references(() => users.id),
  publishedAt: text('published_at'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const comments = sqliteTable('comments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  body: text('body').notNull(),
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  authorId: integer('author_id').notNull().references(() => users.id),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
})

export const postTags = sqliteTable(
  'post_tags',
  {
    postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.postId, table.tagId] })],
)

export const links = sqliteTable('links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  url: text('url').notNull(),
  userId: integer('user_id').notNull().references(() => users.id),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

```bash run fallback
bun run db:make create_tags
```

```bash run fallback
bun run db:migrate
```

Two models. The pivot is a model with no ceremony at all:

```ts file=app/Models/Tag.ts fallback
import { defineModel } from '@guren/core'
import { tags } from '../../db/schema.js'

export type TagRecord = typeof tags.$inferSelect

export class Tag extends defineModel(tags, { fillable: ['name'] }) {
}
```

```ts file=app/Models/PostTag.ts fallback
import { defineModel } from '@guren/core'
import { postTags } from '../../db/schema.js'

export type PostTagRecord = typeof postTags.$inferSelect

export class PostTag extends defineModel(postTags) {
}
```

```ts file=app/Models/Post.ts fallback
import { defineModel, type BelongsToRecord, type BelongsToManyRecord, type HasManyRecord } from '@guren/core'
import { posts, postTags } from '../../db/schema.js'
import type { UserRecord } from './User.js'
import type { CommentRecord } from './Comment.js'
import type { TagRecord } from './Tag.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends defineModel(posts, { fillable: ['title', 'body'] }) {
  static override relationTypes: {
    author: BelongsToRecord<UserRecord>
    comments: HasManyRecord<CommentRecord>
    tags: BelongsToManyRecord<TagRecord>
  } = { author: null, comments: [], tags: [] }
}

Post.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
Post.hasMany('comments', () => import('./Comment.js').then((m) => m.Comment), 'postId', 'id')
Post.belongsToMany('tags', () => import('./Tag.js').then((m) => m.Tag), postTags, 'postId', 'tagId')
```

`belongsToMany` names the pivot table object and the two columns on it. Reading `post.tags` goes through the pivot in one query and then fetches the tags in another.

The validator accepts the field and normalises it:

```ts file=app/Http/Validators/PostValidator.ts fallback
import { z } from 'zod'

export const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
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
```

The controller writes the pivot by hand: delete every row for the post, then create one per name. That is what "sync" means, and it is four lines.

```ts file=app/Http/Controllers/PostController.ts fallback
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import { Comment } from '../../Models/Comment.js'
import { Tag } from '../../Models/Tag.js'
import { PostTag } from '../../Models/PostTag.js'
import type { UserRecord } from '../../Models/User.js'
import { PostResource, type PostResourceData } from '../Resources/PostResource.js'
import { CommentResource } from '../Resources/CommentResource.js'
import { ListPostsQuerySchema, PostIdParamSchema, PostPayloadSchema } from '../Validators/PostValidator.js'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

async function syncTags(postId: number, names: string[]): Promise<void> {
  await PostTag.delete({ postId })
  for (const name of names) {
    const tag = (await Tag.first({ name })) ?? (await Tag.create({ name }))
    await PostTag.forceCreate({ postId, tagId: tag.id })
  }
}

export default class PostController extends Controller {
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
    const comments = await Comment.where('postId', post.id).with('author').orderBy('id', 'asc').get()

    return this.inertia(pages.posts.Show, {
      post: new PostResource(post).toJSON(),
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

  async destroy(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('delete', [Post, post])
    await Post.delete({ id: post.id })
    return this.redirect('/posts')
  }

  async publish(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('publish', [Post, post])
    await Post.forceUpdate({ id: post.id }, { publishedAt: new Date().toISOString() })
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

```ts file=app/Http/Resources/PostResource.ts fallback
import { Resource } from '@guren/core'
import type { PostRecord } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'
import type { TagRecord } from '../../Models/Tag.js'

export type PostWithRelations = PostRecord & { author?: UserRecord | null; tags?: TagRecord[] }

export interface PostResourceData extends Record<string, unknown> {
  id: number
  title: string
  body: string
  createdAt: string
  publishedAt: string | null
  author: { id: number; name: string } | null
  tags: string[]
}

export class PostResource extends Resource<PostWithRelations, PostResourceData> {
  toArray(): PostResourceData {
    const author = this.resource.author
    return {
      id: this.resource.id,
      title: this.resource.title,
      body: this.resource.body,
      createdAt: this.resource.createdAt,
      publishedAt: this.resource.publishedAt,
      author: author ? { id: author.id, name: author.name } : null,
      tags: (this.resource.tags ?? []).map((tag) => tag.name),
    }
  }
}
```

The two forms gain a field. `RouteBody<ApiRoutes, 'posts.store'>` picks up `tags` from the schema; as far as the form is concerned it is a string, because the transform runs on the server:

```tsx file=resources/js/pages/posts/New.tsx fallback
import { Head, useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import { route } from '@/.guren/routes.gen'

type PostForm = RouteBody<ApiRoutes, 'posts.store'>

const inputClass =
  'w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent'

export default function NewPost() {
  const form = useForm<PostForm>({ title: '', body: '', tags: '' })

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
              <input value={form.data.title} onChange={(event) => form.setData('title', event.target.value)} placeholder="Title" className={inputClass} />
              {form.errors.title && <p className="mt-1 text-sm text-g-danger">{form.errors.title}</p>}
            </div>
            <div>
              <textarea value={form.data.body} onChange={(event) => form.setData('body', event.target.value)} placeholder="Body" rows={8} className={inputClass} />
              {form.errors.body && <p className="mt-1 text-sm text-g-danger">{form.errors.body}</p>}
            </div>
            <div>
              <input value={form.data.tags} onChange={(event) => form.setData('tags', event.target.value)} placeholder="Tags, comma-separated" className={inputClass} />
              {form.errors.tags && <p className="mt-1 text-sm text-g-danger">{form.errors.tags}</p>}
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

const inputClass =
  'w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent'

export default function EditPost({ post }: Props) {
  const form = useForm<PostForm>({ title: post.title, body: post.body, tags: post.tags.join(', ') })

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
              <input value={form.data.title} onChange={(event) => form.setData('title', event.target.value)} placeholder="Title" className={inputClass} />
              {form.errors.title && <p className="mt-1 text-sm text-g-danger">{form.errors.title}</p>}
            </div>
            <div>
              <textarea value={form.data.body} onChange={(event) => form.setData('body', event.target.value)} placeholder="Body" rows={8} className={inputClass} />
              {form.errors.body && <p className="mt-1 text-sm text-g-danger">{form.errors.body}</p>}
            </div>
            <div>
              <input value={form.data.tags} onChange={(event) => form.setData('tags', event.target.value)} placeholder="Tags, comma-separated" className={inputClass} />
              {form.errors.tags && <p className="mt-1 text-sm text-g-danger">{form.errors.tags}</p>}
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

And the page shows them:

```tsx file=resources/js/pages/posts/Show.tsx fallback
import { Head, Link, useForm, usePage } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import type { CommentResourceData } from '@/app/Http/Resources/CommentResource'
import { route } from '@/.guren/routes.gen'

type CommentForm = RouteBody<ApiRoutes, 'comments.store'>

interface Props {
  post: PostResourceData
  canManage: boolean
  comments: (CommentResourceData & { canDelete: boolean })[]
}

export default function PostShow({ post, canManage, comments }: Props) {
  const { props } = usePage<{ auth?: { user?: { name?: string } | null } }>()
  const signedIn = Boolean(props.auth?.user)
  const form = useForm<CommentForm>({ body: '' })

  return (
    <>
      <Head title={post.title} />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <Link href={route('posts.index')} className="text-sm text-g-accent-text transition hover:underline">
            All posts
          </Link>
          <h1 className="text-3xl font-bold text-g-heading">{post.title}</h1>
          <p className="font-mono text-xs text-g-text-2">
            by {post.author?.name ?? 'unknown'} · {post.publishedAt ? `Published ${post.publishedAt}` : 'Draft'}
          </p>
          {post.tags.length > 0 && (
            <p className="flex flex-wrap gap-2">
              {post.tags.map((tag) => (
                <span key={tag} className="rounded-g-ctl border border-g-line px-2 py-0.5 font-mono text-xs text-g-text-2">
                  #{tag}
                </span>
              ))}
            </p>
          )}
          <p className="whitespace-pre-wrap text-lg">{post.body}</p>
          {canManage && (
            <div className="flex items-center gap-4">
              <Link href={route('posts.edit', { id: post.id })} className="text-g-accent-text transition hover:underline">
                Edit
              </Link>
              {post.publishedAt ? (
                <Link href={route('posts.unpublish', { id: post.id })} method="post" as="button" className="rounded-g-ctl border border-g-line-strong px-3 py-1 text-sm text-g-text transition hover:border-g-muted">
                  Unpublish
                </Link>
              ) : (
                <Link href={route('posts.publish', { id: post.id })} method="post" as="button" className="rounded-g-ctl bg-g-accent px-3 py-1 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
                  Publish
                </Link>
              )}
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
          )}

          <section className="space-y-4 border-t border-g-line pt-6">
            <h2 className="text-xl font-bold text-g-heading">Comments</h2>
            {comments.length === 0 && <p className="text-g-text-2">No comments yet.</p>}
            {comments.map((comment) => (
              <article key={comment.id} className="rounded-g-card border border-g-line bg-g-panel p-4">
                <p className="whitespace-pre-wrap">{comment.body}</p>
                <p className="mt-2 flex items-center gap-3 font-mono text-xs text-g-text-2">
                  <span>{comment.author?.name ?? 'unknown'} · {comment.createdAt}</span>
                  {comment.canDelete && (
                    <Link href={route('comments.destroy', { id: comment.id })} method="delete" as="button" className="text-g-danger hover:underline">
                      Delete
                    </Link>
                  )}
                </p>
              </article>
            ))}
            {signedIn ? (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  form.post(route('comments.store', { id: post.id }), { onSuccess: () => form.reset() })
                }}
              >
                <textarea
                  value={form.data.body}
                  onChange={(event) => form.setData('body', event.target.value)}
                  placeholder="Add a comment"
                  rows={3}
                  className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
                />
                {form.errors.body && <p className="text-sm text-g-danger">{form.errors.body}</p>}
                <button type="submit" disabled={form.processing} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
                  Comment
                </button>
              </form>
            ) : (
              <p className="text-sm text-g-text-2">
                <Link href={route('login')} className="text-g-accent-text hover:underline">Sign in</Link> to comment.
              </p>
            )}
          </section>
        </div>
      </main>
    </>
  )
}
```

```bash run
bun run codegen
```

```bash run
bun test
```

The rubric:

- `post_tags` has a composite primary key and cascades from both sides; `tags.name` is unique.
- `Post.belongsToMany('tags', ..., postTags, 'postId', 'tagId')` and `tags: BelongsToManyRecord<TagRecord>` in `relationTypes`. No method that does not exist: no `attach`, `sync` or `detach` anywhere.
- The pivot is written through `PostTag`, delete-then-create, and tag rows are found or created by name.
- Normalisation (trim, lower-case, de-duplicate) lives in the validator, so `store` and `update` cannot disagree.
- Twenty-two post tests and six comment tests are green.

**Checkpoint:** edit a post, type `Guren, Bun, guren` into the tags field, save: two tags, both lower-case, on the post page.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: tag posts through a pivot table"
```

## Where you are

- `belongsTo`, `hasMany` and `belongsToMany` declared, typed and loaded; `authorsOf` gone.
- Comments on posts, owned by their author, with a policy and the tests the rule requires.
- Tags through a pivot model, built by the agent without inventing an API.
- ER and domain views that now draw the relationships, ready to become a gate in chapter 13.

## Common trip-ups

- **`Post.hasMany('comments', ...)` does not compile.** `relationTypes` does not have a `comments` key yet. The type declaration and the call go in together; the call is checked against the keys.
- **`post.author` is `undefined`.** The record was loaded without the relation. A loaded relation is `null` or `[]` when empty, never `undefined`; `undefined` means you used `findOrFail` where you meant `findWithOrFail`.
- **Circular import at startup.** A model imported another model's class at the top level. Use `import type` for the record types and a lazy `() => import(...)` for the relation target.
- **The tags come back in the wrong case or twice.** Normalisation moved into the controller and one path forgot it. Keep it in the validator's `transform`.
- **`withCount('tags')` throws.** `withCount` supports `hasMany`, `hasOne` and `belongsTo`, not `belongsToMany`. Load `tags` and read `.length`.

## Next

[Chapter 10: Files](./10-files.md) gives posts a cover image with the attachments layer, one signed delivery route, and then hands the agent a gallery.
