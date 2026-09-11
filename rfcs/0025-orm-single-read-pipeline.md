# RFC: One Read Pipeline for Models

**Author:** 7nohe
**Date:** 2026-09-11
**Status:** Draft

## Problem

`@guren/orm` reads a row through two pipelines, chosen by whether the model
carries a global scope, and only one of them applies the model's read-time
transforms. Everything below is verified at `30a26e94`.

**The fork.** Five static reads on `Model` branch on `hasScopes()`
(`packages/orm/src/Model.ts:550`, `:572`, `:667`, `:1013`, `:1045`). Without a
scope they call the adapter directly and run `applyReadTransforms` (casts,
then accessors; `:435-440`) on the result (`:556`, `:579`, `:679`; the write
paths do the same at `:1201`, `:1286`). With a scope they build a
`QueryBuilder` and return whatever `get()` hands back, and `QueryBuilder.ts`
does not contain the string `applyReadTransforms`. These calls return raw rows:

| Call | Path taken | Transforms |
|---|---|---|
| `Post.all()`, no scope | adapter `findMany` | yes |
| `Post.all()`, model mixes in `SoftDeletes` | `newQuery().get()` (`:551`) | **no** |
| `Post.where(...).get()` / `await Post.where(...)` | builder (`:701`) | **no** |
| `Post.orderBy(...)`, no scope | adapter (`:1031`) | **no**, even on the fast arm |
| `Post.paginate()`, either arm | adapter (`:1089`) or builder (`:1055`) | **no** |
| `Post.with('author')`, with `where` | builder (`:1383`) | **no** |
| every eager-loaded child row | `related.newQuery(...)` (`:1462`, `:1723`, `:1942`) | **no** |

A model declaring `casts = { meta: 'json' }` therefore gets `meta` back as an
object from `Post.find(1)` and as a string from `Post.where('id', 1).first()`.
`docs/en/guides/database.md:696-757` documents casts and accessors with no such
caveat, and the tutorial's own `Post` (`docs/en/tutorials/09-relationships.md`)
walks straight into the builder path the moment chapter 9 adds `with()`.

**The escape hatch drops the scopes.** `Model.query()` (`Model.ts:1336-1361`)
is documented as carrying "no model scopes, casts or accessors", and it is the
only way to join or to aggregate anything but a count: `WhereOperator`
(`QueryBuilder.ts:30`) has eleven operators and the builder's terminals are
`get`, `first`, `firstOrFail`, `count`, `paginate`, `update`, `delete`. The
first query that outgrows the builder is the first query that silently reads
soft-deleted rows and other tenants' rows; `docs/en/guides/api-resources.md:229`
ships that shape as the cursor-pagination example.

**Pagination exists twice.** `Model.paginate()` sanitises page and size,
counts, computes the offset and builds `meta` (`Model.ts:1061-1104`);
`QueryBuilder.paginate()` does it again (`QueryBuilder.ts:307-344`). They agree
by inspection, not by construction.

**Relations are declared three times with nothing linking them.** The blog's
`Post` (`examples/blog/app/Models/Post.ts`) says `authorId` references
`users.id` in `db/schema.ts:26`, then `static override relationTypes: { author:
BelongsToRecord<PostAuthorSummary> } = { author: null }` for the type side, then
`Post.belongsTo('author', () => import('./User.js').then(...), 'authorId',
'id')` after the class for the runtime side. The dummy value exists because a
`static` needs an initializer. Nothing checks that the three agree: the two
names can differ and the foreign key is a `string` at the call. Without
`relationTypes`, `RelationKeyOrString` collapses to `string` (`Model.ts:2011`)
and every relation name type-checks; with it, only the head of a dot path is
checked (`:1994-1999`), which `database.md:489` has to explain.
`packages/cli/src/model-parser.ts:374-503` reads both and prefers
`relationTypes`: the lazy `import()` thunk hides the related model's name.

**What is already in flight.** A bug-fix branch (`fix/review-orm-read-pipeline`)
is applying `applyReadTransforms` inside the builder paths as a patch, which
turns the table above all-yes with no API change. This RFC takes that as Part
0. The patch closes the symptom; the fork stays, and the next transform added
to one arm will be missing from the other. The rest is about removing the fork.

## Proposed Solution

One read pipeline: every static read on `Model` is a thin call into
`QueryBuilder`, which owns scopes, eager loading, pagination and the one point
where rows become records. `QueryBuilder` keeps its name: it is a public export
and the type of every `static scopes` entry, and a rename buys nothing here.

### 1. `QueryBuilder` owns materialisation

Every terminal that returns rows funnels through one method:

```ts
class QueryBuilder<TRecord, TResult = TRecord> {
  /** The one place a row becomes a record: casts, accessors, then eager loads. */
  private async materialize(rows: PlainObject[]): Promise<TResult[]> {
    const records = rows.map((row) => this.modelClass.applyReadTransforms(row))  // public @internal from Part 0
    return this.loadEagerRelations(records)
  }

  async get(): Promise<TResult[]>                 // executeQuery -> materialize
  async first(): Promise<TResult | null>          // limit 1 -> get
  async paginate(...): Promise<PaginatedResult<TResult>>  // count + get
}
```

Eager loaders already fetch children through `related.newQuery(...)`
(`Model.ts:1942`), so a child row is materialised by *its* model's builder.
Dropping the fast arm costs one builder allocation per call and no extra round
trip: `find()` issues one `findUnique` today, one `findManyAdvanced` with
`limit 1` through the builder.

Additions the statics need in order to delegate, and the ones `Model.query()`
users need in order to leave it:

```ts
// Ordering in every shape Model.orderBy() accepts today (Model.ts:61-68)
orderBy(field: FieldKey<TRecord>, direction?: OrderDirection): this
orderBy(input: OrderByInput<TRecord>): this

// Relation counts move over from Model.withCount(); with() and select() already exist
withCount(...relations: RelationKey[]): QueryBuilder<TRecord, TResult & RelationCountPick<...>>

// Aggregates. count() exists; the rest are one adapter method away.
sum(field: FieldKey<TRecord>): Promise<number>
avg(field: FieldKey<TRecord>): Promise<number>
min<K extends FieldKey<TRecord>>(field: K): Promise<TRecord[K] | null>
max<K extends FieldKey<TRecord>>(field: K): Promise<TRecord[K] | null>
exists(): Promise<boolean>        // select <pk> ... limit 1; never materialises

// The scoped escape to Drizzle (replaces Model.query(); see §6)
toSql(): SQL | undefined
toDrizzle<S extends SelectedFields>(selection?: S): DrizzleSelect<S>
```

The adapter side is one optional method shaped like `countAdvanced`:
`aggregateAdvanced?(table, conditions: WhereCondition[], { fn: 'sum' | 'avg' |
'min' | 'max', column }, queryOptions): Promise<unknown>`. `DrizzleAdapter`
implements it with `sql\`sum(${column})\`` and friends; without it, `sum()`
throws the "conditions the configured adapter cannot express" error
`executeQuery` throws today (`QueryBuilder.ts:535`), never a wrong number.

### 2. The statics that become delegations

Each becomes a one-line call into a scoped builder; signatures do not change.

| Static | Delegation |
|---|---|
| `all(opts)` | `newQuery(opts).get()` |
| `find(id, key, opts)` | `id === undefined ? null : newQuery(opts).where(key, id).first()` |
| `findOrFail` | `find` then throw, as today |
| `findWith(id, rels, key, opts)` / `findWithOrFail` | `newQuery(opts).with(rels).where(key, id).first()` |
| `first(where, opts)` | `newQuery(opts).where(where ?? {}).first()` |
| `where`, `whereNull`, `whereNotNull`, `whereIn`, `whereNotIn`, `select`, `scope` | already delegations, unchanged |
| `orderBy(order, where, opts)` | `newQuery(opts).where(where ?? {}).orderBy(order).get()` |
| `paginate(options, opts)` | `newQuery(opts).where(...).orderBy(...).paginate({ page, perPage })` |
| `withPaginate(rels, options, opts)` | same, with `.with(rels)` |
| `with(rels, where, opts)` | `newQuery(opts).where(where ?? {}).with(rels).get()` |
| `withCount(rels, where, opts)` | `newQuery(opts).where(where ?? {}).withCount(rels).get()` |

`Model.paginate()`'s own count-and-slice body (`:1058-1104`) goes; the builder's
is the one implementation. `TransactionModelScope` (`:271-283`) is a third copy
of the same list and becomes the same delegations with `{ trx }` bound.
`findUnique` and the where-clause form of `count` stop being called by `Model`
but stay on the public `ORMAdapter` interface; the builder's basic-adapter
fallback still uses `findMany` and `count`. `hasScopes()` is `protected static`
and reachable from subclasses, so it is kept and `@deprecated` until Part 3.

### 3. Scopes: one registry, applied once per builder instance

Nothing structural changes; the invariant is stated so Part 1 can test it.
`buildScopedQuery` (`Model.ts:767-781`) is the only place a scoped builder is
born: `defaultScope`, then the `GlobalScopeRegistry` entries minus `except`,
then `SEAL_SCOPES` so a later top-level `orWhere()` cannot fold the scopes into
its left arm (#732). Every delegation in §2 goes through it. The registry stays
per class, cloned on first write so a subclass inherits (`:304-310`);
`SoftDeletes` keeps registering only the named scope `softDelete`
(`SoftDeletes.ts:58-64`), so `withTrashed()` can drop it while a tenant scope
stays on. With the fast arm gone, "every read applies the scopes" holds by
construction rather than by five `if` statements.

### 4. One relation declaration

```ts
import { defineModel, belongsTo, hasMany, type WithRelations } from '@guren/orm'
import { User } from './User'                      // static import; the thunk below defers the cycle

export class Post extends defineModel(posts, { fillable: ['title', 'body', 'authorId'] }) {
  static relations = {
    author: belongsTo(() => User, 'authorId'),          // ownerKey defaults to 'id'
  }
}

export class User extends defineModel(users) {
  static relations = {
    posts: hasMany(() => Post, 'authorId'),             // localKey defaults to 'id'
  }
}
```

The descriptors are branded objects: the type carries the related model and
the key names, the value carries what `getRelationDefinitions()` needs:

```ts
export function belongsTo<Related extends typeof Model, FK extends string>(
  related: () => Related, foreignKey: FK, ownerKey?: keyof TRecordFor<Related> & string,
): BelongsTo<Related, FK>
export function hasMany<Related extends typeof Model>(
  related: () => Related, foreignKey: keyof TRecordFor<Related> & string, localKey?: string,
): HasMany<Related>
// hasOne, belongsToMany, hasManyThrough, morphMany, morphTo: same shape, the statics' parameters minus `name`
```

The thunk is what the current API already takes (`Model.ts:820`): two models
that point at each other cannot evaluate each other's class at module load. A
static `import { User }` plus `() => User` is enough; the examples' dynamic
`import()` existed because the call ran at module bottom, where the cycle
bites. The identifier staying in source is what lets `model-parser.ts` read
the related model's name from the runtime declaration.

The result type is inferred from the declaration. `BelongsTo` reads the
foreign key's nullability off the parent's own record, so
`BelongsToRequiredRecord` and the hand-written `| null` go away:

```ts
type RelationResult<T extends typeof Model, R> =
  R extends BelongsTo<infer Related, infer FK>
    ? null extends TRecordFor<T>[FK & keyof TRecordFor<T>] ? TRecordFor<Related> | null : TRecordFor<Related>
  : R extends HasOne<infer Related> ? TRecordFor<Related> | null
  : R extends HasMany<infer Related> | BelongsToMany<infer Related> | HasManyThrough<infer Related> | MorphMany<infer Related>
    ? TRecordFor<Related>[]
  : R extends MorphTo ? PlainObject | null
  : never

type RelationsOf<T extends typeof Model> = T extends { relations: infer R extends Record<string, RelationDescriptor> } ? R : {}

// Every segment of a dot path is checked, not only its head (depth-capped in the implementation).
type RelationPath<T extends typeof Model> = {
  [K in keyof RelationsOf<T> & string]: K | `${K}.${RelationPath<RelatedOf<RelationsOf<T>[K]>>}`
}[keyof RelationsOf<T> & string]

export type WithRelations<T extends typeof Model, P extends RelationPath<T>> =
  TRecordFor<T> & { [K in RelationHead<P>]: RelationResult<T, RelationsOf<T>[K]> /* tails recurse */ }

type PostWithAuthor = WithRelations<typeof Post, 'author'>
//   ^? PostRecord & { author: UserRecord }        (authorId is NOT NULL in the schema)
type UserWithPosts = WithRelations<typeof User, 'posts.author'>
//   ^? UserRecord & { posts: Array<PostRecord & { author: UserRecord }> }
```

`RelationTypesFor<T>` (`:2003-2007`) becomes "`relations` if declared, else
`relationTypes`", so Part 2 is additive: a model may carry either, and the
static `hasMany()`/`belongsTo()` methods keep working until Part 3. At runtime
`getRelationDefinitions()` reads `this.relations` (own property only, the
guard at `:529`) and converts each descriptor into today's `RelationDefinition`
on first use, so every loader in `Model.ts:1569-1903` is untouched; a foreign
key naming no column throws there with the model and relation name, where
today the adapter throws "unknown column" on the first query. `model-parser.ts`
gains a third source and prefers it; `guren model:list`, `spec:generate` and
the ER view need no other change. The relation name is the object key, so
there is no name to mismatch and no dummy value.

### 5. Transactions, as far as reads go

`newQuery({ trx })` is the only way a `trx` enters a read, and the builder
forwards it to every eager load (`QueryBuilder.ts:586-606`), which #744 needed.
With §2 every read passes through one constructor, and that is where an
ambient transaction handle belongs: `options.trx ?? currentTransaction()`. The
handle itself (an `AsyncLocalStorage` the adapter enters on `transaction()`)
is a separate bug fix and is not specified here. The one constraint added: it
must use the on-demand `import('node:async_hooks')` the adapter's nesting guard
already uses (`drizzle-adapter.ts:232-245`), or the Workers and Lambda bundles
gain an edge they cannot resolve.

### 6. Retiring `Model.query()`

```ts
// Today: raw and unscoped
const rows = await Post.query().where(gt(posts.id, cursor)).orderBy(asc(posts.id)).limit(21)

// Proposed: the model's conditions and scopes travel as a Drizzle fragment
const rows = await Post.where('id', '>', cursor)
  .toDrizzle({ id: posts.id, title: posts.title, author: users.name })
  .leftJoin(users, eq(posts.authorId, users.id))
  .orderBy(asc(posts.id))
  .limit(21)

const scoped = Post.newQuery().toSql()          // SQL | undefined, for a hand-built select
await db.select().from(posts).where(and(scoped, gt(posts.views, 100)))
```

`toSql()` renders `effectiveConditions()` through `buildDrizzleConditions`,
exactly what `findManyAdvanced` renders (`drizzle-adapter.ts:491`), so a scope
is applied the same way whether the query stays in the builder or leaves it.
`toDrizzle(selection?)` returns `db.select(selection).from(table).$dynamic()`
with that fragment applied as `.where()`. Two rules for the docs: rows out of
`toDrizzle()` are Drizzle's, not the model's (no casts, no accessors; after a
join they may not be model rows at all), and a further `.where()` on the
Drizzle side *replaces* the fragment (Drizzle keeps one `config.where`), so
conditions go on the model side or through `toSql()` and `and()`. Like
`Model.query()` it needs a Drizzle handle (`:2301-2307`).

### Part plan

- **Part 0 (patch, in flight):** `applyReadTransforms` runs inside the
  builder's terminals. Fixes the Problem table; changes no API.
- **Part 1 (minor, non-breaking):** §1 additions, §2 delegations, `hasScopes()`
  deprecated, `Model.paginate()`'s duplicate body removed. Tests: each §2
  static on a scoped and an unscoped model, asserting a `json` cast came back
  parsed and the scope reached the SQL.
- **Part 2 (minor, additive):** §4 descriptors, `WithRelations` inference,
  parser support, scaffold and docs on the new form; `relationTypes` and the
  static relation methods deprecated per the Migration Path.
- **Part 3 (next `@guren/orm` major, and `@guren/core` with it, since core
  re-exports the ORM by allowlist):** remove `Model.query()`, `relationTypes`,
  the static relation methods and `hasScopes()`; `findUnique` becomes optional
  on `ORMAdapter`. No major is planned (RFC 0022 says the same); Parts 0 to 2
  stand without it.

## Alternatives Considered

**Keep both paths and document them.** Rejected. The fork *is* the bug class:
the transforms were missing from one arm because there were two, and the next
read-time feature would have to be added twice again. Documenting "casts apply
to `find` but not to `where().get()`" is documenting a defect.

**Drop the Active Record statics and expose only the builder.** Rejected.
`.find(` / `.findOrFail(` appear in 49 files across `docs/en`, the scaffold
templates and the examples, the tutorial teaches them first, and every
`make:feature` controller calls them. Delegation keeps the surface and removes
the duplication, which is the point of §2.

**Use Drizzle's relational queries (`db.query.posts.findMany({ with })`) as
the pipeline.** `drizzle-orm` is pinned at `1.0.0-rc.4`, so RQB v2 is the
current API, and the factories already accept a `relations` option
(`postgres.ts:43-47`, `sqlite.ts:192`, `d1.ts:73`). What it gives for free is
real: one declaration against the schema (`defineRelations(schema, r => ({
posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id }) } }))`)
and nested `with` typed at every level with no phantom types of Guren's own.
What it costs: there is no hook for a global scope. RQB's `where` is per call
and per nesting level, so `SoftDeletes` and a tenant scope would have to be
restated at every `with` by every caller, the failure §6 exists to prevent.
Its rows are plain rows, so casts and accessors would run afterwards per level
by finding the model behind each nested table; `morphMany`/`morphTo` have no
RQB equivalent; and a declaration beside the schema needs a second parser for
`model:list` and the spec views. RQB is the right *loader* for typed nested
paths and the wrong *pipeline*: a later part can compile §4's `static
relations` into a `defineRelations` object and let the builder call RQB for
the eager-load step with scopes still applied by the builder. Not proposed
here because it makes eager loading Drizzle-only, and `ORMAdapter` is the one
seam that is not.

**A join DSL on `QueryBuilder`.** Not proposed: it would re-implement a third
of Drizzle's select builder; `toDrizzle()` reaches the real one, scope intact.

## Migration Path

Parts 0 and 1 change no signatures. Part 2 deprecates, Part 3 removes, in the
order `contributing/deprecation-policy.md` sets (announce, warn once per
process, register, CHANGELOG `### Deprecated`, codemod, remove after at least
two minors). Two entries in `packages/cli/src/deprecations.ts`:
`model-relation-types` (the `relationTypes` marker and the static
`hasMany()`/`belongsTo()`/... calls; `detect` is `detectModelStatic(cwd,
'relationTypes')`, the predicate `model-guarded` uses) and `model-query-raw`
(`Model.query()`; a text scan for `.query(` on a model class name, reported as
candidates for a human to read, since the receiver is only known at runtime).

Codemod `model-relations` in `codemods.ts`, scope for `guren upgrade`: a class
with `static (override|declare) relationTypes: { name: XRecord<...> }` plus
module-level `Class.hasMany|belongsTo|...(name, related, ...keys)` calls in the
same file, where `related` is an identifier, a `() => Ident` thunk, or the
`() => import('./X.js').then((m) => m.X)` shape the docs teach, becomes
`static relations = { name: fn(() => X, ...keys) }` with the member and the
calls deleted, a static `import { X }` added where the dynamic form was used,
and unreferenced `XRecord` type imports dropped. Reported for a human instead:
a `relationTypes` entry with no runtime call (the blog's `PostAuthorSummary`
narrowing), any other `related` shape, and `BelongsToRequiredRecord` on a
nullable column (the inferred type would widen). `Model.query()` is not
codemodded: the replacement selection is a decision per call site.

Docs and templates switch in Part 2: `database.md` §Relationships, tutorial
chapters 9 and 10, `packages/create-app/templates/blog/app/Models/*`,
`make-feature.ts` output, and the harness rule `orm-models.md`. The
`api-resources.md:229` example moves to `toDrizzle()` in Part 1, since it is
the shape that drops scopes today.

## Open Questions

1. **`select()` narrowing versus casts and accessors.** A cast on an omitted
   column is skipped. An accessor reading an omitted column (`fullName` from
   `firstName` + `lastName`, selecting only `id`) gets `undefined` inputs.
   Options: run accessors only when their columns are present (needs a
   declared dependency list), skip all accessors on a narrowed query, or type
   the result as the bare `Pick` and document that accessors do not apply to
   narrowed rows. Leaning to the last.
2. **Does `Model.query()` keep a scoped variant name?** `Post.query()` reads
   well. Part 3 could re-point it at `newQuery().toDrizzle()` rather than
   remove it, at the cost of a name that meant "raw" for two majors meaning
   "scoped" in the third. The alternative is deletion.
3. **Foreign-key names in `static relations`.** The static form cannot check
   the parent's foreign key against the parent's own columns (no `this` in a
   static initializer); a `defineModel(posts, { relations })` option could, as
   `fillable` is checked today. Ship both, or only the option?
4. **Inference across a cycle.** `Post.relations` mentions `typeof User` and
   `User.relations` mentions `typeof Post`. Inference only walks `recordType`,
   never the other side's `relations`, so it should resolve; TS7022 on a
   mutually inferred static is still the first thing Part 2 proves, with a
   type test in `packages/orm/tests/model.query.types.ts` on the blog pair.
5. **The write fork.** `update()`/`delete()` fork the same way for their where
   clause (`:1267`, `:1320`). Folding them into the builder is the same change
   as §2 and could ride in Part 1.
