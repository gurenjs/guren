# Relationships

Declare relationships next to the model that owns them, then eager-load them everywhere. Each relation is registered on the model class with `hasMany()`, `belongsTo()` or one of the other methods below. The models themselves are described in [Models](./models.md).

## hasMany / belongsTo

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

`relationTypes` tells TypeScript what each relation loads as; the values (`[]`, `null`) are runtime placeholders. [Typing loaded relations](#typing-loaded-relations) shows the `declare` form that needs none. The related model is passed as a function that imports it, so two models can refer to each other without a circular import.

## Other relationship types

```ts
import { userRoles } from '@/db/schema'

User.hasOne('profile', Profile, 'userId', 'id')
User.belongsToMany('roles', Role, userRoles, 'userId', 'roleId')
Country.hasManyThrough('posts', Post, User, 'countryId', 'authorId')
```

| Method | Arguments |
|--------|-----------|
| `hasMany(name, Related, foreignKey, localKey)` | The foreign key on the related table, and this model's key it points at (usually `id`). Loads an array, `[]` when nothing matches |
| `belongsTo(name, Related, foreignKey, ownerKey)` | The foreign key on this model, and the related model's key. Loads one record or `null` |
| `hasOne(name, Related, foreignKey, localKey)` | As `hasMany`, but loads one record or `null` |
| `belongsToMany(name, Related, pivotTable, foreignPivotKey, relatedPivotKey, parentKey?, relatedKey?)` | Many-to-many through a pivot table |
| `hasManyThrough(name, Related, Through, firstKey, secondKey)` | Records reached through an intermediate model |
| `morphMany(name, Related, morphName, localKey)` / `morphTo(name, morphName)` | Polymorphic relations, below |

For `belongsToMany`, `pivotTable` is the Drizzle table object exported from `@/db/schema`, not the table's name. `foreignPivotKey` and `relatedPivotKey` are both columns *on the pivot*, referencing this model and the related one; `parentKey` and `relatedKey` are the local keys they point at, and both default to `'id'`.

## Polymorphic Relationships

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

## Eager Loading

```ts
const users = await User.with('posts')             // users[0].posts is PostRecord[]
const posts = await Post.with('author')             // posts[0].author is UserRecord | null
const filtered = await Post.with('author', { authorId: [1, 2] })
```

Eager loading also works on the QueryBuilder, so you can combine it with filters and ordering. The record-returning methods (`get()`, `first()`, `firstOrFail()`, and `paginate()`) all attach the relations:

```ts
const activeUsers = await User.where('active', true)
  .with('posts')
  .orderBy('name')
  .get()

const user = await User.newQuery().with('posts').first()

// Each row of the page carries its author
const page = await Post.newQuery().with('author').orderBy('id', 'desc').paginate({ page: 1, perPage: 10 })
```

### Nested relations

Nested relations use dot notation:

```ts
const users = await User.with('posts.comments')
```

Several paths may branch off the same relation. The shared head is read once,
so every branch lands on the same records:

```ts
const users = await User.newQuery().with('posts.comments', 'posts.tags').get()

users[0].posts[0].comments // loaded
users[0].posts[0].tags     // loaded too
```

### Constraining what loads

On the QueryBuilder, the object form of `with()` takes a callback per relation
to constrain the query that loads it. The callback receives that relation's
query builder with the foreign-key filter already on it, so a `where()` narrows
which related rows load:

```ts
const users = await User.newQuery()
  .with({ posts: (q) => q.where('published', true) })
  .get()

users[0].posts // only the published posts
```

Each object key constrains exactly the level it names, and the order of the
keys does not matter. A dotted key constrains the leaf and leaves the head
unfiltered; list both keys to constrain both levels:

```ts
// `posts` loads unfiltered, `comments` are filtered
await User.newQuery()
  .with({ 'posts.comments': (q) => q.where('approved', true) })
  .get()

// both levels filtered
await User.newQuery()
  .with({
    posts: (q) => q.where('published', true),
    'posts.comments': (q) => q.where('approved', true),
  })
  .get()
```

> [!WARNING]
> A top-level `orWhere()` inside a callback **widens** the query instead of
> narrowing it, because it ORs against the foreign-key filter the loader
> applied. Keep it grouped:
> `q.where((g) => g.where('a', 1).orWhere('b', 2))`.
>
> A `select()` must include the column the relation is keyed on (the foreign
> key for `hasMany`/`hasOne`, the owner key for `belongsTo`). Without it the
> loader cannot match rows back to their parent and the relation loads empty.

> [!NOTE]
> Relations are loaded in batches rather than one query per parent, so `limit()`
> inside a constraint caps the whole result set, not each parent's share. A
> constraint carrying `limit()`, `offset()` or `orderBy()` is answered by one
> query over every key at once; without one, the keys are split into batches the
> driver's parameter limit admits. For `belongsToMany` and `hasManyThrough` the
> keys split that way are the related rows', not the parents'. For `morphTo`, the
> callback runs once per morph target, so it may only reference columns every
> target shares.

For `belongsToMany` and `hasManyThrough`, the callback constrains the query for
the **related** model, not the pivot or through-table lookup that finds which
rows to fetch. Filter on the related model's own columns:

```ts
// keeps the `news` tags of each post; the pivot lookup is untouched
await Post.newQuery()
  .with({ tags: (q) => q.where('label', 'news') })
  .get()
```

The static `Model.with()` is a different signature: its second argument filters
the *parent* records, not the relation. Use `Model.newQuery().with({ ... })` for
constraint callbacks.

### Typing loaded relations

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
> Only the head segment (`posts` above) is checked against `relationTypes`: anything after the first dot is an unvalidated string, so a typo'd or malformed tail (`'posts.'`, `'posts..comments'`, `'posts.typo'`) still compiles. At runtime, an unknown tail relation throws, but only once the loader actually has a loaded row to recurse into. If every record's head relation loads zero rows, the tail is never inspected and the call quietly no-ops instead of throwing. Nesting through a `morphTo` relation always throws at runtime regardless. That constraint isn't enforced at the type level either.

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

## Relation Counts

`withCount()` attaches a `${name}Count` field without loading the related rows,
ideal for list pages that only display totals:

```ts
const users = await User.withCount('posts')        // users[0].postsCount is number
const posts = await Post.withCount(['comments', 'author'], { published: true })
```

Supported for `hasMany`, `hasOne`, `morphMany` (children per record) and
`belongsTo` (0 or 1).

