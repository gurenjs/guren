# @guren/orm

Eloquent-style models for [Guren](https://guren.dev/), a Bun-first fullstack TypeScript framework with Laravel-style conventions. A Model API over [Drizzle ORM](https://orm.drizzle.team/), with PostgreSQL, MySQL, SQLite, and Cloudflare D1 behind one interface.

## Installation

Application code gets the Model API from [`@guren/core`](https://www.npmjs.com/package/@guren/core), which re-exports it:

```bash
bun add @guren/core
```

Starting a new app? Scaffold one and pick a database:

```bash
bunx create-guren-app my-app
```

## Defining a model

Tables are declared with Drizzle's schema DSL, re-exported per dialect so the app pins one copy of `drizzle-orm`:

```typescript
// db/schema.ts
import { sqliteTable, integer, text } from '@guren/orm/drizzle/sqlite'

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  published: integer('published', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})
```

```typescript
// app/Models/Post.ts
import { defineModel } from '@guren/core'
import { posts } from '@/db/schema'

export class Post extends defineModel(posts) {
  static fillable = ['title', 'body']
}
```

## Querying

```typescript
const post = await Post.find(1)                    // null when missing
const post = await Post.findOrFail(1)              // throws ModelNotFoundException (404)
const published = await Post.where('published', true).orderBy('createdAt', 'desc').get()
const page = await Post.paginate({ page: 1, perPage: 20 })
const post = await Post.create({ title: 'Hello', body: 'World' })
```

Relationships, scopes, soft deletes, observers, accessors and mutators, and eager loading are documented in the [database guide](https://guren.dev/docs/guides/database).

## Mass assignment

`fillable` is the allowlist, and it is always strict: primary keys are excluded, and an `AuthenticatableModel` refuses password hashes and remember tokens whatever the list says. A column the server chooses next to request data, such as an owner, goes in `set` and stays out of `fillable`:

```typescript
const post = await Post.create(data, { set: { authorId: user.id } })
```

Writes that carry no request data at all (seeders, system records) go through `forceCreate()` and `forceUpdate()`.

## Dialect subpaths

| Import | Contents |
|--------|----------|
| `@guren/orm/drizzle/pg` | Drizzle's PostgreSQL schema DSL, plus `sql` |
| `@guren/orm/drizzle/mysql` | The MySQL schema DSL |
| `@guren/orm/drizzle/sqlite` | The SQLite and D1 schema DSL |

## Documentation

[guren.dev/docs](https://guren.dev/docs)

## License

MIT
