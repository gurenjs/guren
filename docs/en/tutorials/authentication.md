# Part 2: Add Authentication

Your blog from [Part 1](./create-blog-post-app.md) lets anyone publish posts. In this part you add user accounts with one command, put post creation behind a login wall, and attach an author to every post.

**What you'll learn:**

- What `bunx guren add auth` generates and wires up for you
- How to protect routes with a middleware alias and route groups
- How to read the signed-in user in a controller with `this.auth.userOrFail()`
- How to declare a `belongsTo` relationship and eager-load it with `findWithOrFail`

## 1. Install the auth scaffold

From the project root:

```bash
bunx guren add auth
```

This one command creates a complete session-based login stack:

| File | Purpose |
|------|---------|
| `app/Http/Controllers/Auth/LoginController.ts` | Login form, sign in (`auth.attempt`), logout |
| `app/Http/Controllers/DashboardController.ts` | Example protected page |
| `app/Http/Controllers/ProfileController.ts` | Edit name / email / password |
| `app/Models/User.ts` | `User` model extending `AuthenticatableModel` |
| `app/Providers/AuthProvider.ts` | Tells the auth manager to authenticate against `User` |
| `app/Http/Validators/LoginValidator.ts` | Zod schema for the login form |
| `app/Http/Validators/ProfileValidator.ts` | Zod schema for profile updates |
| `resources/js/components/Layout.tsx` | Shared layout with sign-in / log-out navigation |
| `resources/js/pages/auth/Login.tsx` | Login page |
| `resources/js/pages/dashboard/Index.tsx` | Dashboard page |
| `resources/js/pages/profile/Edit.tsx` | Profile page |
| `routes/auth.ts` | `registerAuthRoutes()` — `/login`, `/logout`, `/dashboard`, `/profile` |
| `db/seeders/UsersSeeder.ts` | Seeds a demo user (`demo@example.com` / `secret`) |

It also **edits existing files**:

- `db/schema.ts` — replaces the starter `users` table with one that has `passwordHash` and `rememberToken` columns (still SQLite), and generates the matching migration.
- `src/app.ts` — registers `AuthProvider` and adds `auth: {}` to `createApp()`, which turns on session and CSRF middleware.
- `routes/web.ts` — imports and calls `registerAuthRoutes(router)` at the top of your route registrar.

> [!WARNING]
> `add auth` rewrites the `users` table definition in `db/schema.ts`. If you added custom columns to `users`, re-add them after running the command.

Now apply the users migration, seed the demo account, and refresh the generated types (the scaffold added new pages and routes):

```bash
bun run db:migrate
bun run db:seed
bun run codegen
```

## 2. Checkpoint: sign in

Start the dev server (`bun run dev`) and open [http://localhost:3333/login](http://localhost:3333/login).

1. Sign in with **demo@example.com** / **secret** — you land on `/dashboard`, which greets you by name.
2. Try a wrong password — the form shows "Invalid credentials."
3. Open `/dashboard` in a private browser window — you are redirected to `/login`. Protected routes really are protected.

> [!NOTE]
> The scaffold ships a login flow, not public self-registration. To add more users during development, add entries to `db/seeders/UsersSeeder.ts` and re-run `bun run db:seed`.

## 3. Protect post creation

Register an `auth` middleware alias, then attach it to the two routes that mutate posts.

Edit `routes/web.ts`:

```ts
import { Router, requireAuthenticated } from '@guren/core'
import { registerAuthRoutes } from './auth.js'
import HomeController from '../app/Http/Controllers/HomeController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
  const router = baseRouter.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))

  registerAuthRoutes(router)

  router.get('/', [HomeController, 'index'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.middleware('auth').get('/create', [PostController, 'create']).name('posts.create')
    posts.get('/:id', [PostController, 'show']).name('posts.show')
    posts.middleware('auth').post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
  })
}
```

`aliasMiddleware` names a middleware once so routes can reference it as `'auth'`. It returns a new `Router` carrying that name in its type, so capture it with `const router = baseRouter.aliasMiddleware(...)` — drop the return value and the later `.middleware('auth')` will not compile. Reading and viewing posts stays public; `/posts/create` and the `POST /posts` submission now redirect guests to `/login`. If you have several protected routes, wrap them in a group instead of tagging each one:

```ts
posts.middleware('auth').group((authed) => {
  authed.get('/create', [PostController, 'create']).name('posts.create')
  authed.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
})
```

## 4. Give every post an author

### Add the column

Edit the `posts` table in `db/schema.ts` to reference `users`:

```ts
export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  authorId: integer('author_id').notNull().references(() => users.id),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

Generate the migration, then rebuild the dev database:

```bash
bun run db:make add_author_to_posts
bun run db:reset --seed
```

> [!WARNING]
> SQLite cannot add a `NOT NULL` column without a default to a table that already contains rows — the posts you created in Part 1 would block the migration. `db:reset --seed` drops all tables, re-runs every migration from scratch, and re-seeds the demo user. Development data is disposable; never run `db:reset` against a production database.

### Declare the relationship

Update `app/Models/Post.ts` to declare that a post belongs to an author:

```ts
import { defineModel, type BelongsToRecord } from '@guren/core'
import { posts } from '../../db/schema.js'
import type { UserRecord } from './User.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert
export type PostAuthor = Pick<UserRecord, 'id' | 'name'>

export class Post extends defineModel(posts) {
  static fillable = ['title', 'body', 'authorId']

  static override relationTypes: { author: BelongsToRecord<PostAuthor> } = {
    author: null,
  }
}

Post.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
```

Three pieces work together here:

- `Post.belongsTo('author', ...)` registers the relation: follow `posts.authorId` to `users.id`. The lazy `import()` avoids a circular import between `Post` and `User`.
- `relationTypes` tells TypeScript what eager-loaded data looks like — `post.author` is typed as `PostAuthor | null`.
- `authorId` joins `fillable` so `Post.create()` may set it.

### Set the author in `store`, load it in `show`

Update the two actions in `app/Http/Controllers/PostController.ts`:

```ts
import type { UserRecord } from '../../Models/User.js'

// inside PostController:

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findWithOrFail(id, 'author')

    return this.inertia(pages.posts.Show, {
      post: {
        id: post.id,
        title: post.title,
        body: post.body,
        createdAt: post.createdAt,
        author: post.author ? { id: post.author.id, name: post.author.name } : null,
      },
    })
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(PostPayloadSchema)
    const user = await this.auth.userOrFail<UserRecord>()
    const post = await Post.create({ ...data, authorId: user.id })

    return this.redirect(post ? `/posts/${post.id}` : '/posts')
  }
```

- `this.auth.userOrFail()` returns the signed-in user or responds 401 — a second line of defense behind the route middleware.
- `findWithOrFail(id, 'author')` eager-loads the relation in the same call that 404s on missing posts.
- The `show` action builds an explicit payload instead of passing the raw record. This matters: the loaded author row includes `passwordHash`, and everything you pass to `this.inertia()` is serialized into the page. **Pick the fields you send; never forward a whole user record to the browser.**

### Display the author

Update the `Props` and header in `resources/js/pages/posts/Show.tsx`:

```tsx
interface Props {
  post: {
    id: number
    title: string
    body: string
    createdAt: string
    author: { id: number; name: string } | null
  }
}
```

```tsx
      <p className="text-sm text-zinc-500">
        {new Date(post.createdAt).toLocaleDateString()} · {post.author?.name ?? 'Unknown author'}
      </p>
```

The `Props` shape changed, so refresh the manifest: `bun run codegen` (automatic if `bun run dev` is watching).

## 5. Checkpoint: write a post as the demo user

1. Signed out, click **New post** on `/posts` — you are redirected to `/login`.
2. Sign in as **demo@example.com** / **secret**, then create a post.
3. Open the post — the byline shows "Demo User".

## Common problems

**"Invalid credentials." with the demo account.**
The seeder never ran, so the `users` table is empty. Run `bun run db:seed`.

**`add_author_to_posts` migration fails (`NOT NULL constraint` / cannot add column).**
Existing rows in `posts` can't satisfy the new `NOT NULL` column. Run `bun run db:reset --seed` to rebuild the dev database.

**`pages.auth.Login` or `pages.dashboard.Index` missing after `add auth`.**
Codegen hasn't seen the new pages. Run `bun run codegen` or restart `bun run dev`.

**Every visit to `/posts/create` bounces to `/login`, even after signing in.**
Check that `src/app.ts` gained `auth: {}` in `createApp()` and `AuthProvider` in `providers` — `add auth` patches this automatically, but verify if you had customized the file.

**TypeScript says `authorId` is missing when calling `Post.create`.**
You updated the schema but not the model: add `authorId` to `fillable` and re-check the `store` action passes it.

## Next

Posts have authors — now let readers talk back. Continue with [Part 3: Relationships: Comments](./relationships.md).
