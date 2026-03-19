# Database

Guren uses Drizzle ORM with PostgreSQL. You define your schema in TypeScript, wrap it in a Model class, and get a fluent query API that feels like Laravel Eloquent while staying fully type-safe.

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

## Defining Models

A Model wraps a Drizzle table and gives it an expressive query API:

```ts
// app/Models/Post.ts
import { Model } from '@guren/orm'
import { posts } from '@/db/schema'

export type PostRecord = typeof posts.$inferSelect

export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord
}
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

Or use `guarded` to block specific fields:

```ts
  // Denylist — everything except these is assignable
  static guarded = ['id', 'createdAt', 'updatedAt']
```

> [!NOTE]
> Use `fillable` or `guarded`, not both. If neither is set, all fields are assignable.

## Relationships

Declare relationships once, then eager-load them everywhere.

### hasMany / belongsTo

```ts
// app/Models/User.ts
export class User extends Model<UserRecord> {
  static override table = users
  static override readonly recordType = {} as UserRecord
  static override relationTypes: { posts: HasManyRecord<PostRecord> } = { posts: [] }
}

// app/Models/Post.ts
export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord
  static override relationTypes: { author: BelongsToRecord<UserRecord> } = { author: null }
}

// app/Models/relations.ts — import once in src/main.ts
User.hasMany('posts', Post, 'authorId', 'id')
Post.belongsTo('author', User, 'authorId', 'id')
```

### Other relationship types

```ts
User.hasOne('profile', Profile, 'userId', 'id')
User.belongsToMany('roles', Role, 'user_roles', 'userId', 'roleId')
Country.hasManyThrough('posts', Post, User, 'countryId', 'authorId')
```

### Eager Loading

```ts
const users = await User.with('posts')             // users[0].posts is PostRecord[]
const posts = await Post.with('author')             // posts[0].author is UserRecord | null
const filtered = await Post.with('author', { authorId: [1, 2] })
```

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

## Model Hooks

Hooks run logic at specific points in a record's lifecycle. Use them for auto-generated slugs, timestamps, audit logs, or cache invalidation:

```ts
import { slugify } from '@/utils/string'

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

## Pagination

Paginate query results and get metadata for building page controls:

```ts
const result = await Post.paginate({ page: 1, perPage: 10 })
// result.data  — PostRecord[] for the current page
// result.meta  — { total, perPage, currentPage, totalPages, hasMore, from, to }
```

Pass pagination data directly to an Inertia page:

```ts
async index() {
  const page = Number(this.query('page', '1'))
  const posts = await Post.scope('published').paginate({ page, perPage: 15 })
  return this.inertia('posts/Index', { posts })
}
```

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
