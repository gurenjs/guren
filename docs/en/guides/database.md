# Database

Guren uses Drizzle ORM and supports PostgreSQL, SQLite, and MySQL. You define your schema in TypeScript, derive models from those tables, and get a fluent query API that feels like Laravel Eloquent while staying fully type-safe.

## Connecting to the Database

Define your table schema, configure the Drizzle adapter, and you are ready to query:

```ts
// db/schema.ts
import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull().default('draft'),
  publishedAt: timestamp('published_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
})
```

```ts
// config/database.ts
import { DrizzleAdapter } from '@guren/orm'

DrizzleAdapter.configure({ connectionString: process.env.DATABASE_URL })
```

## MySQL Support

Use `createMySqlDatabase` when your app runs on MySQL-compatible databases.

```ts
// config/database.ts
import { createMySqlDatabase } from '@guren/orm'

const database = createMySqlDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  connectionString: () => process.env.DATABASE_URL,
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database
```

Like the PostgreSQL and SQLite adapters, the MySQL adapter exposes the same runtime API (`getDatabase`, `migrateDatabase`, `configureOrm`, `seedDatabase`) so switching drivers is mostly an import/configuration change.

> [!TIP]
> If you want to use Drizzle's relational queries (`db.query.<table>.findMany(...)`), pass a `relations` option built with `defineRelations(schema, ...)` from `drizzle-orm` (RQB v2). The `Model` API in Guren does not require this.

## Defining Models

Use `defineModel()` to derive a typed model directly from a Drizzle table:

```ts
// app/Models/Post.ts
import { defineModel } from '@guren/orm'
import { posts } from '@/db/schema'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends defineModel(posts) {}
```

That is all you need. `Post` now has `find`, `create`, `where`, `paginate`, and dozens more methods.

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
```

> [!TIP]
> The QueryBuilder is thenable -- you can `await` it directly without calling `.get()`. Both `await Post.where({ status: 'draft' })` and `await Post.where({ status: 'draft' }).get()` produce the same result.

| Method | Description |
|--------|-------------|
| `.where(column, value)` | Filter by equality |
| `.where(column, op, value)` | Filter with operator (`>`, `<`, `!=`, `LIKE`) |
| `.where(object)` | Filter by multiple equalities |
| `.orWhere(column, value)` | OR condition |
| `.orderBy(column, direction?)` | Sort results |
| `.limit(n)` / `.offset(n)` | Limit and skip |
| `.get()` | Execute and return array |
| `.first()` | Return first result or null |
| `.count()` | Return count of matching records |

### Dropping to Drizzle

For joins, aggregates, or driver-specific features, use Drizzle directly:

```ts
import { getDatabase } from '@/config/database'
import { posts, users } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'

const db = await getDatabase()
const rows = await db
  .select({ id: posts.id, title: posts.title, author: users.name })
  .from(posts)
  .leftJoin(users, eq(posts.authorId, users.id))
  .orderBy(desc(posts.id))
```

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

You can also use the transaction-bound scope for cleaner type-safe writes:

```ts
await Post.transaction(async (_trx, txPost) => {
  const post = await txPost.create({
    title: 'Scoped write',
    body: 'No manual { trx } forwarding',
  })

  await txPost.update({ id: post.id }, { status: 'published' })
})
```

### Mass Assignment Protection

Control which fields can be set through `create()` and `update()`:

```ts
export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord

  // Allowlist — only these fields are assignable
  static fillable = ['title', 'body', 'status']
}
```

When `fillable` is set, passing any field outside the allowlist to `create()` or `update()` throws a `MassAssignmentException` (exported from `@guren/core`). The message names the blocked fields, so a typo or an injection attempt fails loudly at the call site instead of being silently discarded and resurfacing later as a confusing NOT NULL violation:

```ts
await Post.create({ title: 'Hello', body: '...', status: 'draft', authorId: 1 })
// MassAssignmentException: Post: mass assignment blocked for field(s) "authorId"
```

For trusted, server-side-assembled data — OAuth account linking, seeders, system records — bypass the allowlist with `forceCreate()` / `forceUpdate()`:

```ts
const user = await User.forceCreate({
  name: profile.name,
  email: profile.email,
  passwordHash: `oauth:${provider}:${profile.id}`,
})

await User.forceUpdate({ id: user.id }, { emailVerifiedAt: new Date() })
```

> [!WARNING]
> `forceCreate()` / `forceUpdate()` skip mass-assignment protection entirely. Never pass raw request input to them.

To restore the previous behavior of silently dropping non-fillable fields, opt out per model:

```ts
  static fillable = ['title', 'body', 'status']
  static strictFillable = false
```

Or use `guarded` to block specific fields:

```ts
  // Denylist — everything except these is assignable
  static guarded = ['id', 'createdAt', 'updatedAt']
```

Guarded fields are always silently stripped — the strict throwing behavior applies only to models that declare `fillable`.

> [!NOTE]
> Use `fillable` or `guarded`, not both. If neither is set, all fields are assignable.

## Relationships

Declare relationships next to the model that owns them, then eager-load them everywhere.

### hasMany / belongsTo

```ts
// app/Models/User.ts
export class User extends defineModel(users) {
  static override relationTypes: { posts: HasManyRecord<PostRecord> } = {
    posts: [],
  }
}

User.hasMany('posts', () => import('./Post.js').then((m) => m.Post), 'authorId', 'id')

// app/Models/Post.ts
export class Post extends defineModel(posts) {
  static override relationTypes: { author: BelongsToRecord<UserRecord> } = {
    author: null,
  }
}

Post.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
```

### Other relationship types

```ts
User.hasOne('profile', Profile, 'userId', 'id')
User.belongsToMany('roles', Role, 'user_roles', 'userId', 'roleId')
Country.hasManyThrough('posts', Post, User, 'countryId', 'authorId')
```

### Polymorphic Relationships

Polymorphic relationships let a model belong to more than one type of parent using a single relation. For example, both posts and videos can have comments.

Define the type/id columns on the related table:

```ts
// db/schema.ts
export const comments = pgTable('comments', {
  id: serial('id').primaryKey(),
  body: text('body').notNull(),
  commentableType: text('commentable_type').notNull(),
  commentableId: integer('commentable_id').notNull(),
})
```

Register the relationships:

```ts
// Parent models
Post.morphMany('comments', Comment, 'commentable', 'id')
Video.morphMany('comments', Comment, 'commentable', 'id')

// Child model (inverse)
Comment.morphTo('commentable', 'commentable')

// Map type strings to model classes
Model.morphMap = {
  'Post': Post,
  'Video': Video,
}
```

Query them like any other relation:

```ts
const postWithComments = await Post.with('comments')
const comment = await Comment.findWith(1, 'commentable')
console.log(comment.commentable) // Post or Video record
```

### Eager Loading

```ts
const users = await User.with('posts')             // users[0].posts is PostRecord[]
const posts = await Post.with('author')             // posts[0].author is UserRecord | null
const filtered = await Post.with('author', { authorId: [1, 2] })
```

Eager loading also works on the QueryBuilder, so you can combine it with filters and ordering:

```ts
const activeUsers = await User.where('active', true)
  .with('posts')
  .orderBy('name')
  .get()

const user = await User.newQuery().with('posts').first()
```

Nested relations use dot notation:

```ts
const users = await User.with('posts.comments')
```

Nested paths type only the head segment from `relationTypes`. To get typed
children, declare the nested shape inside the head relation's record type:

```ts
export class User extends defineModel(users) {
  declare static relationTypes: {
    posts: HasManyRecord<PostRecord & { comments: CommentRecord[] }>
  }
}

const loaded = await User.with('posts.comments')
loaded[0].posts[0].comments // CommentRecord[] — typed end to end
```

> [!NOTE]
> Only the head segment (`posts` above) is checked against `relationTypes` — anything after the first dot is an unvalidated string, so a typo'd or malformed tail (`'posts.'`, `'posts..comments'`, `'posts.typo'`) still compiles. At runtime, an unknown tail relation throws — but only once the loader actually has a loaded row to recurse into. If every record's head relation loads zero rows, the tail is never inspected and the call quietly no-ops instead of throwing. Nesting through a `morphTo` relation always throws at runtime regardless — that constraint isn't enforced at the type level either.

`BelongsToRecord<T>` is always `T | null` — the loader cannot know the row
exists. When the foreign key is `NOT NULL` and the parent is guaranteed,
declare the relation with `BelongsToRequiredRecord<T>` instead. Using the
`declare` modifier skips the runtime placeholder value:

```ts
export class Comment extends defineModel(comments) {
  declare static relationTypes: {
    author: BelongsToRequiredRecord<UserRecord>
  }
}

const comments = await Comment.with('author')
comments[0].author.name // no null check required
```

### Relation Counts

`withCount()` attaches a `${name}Count` field without loading the related rows —
ideal for list pages that only display totals:

```ts
const users = await User.withCount('posts')        // users[0].postsCount is number
const posts = await Post.withCount(['comments', 'author'], { published: true })
```

Supported for `hasMany`, `hasOne`, `morphMany` (children per record) and
`belongsTo` (0 or 1).

## Query Scopes

Scopes encapsulate common filters so you can reuse them by name:

```ts
export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord

  static scopes = {
    published: (q: QueryBuilder<PostRecord>) => q.where('status', 'published'),
    popular: (q: QueryBuilder<PostRecord>) => q.where('views', '>', 1000),
    recent: (q: QueryBuilder<PostRecord>) => q.orderBy('createdAt', 'desc').limit(10),
  }
}
```

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

Every query through `all()`, `find()`, `where()`, and `newQuery()` now applies both scopes automatically.

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
> The `SoftDeletes` mixin registers a global scope named `'softDelete'`. You can bypass it with `withoutGlobalScope('softDelete')` instead of `withTrashed()` if you prefer.

## Model Hooks

Hooks run logic at specific points in a record's lifecycle. Use them for auto-generated slugs, timestamps, audit logs, or cache invalidation:

```ts
import { slugify } from '@/app/utils/string'

export class Post extends Model<PostRecord> {
  static override table = posts

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

## Model Observers

When hook logic grows complex, extract it into a dedicated observer class. Observers respond to the same lifecycle events as hooks but live in their own file.

```ts
// app/Observers/PostObserver.ts
import type { ModelObserver } from '@guren/orm'
import type { PlainObject } from '@guren/orm'

export class PostObserver implements ModelObserver {
  creating(data: PlainObject) {
    data.slug = slugify(data.title as string)
  }

  created(data: PlainObject) {
    await notifySubscribers(data)
  }

  deleting(data: PlainObject) {
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

Observers and inline hooks coexist — hooks fire first, then observers.

## Soft Deletes

Instead of permanently removing records, soft deletes set a `deletedAt` timestamp. Users can recover deleted content, and queries automatically exclude trashed records.

```ts
import { Model, SoftDeletes } from '@guren/orm'

export class Post extends SoftDeletes(Model)<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord
}
```

```ts
await Post.delete({ id: 1 })                // Sets deletedAt (row remains)
const active = await Post.all()              // Excludes soft-deleted
const all = await Post.withTrashed().get()   // Includes soft-deleted
const trashed = await Post.onlyTrashed().get()
await Post.restore({ id: 1 })               // Clears deletedAt
await Post.forceDelete({ id: 1 })           // Permanent removal
```

> [!TIP]
> Your schema must include a `deletedAt` timestamp column for soft deletes to work.

## Attribute Casting

Automatically convert column values when reading from the database:

```ts
export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord

  static casts = {
    metadata: 'json',       // JSON string -> object
    publishedAt: 'date',    // string -> Date
    isActive: 'boolean',    // 0/1 -> true/false
    viewCount: 'number',    // string -> number
  }
}
```

## Accessors & Mutators

Accessors compute virtual attributes when reading records. Mutators transform values before writing to the database.

### Accessors

Define computed properties that are automatically applied when records are fetched:

```ts
export class User extends defineModel(users) {
  static accessors = {
    fullName: (record) => `${record.firstName} ${record.lastName}`,
    isAdmin: (record) => record.role === 'admin',
  }
}
```

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
export class User extends defineModel(users) {
  static hidden = ['passwordHash', 'rememberToken']
}
```

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
export class User extends defineModel(users) {
  static visible = ['id', 'name', 'email']
}
```

When `visible` is set, only those fields appear. `visible` takes precedence over `hidden`.

### Appending Virtual Attributes

Include accessor-computed values in serialized output:

```ts
export class User extends defineModel(users) {
  static accessors = {
    fullName: (record) => `${record.firstName} ${record.lastName}`,
  }
  static appends = ['fullName']
  static hidden = ['firstName', 'lastName']
}
```

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

  return this.inertia<PostsIndexProps>(pages.posts.Index, {
    data: result.data.map((post) => new PostResource(post).toJSON()),
    pagination: paginator,
  })
}
```

## SQLite Support

Guren supports SQLite out of the box via Bun's built-in SQLite driver. New projects use SQLite by default — no Docker or external database needed.

```ts
// config/database.ts
import { createSqliteDatabase } from '@guren/orm'

const database = createSqliteDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  filename: () => process.env.DATABASE_URL ?? './data/guren.db',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database
```

The SQLite adapter has the same API as `createPostgresDatabase`, so switching between them only requires changing the import and connection config.

> [!TIP]
> Use SQLite for development and testing, then switch to PostgreSQL for production. The ORM adapter abstraction means your models and queries work unchanged.

## Migrations

Generate migrations from your Drizzle schema:

```bash
bunx guren make:migration --name add_posts_table
bun run db:migrate
```

> [!NOTE]
> Once a migration has shipped to any environment, treat it as immutable. Create a follow-up migration to correct mistakes.

## Seeding

```ts
// db/seeders/PostsSeeder.ts
import { Post } from '@/app/Models/Post'

export async function run() {
  await Post.create({ title: 'Hello', body: 'Welcome to Guren!' })
}
```

```bash
bun run db:seed
```
