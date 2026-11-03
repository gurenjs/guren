# Database

Guren reads and writes the database through models built on Drizzle tables, with a query API shaped like Laravel's Eloquent and typed from your schema. A new app uses SQLite and needs no setup; PostgreSQL, MySQL and Aurora Serverless are a configuration change away.

This page sets the database up: the connection, the schema and its migrations, and seed data.

## Connecting to the Database

The scaffold writes `config/database.ts` for the driver you picked with `create-guren-app --db`, and `createApp({ config })` lists it, so the ORM connects at boot with the app's validated environment. Every driver exposes the same functions (`getDatabase`, `migrateDatabase`, `closeDatabase`, `configureOrm`, `seedDatabase`, `resetDatabase`, `migrationStatus`) and an `AppSeederContext` type, so models and queries do not change when you switch.

| Driver | `--db` | Factory in `config/database.ts` |
|--------|--------|---------------------------------|
| SQLite (the default) | `sqlite` | `createSqliteDatabase` |
| PostgreSQL | `postgres` | `createPostgresDatabase` |
| MySQL | `mysql` | `createMySqlDatabase` |
| Aurora Serverless (AWS Data API) | none: write it by hand | `createAwsDataApiDatabase` |
| Cloudflare D1 | none: see the [Cloudflare guide](./cloudflare.md#database-d1) | D1's own factory |

Each factory reads its connection settings from `config/env.ts` through a resolver; [Configuration](./configuration.md#the-database-connection) explains the resolver's `context` argument.

### SQLite

New projects use SQLite through Bun's built-in driver, with no Docker or external database:

```ts
// config/database.ts
import { createSqliteDatabase, defineDatabaseConfig, type SqliteSeederContext } from '@guren/core'
import env from './env.js'

const database = createSqliteDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  filename: (context) => {
    const values = context?.env ?? env.parse(undefined, { mode: 'report' }).values
    // `bun test` sets NODE_ENV=test, so the suite uses its own file.
    return process.env.NODE_ENV === 'test'
      ? values.TEST_DATABASE_URL ?? './data/guren.test.db'
      : values.DATABASE_URL ?? './data/guren.db'
  },
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database

export type AppSeederContext = SqliteSeederContext

export default defineDatabaseConfig(database, {
  seedOnBoot: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
})
```

With `seedOnBoot` true, the app runs the seeders at boot once the migrations folder holds migrations. Scaffolds turn it on only under `NODE_ENV=development` (which `bun run dev` sets) and `NODE_ENV=test` (which `bun test` sets). Any other value, an unset `NODE_ENV` included, skips it, so a server started without `NODE_ENV` never creates the seeders' demo accounts; run `bunx guren db:seed` explicitly there. Tests use a separate file; see [Testing](./testing.md#test-database-isolation).

Apps scaffolded earlier pass `seedOnBoot: process.env.NODE_ENV !== 'production'`, which also seeds when `NODE_ENV` is unset. `bunx guren doctor` warns about it and says what to edit; nothing rewrites the file for you. Replace the comparison with `(process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')`, keeping the rest of the expression, and run `bin/serve.ts` under `NODE_ENV=development` in the script `bun run dev` starts it with (`"dev:server": "NODE_ENV=development bun --hot bin/serve.ts"`), or `bun run dev` stops seeding.

> [!TIP]
> Use SQLite for development and testing, then switch to PostgreSQL for production. Your models and queries work unchanged.

### PostgreSQL

`DATABASE_URL` is declared in the scaffolded `config/env.ts`:

```ts
// config/database.ts
import { createPostgresDatabase, defineDatabaseConfig, type PostgresSeederContext } from '@guren/core'
import env from './env.js'

const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  connectionString: (context) => (context?.env ?? env.parse(undefined, { mode: 'report' }).values).DATABASE_URL
    ?? 'postgres://guren:guren@localhost:54322/guren',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database

export type AppSeederContext = PostgresSeederContext

export default defineDatabaseConfig(database, {
  seedOnBoot: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
})
```

Tables are declared with `pgTable`:

```ts
// db/schema.ts
import { pgTable, serial, text, timestamp } from '@guren/orm/drizzle/pg'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull().default('draft'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})
```

On PostgreSQL, give every timestamp column `{ withTimezone: true }`. A `timestamp without time zone` stores a bare wall clock with no offset, so `defaultNow()` records it in the database session's zone while your app reads it back as UTC, and any client other than your app sees a different instant. Scaffolds already emit it, and `bunx guren check` warns about a column declared without it. That warning reads the schema statically, so a clean result means nothing was found, not that every column is right.

### MySQL

Use `createMySqlDatabase` when your app runs on MySQL-compatible databases.

```ts
// config/database.ts
import { createMySqlDatabase, defineDatabaseConfig, type MySqlSeederContext } from '@guren/core'
import env from './env.js'

const database = createMySqlDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  connectionString: (context) => (context?.env ?? env.parse(undefined, { mode: 'report' }).values).DATABASE_URL
    ?? 'mysql://guren:guren@localhost:33306/guren',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database

export type AppSeederContext = MySqlSeederContext

export default defineDatabaseConfig(database, {
  seedOnBoot: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
})
```


### Aurora Serverless (AWS Data API)

Use `createAwsDataApiDatabase` when your app runs on AWS Lambda against Aurora Serverless v2 with the RDS Data API enabled. The Data API is HTTP-based, so there is no connection pool to manage and the Lambda function does not need to run inside a VPC.

```ts
// config/database.ts
import { createAwsDataApiDatabase, defineDatabaseConfig, type ConnectionContext } from '@guren/core'
import env from './env.js'

const values = (context?: ConnectionContext) => context?.env ?? env.parse(undefined, { mode: 'report' }).values

const database = createAwsDataApiDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  // A resolver returning undefined falls back to the environment variable:
  // DATABASE_NAME, DATABASE_RESOURCE_ARN, DATABASE_SECRET_ARN
  database: (context) => values(context).DATABASE_NAME,
  resourceArn: (context) => values(context).DATABASE_RESOURCE_ARN,
  secretArn: (context) => values(context).DATABASE_SECRET_ARN,
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database

export default defineDatabaseConfig(database, {
  seedOnBoot: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
})
```

Declare the three keys in `config/env.ts` (see [Configuration](./configuration.md#declaring-the-environment)), for example as `Env.string().optional()`.

Install the driver package alongside it:

```bash
bun add @aws-sdk/client-rds-data
```

The adapter exposes the same runtime API as the other drivers, and migrations use the standard drizzle-kit folders. One deliberate difference: `getDatabase()` does **not** run pending migrations automatically. On Lambda that check would cost several serialized Data API round trips on every cold start. Run migrations out of band (`bun run db:migrate`, or the console handler once deployed), or opt back in with `migrateOnStart: true`. For `drizzle-kit generate`/`push` against the Data API, set `driver: 'aws-data-api'` in `drizzle.config.ts` with the same `database`/`resourceArn`/`secretArn` credentials.

> [!NOTE]
> Authentication uses the standard AWS SDK credential chain (IAM role on Lambda, `AWS_PROFILE` locally). Pass `clientOptions` to override the region or credentials explicitly.

## Schema and Migrations

Tables are declared in `db/schema.ts` with Drizzle's builders for your driver. A fresh SQLite app starts with a `users` table:

```ts
// db/schema.ts
import { sqliteTable, integer, text } from '@guren/orm/drizzle/sqlite'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

After changing the schema, generate a migration from it and apply it:

```bash
bunx guren make:migration --name add_posts_table
bun run db:migrate
```

### Generating migrations

The command reads the first of `drizzle.config.ts`, `.mts`, `.js`, `.mjs` and `.json` that exists, in that order, for the schema path, output directory, and dialect. You can override the paths:

```bash
bunx guren make:migration --schema ./custom/schema.ts --out ./custom/migrations
```

Overrides cannot be combined with drizzle-kit's `--config`, so Guren reads the config itself and restates its `dialect` (and `driver`) on the command line. Fields you did not override keep their configured values, so `--schema` alone still writes to the config's `out`. If a config field cannot be restated as a flag, the command names it rather than letting the migration differ silently. A config whose `schema` is a list is one such case: drizzle-kit would keep only the last entry, so an override without `--schema` stops with an error.

An app with no drizzle config has nothing to declare the dialect, so state it directly:

```bash
bunx guren make:migration --dialect postgresql
```

The command runs the drizzle-kit your app installs, found in its `node_modules` or a parent's (a hoisted workspace install). With none installed it stops and asks for `bun install`; it never fetches a copy from npm, whose version may take other flags.

> [!NOTE]
> Once a migration has shipped to any environment, treat it as immutable. Create a follow-up migration to correct mistakes.

### When migrations run

`db:migrate` is not the only thing that applies them. Every driver except the
Data API and D1 adapters applies pending migrations on the first `getDatabase()`
or `configureOrm()` call, in every environment: `bun run dev`, `bun test`, and the
container the scaffolded `Dockerfile` starts with `bun bin/serve.ts` all migrate
at boot, which is what lets a deploy that ships only a new image arrive
migrated. A boot that applies something prints one line naming what it applied
and where it came from; an up-to-date database boots silently.

The cost of that convenience is that a migration you did not mean to keep still
reaches the database. A generator writes one as a new, untracked folder under
`db/migrations/`, and neither `git switch` nor `git branch -D` removes an
untracked file, so a migration generated on a branch you threw away is still on
disk and still pending. Remove it with `git clean -fd` (`git clean -fdn` first
shows what that would take) rather than expecting the branch to take it with it.

Removing the folder only helps before a boot has applied it, and a dev server
that reloads while the generator is still editing files can get there first.
After that, the tracker keeps a row for a migration no folder carries, the
migrator skips it, and whatever it created stays in the database. `db:status`
lists such a row as orphaned, and every boot warns about it before migrating.

The two exceptions never migrate at boot, for different reasons. The Data API
adapter is opt-in (`migrateOnStart`) because the check costs serialized round
trips on every Lambda cold start. D1 has no runtime path at all: migrations go
through `wrangler d1 migrations apply <database>`, and `migrateDatabase()` says
so rather than trying.

### Destructive migrations

drizzle-kit writes whatever the schema diff implies. When a column is removed
and another added in one edit, it asks whether that is a rename, and only in an
interactive terminal; run by an agent or a script, it writes a `DROP COLUMN`,
and the next boot applies it. Guren reads every pending migration before it
applies anything and reports these statements:

| Kind | What it matches |
|---|---|
| `drop-table`, `drop-column`, `drop-schema` | `DROP TABLE`, `ALTER TABLE … DROP COLUMN`, `DROP SCHEMA` / `DROP DATABASE` |
| `alter-column-type` | PostgreSQL `ALTER COLUMN … SET DATA TYPE`, MySQL `MODIFY COLUMN` / `CHANGE COLUMN` |
| `table-rebuild` | SQLite's `__new_<table>` copy, drop and rename, which drizzle-kit writes for most column changes. A rebuild whose `CREATE TABLE __new_<table>` copies every column with the same or a wider type (an added default or foreign key) passes, unless another table references it with `ON DELETE CASCADE`, `SET NULL` or `SET DEFAULT` and foreign keys stay on while it runs (Cloudflare D1), where its `DROP TABLE` deletes or rewrites those rows |
| `rename` | `RENAME TO`, `RENAME COLUMN`, `RENAME TABLE` |
| `truncate`, `delete-all` | `TRUNCATE` (a MySQL `TRUNCATE PARTITION` too), and `DELETE FROM` with no `WHERE` |
| `drop-partition` | MySQL `ALTER TABLE … DROP PARTITION`, which drops the partition's rows |
| `drop-cascade` | `DROP TYPE … CASCADE`, `DROP DOMAIN … CASCADE` and any other `DROP … CASCADE`, which also drop the columns that depend on them, and PostgreSQL `DROP OWNED` |
| `unreadable` | SQL the guard cannot read: an unterminated string, comment or body, and SQL built at run time (`EXECUTE` of a concatenation or `format()`, `PREPARE … FROM @variable`) |

The guard reads the SQL as the database will: MySQL's backslash escapes and `#`
comments, PostgreSQL's `E'…'` strings and dollar-quoted bodies. The dialect
comes from the factory at boot and from `snapshot.json` elsewhere; where neither
names one, every dialect's reading counts. Statements inside a `CREATE
PROCEDURE`, `FUNCTION` or `TRIGGER` body, and a function body written as a
string, are judged like any other.

A rename loses no rows, but the previous deploy keeps reading the old name until
it is replaced. A type change that only widens (a longer `varchar`, `smallint`
to `integer`) passes when the `snapshot.json` drizzle-kit writes beside each
migration shows both types; without that evidence it is reported. A statement
against a table that an earlier pending migration creates is never reported, so
a fresh database, which applies the whole history at once, is not refused over
an old drop.

To apply a destructive migration, acknowledge it on the first line of its
`migration.sql`, with the reason a reviewer should read:

```sql
-- guren:allow-destructive: posts moved to articles in 20261012_copy_posts
DROP TABLE "posts";
```

Keep the comment on the first line. drizzle splits the file at
`--> statement-breakpoint`, and a comment alone after the last one is an empty
statement that SQLite rejects.

Where the guard applies:

- `bunx guren db:migrate` refuses an unacknowledged statement in every
  environment. `--dry-run` reports without applying, and
  `--allow-destructive` applies once without editing the file.
- At boot, the factory option decides. `destructiveMigrations: 'refuse'`, which
  new apps set in `config/database.ts`, throws before anything is applied;
  `'warn'`, the default for apps that do not set it, prints the statements and
  applies them. `GUREN_ALLOW_DESTRUCTIVE_MIGRATIONS=1` lets one refused run
  through. A `db:reset` re-applies everything into an emptied database and is
  never judged.
- `bunx guren check` and `bunx guren gate` report the migrations not yet on
  `main` (committed on the branch, uncommitted or untracked), so the agent's
  Stop hook and CI catch one before it is merged. A drop that already shipped is
  never reported.

```ts
const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  destructiveMigrations: 'refuse',
})
```

The comment records that a person decided the data can go; an agent can type it
as easily as the statement, so the harness tells it to ask first, and review is
where a reason that does not hold up gets caught.

## Seeding

Seeders live in `db/seeders/`. The simplest one exports an async `run()` function; this one uses the `Post` model described in [Defining Models](./models.md#defining-models):

```ts
// db/seeders/PostsSeeder.ts
import { Post } from '@/app/Models/Post'

export async function run() {
  await Post.create({ title: 'Hello', body: 'Welcome to Guren!' })
}
```

`bun run db:seed` runs every seeder:

```bash
bun run db:seed
```

### Seeding through Drizzle

`defineSeeder()` hands the seeder the Drizzle database itself, which is useful
for bulk inserts and upserts that bypass the model layer. Its type depends on
the dialect, so annotate the context with `AppSeederContext`, the alias
`config/database.ts` exports for whichever database the app is configured with:

```ts
// db/seeders/PostsSeeder.ts
import { defineSeeder } from '@guren/core'
import type { AppSeederContext } from '../../config/database.js'
import { posts } from '../schema.js'

export default defineSeeder(async ({ db }: AppSeederContext) => {
  await db.insert(posts).values({ title: 'Hello', body: 'Welcome to Guren!' })
})
```

`SeederContext` without a type argument means PostgreSQL, so on MySQL or SQLite
it rejects the app's own schema. `AppSeederContext` is exported by
`config/database.ts` in apps scaffolded from this release onwards; an older app
imports its dialect's alias from `@guren/core` directly instead, one of
`PostgresSeederContext`, `MySqlSeederContext`, `SqliteSeederContext`, or
`AwsDataApiSeederContext`:

```ts
import { defineSeeder, type MySqlSeederContext } from '@guren/core'
```

> [!NOTE]
> D1 has no seeder context: its `seedDatabase()` does not run seeders. Seed a D1
> database with `wrangler d1 execute <database> --file <seed.sql>` instead.
## Next Steps

- [Models](./models.md): define a model on a table, then query, create and update its rows
- [Relationships](./relationships.md): declare relations between models and eager-load them

