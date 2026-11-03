# Models

A model wraps one table from `db/schema.ts`. It queries the table, creates and updates rows, and decides how a record is cast, serialized and paginated. The connection and the schema are set up in [Database](./database.md), and relations between models are declared as described in [Relationships](./relationships.md).

## Defining Models

Use `defineModel()` to derive a typed model directly from a Drizzle table:

```ts
// app/Models/Post.ts
import { defineModel } from '@guren/core'
import { posts } from '@/db/schema'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends defineModel(posts) {}
```

That is all you need. `Post` now has `find`, `create`, `where`, `paginate`, and dozens more methods.

### Reshaping the create payload

The type `defineModel()` infers for `create()` requires every column without a database default. When the model derives a column itself, say so in the same call rather than hand-writing a type:

```ts
export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],  // derived from `password`, so callers need not pass it
  requireOnCreate: ['password'],     // demand the virtual field instead
}) {}
```

`optionalOnCreate` makes columns optional: they keep their type, callers just need not supply them. `requireOnCreate` goes the other way, and accepts both table columns (Drizzle marks defaulted ones optional) and fields contributed by `base`. Both are type-level only and are checked against the real keys, so a typo fails to compile.

Neither closes the payload: a create type always admits unknown keys as `unknown`, so `fillable` remains what rejects an unwanted field at runtime.

## Querying Data

Start simple, then build up:

```ts
// Fetch everything
const allPosts = await Post.all()

// Find by primary key
const post = await Post.find(1)          // returns null if missing
const post = await Post.findOrFail(1)    // throws ModelNotFoundException (404) if missing

// First matching record
const latest = await Post.first()
```

### Fluent QueryBuilder

Chain conditions, ordering, and limits for more complex queries:

```ts
const published = await Post.where('status', 'published').get()

const trending = await Post.where('status', 'published')
  .where('views', '>', 100)
  .orWhere('featured', true)
  .orderBy('createdAt', 'desc')
  .limit(10)
  .get()

// Object syntax for simple equality
const drafts = await Post.where({ status: 'draft', authorId: 1 }).get()

// Callback syntax groups conditions in parentheses:
// (title LIKE ? OR excerpt LIKE ?) AND status = 'published'
const hits = await Post.where((q) => {
  q.where('title', 'like', '%bun%').orWhere('excerpt', 'like', '%bun%')
})
  .where('status', 'published')
  .get()
```

> [!TIP]
> The QueryBuilder is thenable -- you can `await` it directly without calling `.get()`. Both `await Post.where({ status: 'draft' })` and `await Post.where({ status: 'draft' }).get()` produce the same result.

| Method | Description |
|--------|-------------|
| `.where(column, value)` | Filter by equality |
| `.where(column, op, value)` | Filter with an operator: `'='`, `'!='`, `'>'`, `'<'`, `'>='`, `'<='`, `'like'`, `'in'`, `'not in'`, `'is null'`, `'is not null'` |
| `.where(object)` | Filter by multiple equalities |
| `.where(callback)` | Parenthesized condition group, AND-ed with the rest |
| `.orWhere(column, value)` | OR condition |
| `.orWhere(column, op, value)` | OR condition with an operator |
| `.orWhere(callback)` | OR a parenthesized condition group |
| `.orderBy(column, direction?)` | Sort results |
| `.limit(n)` / `.offset(n)` | Limit and skip |
| `.get()` | Execute and return array |
| `.first()` | Return first result or null |
| `.count()` | Return count of matching records |
| `.sum(column)` / `.avg(column)` | Sum or average of a column over matching records |
| `.min(column)` / `.max(column)` | Smallest or largest value of a column |
| `.exists()` | Whether any record matches |
| `.toDrizzle(query?)` | A Drizzle select that carries the model's conditions and scopes |

### Aggregates

```ts
const revenue = await Order.where('status', 'paid').sum('total')
const averageViews = await Post.where('status', 'published').avg('views')
const newest = await Post.newQuery().max('createdAt')
const hasDrafts = await Post.where('status', 'draft').exists()
```

Aggregates run through the model's [global scopes](#global-scopes), so a model with [`SoftDeletes`](#soft-deletes) leaves trashed rows out of a sum just as it leaves them out of `get()`.

The result keeps the column's type. An `integer` or `real` column sums to a `number`, a `bigint({ mode: 'bigint' })` column to a `bigint`, and a `numeric` or `decimal` column to a `string`, which is how Drizzle types those columns so that no digit is lost. `avg()` returns a `number` for a `number` column and a decimal string otherwise. When nothing matches, `sum()` returns the zero of that type (`0`, `0n` or `'0'`) and the other three return `null`. Like `count()`, aggregates ignore `limit()` and `offset()`.

A sum of a `number` column past `Number.MAX_SAFE_INTEGER` throws instead of rounding. Declare that column with `mode: 'bigint'`.

### Dropping to Drizzle

`toDrizzle()` hands a query to Drizzle with the model's conditions and global scopes already in its `WHERE` clause. Use it for joins, custom selections, and anything else the builder cannot express:

```ts
import { getDatabase } from '@/config/database'
import { posts, users } from '@/db/schema'
import { desc, eq, gt } from 'drizzle-orm'

const db = await getDatabase()
const rows = await Post.where('status', 'published')
  .toDrizzle(
    db.select({ id: posts.id, title: posts.title, author: users.name })
      .from(posts)
      .leftJoin(users, eq(posts.authorId, users.id)),
  )
  .where(gt(posts.views, 100))
  .orderBy(desc(posts.id))
```

- Without an argument, `toDrizzle()` starts from `select().from(table)` and runs inside the open transaction when there is one. A query you pass runs on the handle you built it from, so inside [`Model.transaction()`](#transactions) build it from `trx`.
- A `.where()` on the result is AND-ed with the model's conditions and cannot drop a scope. To pass a query that already has a `where()`, call `$dynamic()` before it.
- The builder's `orderBy()`, `limit()` and `offset()` carry over. `select()` carries over only without an argument, since a query you pass keeps its own selection.
- Rows come back as Drizzle reads them. Casts, accessors and eager loads do not apply.
- `toSql()` returns the same conditions as one `SQL` fragment for a query you assemble yourself. On a plain Drizzle select a second `.where()` replaces the first, so combine the fragment with `and()`:

```ts
const popular = await db.select().from(posts).where(and(Post.newQuery().toSql(), gt(posts.views, 100)))
```

A query written against `db` alone never goes through the model and applies none of its scopes. `Model.query()` returned exactly that kind of query and is deprecated for this reason (see [Upgrading](./upgrading.md)).

> [!TIP]
> To use Drizzle's relational queries (`db.query.<table>.findMany(...)`), pass a `relations` option built with `defineRelations(schema, ...)` from `drizzle-orm` (RQB v2). The `Model` API in Guren does not require this.

## Creating and Updating

```ts
// Create
const post = await Post.create({
  title: 'Hello World',
  body: 'Welcome to Guren!',
})

// Update
await Post.update({ id: post.id }, { title: 'Updated Title' })

// Delete
await Post.delete({ id: post.id })
```

Bulk `update()`, `forceUpdate()`, and `delete()` reject `limit()`, `offset()`, and `orderBy()`. Select the intended IDs first, then write with `whereIn()`. On a `SoftDeletes` model, builder `delete()` also marks rows deleted; use `forceDelete()` for permanent removal.

### Transactions

Use `Model.transaction()` when multiple writes must succeed or fail together:

```ts
await Post.transaction(async (trx) => {
  const post = await Post.create({
    title: 'Atomic write',
    body: 'Everything in one transaction',
  }, { trx })

  await Post.update({ id: post.id }, { status: 'published' }, { trx })
})
```

If an error is thrown in the callback, Guren rolls back the transaction.

The second argument to the callback is a transaction-bound copy of the model, which passes `{ trx }` for you:

```ts
await Post.transaction(async (_trx, txPost) => {
  const post = await txPost.create({
    title: 'Scoped write',
    body: 'No manual { trx } forwarding',
  })

  await txPost.update({ id: post.id }, { status: 'published' })
})
```

Things to know:

- **A call without `{ trx }` still joins the transaction.** Inside the callback, a model call that leaves the handle off runs on the open transaction instead of going to the pool, where a single-connection pool would make it wait on the transaction that owns the connection.
- **A nested `Model.transaction()` is a savepoint.** Its writes commit or roll back with the outer transaction, and an inner error the outer callback catches discards only the inner writes. Await each nested transaction before starting the next: savepoints on one connection are released in the order they were taken, so two running at once discard each other's frames.
- **On SQLite, transactions run one at a time.** SQLite holds a single connection, so concurrent transactions are queued, each committing or rolling back on its own. Model reads and writes made outside a transaction wait until it settles, and so does awaiting `toDrizzle()` without an argument. Its synchronous `.all()`, `.get()`, `.run()` and `.values()` cannot wait, so they throw while another request holds a transaction open. A Drizzle query you build on `db` yourself does not wait and would run inside that transaction; await the transaction first.

### Mass Assignment Protection

Control which fields can be set through `create()` and `update()`:

```ts
export class Post extends defineModel(posts, {
  // Allowlist — only these fields are assignable.
  // Checked against the table's columns: a typo is a compile error.
  fillable: ['title', 'body', 'status'],
}) {}
```

The same allowlist can be declared as `static fillable = ['title', 'body', 'status']` on the class instead; the option form is preferred because TypeScript verifies every name against the table (a `static` declaration on the subclass shadows the option). When `fillable` is set, passing any field outside the allowlist to `create()` or `update()` throws a `MassAssignmentException` (exported from `@guren/core`). The message names the blocked fields, so a typo or an injection attempt fails loudly at the call site instead of being silently discarded and resurfacing later as a confusing NOT NULL violation:

```ts
await Post.create({ title: 'Hello', body: '...', status: 'draft', authorId: 1 })
// MassAssignmentException: Post: mass assignment blocked for field(s) "authorId"
```

#### Columns the server chooses

Some columns belong in the row but must never come from a request: the post's author, the post a comment belongs to, a default status. Keep them out of `fillable` and pass them in the `set` option, beside the validated data:

```ts
const author = await this.auth.userOrFail<UserRecord>()
const data = await this.validateBody(PostPayloadSchema)

const post = await Post.create(data, { set: { authorId: author.id } })
await Post.update({ id: post.id }, data, { set: { status: 'draft' } })
```

The query builder's bulk update takes the same option: `Post.where('status', 'draft').update(data, { set: { reviewedAt: new Date() } })`.

`data` is still filtered by `fillable`; only the keys in `set` skip it. Because `set` exists to keep the two apart, it throws a `MassAssignmentException` when:

- a `set` key is in `fillable` (a request could already set it, so it belongs in `data`);
- `data` carries a key that `set` also sets;
- a `set` key is `id` or a credential column;
- the model declares no `fillable`.

`{ set: { ...data, authorId } }` usually throws under the first rule, because the spread moves fillable keys into `set`. It does not when the spread carries no fillable key, so do not rely on the throw: never spread request input into `set`. `guren audit` warns on a spread written inside a `set` literal (`set-spread:*`).

#### Force writes

For writes that carry no request data at all (OAuth account linking, seeders, system records), bypass the allowlist with `forceCreate()` / `forceUpdate()`:

```ts
const user = await User.forceCreate({
  name: profile.name,
  email: profile.email,
  passwordHash: `oauth:${provider}:${profile.id}`,
})

await User.forceUpdate({ id: user.id }, { emailVerifiedAt: new Date() })
```

> [!WARNING]
> `forceCreate()` / `forceUpdate()` skip mass-assignment protection entirely. Never pass request input to them, validated or not: to add a server-chosen column to request data, use `set`.

Two protections apply regardless of `fillable`:

- The primary key (`id`) is always silently stripped from mass-assignment input — a form that round-trips it cannot retarget the write.
- On models extending `AuthenticatableModel`, credential columns (the password hash and remember token) always throw. Listing them in `fillable` does not open them; pass a plain `password` and let the model hash it, or use `forceCreate()`/`forceUpdate()` for trusted server-side values.

> [!NOTE]
> If `fillable` is not set, all columns except `id` and the denied credential columns are assignable. Declare it on any model that accepts user input.

## Query Scopes

Scopes encapsulate common filters so you can reuse them by name:

```ts
export class Post extends defineModel(posts) {
  static scopes = {
    published: (q: QueryBuilder<PostRecord>) => q.where('status', 'published'),
    popular: (q: QueryBuilder<PostRecord>) => q.where('views', '>', 1000),
    recent: (q: QueryBuilder<PostRecord>) => q.orderBy('createdAt', 'desc').limit(10),
  }
}
```

Apply them with `.scope()`, chained with each other or with any other condition:

```ts
const trending = await Post.scope('published').scope('popular').get()

const myPopular = await Post.scope('published')
  .where('authorId', currentUser.id)
  .get()
```

## Global Scopes

Global scopes apply automatically to every query on a model. Use them for multi-tenancy, soft deletes, or any filter that should always be active.

```ts
// Always filter by the current tenant
User.addGlobalScope('tenant', (q) => q.where('tenantId', currentTenantId()))

// Always exclude inactive users
User.addGlobalScope('active', (q) => q.where('active', true))
```

Every query entry point applies both scopes automatically: `all()`, `find()`,
`first()`, `where()` and its `whereIn`/`whereNull`/`select` siblings, `scope()`,
`orderBy()`, `paginate()` (the count as well as the rows), `newQuery()`, and the
queries that eager-load a relation, which apply the *related* model's scopes.

Writes honor them too: `update()`, `forceUpdate()`, and `delete()` add the same
scopes to their `where`, so a `tenant` scope stops one tenant from updating or
deleting another tenant's row, not just from reading it.

The only way past them is to ask explicitly, below.

### Bypassing Global Scopes

Remove a specific scope for one query:

```ts
const allUsers = await User.withoutGlobalScope('active').get()
```

Remove all global scopes:

```ts
const everyone = await User.withoutGlobalScopes().get()
```

Remove a scope permanently:

```ts
User.removeGlobalScope('active')
```

> [!TIP]
> The `SoftDeletes` mixin registers a global scope named `'softDelete'`. `withTrashed()` *is* `withoutGlobalScope('softDelete')`: either spelling reaches trashed rows while every other global scope stays applied, so a `tenant` scope keeps isolating them. `withoutGlobalScopes()` is the one that drops those too.

## Model Hooks

Hooks run logic at specific points in a record's lifecycle. Use them for auto-generated slugs, timestamps, audit logs, or cache invalidation:

```ts
import { slugify } from '@/app/utils/string'

export class Post extends defineModel(posts) {
  static hooks = {
    creating: async (data) => {
      data.slug = slugify(data.title)
    },
    updating: async (data) => {
      data.updatedAt = new Date()
    },
    deleted: async (data) => {
      console.log('Post deleted:', data.id)
    },
  }
}
```

| Hook | Timing |
|------|--------|
| `creating` / `created` | Before / after insert |
| `updating` / `updated` | Before / after update |
| `deleting` / `deleted` | Before / after delete |
| `saving` / `saved` | Before / after both insert and update |

## Model Observers

When hook logic grows complex, extract it into a dedicated observer class. Observers respond to the same lifecycle events as hooks but live in their own file.

```ts
// app/Observers/PostObserver.ts
import type { ModelObserver, PlainObject } from '@guren/core'

export class PostObserver implements ModelObserver {
  creating(data: PlainObject) {
    data.slug = slugify(data.title as string)
  }

  async created(data: PlainObject) {
    await notifySubscribers(data)
  }

  async deleting(data: PlainObject) {
    await clearPostCache(data.id)
  }
}
```

Register the observer on the model:

```ts
import { PostObserver } from '@/app/Observers/PostObserver'

Post.observe(PostObserver)
```

Returning `false` from a before-event (`creating`, `updating`, `deleting`, `saving`) aborts the operation, just like inline hooks.

Observers and inline hooks coexist: hooks fire first, then observers.

## Soft Deletes

Instead of permanently removing records, soft deletes set a `deletedAt` timestamp. Users can recover deleted content, and queries automatically exclude trashed records.

```ts
import { SoftDeletes, defineModel } from '@guren/core'
import { posts } from '@/db/schema'

export class Post extends SoftDeletes(defineModel(posts)) {}
```

```ts
await Post.delete({ id: 1 })                // Sets deletedAt on a live row (the row remains)
const active = await Post.all()              // Excludes soft-deleted
const all = await Post.withTrashed().get()   // Includes soft-deleted
const trashed = await Post.onlyTrashed().get()
await Post.restore({ id: 1 })               // Clears deletedAt
await Post.forceDelete({ id: 1 })           // Permanent removal
```

Every one of these honors the model's *other* global scopes. `delete()` marks
only a live row the current scopes can see — on an already-trashed row it
matches nothing and leaves the original `deletedAt` alone. `restore()` and
`forceDelete()` drop
the `softDelete` filter so they reach trashed rows, and keep the rest: a
`tenant` scope still stops a force delete, which cannot be undone, from reaching
another tenant's row.

Inside a transaction, every one of them takes the handle. The transaction-bound
scope covers `delete()`; the rest take it as a trailing argument, like any other
write:

```ts
await Post.transaction(async (trx, txPost) => {
  await txPost.delete({ id: 1 })
  await Post.restore({ id: 2 }, { trx })
  await Post.forceDelete({ id: 3 }, { trx })
  const trashed = await Post.onlyTrashed({ trx }).get()
})
```

> [!TIP]
> Your schema must include a `deletedAt` timestamp column for soft deletes to work.

## Attribute Casting

Automatically convert column values when reading from the database:

```ts
export class Post extends defineModel(posts) {
  static casts = {
    metadata: 'json',       // JSON string -> object
    publishedAt: 'date',    // string -> Date
    isActive: 'boolean',    // 0/1 -> true/false
    viewCount: 'number',    // string -> number
  }
}
```

The cast types are `'json'`, `'date'`, `'boolean'`, `'number'` and `'string'`.

## Accessors & Mutators

Accessors compute virtual attributes when reading records. Mutators transform values before writing to the database.

### Accessors

Define computed properties that are automatically applied when records are fetched:

```ts
export class User extends defineModel(users, {
  accessors: {
    // `record` is typed as the table's record — field typos are compile errors
    fullName: (record) => `${record.firstName} ${record.lastName}`,
    isAdmin: (record) => record.role === 'admin',
  },
}) {}
```

(`static accessors = { ... }` on the class works too, without the typed `record` parameter.)

```ts
const user = await User.find(1)
console.log(user.fullName)  // "John Doe"
console.log(user.isAdmin)   // true
```

Accessors run on every read path: `all()`, `find()`, `where()`, `first()`, and `paginate()`.

### Mutators

Transform input data before it hits the database:

```ts
export class User extends defineModel(users) {
  static mutators = {
    email: (value) => String(value).toLowerCase().trim(),
    name: (value) => String(value).trim(),
  }
}
```

```ts
await User.create({ email: '  JOHN@EXAMPLE.COM  ', name: '  John  ' })
// Stored as: email = "john@example.com", name = "John"
```

Mutators run on both `create()` and `update()`, before hooks and before cast serialization.

## Serialization

Control how model records appear in API responses and Inertia props.

### Hiding Fields

Exclude sensitive fields from serialized output:

```ts
export class User extends defineModel(users, {
  hidden: ['passwordHash', 'rememberToken'],
}) {}
```

Like `fillable`, the option is checked against the table's columns; `static hidden = [...]` also works.

```ts
const user = await User.find(1)
const json = User.serialize(user)
// { id: 1, name: "John", email: "john@example.com" }
// passwordHash and rememberToken are excluded
```

Fields listed in `hidden` are also stripped from the record returned by `auth.user()`, so they never leak into Inertia shared props or API responses that expose the authenticated user. See the [Authentication guide](./authentication.md) for details.

### Visible Fields

Use a whitelist instead of a blacklist:

```ts
export class User extends defineModel(users, {
  visible: ['id', 'name', 'email'],
}) {}
```

When `visible` is set, only those fields appear. `visible` takes precedence over `hidden`.

### Appending Virtual Attributes

Include accessor-computed values in serialized output:

```ts
export class User extends defineModel(users, {
  accessors: {
    fullName: (record) => `${record.firstName} ${record.lastName}`,
  },
  appends: ['fullName'],
  hidden: ['firstName', 'lastName'],
}) {}
```

`appends` may only name accessors declared in the same options object: an undeclared name is a compile error.

```ts
const json = User.serialize(user)
// { id: 1, fullName: "John Doe", email: "john@example.com" }
```

### Serializing Collections

```ts
const users = await User.all()
const json = User.serializeMany(users)
```

> [!TIP]
> `serialize()` and `serializeMany()` are ideal for building Inertia page props or API responses. Pair them with `JsonResource` for more complex transformations.

## Pagination

Paginate query results and get metadata for building page controls:

```ts
const result = await Post.paginate({ page: 1, perPage: 10 })
// result.data  — PostRecord[] for the current page
// result.meta  — { total, perPage, currentPage, totalPages, hasMore, from, to }
```

Pass pagination data directly to an Inertia page:

```ts
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { PostResource, type PostResourceData } from '@/app/Http/Resources/PostResource'
import { pages } from '@/.guren/pages.gen'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

async index() {
  const page = Number(this.query('page', '1'))
  const result = await Post.scope('published').paginate({ page, perPage: 15 })
  const paginator = paginate(result, { path: this.request.path ?? '/posts' })

  return this.inertia(pages.posts.Index, {
    data: result.data.map((post) => new PostResource(post).toJSON()),
    pagination: {
      meta: paginator.meta(),
      links: paginator.links(),
    },
  } satisfies PostsIndexProps)
}
```
