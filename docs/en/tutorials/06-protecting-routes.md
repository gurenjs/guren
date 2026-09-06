# Chapter 6: Protecting Routes

The blog has users now, but nothing checks for one: a guest can still write, edit and delete posts, and `guren audit` has been saying so since chapter 3. This chapter puts the post mutations behind a login wall, gives every post an author with a migration that keeps the rows you already have, and then hands the agent a migration of its own and watches the `db-manage` skill keep it safe. It ends by showing you what `bunx guren add auth` would have written, now that you can read it.

**What you'll learn:**

- What `requireAuthenticated` and `requireGuest` do, and how a middleware alias and a group keep routes readable
- Why `guren audit` trusts `requireAuthenticated` and not a middleware you wrote with "auth" in its name
- How to add a required column to a table that already has rows: nullable, backfill, then not null
- What `forceCreate` and `forceUpdate` are for, and why `authorId` must never be fillable
- How a skill changes what an agent does with your database

Start the dev server if it is not running:

```bash run background
bun run dev
```

## 1. Specify the wall

Three test files change, before any route does. Posts first. Every mutating request now happens as Ada, and two new tests say what a guest gets:

```ts file=tests/PostController.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post } from '../app/Models/Post.js'
import { User, type UserRecord } from '../app/Models/User.js'

describe('PostController', () => {
  let http: TestApp
  let ada: UserRecord
  let asAda: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    asAda = await http.actingAs(ada).withCsrf()
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

  it('serves the edit form with the post in it', async () => {
    const post = await Post.create({ title: 'Before', body: 'The old body' })

    const response = await asAda.get(`/posts/${post.id}/edit`).assertOk()
    await response.assertBodyContains('The old body')
  })

  it('updates a post and redirects to it', async () => {
    const post = await Post.create({ title: 'Before', body: 'The old body' })

    await asAda.put(`/posts/${post.id}`, { title: 'After', body: 'The new body' }).assertRedirect(`/posts/${post.id}`)

    const updated = await Post.findOrFail(post.id)
    expect(updated.title).toBe('After')
    expect(updated.body).toBe('The new body')
  })

  it('rejects an invalid update with the same messages', async () => {
    const post = await Post.create({ title: 'Before', body: 'The old body' })

    await asAda
      .put(`/posts/${post.id}`, { title: '', body: 'Still here' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
  })

  it('deletes a post and redirects to the list', async () => {
    const post = await Post.create({ title: 'Doomed', body: 'Gone soon' })

    await asAda.delete(`/posts/${post.id}`).assertRedirect('/posts')

    expect(await Post.find(post.id)).toBeNull()
  })
})
```

The profile page stops answering 401 and joins the wall:

```ts file=tests/ProfileController.test.ts
import { beforeAll, beforeEach, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { User } from '../app/Models/User.js'

describe('ProfileController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('shows the signed-in user their name and email', async () => {
    const user = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })

    const response = await http.actingAs(user).get('/profile').assertOk()
    await response.assertBodyContains('ada@example.com')
  })

  it('sends a guest to the login page', async () => {
    await http.get('/profile').assertRedirect('/login')
  })
})
```

And the login page gains the opposite rule, a signed-in user has no business on it:

```ts file=tests/LoginController.test.ts
import { beforeAll, beforeEach, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { User } from '../app/Models/User.js'

describe('LoginController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
  })

  it('serves the login form', async () => {
    await http.get('/login').assertOk()
  })

  it('sends a signed-in user home instead of the login form', async () => {
    const user = await User.where('email', 'ada@example.com').first()
    await http.actingAs(user).get('/login').assertRedirect('/')
  })

  it('signs in with the right password and redirects', async () => {
    const csrf = await http.withCsrf('/login')
    await csrf.post('/login', { email: 'ada@example.com', password: 'correct horse battery' }).assertRedirect('/')
  })

  it('rejects the wrong password with a message', async () => {
    const csrf = await http.withCsrf('/login')
    await csrf
      .post('/login', { email: 'ada@example.com', password: 'wrong' })
      .assertStatus(422)
      .assertJsonPath('errors.message.0', 'Invalid credentials.')
  })

  it('signs out and redirects home', async () => {
    const user = await User.where('email', 'ada@example.com').first()
    const csrf = await http.actingAs(user).withCsrf()
    await csrf.post('/logout').assertRedirect('/')
  })
})
```

```bash run expect-fail
bun test
```

Five red: the guest redirects, the signed-in redirect from `/login`, and the author on a stored post, which does not exist yet. Note the shape of the guest test for `POST /posts`: it primes a CSRF token like any other, because CSRF is checked before authentication, and then asserts that nothing was stored. A redirect alone would not prove the wall held.

## 2. Two aliases, two groups

Replace `routes/web.ts`:

```ts file=routes/web.ts
import { Router, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
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
  })

  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.get('/posts/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

- `requireAuthenticated({ redirectTo: '/login' })` asks the guard whether the session has a user and redirects if not. Without `redirectTo` it answers a 401, which is what an API wants and what chapter 5's profile page did.
- `requireGuest({ redirectTo: '/' })` is the mirror image, for pages that only make sense signed out.
- `aliasMiddleware` gives each a name; `router.middleware('auth').group(...)` applies it to everything inside. Read the file top to bottom and you can see the wall: public, guest-only, signed-in-only, public again. The one rule the order has to respect is unchanged from chapter 3: `/posts/create` before `/posts/:id`.

Now the author. Replace the schema first: `authorId` references `users`, and it is **nullable** for now, on purpose:

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
  authorId: integer('author_id').references(() => users.id),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

```bash run
bun run db:make add_author_to_posts
```

```bash run
bun run db:migrate
```

Then `store` records who wrote the post:

```ts file=app/Http/Controllers/PostController.ts
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'
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
    const author = await this.auth.userOrFail<UserRecord>()
    const data = await this.validateBody(PostPayloadSchema)
    const post = await Post.forceCreate({ ...data, authorId: author.id })
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

`forceCreate` is the deliberate choice here, and it is worth a moment. `fillable` on the model lists `title` and `body`, and `authorId` is not on it: a request must never be able to say who wrote a post. `Post.create(data)` would therefore drop `authorId`. `forceCreate` bypasses the filter, and it is safe because nothing in that object came from the request unfiltered: `data` passed the validator, and `author.id` came from the session. The rule is not "never use forceCreate"; it is "only with values the server chose".

```bash run
bun test
```

Green. Now look at the audit:

```bash run
bunx guren audit
```

The three warnings are gone, replaced by "Protected by an authentication guard (verified via middleware capabilities)". That last phrase matters. `requireAuthenticated` carries a marker the framework stamps on it; `audit` trusts the marker, not the name. Had you written your own `requireLogin` middleware and aliased it as `auth`, the audit would say the middleware is *named like* a guard but is not one it recognises, and keep warning. That is the right answer: a reviewer, human or machine, cannot tell from a name whether a function checks anything.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: protect post mutations and record each post's author"
```

## 3. The rows you already have

`authorId` is nullable, and your development database has posts from chapters 3 and 4 with no author. Making the column required now would fail on those rows, and the old way around that, dropping the database and starting over, throws away data, which is not something you get to do once an app is deployed. The migration that survives real data is three steps: add the column nullable (done), fill it in, then require it.

The backfill is a script, not a migration, because it makes a decision a migration should not make on its own: which user owns the orphaned posts. Here, a "Legacy author" account that nobody can sign in to:

```ts file=scripts/backfill-post-authors.ts
import app from '../src/app.js'
import { Post } from '../app/Models/Post.js'
import { User } from '../app/Models/User.js'

await app.boot()

const orphans = (await Post.all()).filter((post) => post.authorId === null)
if (orphans.length === 0) {
  console.log('Every post has an author; nothing to do.')
  process.exit(0)
}

const legacy =
  (await User.where('email', 'legacy@guren-blog.test').first()) ??
  (await User.create({ name: 'Legacy author', email: 'legacy@guren-blog.test', password: crypto.randomUUID() }))

for (const post of orphans) {
  await Post.forceUpdate({ id: post.id }, { authorId: legacy.id })
}

console.log(`Assigned ${orphans.length} post(s) to ${legacy.name} (#${legacy.id}).`)
```

```bash run
bun scripts/backfill-post-authors.ts
```

`forceUpdate` for the same reason as `forceCreate`: `authorId` is not fillable, and this value was chosen here. A random UUID as the password means the account has a valid hash and no password anyone knows.

Requiring the column is the next slice, and it is the agent's.

## 4. Specify the constraint and the names

Two things the reader of the blog cannot yet see: that every post has an author, and who it is. Replace the posts test file. Every post created in a test now names its author, and three tests are new: the schema declares `authorId` as not null, and the list and the page show the author's name.

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
  let asAda: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    asAda = await http.actingAs(ada).withCsrf()
  })

  it('requires an author at the schema level', () => {
    expect(posts.authorId.notNull).toBe(true)
  })

  it('lists posts, newest first, each with its author', async () => {
    const grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
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

  it('serves the edit form with the post in it', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    const response = await asAda.get(`/posts/${post.id}/edit`).assertOk()
    await response.assertBodyContains('The old body')
  })

  it('updates a post and redirects to it', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    await asAda.put(`/posts/${post.id}`, { title: 'After', body: 'The new body' }).assertRedirect(`/posts/${post.id}`)

    const updated = await Post.findOrFail(post.id)
    expect(updated.title).toBe('After')
    expect(updated.body).toBe('The new body')
  })

  it('rejects an invalid update with the same messages', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    await asAda
      .put(`/posts/${post.id}`, { title: '', body: 'Still here' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
  })

  it('deletes a post and redirects to the list', async () => {
    const post = await Post.forceCreate({ title: 'Doomed', body: 'Gone soon', authorId: ada.id })

    await asAda.delete(`/posts/${post.id}`).assertRedirect('/posts')

    expect(await Post.find(post.id)).toBeNull()
  })
})
```

```bash run expect-fail
bun test
```

Three red. The first of them, `posts.authorId.notNull`, is a test of the schema itself: Drizzle's column objects know their own constraints, so the decision "a post has an author" can be pinned without a database.

## 5. Delegate it

Ask your agent:

> Every post now has an author (`scripts/backfill-post-authors.ts` has run). Make `authorId` on the `posts` table NOT NULL with a new migration, and show each post's author name on the posts list and the post page. Load the authors for a page of posts in one query, not one per post, and keep `PostResource` the one place a post's shape is defined. `tests/PostController.test.ts` describes all of it; make it pass.

This is the first time the agent touches your database, and this chapter's harness lever is the **`db-manage` skill** in `.claude/skills/db-manage/`. Read it before the agent does. It tells the agent how migrations are generated, applied and inspected in this app (`make:migration`, `db:migrate`, `db:status`), that they are forward-only, and it carries safety rules: a destructive operation (`db:reset`, `db:fresh`) is never run without confirming with you first, showing what it would affect and warning about the data loss. Watch whether the agent generates a migration and applies it, or asks you about a reset. The skill exists so that the difference is not left to the model's mood.

**No agent handy?** The schema gains one word, then the migration, then the code:

```ts file=db/schema.ts fallback
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
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

```bash run fallback
bun run db:make require_post_authors
```

```bash run fallback
bun run db:migrate
```

The resource learns about authors. It takes a post that may carry its author record, and sends only the author's id and name:

```ts file=app/Http/Resources/PostResource.ts fallback
import { Resource } from '@guren/core'
import type { PostRecord } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'

export type PostWithAuthor = PostRecord & { author?: UserRecord | null }

export interface PostResourceData extends Record<string, unknown> {
  id: number
  title: string
  body: string
  createdAt: string
  author: { id: number; name: string } | null
}

export class PostResource extends Resource<PostWithAuthor, PostResourceData> {
  toArray(): PostResourceData {
    const author = this.resource.author
    return {
      id: this.resource.id,
      title: this.resource.title,
      body: this.resource.body,
      createdAt: this.resource.createdAt,
      author: author ? { id: author.id, name: author.name } : null,
    }
  }
}
```

```ts file=app/Http/Controllers/PostController.ts fallback
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post, type PostRecord } from '../../Models/Post.js'
import { User, type UserRecord } from '../../Models/User.js'
import { PostResource, type PostResourceData } from '../Resources/PostResource.js'
import { ListPostsQuerySchema, PostPayloadSchema } from '../Validators/PostValidator.js'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

async function authorsOf(posts: PostRecord[]): Promise<Map<number, UserRecord>> {
  const ids = [...new Set(posts.map((post) => post.authorId))]
  const authors = ids.length === 0 ? [] : await User.where({ id: ids }).get()
  return new Map(authors.map((author) => [author.id, author]))
}

export default class PostController extends Controller {
  async index(): Promise<Response> {
    const { page } = this.validateQuery(ListPostsQuerySchema)
    const result = await Post.paginate({ page, perPage: 10, orderBy: ['id', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })
    const authors = await authorsOf(result.data)

    return this.inertia(pages.posts.Index, {
      data: result.data.map((post) => new PostResource({ ...post, author: authors.get(post.authorId) ?? null }).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies PostsIndexProps)
  }

  async show(): Promise<Response> {
    const post = this.model(Post)
    const author = await User.find(post.authorId)

    return this.inertia(pages.posts.Show, {
      post: new PostResource({ ...post, author }).toJSON(),
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

`User.where({ id: ids })` with an array is an `IN` query: one round trip for a whole page of posts, however many authors it has. Chapter 9 replaces `authorsOf` with a relationship and `with('author')`, which does the same thing with less code; the query it runs is this one.

The two pages render the name:

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
                <p className="mt-1 font-mono text-xs text-g-text-2">by {post.author?.name ?? 'unknown'}</p>
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
          <p className="font-mono text-xs text-g-text-2">
            by {post.author?.name ?? 'unknown'} · {post.createdAt}
          </p>
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

```bash run
bun run codegen
```

```bash run
bun test
```

The rubric:

- A new migration folder exists under `db/migrations/`, and `bun run db:status` shows it applied. There is no `db:reset` or `db:fresh` in the transcript; if the agent proposed one, it asked you first, which is the skill doing its job, and the answer was no.
- `authorId` is `notNull()` in the schema and still not in `fillable`.
- The list loads its authors with one `IN` query, not a `User.find` inside the map.
- `PostResource` is still the only place a post's shape is written, and the author it emits is an id and a name, not a user record.
- All fourteen tests are green.

**Checkpoint:** the posts list at [http://localhost:3333/posts](http://localhost:3333/posts) shows "by Legacy author" on the posts you wrote before this chapter, and your name on any you write now.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: require an author on every post and show it"
```

## What `add auth` would have given you

You now know what a session, a guard, a hash, a CSRF token and a login wall are, because you built each one. That is the moment to look at the generator. On a branch you will throw away:

```bash manual
git switch -c scratch/add-auth
bunx guren add auth --force
git diff main --stat
git switch main
git branch -D scratch/add-auth
```

Most of the diff is what you wrote, in the same shape: the model, the provider, the two controllers, the validators. The rest is what you did not: password reset by email, email verification, a "remember me" token, a seeder with a demo user, a dashboard. From now on, when the course needs one of those, you will reach for the generator, and you will be able to read what it wrote.

## Where you are

- Post mutations, the profile and logout behind `requireAuthenticated`; the login and registration pages behind `requireGuest`.
- A clean audit, and an understanding of why it trusts the framework's guard and not a name.
- An author on every post, added without losing a row: nullable, backfilled, required.
- The agent's first migration, run under the `db-manage` skill's rules.

## Common trip-ups

- **`.middleware('auth')` does not compile.** `aliasMiddleware()` returns a new router type that knows the name; the result was not captured. Chain and assign, as in the file above.
- **A signed-in test gets redirected to `/login`.** `actingAs()` must come before `withCsrf()`: the priming request has to be authenticated too. Both return new clients; reassign.
- **`db:migrate` fails with "NOT NULL constraint failed".** A post still has no author; run `bun scripts/backfill-post-authors.ts` first. The order is the whole point of section 3.
- **The stored post has `authorId: null`.** `store` used `Post.create`, and `fillable` dropped the author. Use `forceCreate` with a value the server chose.
- **The list shows "unknown" for every author.** The `IN` query got ids of the wrong type, or the map is keyed by something other than the user's id. Log `authors` once; it should have one entry per distinct author.

## Next

[Chapter 7: Authorization, and What the Gate Cannot See](./07-authorization.md) makes editing and deleting an author-only affair with a policy, then asks the agent for a feature without mentioning authorization, and shows you which of your safeguards notices.
