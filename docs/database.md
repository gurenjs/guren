# Database Guide

Guren pairs Drizzle ORM with a PostgreSQL database. This guide covers schema definitions, migrations, seeders, and day-to-day usage from your application code.

## Configuration Overview
- `config/database.ts`: Creates the database connection and exposes it to the framework.
- `drizzle.config.ts`: Shared drizzle-kit configuration used by the CLI when generating migrations.
- `db/schema.ts`: Drizzle schema definitions used by models and migrations.
- `db/migrations/`: SQL migrations generated or written by hand.
- `db/seeders/`: Seed scripts for populating sample data.

Ensure your `.env` file sets `DATABASE_URL` (defaults to `postgres://guren:guren@localhost:54322/guren`).

## Defining Schema
Use Drizzle’s schema builder inside `db/schema.ts`:

```ts
import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
})
```

Expose the table to your model by assigning it to `static table`.

```ts
// app/Models/Post.ts
import { Model } from '@guren/orm'
import { posts } from '@/db/schema'

export type PostRecord = typeof posts.$inferSelect

export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord
}

// `recordType` ensures static helpers like Post.find() return the precise shape inferred from Drizzle.
```

## Generating Migrations
The Guren CLI wraps drizzle-kit so you can create SQL files straight from your Drizzle schema:

```bash
bunx guren make:migration --name add_posts_table
```

The command looks for `drizzle.config.ts` (or `.mts/.js/.mjs`) in the project root to pick up defaults for the schema path, migrations output directory, and database dialect. Override the schema or output location when needed:

```bash
bunx guren make:migration --schema ./custom/schema.ts --out ./custom/migrations
```

If you prefer a blank file, you can still create one manually—each migration is just SQL.

## Running Migrations
Add SQL migration files under `db/migrations/` (e.g. `0001_add_posts.sql`). Write standard PostgreSQL statements:

```sql
CREATE TABLE posts (
  id serial PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL
);
```

Apply migrations with:

```bash
bun run db:migrate
```

The script included in the scaffold executes pending migrations in order. Re-running the command is safe because completed migrations are tracked.

## Seeding Data
Place seed scripts in `db/seeders/`. A typical seeder exports an async `run()` function:

```ts
// db/seeders/PostsSeeder.ts
import { Post } from '@/app/Models/Post'

export async function run() {
  await Post.create({ title: 'Hello', body: 'Welcome to Guren!' })
}
```

Execute all seeders with:

```bash
bun run db:seed
```

Use seeders to load fixtures for development, testing, or demos.

## Working with the ORM
After the `DatabaseProvider` (or your own provider that calls `bootModels()`) runs during application startup, every model gains access to the configured database adapter. Common helpers include:

```ts
await Post.all()            // Fetch all posts
await Post.find(id)         // Look up by primary key (returns null if missing)
await Post.create(payload)  // Insert a new row
await Post.where({ title }) // Filter with simple where clauses
```

### Typed Filtering with `where`

Each model exposes its Drizzle-inferred record type through `recordType`, so the `where` helper can enforce valid columns and value shapes at compile time. Clauses accept plain values, arrays (translated to `IN` queries), or `null` when checking for nullable fields.

```ts
// Narrow by equality
await Post.where({ title: 'Hello' })

// Provide multiple values to generate an IN (...) predicate
await Post.where({ id: [1, 2, 3] })

// Undefined entries are ignored, making optional filters easy
await Post.where({ published: true, authorId: user?.id ?? undefined })
```

TypeScript will flag unknown keys (`Post.where({ foo: 'bar' })`) or mismatched types (`Post.where({ id: 'oops' })`) before the query runs.

### Sorting Results with `orderBy`

Use `Model.orderBy()` to request ordered results. The helper keeps column names type-safe and supports a few convenient input shapes:

```ts
// String column defaults to ascending order
await Post.orderBy('publishedAt')

// Tuple format lets you choose the direction
await Post.orderBy(['publishedAt', 'desc'])

// Array of expressions produces multi-column ordering
await Post.orderBy([
  ['published', 'desc'],
  { column: 'title', direction: 'asc' },
])

// You can still include filters alongside ordering
await Post.orderBy('publishedAt', { published: true })
```

Behind the scenes, `orderBy` normalizes these expressions and passes them to the configured ORM adapter (Drizzle by default), which converts them into the appropriate `orderBy()` clauses.

For more advanced queries, reach for Drizzle directly via the database instance in `config/database.ts` or build helper methods on your model.

### Defining Relationships

The ORM ships with a lightweight relationship layer for common Eloquent-style patterns. Declare your relations once on the model class—typically alongside the static `table` assignment—to keep everything discoverable.

```ts
// app/Models/User.ts
import { Model } from '@guren/orm'
import { users } from '@/db/schema'

export type UserRecord = typeof users.$inferSelect

export class User extends Model<UserRecord> {
  static override table = users
  static override readonly recordType = {} as UserRecord
}

// app/Models/Post.ts
import { Model } from '@guren/orm'
import { posts } from '@/db/schema'

export type PostRecord = typeof posts.$inferSelect

export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord
}

// app/Models/relations.ts
import { Post } from './Post'
import { User } from './User'

// Define relations after both models are declared to avoid module cycles.
User.hasMany('posts', Post, 'authorId', 'id')
Post.belongsTo('author', User, 'authorId', 'id')
```

Import the `relations.ts` module once during application boot (for example inside `src/main.ts`) so the side-effects run before your controllers start querying:

```ts
// src/main.ts
import './app/Models/relations'
```

- `hasMany(name, RelatedModel, foreignKey, localKey)` expects the related model’s foreign key and the local key on the parent (often `id`).
- `belongsTo(name, RelatedModel, foreignKey, ownerKey)` ties the current model’s foreign key to the owner key on the related model.

### Eager Loading with `with`

Use `Model.with()` to eager load one or more relations. The helper returns shallow copies of each record with the relation data inserted under the configured name.

```ts
// Load users alongside their posts
const users = await User.with('posts')

// Combine eager loading with filters
const posts = await Post.with('author', { authorId: [1, 2] })

// posts[0].author is either the related UserRecord or null (for belongsTo)
```

`hasMany` relations hydrate to arrays (defaulting to `[]` when no matches are found). `belongsTo` returns the single related record or `null` when the foreign key is missing. Chain multiple relations by passing an array: `await User.with(['posts'])`, and combine with the existing `where`/`orderBy` helpers when you need additional filtering.

## Transactions
Use the database instance from `config/database.ts` to run transactions:

```ts
import { db } from '@/config/database'

await db.transaction(async (tx) => {
  await tx.insert(posts).values({ title, body })
})
```

Pass `tx` into models or Drizzle queries as needed to keep operations atomic.

## Tips
- Keep migrations idempotent—avoid destructive statements that fail when run twice.
- Prefer seeders for mutable data; treat migrations as append-only.
- When renaming columns or tables, schedule explicit data migrations to avoid losing information.

With schema, migrations, and seeders in place, your application has a reliable foundation for evolving your database alongside your code.
