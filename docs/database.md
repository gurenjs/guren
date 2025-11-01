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

For more advanced queries, reach for Drizzle directly via the database instance in `config/database.ts` or build helper methods on your model.

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
