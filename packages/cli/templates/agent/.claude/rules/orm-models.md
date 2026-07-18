---
description: Guren ORM (@guren/orm) — model definition, queries, relations, pagination, mass assignment
globs:
  - "app/Models/**"
  - "db/**"
---

# ORM Models (@guren/orm)

## Defining a model

```typescript
import { defineModel, type BelongsToRecord } from '@guren/orm'
import { posts } from '../../db/schema.js'

export type PostRecord = typeof posts.$inferSelect

export class Post extends defineModel(posts) {
  static fillable = ['title', 'body', 'authorId']
  static override relationTypes: { author: BelongsToRecord<UserRecord> } = { author: null }
}
Post.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
```

`class Post extends Model<typeof posts> { static table = posts }` also works.
Auth user models: `defineModel(users, { base: AuthenticatableModel })`.

## Statics

`find(id)` → record | null · `findOrFail(id)` throws `ModelNotFoundException` (renders 404) ·
`first(where?)` → record | null · `all()` · `create(data)` · `forceCreate(data)` ·
`update(where, data)` · `forceUpdate(where, data)` · `delete(where)` ·
`paginate(options?)` · `transaction(async (trx) => ...)`

## Where clauses

```typescript
await Post.where({ status: 'active', authorId: 1 }).get()  // object form = AND
await Post.where({ id: [1, 2, 3] }).get()                  // array value = IN
await Post.where('views', '>', 100).orWhere('featured', true).get()
```

Operators (exact set): `=` `!=` `>` `<` `>=` `<=` `like` `in` `not in` `is null` `is not null`

## QueryBuilder chain

`Post.where(...)` returns a `QueryBuilder`. Chainable:
`where` / `orWhere` / `whereNull(field)` / `whereNotNull(field)` /
`whereIn(field, values)` / `whereNotIn(field, values)` /
`orderBy(field, 'asc' | 'desc')` (repeatable) / `limit(n)` / `offset(n)` /
`with(...relations)` / `scope(name)`

Terminate with: `get()` / `first()` / `firstOrFail()` / `count()` /
`paginate(page?, perPage?)` or `paginate({ page, perPage })` /
`update(data)` / `forceUpdate(data)` / `delete()`

## Pagination

```typescript
const result = await Post.paginate({ page: 1, perPage: 15, where: {...}, orderBy: 'createdAt' })
// PaginateOptions: { page? (1-based, default 1), perPage? (default 15), where?, orderBy? }
// PaginatedResult: { data: TRecord[], meta: { total, perPage, currentPage, totalPages, hasMore, from, to } }
```

For Inertia/HTTP pagination links wrap it with `paginate` from `@guren/core`:
`paginate(result, { path, query?, fragment? })` — those three fields are `PaginatorOptions`.

## Relations — declaration signatures

- `hasOne(name, related, foreignKey, localKey)`
- `hasMany(name, related, foreignKey, localKey)`
- `belongsTo(name, related, foreignKey, ownerKey)`
- `belongsToMany(name, related, pivotTable, foreignPivotKey, relatedPivotKey, parentKey = 'id', relatedKey = 'id')` — 7 args; `pivotTable` is the Drizzle table
- `hasManyThrough(name, related, through, firstKey, secondKey, localKey = 'id', secondLocalKey = 'id')`
- `morphMany` / `morphTo` also exist

`related` is a model class or lazy loader: `() => import('./Tag.js').then((m) => m.Tag)`.

Typed relation results — declare `static relationTypes` using these exported types:
`HasManyRecord<T>` = `T[]` · `HasOneRecord<T>` = `T | null` · `BelongsToRecord<T>` = `T | null` ·
`BelongsToManyRecord<T>` = `T[]` · `HasManyThroughRecord<T>` = `T[]`

## Eager loading

```typescript
await Post.with('tags')                    // Array<record & { tags: TagRecord[] }>; nested: with('author.posts')
await Post.with(['author', 'tags'], { published: true })  // optional where filter
await Post.findWith(1, 'tags')             // single record + relations, or null
await Post.findWithOrFail(1, ['author'])   // throws ModelNotFoundException
await Post.withCount('tags')               // adds tagsCount: number (no nested names)
await Post.withPaginate('tags', { page: 1 })  // PaginatedResult with relations
```

## No attach/detach/sync — use a pivot model

```typescript
export class PostTag extends defineModel(postTags) {}
await PostTag.create({ postId, tagId })   // attach
await PostTag.delete({ postId, tagId })   // detach
// sync: PostTag.delete({ postId }) then re-create the desired set
```

## No firstOrCreate / updateOrCreate — hand-roll it

```typescript
const existing = await Tag.first({ name })
const tag = existing ?? await Tag.create({ name })
```

For concurrency safety add a unique index and catch the constraint error, or wrap in
`Tag.transaction(async (trx) => ...)`.

## Mass assignment

- With `static fillable = [...]` set, `create()`/`update()` **throw `MassAssignmentException`**
  on any unlisted input key (`static strictFillable = false` restores silent discarding)
- Without `fillable`, keys in `static guarded` (default `['id']`) are silently stripped
- `forceCreate()` / `forceUpdate()` bypass filtering — trusted server-side data only
