# Chapter 15: Prototype First

Fourteen chapters built the blog backend first: a table, a model, a controller, and only then the page. That order is right when you know what to build. Most features start before anyone knows, and a specification written as a document gets argued about while one a customer can click gets corrected. This chapter builds the next feature the other way round: the screens first, on seed data, hosted as static files with no server behind them, then the backend from the same code once the customer has said yes.

The feature is site announcements: a pinned notice the author can post, edit and take down. You will ship a clickable prototype of it, put the backend behind it, and watch the pages you demonstrated become the pages you ship, unchanged.

**What you'll learn:**

- What `guren add prototype` wires, and why none of it reaches a production bundle
- How a fixture answers every Inertia visit in the browser, typed against the same page `Props` as a controller
- What `bun run build:prototype` produces, and what any static host needs from it
- How the same fixture keeps `bun run dev` rendering while routes are still on the `prototype` handler
- What promotion is, and which files it leaves alone

## 1. Install prototype mode

```bash run
bunx guren add prototype
```

It writes one file and patches three:

```bash run
git status --short
```

- `resources/js/prototype/index.ts` is the **fixture**: a `definePrototype({ … })` call with empty `state` and `routes`, plus a `paginate()` helper shaped like the props an index page takes.
- `resources/js/app.tsx` now passes `prototype` to `startInertiaClient()`, guarded by `import.meta.env.GUREN_PROTOTYPE`. Vite defines that as the literal `true` under `--mode prototype` and the literal `false` everywhere else, so the branch and the fixture import are dead code in `bun run build`.
- `src/app.ts` now passes `prototype: () => import('../resources/js/prototype/index.js')` to `createApp()`. The server loads it only when a route asks for it.
- `package.json` gained `dev:prototype` and `build:prototype`, and `resources/js/vite-env.d.ts` declares the env variable.

Nothing else changed, and the app you had still builds, tests and runs exactly as it did.

## 2. Generate the screens

```bash run
bunx guren make:feature Announcement --fields "title:string,body:text,pinned:boolean" --prototype
```

`--prototype` writes the half of a feature the customer can see and nothing else: four page components under `resources/js/pages/announcements/`, the validator, a `resources/js/types/Announcement.ts` exporting the `AnnouncementData` the pages render, and seven entries appended to the fixture, one per route the feature will have. No model, no migration, no Resource, no controller. It prints the routes to register, which you will write by hand in a moment.

Regenerate the manifests so the fixture's `pages.announcements.*` and route names exist:

```bash run
bunx guren codegen
```

## 3. Register the routes

The fixture is keyed by route name, so the routes have to exist before anything can answer them. Register them on the `prototype` handler instead of a controller. Announcements are for readers, so the list and the page are public; everything that changes one sits with the other author-only routes in the `auth` group.

```ts file=routes/web.ts
import { Router, prototype, registerAttachmentRoutes, requireAuthenticated, requireGuest } from '@guren/core'
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
import { AnnouncementIdParamSchema, AnnouncementPayloadSchema } from '../app/Http/Validators/AnnouncementValidator.js'
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

    // Announcements, still on the prototype fixture: no controller exists yet.
    auth.get('/announcements/create', prototype).name('announcements.create')
    auth.get('/announcements/:id/edit', { name: 'announcements.edit', params: AnnouncementIdParamSchema }, prototype)
    auth.post('/announcements', { name: 'announcements.store', body: AnnouncementPayloadSchema }, prototype)
    auth.put('/announcements/:id', { name: 'announcements.update', params: AnnouncementIdParamSchema, body: AnnouncementPayloadSchema }, prototype)
    auth.delete('/announcements/:id', { name: 'announcements.destroy', params: AnnouncementIdParamSchema }, prototype)
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
  router.get('/announcements', prototype).name('announcements.index')
  router.get('/announcements/:id', { name: 'announcements.show', params: AnnouncementIdParamSchema }, prototype)

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

Two things are worth reading twice. `prototype` goes where a controller tuple would, in both route shapes, with or without contract options. And the contracts are real: `params: AnnouncementIdParamSchema` on `/announcements/:id` means `/announcements/abc` is a 422 on the server before the fixture is asked, exactly as it will be when a controller is there. The fixture inherits the route's contract; it does not replace it.

```bash run
bunx guren codegen
```

## 4. Make the demo real

`make:feature --prototype` seeded the fixture with `Sample title 1`. A customer reads seed data as the product, so this is the one part of the prototype worth writing by hand: what the screens say. The rest of the file is what the generator wrote, and the shape of each entry is the thing to learn here, because it is the shape of the controller you will write later, minus the database.

```ts file=resources/js/prototype/index.ts
/**
 * The prototype fixture (RFC 0021). Under `vite --mode prototype` it answers
 * every Inertia visit in the browser, so `dist/prototype/` runs on a static
 * host with no server; on the server, routes registered with the `prototype`
 * handler answer from it until a controller replaces them. Each entry is keyed
 * by route name, typed from the route manifest and the page's Props, so a
 * renamed route or a changed Props interface fails the typecheck here.
 * `bunx guren make:feature <Entity> --prototype` appends entries.
 */
import { apiRoutes, definePrototype } from '@guren/inertia-client/prototype'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import { routeManifest } from '@/.guren/routes.gen'
import type { AnnouncementData } from '@/resources/js/types/Announcement'
import { pages } from '@/.guren/pages.gen'

const PER_PAGE = 10

/** The `PaginatedPageProps` shape an index page expects, over an in-memory list. */
export function paginate<T>(items: T[], pageNumber: number, path: string) {
  const total = items.length
  const lastPage = Math.max(1, Math.ceil(total / PER_PAGE))
  const currentPage = Math.min(Math.max(1, pageNumber || 1), lastPage)
  const start = (currentPage - 1) * PER_PAGE
  const urlFor = (n: number) => (n === 1 ? path : `${path}?page=${n}`)

  return {
    data: items.slice(start, start + PER_PAGE),
    pagination: {
      meta: {
        currentPage,
        lastPage,
        perPage: PER_PAGE,
        total,
        from: total === 0 ? null : start + 1,
        to: total === 0 ? null : Math.min(start + PER_PAGE, total),
      },
      links: {
        first: urlFor(1),
        last: urlFor(lastPage),
        prev: currentPage > 1 ? urlFor(currentPage - 1) : null,
        next: currentPage < lastPage ? urlFor(currentPage + 1) : null,
        pages: Array.from({ length: lastPage }, (_, index) => ({
          page: index + 1,
          url: urlFor(index + 1),
          active: index + 1 === currentPage,
        })),
      },
    },
  }
}

export default definePrototype({
  manifest: routeManifest,
  api: apiRoutes<ApiRoutes>(),

  // Props every page carries under its own. The demo author keeps guarded
  // screens reachable in the walkthrough; set `user: null` to walk it as a guest.
  shared: {
    auth: { user: { id: 1, name: 'Ada', email: 'ada@example.com' } },
  },

  // Seed data, persisted in the tab's sessionStorage; `?prototype.reset=1` on
  // any URL starts over. `make:feature --prototype` adds a collection per entity.
  state: () => ({
    announcements: [
      {
        id: 1,
        title: 'Comments are open',
        body: 'Sign in to leave a comment on any published post. Authors get an email when you do.',
        pinned: true,
      },
      {
        id: 2,
        title: 'Maintenance on Sunday',
        body: 'The blog will be read-only from 02:00 to 02:30 UTC while the database moves.',
        pinned: false,
      },
      {
        id: 3,
        title: 'New: cover images',
        body: 'Posts can carry a cover image and a gallery. Open any post you own and look for the upload field.',
        pinned: false,
      },
    ] as AnnouncementData[],
    nextAnnouncementId: 4,
  }),

  // One entry per route name: `({ state, params, query, body, page, redirect,
  // errors, notFound }) => ...`. A named GET route with no entry opens the
  // 404 dialog in the prototype; `bunx guren check --prototype` lists them.
  routes: {
    // Announcement: generated by make:feature --prototype
    'announcements.index': ({ state, query, page }) =>
      page(pages.announcements.Index, paginate(state.announcements, Number(query.page ?? 1), '/announcements')),
    'announcements.create': ({ page }) => page(pages.announcements.New, {}),
    'announcements.show': ({ state, params, page, notFound }) => {
      const announcement = state.announcements.find((item) => item.id === Number(params.id))
      return announcement ? page(pages.announcements.Show, { announcement }) : notFound()
    },
    'announcements.edit': ({ state, params, page, notFound }) => {
      const announcement = state.announcements.find((item) => item.id === Number(params.id))
      return announcement ? page(pages.announcements.Edit, { announcement }) : notFound()
    },
    'announcements.store': ({ state, body, redirect }) => {
      const announcement: AnnouncementData = { id: state.nextAnnouncementId++, title: body.title, body: body.body, pinned: body.pinned }
      state.announcements.unshift(announcement)
      return redirect('announcements.show', { id: announcement.id })
    },
    'announcements.update': ({ state, params, body, redirect, notFound }) => {
      const announcement = state.announcements.find((item) => item.id === Number(params.id))
      if (!announcement) return notFound()
      Object.assign(announcement, { title: body.title, body: body.body, pinned: body.pinned })
      return redirect('announcements.show', { id: announcement.id })
    },
    'announcements.destroy': ({ state, params, redirect }) => {
      state.announcements = state.announcements.filter((item) => item.id !== Number(params.id))
      return redirect('announcements.index')
    },
  },
})
```

Read one entry against the controller pattern you know. `'announcements.show'` receives `params` typed from the route's path, `state` typed from the factory above, and returns `page(pages.announcements.Show, { announcement })`, where `announcement` has to satisfy the page's `Props`. A controller's `show()` reads `this.validateParams()`, calls `findOrFail()`, and returns `this.inertia(pages.announcements.Show, { announcement })`, checked against the same `Props`. The two are held to the same contract by the same generated code; only where the data comes from differs. `'announcements.store'` receives `body` typed from the route's `body` schema, the way `this.validateBody()` types it in a controller, and answers with `redirect('announcements.show', …)`, checked against the route manifest the way `this.redirect()` is not.

Everything the fixture is typed against comes from `.guren/`: rename a route, change a page's `Props`, and the fixture fails `bun run typecheck` in the same run as the controller would.

## 5. Check it, build it, walk it

```bash run
bunx guren check --prototype
```

The suite checks the wiring the typechecker cannot: every `prototype` route has a name and a fixture entry, every entry names a route that exists, no two routes share a method and path (the browser matcher could not tell them apart), and `createApp()` carries the loader. It also lists, as an advisory warning, the named GET routes with no entry: `home`, `about`, `posts.index` and the rest are not reachable in this prototype. That is the right call for a prototype of one feature; a link from the announcements page to one of them would open the 404 dialog, and the warning is the list of what to add if you wanted the whole blog walkable.

The server side answers from the same fixture. Your existing tests still pass, with seven routes on their fixture and no controller behind them:

```bash run
bun test
```

Now build the artefact the customer gets:

```bash run
bun run build:prototype
```

```bash run
ls dist/prototype
```

`index.html` is the shell, with `<meta name="robots" content="noindex, nofollow">` because a prototype is not meant to be found. `404.html` is a copy of it for hosts that serve that file on unknown paths (GitHub Pages), and `_redirects` says `/* /index.html 200` for hosts that read it (Cloudflare Pages, Netlify). The hashed bundle sits beside them, fixture included, and everything under `public/` is copied in, except `public/assets/`, which is the ordinary build's own output. Upload the directory to any static host, tell it to answer unknown paths with `index.html`, and send the link. There is no server, no database, and nothing to keep running. The [Prototype First guide](../guides/prototype-first.md#ship-it) has the per-host matrix and the subpath note for a project page under `/repo/`.

To walk it yourself before you send it:

```bash manual
bun run dev:prototype
```

That is Vite alone; stop `bun run dev` if it is running, or give Vite another port. Open `/announcements`, post one, edit it, delete it, reload. The state lives in the tab's `sessionStorage`, so a reload keeps what you did and a new tab starts from the seed. Open any URL with `?prototype.reset=1` to start over; a demo you cannot reset in front of a customer is a demo you cannot repeat.

Two things a walkthrough will run into, and neither is a bug. The **login page renders but the form goes nowhere**: only Inertia visits reach the fixture, and a native form post, a plain `<a href>` or `window.location` hits the static host's fallback instead. And the **guarded screens open without signing in**: no middleware runs in the browser, and the fixture's `shared.auth` says Ada is signed in. Set `user: null` there to walk the prototype as a guest.

The backlog is visible from the CLI too. `guren context` lists the routes still on their fixture, which is what an agent asked to "implement the next screen" should read:

```bash run
bunx guren context | grep -A 8 'Prototype backlog'
```

```bash run
git add -A
git commit -m "feat: prototype the announcements feature"
```

`dist/` is ignored, so the commit is the fixture, the pages, the validator, the type, the routes and the wiring. That is the whole prototype, and it is the start of the feature, not a throwaway.

## 6. Specify the backend

The customer has clicked through it and said yes. Now the backend, and the test that says what "done" means comes first. The one assertion that matters is the one the prototype cannot pass: the list must come from the database.

```ts file=tests/AnnouncementController.test.ts
import { beforeAll, beforeEach, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { User } from '../app/Models/User.js'

describe('AnnouncementController', () => {
  let http: TestApp
  let asAda: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    const ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    asAda = await http.actingAs(ada).withCsrf()
  })

  it('lists announcements from the database, not the fixture', async () => {
    await http
      .withHeader('X-Inertia', 'true')
      .get('/announcements')
      .assertInertia('announcements/Index', { data: [] })
  })

  it('rejects an empty title before anything is stored', async () => {
    await asAda
      .post('/announcements', { title: '', body: 'Sunday 02:00 UTC', pinned: false })
      .assertStatus(422)
  })

  it('stores an announcement for a signed-in author and shows it', async () => {
    await asAda
      .post('/announcements', { title: 'Maintenance on Sunday', body: 'Sunday 02:00 UTC', pinned: true })
      .assertRedirect()

    const response = await http.withHeader('X-Inertia', 'true').get('/announcements').assertOk()
    await response.assertBodyContains('Maintenance on Sunday')
  })

  it('sends a guest to the login page instead of the form', async () => {
    await http.get('/announcements/create').assertRedirect('/login')
  })
})
```

```bash run expect-fail
bun test tests/AnnouncementController.test.ts
```

One red, three green, and the greens are the interesting part. The 422 is green because the route contract is enforced before the fixture runs, on the server as in the controller to come. The store-then-list is green because the fixture answers both, from the state object the server keeps for the process. The guest redirect is green because the route's middleware runs regardless of what answers behind it. Only the empty list is red: the fixture has three announcements and the database has none. That test is the line between a prototype and a feature.

## 7. Delegate the promotion

Hand the backend to the agent:

> Promote the announcements feature from its prototype to a real backend. Add an `announcements` table to `db/schema.ts` (title, body, `pinned` as a boolean defaulting to false, `createdAt`), generate and run the migration with `bun run db:make create_announcements` and `bun run db:migrate`, then run `bunx guren make:feature Announcement --fields "title:string,body:text,pinned:boolean"` to write the model, Resource and controller. Replace each `prototype` handler for the `announcements.*` routes in `routes/web.ts` with the matching `[AnnouncementController, 'action']`, keeping the public/auth split as it is. Do not modify the page components, the validator or `resources/js/prototype/index.ts`. Regenerate the spec views with `bunx guren spec:generate`. `tests/AnnouncementController.test.ts` must pass.

The rubric:

- **`db/schema.ts`** gained an `announcements` table with the four columns and nothing else changed. A migration under `db/migrations/` was generated and applied.
- **`app/Models/Announcement.ts`**, **`app/Http/Resources/AnnouncementResource.ts`** and **`app/Http/Controllers/AnnouncementController.ts`** exist. The Resource's `toArray()` returns `AnnouncementData`, the type the pages were built against, so the shape the customer saw is now the serializer's contract.
- **`routes/web.ts`** has no `prototype` handler left for `announcements.*`, `index` and `show` are still public, the rest still in the `auth` group, and the `params` and `body` schemas are unchanged.
- **`resources/js/pages/announcements/`**, **`app/Http/Validators/AnnouncementValidator.ts`** and **`resources/js/prototype/index.ts`** are untouched. `git diff --stat` is the check; the pages are the point of the exercise, and the fixture keeps serving `build:prototype`.
- **`docs/spec/`** was regenerated, so `check --spec` is green.
- **`bunx guren check --prototype`** no longer lists any route on its fixture.

The fallback, when you are working without an agent. First the table:

```ts file=db/schema.ts fallback
import { index, integer, primaryKey, sqliteTable, text } from '@guren/orm/drizzle/sqlite'
import type { AttachmentVariantRecord } from '@guren/core'

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

export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  attachableType: text('attachable_type').notNull(),
  attachableId: text('attachable_id').notNull(),
  collection: text('collection').notNull().default('default'),
  disk: text('disk').notNull(),
  path: text('path').notNull(),
  name: text('name').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  width: integer('width'),
  height: integer('height'),
  variants: text('variants', { mode: 'json' }).$type<Record<string, AttachmentVariantRecord>>(),
  placeholder: text('placeholder'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => [index('attachments_attachable_idx').on(t.attachableType, t.attachableId, t.collection)])

/**
 * Column property names are the store's contract: `id`, `data`, `expiresAt`.
 * `mode: 'json'` matches DatabaseSessionStore's default, which hands the object
 * to the column rather than serializing it first.
 */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
})

export const announcements = sqliteTable('announcements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

```bash run fallback
bun run db:make create_announcements
```

```bash run fallback
bun run db:migrate
```

Then the same command as section 2, without the flag. In an app whose `announcements.*` routes are on the `prototype` handler, it knows it is promoting: it writes the model, the Resource and the controller, leaves the pages and the validator it finds in place, and prints the handler replacements.

```bash run fallback
bunx guren make:feature Announcement --fields "title:string,body:text,pinned:boolean"
```

Apply the replacements. The file is the one from section 3 with `prototype` swapped for the controller on the seven routes, and the controller imported:

```ts file=routes/web.ts fallback
import { Router, registerAttachmentRoutes, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import CommentController from '../app/Http/Controllers/CommentController.js'
import LinkController from '../app/Http/Controllers/LinkController.js'
import AnnouncementController from '../app/Http/Controllers/AnnouncementController.js'
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
import { AnnouncementIdParamSchema, AnnouncementPayloadSchema } from '../app/Http/Validators/AnnouncementValidator.js'
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
    auth.get('/announcements/create', [AnnouncementController, 'create']).name('announcements.create')
    auth.get('/announcements/:id/edit', { name: 'announcements.edit', params: AnnouncementIdParamSchema }, [AnnouncementController, 'edit'])
    auth.post('/announcements', { name: 'announcements.store', body: AnnouncementPayloadSchema }, [AnnouncementController, 'store'])
    auth.put('/announcements/:id', { name: 'announcements.update', params: AnnouncementIdParamSchema, body: AnnouncementPayloadSchema }, [AnnouncementController, 'update'])
    auth.delete('/announcements/:id', { name: 'announcements.destroy', params: AnnouncementIdParamSchema }, [AnnouncementController, 'destroy'])
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
  router.get('/announcements', [AnnouncementController, 'index']).name('announcements.index')
  router.get('/announcements/:id', { name: 'announcements.show', params: AnnouncementIdParamSchema }, [AnnouncementController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

```bash run fallback
bunx guren codegen
```

The schema changed, so the ER view under `docs/spec/` is stale, and chapter 13 made that a gate:

```bash run fallback
bunx guren spec:generate
```

## 8. Verify

```bash run
bun test tests/AnnouncementController.test.ts
```

Four green. The one that was red now reads an empty table; the three that were already green did not change, because the contract, the middleware and the redirect were never the fixture's to begin with.

```bash run
bunx guren check --prototype
```

No route is on its fixture, so the backlog is empty; `guren context` no longer prints one:

```bash run expect-fail
bunx guren context | grep 'Prototype backlog'
```

`git diff --stat` for the rubric's fourth point, then the gate:

```bash run
git diff --stat -- resources/js/pages app/Http/Validators/AnnouncementValidator.ts resources/js/prototype
```

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: announcements backed by the database"
```

The fixture is still there, and `bun run build:prototype` still works: the customer's link keeps rendering the same screens, now the same screens the server renders. When the next feature comes, it starts in that file. When the fixture has no further use, `bunx guren add prototype --remove` unwires the two loaders and leaves the file for you to delete.

## Where you are

- You have shipped a feature as static files before its backend existed, and walked it with no server running.
- You know what a fixture entry is: a controller action minus the database, typed against the same route manifest and page `Props`.
- You have seen the server answer from the same fixture, with the route's contract and middleware in front of it, and a production boot refuse to.
- You have promoted a prototype to a backend and watched the pages, the validator and the fixture stay untouched, because promotion changes where the data comes from and nothing the customer saw.

## Common trip-ups

- **`pages.announcements.Index` does not exist in the fixture.** Codegen has not run since `make:feature --prototype` wrote the pages. `bunx guren codegen`, which `build:prototype` also runs first.
- **The boot fails naming a route with no fixture entry.** A route is on the `prototype` handler and the fixture has no key for its name. Add the entry, or give the route a controller; `check --prototype` reports the same thing without booting.
- **A link in the prototype opens Inertia's error dialog.** The target is a named GET route with no fixture entry, which `check --prototype` listed as not reachable. Add an entry, or give `definePrototype()` a `notFoundPage` for a designed 404.
- **The customer's edits are gone after a reload.** They opened a new tab, or the host answered a full page load and the state was `persist: false`. The default `'session'` survives a reload in the same tab; `'local'` survives across tabs.
- **`bun run preview` refuses to start.** A route is still on the `prototype` handler and `NODE_ENV=production` refuses the process-shared state. Promote it, or ship `dist/prototype/` instead of the server. `bunx guren doctor` names the routes.
- **`check --spec` is red after promotion.** The schema gained a table and the ER view was not regenerated. `bunx guren spec:generate`.

## Exercises

1. The fixture's `shared.auth.user` is Ada. On a branch, set it to `null`, run `bun run dev:prototype`, and open `/announcements/create`. It renders. Say why the server would not have, and where in the fixture a guest check would have to go to make the prototype honest about it.
2. On a branch, add a `notFoundPage` to `definePrototype()` pointing at a page of your own, and open `/announcements/99` in the prototype. Then remove the page component and run `bun run typecheck`. What caught it, and would the same mistake in a controller have been caught in the same place?

## The end, again

That was the course's last feature, built the other way round: a link the customer could click on Monday, a backend behind it on Wednesday, and nothing the customer saw rewritten in between. The [Prototype First guide](../guides/prototype-first.md) has the parts this chapter left out: the per-host settings, subpath builds, the shell override for a favicon, and the full list of what the browser runtime does not reproduce.
