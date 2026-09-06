# Chapter 14: Production

Thirteen chapters, and the blog has never left your machine. This one takes it the rest of the way: a session store that survives a restart, a limit on how fast a stranger can guess a password, the production switches you get for free, and an honest list of what is still not ready.

There is no slice to hand an agent here. What is left is judgment about your own app, and judgment is the part of this job that does not delegate.

**What you'll learn:**

- Which of your app's stores live in memory, and which one of them is a bug
- Where rate limiting goes, and the mistake that makes two limiters share one budget
- What `NODE_ENV=production` changes for you, and what it leaves to you
- What the CI file you were given in chapter 1 has been running all along
- The checklist for this app, including the parts this chapter cannot fix

## 1. The two stores that live in this process

Sign in, restart the dev server, reload: you are signed out. Sessions have been in a `Map` since chapter 5. That is fine for one developer and wrong for anything else, because it makes every deploy a mass sign-out and every second container a coin flip.

The database already outlives the process, so put them there. Sessions need a table, and the column names are the store's contract:

```ts file=db/schema.ts
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
```

```bash run
bun run db:make create_sessions
```

```bash run
bun run db:migrate
```

A new table means the ER view is stale, and chapter 13's gate is about to say so. Regenerate with the change, not after someone notices:

```bash run
bunx guren spec:generate
```

Now the wiring, and one more thing while you are in this file. An app that accepts passwords should not let anyone try them a thousand times a minute:

```ts file=src/app.ts
// Every zod schema built after this import parses through a compiled fast
// path. Keep it the first import so it runs before any module that defines
// schemas. It honors z.config({ jitless: true }) for CSP-restricted runtimes
// and never throws — unsupported schemas keep the regular parser. One caveat:
// on invalid input, refinements/transforms can run twice (fast path, then
// fallback), so keep .refine()/.transform() free of side effects.
import 'zod/compile'
import { createApp } from '@guren/core'
import { DatabaseSessionStore, createRateLimitMiddleware, setInertiaDocument } from '@guren/core'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import AuthProvider from '../app/Providers/AuthProvider.js'
import { registerWebRoutes } from '../routes/web.js'
import { sessions } from '../db/schema.js'
import { StorageServiceProvider as CoreStorageServiceProvider } from '@guren/core'
import StorageProvider from '../app/Providers/StorageProvider.js'
import AttachmentsProvider from '../app/Providers/AttachmentsProvider.js'
import { EventServiceProvider as CoreEventServiceProvider } from '@guren/core'
import EventProvider from '../app/Providers/EventProvider.js'
import { QueueServiceProvider as CoreQueueServiceProvider } from '@guren/core'
import QueueProvider from '../app/Providers/QueueProvider.js'
import { MailServiceProvider as CoreMailServiceProvider } from '@guren/core'
import MailProvider from '../app/Providers/MailProvider.js'

// Rendered into every server-rendered document. Replace public/favicon.svg
// with your own artwork, or add more tags here (Open Graph, apple-touch-icon).
setInertiaDocument({
  head: '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
})

// The Host header is client-controlled, so production should answer only to the
// host this app is deployed as, which APP_URL carries.
//
// Read at module scope, where not every platform has populated process.env yet
// (the Cloudflare worker imports this module before wrangler `vars` land). A
// missing value therefore warns and leaves the check off, rather than throwing
// and stopping the app from booting at all. Emailed links do not depend on this
// — app/Auth/AppUrl.ts resolves those per request and fails closed there.
function hostAuthorization() {
  const exclude = ['/health']

  if (process.env.NODE_ENV !== 'production') {
    return { allowedHosts: ['localhost:*', '127.0.0.1:*'], exclude }
  }

  const appUrl = process.env.APP_URL?.trim()
  if (!appUrl) {
    console.warn('[app] APP_URL is not set — host authorization is disabled. Set it to the public base URL of this app.')
    return false
  }

  // `hostname:*` rather than the bare host: the hostname is the security
  // boundary, and a proxy may or may not include the default port in `Host`.
  return { allowedHosts: [`${new URL(appUrl).hostname}:*`], exclude }
}

const app = createApp({
  routes: registerWebRoutes,
  providers: [DatabaseProvider, AuthProvider, CoreStorageServiceProvider, StorageProvider, AttachmentsProvider, CoreEventServiceProvider, EventProvider, CoreQueueServiceProvider, QueueProvider, CoreMailServiceProvider, MailProvider],
  auth: {
    sessionOptions: {
      // Sessions in the database, not in this process: a restart, a second
      // container, or a deploy would otherwise sign everybody out.
      store: new DatabaseSessionStore(sessions),
    },
  },
  // Translations live in lang/<locale>/*.json. Add locales to `supported`
  // and the request locale is detected from ?locale=, a locale cookie, or
  // Accept-Language. `guren codegen` types the keys for t()/useTranslation().
  i18n: { supported: ['en'] },
  hostAuthorization: hostAuthorization(),
})

// One shared counter per prefix, so the two limiters cannot spend each other's
// budget: the default store is a single module-level map keyed by prefix.
app.use('*', createRateLimitMiddleware({
  limit: 300,
  windowMs: 60_000,
  keyPrefix: 'rl:web:',
  trustProxy: process.env.NODE_ENV === 'production',
  skip: (ctx) => ctx.req.path === '/health',
}))

app.use('/login', createRateLimitMiddleware({
  limit: 5,
  windowMs: 15 * 60_000,
  keyPrefix: 'rl:login:',
  trustProxy: process.env.NODE_ENV === 'production',
  message: 'Too many sign-in attempts. Try again in a few minutes.',
}))

export default app
```

Both changes are about memory, and they are not the same kind of change.

The session store had to move. A session in memory is a session that a restart destroys, and a session two processes cannot agree on.

The rate limiter's store did not. `createRateLimitMiddleware` defaults to an in-memory counter, which is a per-process budget: correct for one container, and wrong the moment you run two, because each one grants the full allowance. The Redis store swaps in for that case and nothing else changes. What does matter here even on one process is `keyPrefix`: the default store is a single map shared by every limiter, so two limiters without distinct prefixes spend each other's budget, and five requests to the blog would lock the sign-in page.

`trustProxy` is the other line worth reading twice. Off, the limiter keys on the socket's address, which is your load balancer's if you have one, so every visitor shares a bucket. On, it reads `X-Forwarded-For` and friends, which any client can send, so it is only safe behind a proxy that overwrites them. There is no setting that is right in both places, which is why it is a decision and not a default.

```bash run
bun test
```

Green, and the sessions the tests create now go through the table.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: database sessions and rate limiting"
```

## 2. Production mode

Build the client assets, then run the app the way a server would:

```bash run
bun run build
```

```bash run background
bun run preview
```

`preview` is `NODE_ENV=production bun bin/serve.ts`, and that one variable changes six things you would otherwise have to remember:

- **Session and CSRF cookies get `Secure`**, so they travel only over HTTPS.
- **HSTS** is sent for a year.
- **Stack traces stop**. An unhandled error becomes a plain 500 instead of the debug page you have been reading since chapter 2.
- **The development endpoints refuse to mount**: the MCP endpoint your editor talks to and the docs viewer are both gated on `NODE_ENV !== 'production'` *and* their own env flag. Neither can be turned on in production by setting a variable.
- **Assets come from `public/assets/`** with the manifest the build wrote, not from Vite.
- **The port does not walk.** In development a busy port makes the server try the next one; in production it fails instead, because a server that silently moves is a server your load balancer cannot find.

One more thing it changes, which will surprise you: the banner is gone. A production start prints nothing at all. Ask the app instead:

```bash manual
curl -s localhost:3333/health
{"status":"ok"}
```

That route has been in `routes/web.ts` since chapter 1, and the `fly.toml` you are about to generate points its health check at it. It is also the one path `hostAuthorization()` excludes, which matters more than it looks: in production the app answers only to the host `APP_URL` names, and a load balancer probing by IP is not that host. Health checks have to reach a server that is refusing everyone else.

**Checkpoint:** open the blog on `localhost:3333`, sign in, and restart the server. You are still signed in, because the session is a row now.

## 3. The CI you already had

Chapter 1 scaffolded a workflow file and you have not looked at it since. Read it now:

```bash run
cat .github/workflows/ci.yml
```

One job, one command: `bunx guren gate --deps`. That is the same gate you have run at the end of every chapter, plus `--deps`, which adds a dependency vulnerability scan against the registry. There is nothing else to configure, and nothing in it that you have not been running locally for thirteen chapters.

That is the whole point of the ritual. The command that tells you a chapter is finished is the command that decides whether a pull request is mergeable, so the two can never disagree about what "done" means.

Push the branch and watch it run. If it is red on `--deps` and green locally, a dependency has a published advisory: read what `bun audit` names, and upgrade it rather than dropping the flag.

## 4. The honest checklist

Everything below is true of the app you have right now. Some rows are already done, some are one line, and some need an account somewhere.

| Thing | Where it stands | What production wants |
|---|---|---|
| Sessions | in the database, from section 1 | done |
| Rate limiting | in-memory, per process | fine for one container; `RedisRateLimitStore` for several |
| Cookies, HSTS, error pages | automatic under `NODE_ENV=production` | done |
| `APP_KEY` | in `.env`, which is not committed | set it as a platform secret, or the container starts without one |
| `APP_URL` | unset | set it, or host authorization stays off and warns |
| Uploads | on the `local` disk, inside the container | an S3 or R2 disk, or every deploy loses them |
| Queue | `sync`: jobs run inside the request | a Redis or SQS driver plus `guren queue:work` as a second process |
| Mail | `log`: printed to the server output | a real transport and its credentials |
| Database | SQLite, in a file | fine for one machine; Postgres to run more than one |
| Agent tools | reachable only in tests | the MCP plugin and a token store, from chapter 12 |

Two of those rows deserve a warning rather than a row.

**The Dockerfile does not copy `storage/`.** Chapter 1 generated it before the app had uploads, and it lists the directories it knows about. A container built from it starts with an empty attachments disk, so every deploy silently loses every cover image. Either add `storage` to the copied directories and mount a volume over it, or move the disk to object storage, which is the answer this chapter would give you.

**`guren doctor` will not warn you about any of this.** Its production-store check only runs when it detects a serverless deploy plugin, so on a Docker or Fly deployment it reports a pass while your sessions are in memory. That check is not lying; it is answering a narrower question than the one you are asking.

The deploy recipes for the other two targets, so you can read what they assume:

```bash run
bunx guren deploy --target all --app my-blog --force
```

`fly.toml` and `railway.json` join the `Dockerfile` from chapter 1. `--force` is there because that file already exists; without it the command stops rather than overwrite something you may have edited. Nothing here talks to a platform: these are files, and `fly deploy` or `railway up` is the step that needs an account.

```bash manual
docker build -t my-blog .
docker run --rm -p 3333:3333 -e APP_KEY="$APP_KEY" -e APP_URL=http://localhost:3333 my-blog
```

## 5. Keeping the harness current

The framework moves, and so does the harness it installed in chapter 1. After an upgrade, ask what would change before it changes:

```bash run
bunx guren agent:sync --dry-run
```

It reports what it would write, what it would replace, and what in the managed directories is no longer part of the harness. Files you wrote yourself are never touched: the rules and skills you authored in chapter 8 are yours, and sync only owns what it shipped.

The upgrade itself needs the registry, so it is not part of this chapter's script:

```bash manual
bunx guren upgrade --install
bunx guren agent:sync
bunx guren codegen --force
bun run typecheck
bunx guren gate
```

`upgrade` aligns every `@guren/*` version and the Drizzle pins that must match the ORM's, applies the codemods for the release, and prints the three commands above as its own next steps. Run the gate after, not before.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "chore: deploy recipes for fly and railway"
```

## Where you are

You have a blog with users, posts, comments, tags, uploads, mail, agent tools and documentation that cannot drift, running in production mode against a database that outlives it, behind a gate that runs the same six stages locally and in CI.

More than that, you have a way of working. Every chapter here was the same four steps: build the new idea by hand until you understand it, write the failing test that says what comes next, hand that slice to an agent with a rubric and a deterministic fallback, and let `guren gate` decide whether it worked. The framework's part of that is the gate and the harness. Your part is the first two steps, and they are the ones that do not get easier when the typing gets faster.

## Common trip-ups

- **Everyone is signed out after a deploy.** The session store is still in memory, or the new container has a different `APP_KEY`. Both are in section 1 and section 4.
- **The rate limiter blocks the wrong thing.** Two limiters are sharing a counter: give each a distinct `keyPrefix`.
- **Every visitor shares one rate-limit bucket.** The key is the socket address and there is a proxy in front. Set `trustProxy`, but only if the proxy overwrites the client headers.
- **`bun run preview` prints nothing.** That is correct. The banner is a development thing; ask `/health` whether it is up.
- **`bun run preview` fails on a busy port.** Production does not walk to the next one. Free the port, or set `PORT`.
- **Assets 404 in preview.** `bun run build` has not run since the last change; the manifest is missing or stale.
- **CI is red on `--deps` only.** A dependency has an advisory. Upgrade it; do not drop the flag.

## The end

That is the course. The app is yours now, and so is the harness that helped build it: the rules, the skills, the subagent brief, the checks, and the gate. Add the next feature the way you added the last one, and if you get it wrong, the tests will say so before anyone else does.
