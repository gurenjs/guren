---
paths:
  - "app/Models/**"
  - "db/**"
  - "modules/*/app/Models/**"
  - "modules/*/db/**"
---

# ORM Models

Import models from `@guren/core`. The only `@guren/orm` import app code writes
is `@guren/orm/drizzle/<dialect>`, in `db/schema.ts`. After editing
`db/schema.ts`, run `bunx guren make:migration <name>` (drizzle-kit writes the
SQL; do not hand-write it), then `bun run db:migrate`.

## Defining a model

```typescript
import { defineModel, type BelongsToRecord, type HasManyRecord } from '@guren/core'
import { posts } from '../../db/schema.js'

export type PostRecord = typeof posts.$inferSelect   // the row type; the class `Post` has no columns

export class Post extends defineModel(posts, {
  fillable: ['title', 'body'],   // typed; authorId stays out: Post.create(data, { set: { authorId } })
}) {
  static override relationTypes: {
    author: BelongsToRecord<UserRecord>
    comments: HasManyRecord<CommentRecord>
  } = { author: null, comments: [] }   // single → null, array → []
}
Post.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
Post.hasMany('comments', () => import('./Comment.js').then((m) => m.Comment), 'postId', 'id')
```

The placeholder must match the alias's shape: `hasMany`/`belongsToMany`/`hasManyThrough`
need `[]`, `hasOne`/`belongsTo` need `null`; with `declare static relationTypes`
none is needed. `BelongsToRequiredRecord<T>` types a NOT NULL foreign key.

## Mass assignment

- With `fillable` set, `create()`/`update()` **throw `MassAssignmentException`** on
  any unlisted input key; `id` is silently stripped.
- A column the server chooses (the owner `authorId`, a parent `postId`, a default
  `status`) stays out of `fillable` and goes in `set`:
  `Post.create(data, { set: { authorId: user.id } })`. `set` throws on a key in
  `fillable`, on `id` and on credential columns. Never spread request input into `set`.
- `forceCreate()` / `forceUpdate()` bypass filtering, for writes that carry no
  request data (seeders, system records). **Never call them with request input.**

## Queries that bite

```typescript
// An OR next to AND filters needs the callback group, or the ANDs get OR'd away:
await Post.where((q) => q.where('title', 'like', p).orWhere('excerpt', 'like', p))
  .where('published', true).get()
await Post.whereNull('publishedAt').get()   // not where('publishedAt', 'is null'), which throws
await Post.where({ authorId }).count()      // count() is on the query builder, not the model
```

No `attach/detach/sync`: create and delete rows on a pivot model
(`await PostTag.create({ postId, tagId })`, `await PostTag.delete({ postId, tagId })`;
sync = delete by `postId`, then re-create). No `firstOrCreate`:
`(await Tag.first({ name })) ?? (await Tag.create({ name }))`.

Every static and builder method, pagination shapes, eager loading (`with`,
`findWithOrFail`, `withCount`, nested paths and their typing), authenticatable
user models and the full mass-assignment rules:
`__SKILLS_DIR__/guren-api/reference/orm-models.md`.
