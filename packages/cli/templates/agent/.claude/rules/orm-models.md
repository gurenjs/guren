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

Auth user models use the same `defineModel()` call with `AuthenticatableModel` as the base, plus the
options that reshape the create payload — the model hashes a plain `password` into `passwordHash`, so
the column becomes optional and the virtual field becomes required:

```typescript
export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
}) {
  static override hidden = ['passwordHash', 'rememberToken']
}
```

Drop `requireOnCreate` when accounts can also be created without a password (OAuth-only sign-up).
Optional means optional — passing `passwordHash` still type-checks. At runtime the base class
denies the hash and remember-token columns from mass assignment entirely; `forceCreate()`/
`forceUpdate()` is the path for trusted server-side values.

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
`paginate(result, { path?, query?, fragment? })` — those three fields are `PaginatorOptions`.

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
`BelongsToRequiredRecord<T>` = `T` (NOT NULL FK) · `BelongsToManyRecord<T>` = `T[]` · `HasManyThroughRecord<T>` = `T[]`

**Placeholder value must match the alias's shape**, not always `null`: array-typed relations (`hasMany`/`belongsToMany`/`hasManyThrough`) need `[]`, single-record relations (`hasOne`/`belongsTo`) need `null` — mixing them up is a TS error. With the `declare` modifier no placeholder is needed at all (type-only, no runtime value).

```typescript
static override relationTypes: { comments: HasManyRecord<CommentRecord> } = { comments: [] }  // hasMany → []
static override relationTypes: { author: BelongsToRecord<UserRecord> } = { author: null }     // belongsTo → null
// NOT NULL FK: parent always exists once loaded — declare it non-nullable (no placeholder with `declare`)
declare static relationTypes: { author: BelongsToRequiredRecord<UserRecord> }
```

## Eager loading

```typescript
await Post.with('tags')                    // Array<record & { tags: TagRecord[] }>
await Post.with(['author', 'tags'], { published: true })  // optional where filter
await Post.with('comments.author')         // nested via dot notation (see below)
await Post.findWith(1, 'tags')             // single record + relations, or null
await Post.findWithOrFail(1, ['author'])   // throws ModelNotFoundException
await Post.withCount('tags')               // adds tagsCount: number (no nested names)
await Post.withPaginate('tags', { page: 1 })  // PaginatedResult with relations
```

**Nested paths type only the head segment** from `relationTypes`. To get typed
children, declare the nested shape inside the head relation's record type:

```typescript
export class Post extends defineModel(posts) {
  declare static relationTypes: {
    comments: HasManyRecord<CommentRecord & { author: BelongsToRecord<UserRecord> }>
  }
}
const post = await Post.findWithOrFail(id, 'comments.author')
post.comments[0].author   // UserRecord | null — typed end to end
```

**The tail after the first dot is unvalidated** — `'comments.'`, `'comments..author'`, `'comments.typo'` all compile. At runtime an unknown tail throws "unknown relation", but only once the loader recurses into an actual loaded child; if the head relation loads zero rows for every record, the tail is never checked and the call silently no-ops. Nesting through `morphTo` always throws at runtime — also not type-checked.

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
  on any unlisted input key; the primary key (`id`) is always silently stripped
- Credential columns (`passwordHash`, `rememberToken`) **always throw** on authenticatable
  models — the framework denies them, listing them in `fillable` does not open them
- `forceCreate()` / `forceUpdate()` bypass filtering — trusted server-side values only.
  **Never call them with request input**; a `MassAssignmentException` is never fixed by
  switching the same payload to `force*`
