# @guren/orm

## 2.5.0

### Minor Changes

- 9e1ce65: Apply `with()` constraint callbacks when eager loading

  `QueryBuilder.with()` accepts the object form
  `with({ posts: (q) => q.where('published', true) })` and stored each callback,
  but nothing ever read the stored map. Eager loading iterated only the relation
  names, so the callback silently did nothing and the relation loaded fully
  unconstrained, while the JSDoc advertised the feature as supported.

  Constraint callbacks now reach the query that fetches the relation, for every
  relation type (`hasMany`, `hasOne`, `belongsTo`, `belongsToMany`,
  `hasManyThrough`, `morphMany`, `morphTo`) on `get()`, `first()` and `paginate()`
  alike. The callback runs with the foreign-key filter already on the builder, so
  a `where()` narrows it, and on the same query options the relation would have
  used anyway — a constrained relation still loads on its parent query's
  transaction.

  Each object key constrains exactly the level it names, in any order: `posts`
  constrains the head, `posts.comments` constrains the leaf and leaves `posts`
  unfiltered, and listing both constrains both.

  Three behaviours are worth knowing, and are documented in the database guide:

  - A top-level `orWhere()` inside a callback _widens_ the query rather than
    narrowing it, since it ORs against the foreign-key filter. Group it to keep
    it contained. `morphMany` no longer trusts the query alone for this — it
    groups results on the morph type as well as the id, so a widened constraint
    can no longer attach another model's rows to a parent.
  - A `select()` must include the column the relation is keyed on, or the loader
    cannot match rows back to their parent and the relation loads empty.
  - Relations load with one batched query for all parent records, so `limit()`
    caps that whole query rather than applying per parent; and for `morphTo` the
    callback runs once per morph target, so it may only reference columns every
    target shares.

  Eager loading also no longer walks a relation path whose head another path
  already covers. Loading `posts` and `posts.comments` together used to fetch
  `posts` twice, and the second fetch replaced the very rows the first pass had
  attached children to — so whichever path ran last won. Only the longest path is
  walked now, which removes the redundant query and makes the result independent
  of the order the relations were named in.

  The static `Model.with()` is unchanged — its second argument filters parent
  records, not the relation.

  `@guren/core` is bumped alongside because it re-exports ORM types through an
  explicit allowlist, and `EagerLoadConstraint` was added to it. Core's dependency
  range on `@guren/orm` is a caret that already admits the new minor, so nothing
  would otherwise put core in the release plan and the new type would never reach
  `@guren/core` users.

- 7251560: Eager-loaded relations now run on the transaction that read their parents.

  `QueryBuilder` carried its `trx` into the parent query but not into the relation
  queries `with()` issues, so a transaction-bound `get()`, `first()` or
  `paginate()` read parents inside the transaction and their relations on the
  pool. On Postgres and MySQL, where the transaction selects a connection, that
  means relations of uncommitted parents came back `null` (or empty), and reads
  could be inconsistent even when they did not.

  `Model.loadRelationInto()` and every relation loader it delegates to
  (`belongsTo`, `hasMany`, `hasOne`, `belongsToMany`, `hasManyThrough`,
  `morphMany`, `morphTo`, and nested-path recursion) now accept
  `ModelQueryOptions` and pass it to each related query, including the pivot and
  through-table reads. `QueryBuilder` forwards its own `trx`.

  `Model.with()`, `findWith()`, `findWithOrFail()`, `withPaginate()` and
  `withCount()` gained an optional trailing `queryOptions` argument so they can
  forward a transaction too. These five previously took no query options at all,
  so this completes the plumbing rather than fixing a reachable bug in them.

### Patch Changes

- 866919c: Load eager relations in `QueryBuilder.paginate()`

  `Post.newQuery().with('author').paginate({ page, perPage })` returned the page
  without `author` on any row. `get()` and `first()` both run their rows through
  the builder's eager loader, but `paginate()` returned the adapter's rows as-is,
  so a `.with()` on the chain was accepted and then silently dropped. The blog
  blueprint's `PostController.index` uses exactly this chain, which is why its
  posts index never received `author` and `PostResource.whenLoaded('author')`
  omitted it without an error.

  `paginate()` now attaches every relation named on the builder, the same way
  `get()` and `first()` do. `Model.withPaginate()` was the working alternative all
  along and is unchanged.

- 32e03dd: Load a relation shared by several eager-load paths exactly once

  `with('posts.comments', 'posts.tags')` walked each path independently, so the
  shared `posts` head was loaded twice and the second pass replaced the very row
  objects the first had attached children to. Only the last-named path survived,
  with no error raised. Eager-load paths are now grouped by their head segment
  and each level is loaded once, so sibling branches all land on the same records
  regardless of the order they are named in. The same fix applies to
  `Model.with()`, `findWith()`, `findWithOrFail()` and `withPaginate()`, which
  had the same defect.

- 39b17e7: Reject a connection URI where the SQLite driver expects a file path

  `createSqliteDatabase()` treats its `filename` as a path, and creates the
  directory above it with `mkdir -p`. So a connection string handed to a SQLite
  app did not fail — it _succeeded_. `postgres://guren:guren@localhost:54322/guren`
  became a real `postgres:/guren:guren@localhost:54322/` directory tree with a
  real database inside it, and `db:migrate` and `db:status` then agreed with each
  other about that stray file. The only symptom was that the database the app
  actually reads stayed empty, which reads as "migrate claims success but does
  nothing" rather than "migrate wrote somewhere else". A SQLite-backed Nightly
  Canary failed this way for two weeks.

  The resolved filename is now rejected when it names a database server, before
  the `mkdir` runs:

  ```
  createSqliteDatabase() received a connection URI where it expects a file path:
  postgres://guren:guren@localhost:54322/guren (from DATABASE_URL). Left alone it
  would be created as a directory tree and migrated into silently.
  ```

  The check is on the resolved value rather than on the option, so it also covers
  the `filename`-less path, where the driver falls back to `process.env.DATABASE_URL`
  — an ambient Postgres URL that a SQLite app never meant to consume is the
  likeliest way to hit this, and the option is not involved.

  Rejected are `postgres://…`, `mysql://…`, `libsql://…` and anything else naming
  a server. Filenames are not, and that includes two shapes a plain authority
  check would have swept up: `file:` is sqlite's own URI scheme and never
  addresses a server, so `file:///absolute/path.db` keeps working alongside
  `file:local.db` and `file::memory:`; and a one-letter scheme is a Windows drive
  rather than a scheme, so `C://data/app.db` keeps working alongside
  `C:/data/app.db`. Plain `:memory:`, `./data/guren.db` and absolute paths were
  never in scope.

## 2.4.0

### Minor Changes

- 7b34556: `resetDatabase()` now re-applies migrations after dropping, matching `guren db:reset`

  The Postgres, MySQL, SQLite, and Aurora Data API factories dropped every table
  and stopped there, so the next query failed with `relation "posts" does not
exist` — far from the reset that caused it. `resetDatabase()` now migrates
  afterwards and leaves a migrated database, the same end state the CLI's
  `db:reset` produces.

  Suites already following the documented reset-then-migrate pattern keep
  working: the second `migrateDatabase()` call sees an up-to-date tracker and
  no-ops. D1 is unchanged — its resets go through wrangler.

- b7b2b09: `where(callback)` and `orWhere(callback)` compose parenthesized condition groups, Laravel's `where(fn ($q) => ...)`.

  Until now `orWhere()` always pushed a top-level OR, so "(title LIKE ? OR excerpt LIKE ?) AND published = true" was inexpressible from application code — any AND filter next to an OR keyword chain (a published flag, tenancy, soft deletes) was silently OR'd away. The callback form collects conditions on a nested builder and folds them into a single group AND-ed with the rest of the query (`orWhere(callback)` ORs the whole group instead). Sequential semantics inside the callback match the top level: `.where(a).where(b).orWhere(c)` reads `(a AND b) OR c`, and callbacks nest. Groups render through the existing Drizzle condition tree, verified against the real sqlite driver alongside SoftDeletes and global scopes.

  The blog starter's `posts.search` action now groups its keyword OR chain this way, so filters added after it apply to every match.

## 2.3.0

### Minor Changes

- dd9a5df: Add per-dialect drizzle barrels: `@guren/orm/drizzle/pg`, `@guren/orm/drizzle/mysql`, and `@guren/orm/drizzle/sqlite`, each re-exporting its dialect's builders wholesale (plus `sql`).

  The mixed `@guren/orm/drizzle` barrel exports both dialects into one namespace, so `varchar` resolves to the MySQL builder — a Postgres schema using it type-checks and then throws `TypeError: colBuilder.buildExtraConfigColumn is not a function` at import time. The barrel was also missing builders every real schema needs (`index`, `primaryKey`, `pgEnum`, `unique`, `numeric`, `date`, …), forcing split imports from `drizzle-orm/pg-core`.

  The mixed barrel is unchanged for compatibility; its MySQL exports (`mysqlTable`, `int`, `varchar`, `datetime`) are now marked `@deprecated` pointing at `@guren/orm/drizzle/mysql`.

## 2.2.2

### Patch Changes

- e38ac75: Apply global scopes to `Model.update()`, `forceUpdate()`, and `delete()`

  Read entry points (`all`, `find`, `first`, `where`, `paginate`, …) route through
  the scope-applying builder, but the static write shortcuts did not: `update()`,
  `forceUpdate()`, and `delete()` forwarded the caller's `where` straight to the
  adapter, dropping every global scope. The docs recommend global scopes for
  multi-tenancy ("any filter that should always be active"), so a tenant scope that
  isolated reads still let one tenant update or delete another tenant's row — the
  row was hidden from `find()` yet writable by id.

  These three now add the model's scopes to the write, the same way reads do. The
  already-prepared payload is threaded through a symbol-keyed builder terminal so
  mutators and casts still run exactly once (routing it through the fluent
  `update()` would have re-run them, e.g. double-hashing a hashed column). The
  symbol is not re-exported from the package entry point: a named public method
  there would have been a supported way to write arbitrary columns, since it
  skips both mass-assignment filtering and payload preparation.
  `withoutGlobalScope()` / `withoutGlobalScopes()` remain the explicit opt-out.

  The fluent form (`Post.where({ id }).update(data)`) was already scoped and is
  unchanged. Soft-delete's own `delete`/`restore`/`forceDelete` carry the same
  class of gap and are addressed separately, since restoring a trashed row needs to
  drop only the soft-delete filter while keeping the tenant scope.

- 5e38d18: Apply global scopes to `SoftDeletes`' `delete()`, `restore()`, and `forceDelete()`

  The companion to the fix for the static write shortcuts: the `SoftDeletes` mixin
  overrides all three, and each forwarded the caller's `where` straight to the
  adapter, dropping every global scope. On a multi-tenant app with a `tenant`
  scope, `delete()` soft-deleted, `restore()` un-deleted, and `forceDelete()`
  _permanently_ removed another tenant's row — the sharpest of the three, since a
  hard delete cannot be undone. `withTrashed()` and `onlyTrashed()` had the mirror
  of the same bug: they dropped every scope to escape the soft-delete filter, so
  they returned other tenants' trashed rows.

  The three writes now run through the scope-applying builder. `delete()` uses the
  full scope set, so it marks only a live row the current scopes can see;
  `restore()` and `forceDelete()` drop the `softDelete` scope alone, reaching
  trashed rows while a tenant scope keeps them in bounds. `withTrashed()` /
  `onlyTrashed()` do the same, which makes the documented equivalence between
  `withTrashed()` and `withoutGlobalScope('softDelete')` literally true for the
  first time.

  Two supporting changes made that possible:

  - The mixin no longer registers its filter as `defaultScope` in addition to the
    named `'softDelete'` scope. `withoutGlobalScope()` re-applies `defaultScope`,
    so the double registration made the filter unremovable by name. `defaultScope`
    is therefore gone from the `SoftDeletesStatic` type (re-exported from
    `@guren/core`); reading `Post.defaultScope` still compiles through `Model`'s
    own optional declaration, but calling it unguarded no longer does.
  - A subclass that registers its own scope now seeds its registry from the
    inherited one instead of starting empty. Without this,
    `class Post extends SoftDeletes(Base)` followed by
    `Post.addGlobalScope('tenant')` silently dropped the inherited `softDelete`
    filter — masked until now by the `defaultScope` registration above. The copy
    is a snapshot: scopes added to a parent after a subclass first registers or
    removes one do not propagate.

  Two visible behavior changes: `Post.delete({ id })` on an already-trashed row is
  now a no-op rather than refreshing `deletedAt`, since the soft-delete scope
  excludes it; and `withTrashed()` / `onlyTrashed()` no longer return rows that
  other global scopes exclude. The mixin's `delete` override still bypasses the
  `deleting` / `deleted` hooks, exactly as before.

## 2.2.1

### Patch Changes

- de3298b: Stop a superseded connection attempt from evicting a newer one

  Every database factory memoizes its connection and migration handle in a
  promise, clearing it on rejection so the next caller retries. The clear was
  unconditional, so a rejection arriving after `closeDatabase()` (or
  `resetDatabase()`) had already dropped the handle and a newer attempt had
  replaced it would evict that newer attempt — a second connection where one was
  expected. Clearing now happens only while the cell still holds the attempt that
  failed. The five drivers share one internal `singleFlight()` helper instead of
  hand-rolling the pattern eight times.

- 19f7119: Stop concurrent callers from opening a second SQLite handle

  `createSqliteDatabase()` was the one driver still memoizing its connection by
  hand, and the check ran five awaits before the memo was written — so two callers
  arriving together both opened a client, ran `PRAGMA journal_mode = WAL` on it,
  and the second overwrote the first. `closeDatabase()` only ever closes the
  client it can still see, leaving the first one open for the life of the process.
  The connection now shares the `singleFlight()` helper the other four drivers
  already use, so one attempt serves every caller that races it.

## 2.2.0

### Minor Changes

- 80ef7b1: Refuse, rather than silently drop, conditions the adapter cannot express

  On an adapter implementing neither `findManyAdvanced` nor `countAdvanced`,
  `QueryBuilder` flattened its conditions into a simple where-object and passed
  `where: undefined` whenever that conversion failed — discarding every condition,
  global scopes included, and returning the whole table. It now throws.

  This is a **runtime behavior change beyond the global-scope fix it came from**,
  which is why it is a minor rather than a patch. The conversion fails for more
  than the exotic cases: every comparison operator (`>`, `<`, `>=`, `<=`, `!=`,
  `like`), `not in`, `is not null`, and any `orWhere` group. So on such an adapter
  `Post.where('views', '>', 100).get()` now throws where it previously returned
  rows — rows that were unfiltered, and therefore wrong, but returned.

  The shipped `DrizzleAdapter` implements both methods and never reaches this
  path. Custom adapters and hand-rolled test doubles are what this affects; the
  fix is to implement `findManyAdvanced`/`countAdvanced`.

### Patch Changes

- 80ef7b1: Apply global scopes on every query entry point, not just four of them

  `defaultScope` and the `addGlobalScope()` registry were applied by `newQuery()`,
  and by `all()` / `find()` / `first()` which branch into it. Every other entry
  point skipped them: `where()` and its `whereNull` / `whereNotNull` / `whereIn` /
  `whereNotIn` / `select` / `scope` siblings constructed a bare `QueryBuilder`, and
  `orderBy()` / `paginate()` called the adapter directly. The relation loaders go
  through `where()`, so eager loading dropped the _related_ model's scopes too.

  The docs present global scopes as a filter that always applies, name
  multi-tenancy as the first use case, and state that `where()` is covered — so an
  app following the documented pattern got no tenant isolation on the most common
  entry point. `SoftDeletes` is implemented as a global scope and inherited every
  hole, which is how a scaffolded `index()` — `make:feature` generates it as
  `Model.paginate(...)` on a route with no auth — served soft-deleted rows.
  `paginate()` leaked the unscoped row count through `meta.total` as well.

  All of these now route through the scope-applying builder. `newQuery()` with no
  scopes registered constructs exactly what the bare builder did, so an app that
  uses no global scopes is unaffected. `withoutGlobalScope(s)` remains the way out.

- 80ef7b1: Refuse a query whose conditions collide on a scoped column

  On an adapter without `findManyAdvanced`/`countAdvanced`, conditions are
  flattened into one where-object, so a second condition on a field overwrote the
  first. A global scope pinning `tenantId` was therefore replaced by a caller's own
  `where('tenantId', …)` — the filter meant to enforce isolation handed back
  another tenant's rows. Only a repeat of the same value collapses now; a genuine
  conflict throws, like the operators that already cannot be flattened.

## 2.1.0

### Minor Changes

- fe70ee7: Add typed allowlist options to `defineModel`: `fillable`, `hidden`, `visible`, `accessors`, and `appends` can now be passed as options, checked at compile time against the table's columns (and, for `fillable`, fields contributed by the `base` such as `AuthenticatableModel`'s virtual `password`). Accessor functions receive the table's inferred record, and `appends` may only name declared accessors. `static` declarations keep working and shadow the options. `guren audit` and `guren check` recognize the option form with the same shadowing order.

## 2.0.0

### Major Changes

- cda337b: Structural mass-assignment protection (RFC 0006).

  BREAKING CHANGE: `Model.guarded` and `Model.strictFillable` are removed.
  `fillable` is the single allowlist and is always strict; the primary key
  (`id`) is always silently stripped from mass-assignment input. Models can
  contribute always-denied fields via the new `deniedFields()` hook —
  `AuthenticatableModel` denies its resolved password-hash and remember-token
  columns (new `rememberTokenField` static), so a request body carrying them
  throws a `MassAssignmentException` (new `reason: 'denied' | 'not-fillable'`
  property) regardless of `fillable`. Use `forceCreate()`/`forceUpdate()` for
  trusted server-side values such as `passwordHash: 'oauth:...'`.

  `ModelUserProvider` now reads credential column names from the model contract
  (`resolvePasswordHashField()`/`resolveRememberTokenField()`, now public) when
  the target extends `AuthenticatableModel`; explicit options remain as
  overrides. `AuthManager.useModel()` no longer hardcodes them.

  `defineModel()` drops the deprecated `createType` option (use
  `optionalOnCreate`/`requireOnCreate`), and `AuthenticatableModel.createType`
  no longer widens to `PlainObject` — models extending it directly should
  declare their own `createType`; `defineModel()`-based models are unaffected.

  CLI: `make:auth` stops emitting the now-redundant `guarded` line;
  `guren check` fails on models declaring `guarded`/`strictFillable` and on
  `fillable` listing a denied credential column; `guren audit` recognizes
  structurally protected auth models and warns when a controller method mixes
  `validateBody` with `forceCreate`/`forceUpdate`; `guren upgrade --check-only`
  detects the removed statics.

### Minor Changes

- 63fd323: Let `defineModel()` reshape the inferred create payload without a cast.

  `defineModel(table)` infers `createType` from the table, which requires every
  non-defaulted column — the wrong shape for a model that fills a column in
  itself. `AuthenticatableModel` is the standing example: it hashes a plain
  `password` into `passwordHash`, so callers pass the former and not the latter,
  and until now the only way to say so was to skip `defineModel()` entirely and
  redeclare the type markers by hand.

  Two type-level options replace that:

  ```ts
  export class User extends defineModel(users, {
    base: AuthenticatableModel,
    optionalOnCreate: ["passwordHash"],
    requireOnCreate: ["password"],
  }) {
    static guarded = ["id", "passwordHash", "rememberToken"];
    static override hidden = ["passwordHash", "rememberToken"];
  }
  ```

  `optionalOnCreate` makes columns optional — they keep their type, callers just
  need not supply them. `requireOnCreate` goes the other way, accepting both
  table columns (Drizzle marks defaulted ones optional) and named fields
  contributed by `base`. Both are checked against the real keys, so a typo fails
  to compile, and neither has a runtime effect. Neither closes the payload
  either: a create type always admits unknown keys as `unknown`, so
  `fillable`/`guarded` remain what reject an unwanted field at runtime.

  `make:auth` now generates this shape — with `requireOnCreate` only when
  password sign-up is the sole way in, since OAuth accounts are created without
  one — and guards `passwordHash` against mass assignment, which the scaffolded
  model previously left on its default.

  The `createType` option is deprecated in favour of these: it needs a value to
  infer from, which is exactly the cast this removes. It still works, and
  `defineModel<TTable, TBase, TCreate>()` still means what it did — the two new
  type parameters go after `TCreate`, not before it.

  Also fixes `guren audit`: its sensitive-column check resolved a model's table
  only from `static table = users`, so it silently skipped any model written as
  `defineModel(users, …)` — including every model this release migrates.

- e2c82da: Type the seeder context against the app's own database dialect

  `SeederContext.db` was hard-typed as `PostgresJsDatabase`, so every seeder was
  typed against PostgreSQL no matter which database the app configured. On MySQL
  and SQLite that made the seeder reject its own `db/schema.ts` — `db.insert()`
  does not accept a `mysqlTable`/`sqliteTable`, and `.onDuplicateKeyUpdate()` is
  not a method on the PostgreSQL insert builder at all. The runtime was always
  fine: the callback receives the real database.

  It was invisible in the default scaffold because `db/` was outside the app's
  `tsconfig.json` `include`, but not everywhere — the API-only template already
  typechecks `db/`, so `guren add auth` on a `--db mysql` API app failed
  `bun run typecheck` on the seeder it had just generated.

  `SeederContext` and `SeederHandler` are now generic over the database, with the
  same `PostgresJsDatabase` default as before, so existing seeders keep compiling.
  `PostgresSeederContext`, `MySqlSeederContext`, `SqliteSeederContext`, and
  `AwsDataApiSeederContext` are exported for the other drivers that seed (D1 does
  not — its `seedDatabase()` throws), and scaffolded apps re-export the one they
  configured from `config/database.ts` as `AppSeederContext`:

  ```ts
  import { defineSeeder } from "@guren/core";
  import type { AppSeederContext } from "../../config/database.js";

  export default defineSeeder(async ({ db }: AppSeederContext) => {
    /* ... */
  });
  ```

  `guren add auth` and `make:seeder` now annotate what they generate, and `db/`
  joined the default template's `tsconfig.json` `include` so the generated
  seeders and schema are actually typechecked. `runSeeders()` and `loadSeeders()`
  accept any dialect's database, which drops the casts the MySQL, SQLite, and
  Aurora Data API drivers needed.

### Patch Changes

- d7e80fe: Identify hot-reload owners correctly when a path or a function name contains
  parentheses

  Under `bun --hot`, both packages key what a reload must tear down — timers for
  cache stores, schedulers, rate limiters and broadcast managers; clients for
  database connections — on the file that built it, read out of a stack frame
  whose location is wrapped in parentheses: `at make (/app/x.ts:3:1)`.

  `@guren/server` could not read that shape at all when the path itself
  contained parentheses, which is an ordinary macOS directory name
  (`~/Projects (2024)`). The rejected frame was not simply lost: the frame walk
  falls through to the next frame that does parse — a _different_ file, further
  out — so two owners reached from one place shared a slot, and building the
  second stopped the first's live timer.

  `@guren/orm` could read a path with parentheses, but by taking the frame's
  _leftmost_ `(` — which gets the wrong pair when the _function name_ in front
  of the location has parentheses instead. Bun emits exactly that shape for a
  method whose key carries them: `at weird (name) (/app/x.ts:3:1)`. Leftmost
  matching reads that as `name) (/app/x.ts`, which is not a path but is stable
  enough to be used as a key — worse than losing the frame, because on the
  server side the same rule also swallows the `unknown` marker of an implicit
  constructor, defeating the filter that stops every such owner from collapsing
  into one slot.

  Neither the leftmost nor the rightmost `(` is right in general — a path with
  parentheses needs the first, a function name with parentheses needs the last.
  Both packages now find the location by scanning back from the frame's final
  `)` and counting nesting depth, so it is bounded by whichever parenthesis
  actually matches it. Frames without parentheses in either position parse to
  exactly what they did before.

  An `eval` frame — `at eval (eval at <anonymous> (/app/x.ts:1:2), <anonymous>:1:1)`
  — is now rejected outright rather than read as a path: the location it
  contains belongs to the `eval` call site, not to the owner under construction,
  and using it as a key would drift on any edit to the line the `eval` occurs
  on. An owner with no key is left alone, which is the safe failure everywhere
  else in these registries.

- df90e04: Stop keying a hot-reload database handle to a stack frame that names no file.

  Under `bun --hot`, a handle built by `createPostgresDatabase()` and friends is
  identified by the file that built it, read from frame 2 of a captured stack. But
  JSC synthesizes frames for code nobody wrote and reports them with a location
  like any other frame: a class carrying a field initializer, or a subclass that
  declares no constructor of its own, appears as `at new Owner (unknown:1:17)`, and
  a built-in doing the calling appears as `at map (native:1:11)`. Reading one of
  those as the caller keyed every such handle in the process to the literal string
  `unknown`, collapsing handles opened from unrelated files into one registry slot
  where each new one closes the previous one's live connection.

  `describeCallerFile()` now walks outwards from frame 2 to the first frame that
  names a real file, skipping `unknown`, `native`, and `<anonymous>` — and still
  returns nothing when every frame is synthetic, so the handle is left alone rather
  than given a key that is wrong. Nothing in the framework hit this, because each
  factory is a plain function called from module scope; `class Database { db =
createPostgresDatabase({ url }) }` in an application was enough to.

  The walk also steps over host frames the engine leaves without a location at all,
  which Bun emits for a callback a built-in invoked (`at replace (unknown)`). Those
  previously stopped the read at frame 2 and produced no key, so such a handle was
  never reclaimed across a reload; it now resolves to the file that opened it.

  The equivalent registry for hot-reloaded timer owners already guarded this; the
  ORM's registry now does too.

## 1.3.0

### Minor Changes

- a7aec95: Add `createAwsDataApiDatabase()` for Aurora Serverless v2 via the RDS Data API.

  The factory mirrors the other database factories (`getDatabase`, `migrateDatabase`,
  `configureOrm`, `seedDatabase`, `resetDatabase`, `migrationStatus`) on top of
  `drizzle-orm/aws-data-api/pg`. The Data API is HTTP-based, so Lambda apps get a
  Postgres-compatible connection without a connection pool, RDS Proxy, or VPC
  placement. Connection settings resolve from options or the `DATABASE_NAME`,
  `DATABASE_RESOURCE_ARN`, and `DATABASE_SECRET_ARN` environment variables;
  `@aws-sdk/client-rds-data` is an optional peer dependency. Unlike the other
  factories, `getDatabase()` does not run pending migrations automatically —
  on Lambda that check costs serialized Data API round trips on every cold
  start. Run migrations out of band, or opt back in with `migrateOnStart: true`.

### Patch Changes

- 7d18f07: Name the real cause when a database command fails, and give container-backed apps `db:up`/`db:down`

  `db:migrate` against a database that is not reachable used to report `Failed to
run database migrations: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"` —
  the migrator's own bookkeeping statement, not anything the user wrote. The
  driver's `ECONNREFUSED` lived on the error's `cause`, which was discarded. It now
  reports `cannot connect to the database at localhost:54322 (ECONNREFUSED). Is it
running and accepting connections?`, with the host and port only so the
  connection string's credentials stay out of the log. Genuine SQL failures now
  carry the driver's message alongside the query instead of the query alone.

  Three sibling commands had the same blind spot. `db:status` caught an unreachable
  server in the branch written for "the tracker table does not exist yet", so it
  reported every migration as pending and exited 0 — indistinguishable from a
  healthy database with nothing applied; it now fails with the connection error.
  `db:reset` rethrew the driver error untouched, and a message-less
  `AggregateError` printed as a bare `ERROR` line with nothing after it. `db:seed`
  reported the failing statement without the driver's explanation of why it failed.

  Scaffolding with PostgreSQL or MySQL also writes `db:up` and `db:down` scripts
  next to the generated `docker-compose.yml`, so starting the database is
  discoverable from `package.json`. The selected driver is no longer listed in both
  `dependencies` and `devDependencies`, which made `bun install` warn about a
  duplicate dependency on the first command a new project runs.

  The AI agent harness that `agent:init` installs is updated to match: its database
  skill pointed agents at a `db:logs` script that nothing scaffolds, and handed
  container commands to SQLite projects, which have no container.

- f448a0a: Fix `createMySqlDatabase()`, which failed on every query

  Any statement against a MySQL app — including the first one `db:migrate` runs —
  threw `undefined is not an object (evaluating
'client.config.supportBigNumbers = !0')` before touching a socket, so MySQL was
  unusable even though `create-guren-app --db mysql` offers it. Passing a
  connection to `drizzle()` makes it build the pool through `mysql2/promise`,
  whose wrapper exposes no `config` object for the driver to write that flag onto.
  The ORM now creates the pool itself with `mysql2`'s callback API and hands
  drizzle a client, matching how the PostgreSQL helper already works, and closes
  that pool directly instead of reaching for drizzle's `$client`.

## 1.2.0

### Minor Changes

- 360d1f4: Added `createD1Database` — the Cloudflare D1 factory (RFC 0003 Part 2), alongside the postgres/mysql/sqlite factories and re-exported from `@guren/core`. It takes a deferred `binding` resolver (`binding: () => getWorkersEnv<Env>().DB` — bindings reach runtime-portable app code via the plugin's write-once holder, populated on the first request) and wires `drizzle-orm/d1` into the ORM adapter. D1 speaks the SQLite dialect, so schemas written for `createSqliteDatabase` port unchanged.

  The operational surface is deliberately different from the other factories: `migrateDatabase()`, `seedDatabase()`, `resetDatabase()`, and `migrationStatus()` throw with guidance instead of executing — wrangler owns the D1 migration lifecycle (`wrangler d1 migrations apply` over the same drizzle-kit-generated SQL files, `migrations_dir` pointing at `db/migrations`). The drizzle-kit SQL format contract (statement-breakpoint separators, filename ordering, idempotent re-apply) is covered by an opt-in end-to-end test against wrangler's local D1 (`GUREN_TEST_WRANGLER=1`).

### Patch Changes

- a2c7b8c: Fixed a database connection leak under `bun --hot`. Each hot reload re-runs the module graph in the same process, so `createPostgresDatabase()`, `createMySqlDatabase()`, and `createSqliteDatabase()` opened a fresh client while the one the previous evaluation opened stayed connected with nothing left to close it — roughly one leaked connection per reload, which exhausts a default Postgres `max_connections` over a long dev session. The factories now park their teardown on a `globalThis` registry (the same approach `Application.listen()` already uses for the Bun and Vite dev servers) and close the previous client before serving from the new one.

  This only applies under `bun --hot`. A handle is identified by the file that built it and the database it points at, so it is replaced only by a later evaluation of that same file. Nothing is ever torn down automatically in production, tests, CLI commands, or serverless. The one thing to know: two handles built in a single file against a single database — separate pools for web requests and background jobs, say — share that identity under `--hot`, so the second replaces the first. Give them their own module to keep them apart.

  As part of this, `closeDatabase()` on a SQLite database now actually closes the underlying `bun:sqlite` handle instead of only dropping its reference.

- d5d0c5b: Fixed the `bun --hot` connection registry truncating call-site paths that contain a space or parentheses. The stack frame naming the caller was parsed with a pattern that excluded both characters from the path, so a project under `/Users/me/My Projects` was recorded as `Projects/app/config/database.ts`.

  The truncation was deterministic, so the key stayed stable across reloads and connection replacement kept working. What it cost was identity: a registry slot is keyed by driver, caller file, and connection target, so two call sites that truncate to the same path — two apps in one monorepo booted by a single dev process, pointed at one database — would share a slot, and the second would close the first's live connection. Frames are now matched by shape (`at fn (/path/file.ts:1:2)` and the bare `at /path/file.ts:1:2`) with nothing excluded from the path itself.

## 1.1.0

### Minor Changes

- 0c01602: Accept dot-notation nested relation paths (`with('comments.author')`) in the type signatures of `with()`, `findWith()`, `findWithOrFail()`, and `withPaginate()` — the runtime already supported them. Add `BelongsToRequiredRecord<T>` for belongsTo relations backed by a NOT NULL foreign key, so `relationTypes` can declare the parent as non-nullable (use the `declare` modifier to skip the runtime placeholder).

## 1.0.1

### Patch Changes

- bc79a6a: `QueryBuilder.firstOrFail()` now throws `ModelNotFoundException` (rendered as HTTP 404) instead of a plain `Error` (which rendered as 500), matching `Model.findOrFail()`.

## 1.0.0

### Major Changes

- 73d311c: v1.0 Release Candidate

  New subsystems: OAuth, MySQL adapter, typed broadcasting, OpenAPI generation,
  production error pages, request ID/logging middleware, plugin test harness,
  API-only and worker starter kits.

  DX: Golden path standardization, doctor autofixes, CLI consistency,
  upgrade productization, security defaults.

  Quality: Playwright E2E, CI matrix, nightly canary, benchmarks,
  smoke tests for all starter kits.

  Docs: Task-completion guides (en/ja), plugin authoring guide,
  deployment recipes (Docker, Fly.io, VPS, serverless).

  Governance: API stability tiers, deprecation policy, SemVer guidance,
  RFC process, release cadence, issue triage SLAs.

### Minor Changes

- a1fc6ec: Two security defaults locked in ahead of 1.0:

  - **Strict mass assignment.** When a model defines `fillable`, `create()`/`update()` now throw a `MassAssignmentException` naming any field outside the allowlist instead of silently discarding it (silent drops surfaced as NOT NULL violations far from the cause, and masked injection attempts). Use the new `forceCreate()` / `forceUpdate()` for trusted server-side data, or set `static strictFillable = false` per model to restore the old behavior. The `guarded` path is unchanged.
  - **`auth.user()` never exposes credentials.** The session guard sanitizes user records before caching or returning them: the password column, remember-token column, and the model's `static hidden` fields are stripped. Credential checks still run on the raw record internally, so login and remember-me behave exactly as before — but sharing `auth.user` into Inertia props no longer leaks `passwordHash` to the browser. Custom user providers can opt in via the new optional `UserProvider.sanitize()`. `guren add auth` now generates the User model with `static hidden = ['passwordHash', 'rememberToken']`.

- f7de890: Final API freeze pass before 1.0, driven by an adversarial pre-release review:

  - **`QueryBuilder.update()` now enforces the fillable allowlist** exactly like `Model.update()` (it previously bypassed mass-assignment protection entirely); `QueryBuilder.forceUpdate()` is the trusted-data escape hatch.
  - **Redis stores are now importable**: `@guren/core/redis` (and `@guren/server/redis`) ship `RedisSessionStore`, `RedisRateLimitStore`, `RedisSlidingWindowRateLimitStore`, `RedisApiTokenStore`, `RedisPasswordResetStore`, `RedisEmailVerificationStore`, and the new `RedisOAuthStateStore`. The default `MemoryOAuthStateStore` is now bounded (10k entries with expiry sweep) to prevent memory-exhaustion DoS.
  - **`PaginationMeta` name collision resolved**: the ORM's pagination meta is now `ModelPaginationMeta`; `PaginationMeta` from `@guren/core` unambiguously refers to the resource/paginator shape.
  - **React is a peer dependency**: `@guren/inertia-client` moves `react`/`react-dom` to peerDependencies, and `@guren/server` makes `@guren/inertia-client` an optional peer — API-only apps no longer pull React transitively.
  - **`@guren/testing/vitest` subpath**: vitest/React helpers move out of the root barrel so `bun:test` users don't need the React test stack; the related peer deps are marked optional.
  - **`Hash` is runtime-safe**: it now points at `DefaultHasher`, which delegates to Bun's scrypt on Bun and the Node implementation elsewhere (Lambda on Node no longer crashes).
  - Smaller freeze items: `ApplicationOptions`/`AuthPluginOptions` exported, unimplemented `Command.callSilent()` removed, `FormRequest` marked `@deprecated`, `MemoryQueueDriver`/`SyncQueueDriver`/`RedisQueueDriver` aliases added, internal ORM plumbing removed from the `@guren/core` allowlist, `nodemailer` bumped to v9 (HIGH advisory), stray `./dist/*` export wildcard removed.
  - **Docs**: broadcasting client flow rewritten around the `connected` handshake and `clientId` subscription (the previous example authorized but never subscribed), array-style query params documented, rc → 1.0.0 migration notes added, MySQL support matrix corrected, rate-limiting/serverless guides point at the shipped Redis stores.

- 8ee89bb: Quality hardening: database-matrix runtime gates, upgrade-path protection, and add-on runtime smokes:

  - **PostgreSQL golden-path gate**: the scaffold→auth→CRUD runtime smoke now also runs against PostgreSQL in CI and the release workflow (dedicated `guren_smoke` database locally so developer data is never touched), verifying dialect-aware scaffolds, `resetDatabase()`, and `migrationStatus()` on pg for every release.
  - **`guren upgrade` works for the rc channel**: previously only `--canary` was supported, leaving rc users with no tool-assisted upgrade. `guren upgrade` now aligns every `@guren/*` package to a resolved dist-tag version (default `rc`, override with `--tag`), and warns when nested duplicate `@guren` copies survive in node_modules with the exact dedupe command.
  - **Duplicate-copy runtime guard**: loading two copies of `@guren/orm` (mixed versions) now prints a loud diagnostic explaining why database access fails and how to fix it, instead of failing silently with "database has not been configured".
  - **`Mail#build()` runs automatically**: scaffolded mailables previously threw "Email must have a subject" because `send()`/`queue()` never invoked `build()` — every user following the `add mail` scaffold hit this. Found by the new add-on runtime smoke, which now dispatches the scaffolded queue job and sends the scaffolded mailable on every release.

- bba40d6: Runtime release gate, unified drizzle-kit migrations, and richer relations:

  - **Golden-path runtime smoke**: the release workflow now boots a scaffolded app and drives login, CRUD, CSRF, and auth rejection over HTTP before publishing — the class of published-artifact-only breakage fixed in rc.20 can no longer ship.
  - **Migrations unified on drizzle-kit**: `createSqliteDatabase`/`createPostgresDatabase`/`createMySqlDatabase` now expose `resetDatabase()` and `migrationStatus()`, making `guren db:reset`, `db:fresh`, and `db:status` work out of the box (all three previously failed on scaffolded apps). `db:rollback` now explains that drizzle-kit migrations are forward-only and points to `db:reset` or a compensating forward migration; the dead flat-SQL rollback tracker was removed.
  - **Relations**: nested eager loading with dot notation (`User.with('posts.comments')` — previously documented but not implemented) and `withCount()` (`users[0].postsCount`) for hasMany/hasOne/belongsTo/morphMany. Relation declarations no longer need `typeof` guards or `as any` casts; the testing mocks now include relation registrars so model modules load cleanly under Vitest.
  - Templates export `resetDatabase`/`migrationStatus` from config/database.ts and ship `db:reset`/`db:status` scripts; relationship docs updated (EN/JA) with the clean declaration pattern and `withCount`.

- ac73182: Added SSR support, ORM relationships, pagination, and authentication enhancements.

### Patch Changes

- e74eab5: fix(ci): upgrade to Node 24 for npm OIDC trusted publishing
- b3c9414: feat(cli): add @guren/plugin-vercel and remove legacy deploy vercel target
  fix(create-app,orm,cli): fix blog blueprint SQLite support and DX issues
  fix(create-app): comment out VITE_DEV_SERVER_URL in template .env
- 73d311c: Align all packages to rc.9.
- 7687a0f: Fix array values in object-form `where()` producing `eq(column, array)` instead of an IN clause. On bun:sqlite this threw "SQLite query expected 1 values, received N" whenever an eager load (`Model.with(...)`) ran against two or more parent records; with a single value it silently used wrong equality semantics. `where({ id: [1, 2] })`, `where('id', [1, 2])`, and the `orWhere` equivalents now compile to `IN`, matching `whereIn()`. Adds a real bun:sqlite integration test suite for relations, which fake-adapter tests could not cover.
- 5fbd7e7: Pinned dependencies to specific versions for consistency across packages
- 83ca2c2: Fix critical scaffold-to-runtime breakages found by dogfooding the published packages:

  - **@guren/server**: stop bundling `@guren/orm` (now a real dependency). The bundled copy created a second `Model`/`DrizzleAdapter` instance, so `configureOrm()` never reached `AuthenticatableModel` and every auth query failed with "database has not been configured" in published apps.
  - **@guren/cli `add auth`**: schema updates and the users migration now respect the app's database dialect (sqlite/postgres/mysql) instead of always emitting Postgres SQL; the migration is generated via drizzle-kit instead of a loose `.sql` file that `db:migrate` never executed; `createApp()` is patched with `auth: {}` so sessions and CSRF actually mount.
  - **@guren/cli `add resource`**: honors `--fields` (previously silently ignored) and adds `--public`; delegates file generation to the `make:feature` templates; registers the route group with typed body contracts — the previous insertion regex never matched the starter template, so routes were silently never registered.
  - **@guren/cli `codegen`**: generates route/data/channel/API-client artifacts by default (previously skipped silently unless `--routes` was passed, leaving `routes.gen.ts` empty).
  - **@guren/orm**: warn when the migrations folder contains loose `.sql` files that the drizzle migrator will not execute; export `jsonb` from `@guren/orm/drizzle`.
  - **@guren/inertia-client**: add missing `./typed-forms` and `./components` export map entries (imports failed to resolve in published apps).
  - **create-guren-app**: `--auth` now runs after dependency installation using the app-local CLI and reports failures honestly (previously it always failed silently when run via bunx, yet printed a success message).
  - Docs: quick start now pins `create-guren-app@rc` (npm `latest` still points at the old 0.2.0 alpha) and reflects the SQLite default.

- 38bd637: Ensure dev asset server resolves and serves Inertia client chunks so the scaffold works in dev.
- d3a0d2c: DX fixes from the i18n dogfooding lap:

  - **Middleware `c.header()` now reaches controller responses.** Handlers and controllers return raw `Response` objects, which bypassed Hono's response construction — headers staged via `c.header()` in upstream middleware (e.g. a locale cookie) were silently dropped. Route responses are now rebuilt through `c.newResponse()`, merging prepared headers (`Set-Cookie` appended, the handler's own headers winning otherwise).
  - **`TestApp.withHeaders()` / `withHeader()`**: send custom request headers on every request (Accept-Language, bearer tokens, …). Like `actingAs()` and `json()`, they return a new `TestApp` and compose freely.
  - **`shareInertiaProps()`** merges shared props over previously registered resolvers, so multiple providers can each contribute (auth, i18n, flash, …) without clobbering one another. `getInertiaSharedPropsResolver()` is now exported for manual composition.
  - **Docs**: global middleware must be attached in a provider's `register()` — routes mount before `boot()`, so `app.use()` from `boot()` never applies. Documented in the architecture guide (en/ja).

- 379d57e: First-class file uploads:

  - **`this.file(name)` / `this.files(name)` controller helpers** — read uploaded files from multipart requests (null/empty-safe, composes with other body reads via Hono's cached parseBody). Previously controllers had to call `this.request.parseBody()` and duck-type the result.
  - **`TestApp` accepts `FormData` bodies** — `csrf.post('/tasks/1/attachments', formData)` sends real multipart requests, so upload endpoints are finally testable.

- c2f318d: Move drizzle-orm from peerDependencies to dependencies so it resolves transitively when create-guren-app is invoked via bunx.
- da8707f: The release build runs build:create-app so the CLI binary is bundled.
- afe4bfd: Two fixes surfaced by dogfooding i18n in a real app:

  - **CSRF cookie refresh no longer wipes other cookies.** `setXsrfCookie` replaced the `Set-Cookie` header on the finalized response, silently dropping any cookie appended by inner middleware or handlers (e.g. a `locale` cookie). It now appends.
  - **`I18nConfig` accepts a `loader` option** as the i18n guide documents. Previously only `path` existed, so `MemoryLoader` (or any custom `TranslationLoader`) could not be injected into `createI18n` / `new I18nManager()`. `loader` takes precedence over `path`.

- 57f6f35: Fixes and features from building a real app (Kadai) on the published packages:

  - **@guren/server: entry bundles now share chunks** (tsup `splitting: true`). Each entry point previously bundled its own copy of module-level state, so `registerJob()` via the root entry and `Worker` via `./queue` used different job registries — jobs failed with "Job class not found". The same duplication affected the mail manager and queue driver globals.
  - **@guren/server: new `SyncDriver` (queue) and `LogTransport` (mail)** — the template `.env` defaults (`QUEUE_CONNECTION=sync`, `MAIL_MAILER=log`) previously named drivers that did not exist. Sync dispatch executes jobs inline with no worker process; the log transport writes full messages to server output. The `add queue` / `add mail` blueprints now honor these env vars and default to sync/log.
  - **@guren/orm: multi-relation type fix** — `findWith(id, ['a', 'b'])` and `with(['a', 'b'])` typed their results as a union of single-relation picks instead of an intersection, making relation properties inaccessible.
  - **@guren/orm: `QueryBuilder.paginate()` accepts an options object** (`{ page, perPage }`) in addition to positional arguments, matching `Model.paginate()`.

- 77049eb: Load the `postgres` and `mysql2` driver packages lazily. Importing `@guren/orm` previously executed `import postgres from 'postgres'` at module load, so any environment without the optional peer installed (SQLite-only apps that prune unused drivers, or the CLI resolved outside an app) crashed with "Cannot find package 'postgres'" before any code ran. Drivers now load on first use of `createPostgresDatabase()` / `createMySqlDatabase()`, with a clear install hint when missing.
- 7fbf1de: Accept Hono middleware as a terminal route handler:

  - **`RouteHandler` now includes `(c, next)` signatures**, so any Hono `MiddlewareHandler` — including `broadcast.sseMiddleware()` and `broadcast.authMiddleware()` — can be passed directly to `router.get()` / `router.post()` as the docs show, without wrapper closures or `as Promise<Response>` casts.
  - **Responses set via `c.res` are honored**: a middleware mounted as a handler that finalizes the response through `next()` or `c.res =` no longer gets clobbered by a synthesized `204 No Content`. Plain handlers returning `undefined` still produce `204`.

- 08ac277: Updated the scaffolded app template so new projects pull in the freshly published prerelease.
- c10691c: Three bug fixes ahead of 1.0:

  - **Nested eager loading now works at any depth** (#15). `User.with('posts.comments.author')` previously loaded two levels and silently left deeper relations unloaded when going through the query builder. `QueryBuilder` now delegates the full dotted path to `Model.loadRelationInto`, which recurses correctly.
  - **Auth context is available to middleware registered before `boot()`** (#13). The fallback auth context (apps without `options.auth`) is attached in the `Application` constructor, and the context resolves its session lazily — so `app.use(requireAuthenticated())` before `boot()` responds 401 instead of throwing, regardless of session middleware ordering.
  - **Route contracts accept array-style query strings** (#12). `?tag=a&tag=b` now reaches query schemas as `{ tag: ['a', 'b'] }` (single occurrences stay plain strings), matching the controller-side `validateQuery` behavior. Schemas that expect a plain string for a key clients may repeat should switch to `z.array(...)` or accept both.
  - **`guren add oauth` now generates code that compiles.** The scaffolded controller named its action `redirect`, shadowing the base `Controller.redirect()` helper (infinite recursion) and failing to typecheck; the route-param validator also rejected `string | undefined`. The action is now `redirectToProvider` and the validator handles missing params.

- 4011200: Second round of real-app (Kadai) fixes:

  - **@guren/cli codegen: inherited page props are no longer dropped.** `interface Props extends PaginatedPageProps<T> { ... }` now extracts as an intersection of the heritage clauses and the body. Previously only the body was captured — an empty-bodied extends silently degraded the page contract to `{}` (no type checking at all), and adding any own member made the inherited members vanish from the contract, rejecting valid controller props.
  - **@guren/testing: `TestApp.withCsrf()`** primes CSRF like a real browser — GETs a page, captures the session and XSRF-TOKEN cookies, and sends them (plus `X-XSRF-TOKEN`) on subsequent requests, so mutating endpoints are finally testable against apps with CSRF enabled.
  - **@guren/orm: `GUREN_QUIET_DUPLICATE_ORM=1`** silences the duplicate-copy warning for environments where two copies coexist by design (e.g. monorepo dev with src + dist).

- d8c572a: Fix the project created with the `create-guren-app` command so it can start successfully.
- 3add058: Fixed registerDevAssets to resolve the bundled Inertia client via @guren/inertia-client/app, rebuilt @guren/server, and confirmed the scaffolded app now loads without blank-screen 404s.
- 7f52ba4: Add open-source metadata, licensing, and community docs to prepare the packages for an initial public release.
- a835522: Secure-by-default hardening and AI-agent tooling:

  - `guren audit` command: validates auth/validation coverage on mutating routes, detects raw SQL, secrets, and mass assignment risks
  - `make:feature` now scaffolds auth checks by default (`--public` to opt out) and supports `--policy`
  - Authorization gate wiring, hardened auth/storage/mail/error rendering
  - Inertia asset version mismatch handling
  - drizzle-orm / drizzle-kit upgraded to 1.0.0-rc.1
  - Migration tracker SQL escaping fix and dependency vulnerability patches

- 42c6053: Make SSE broadcasting actually reachable from clients:

  - **The SSE stream announces the connection** with a `connected` event carrying the `clientId` and any already-subscribed channels. Previously clients had no way to learn their id, and no HTTP path ever subscribed a client to a channel — SSE connections received pings but never a single broadcast event.
  - **`?channels=a,b` query subscriptions** on the SSE endpoint: requested channels are authorized against the connecting user (`sseMiddleware({ getUser })`) and subscribed before the stream starts, so a bare `EventSource` works for public channels.
  - **`POST /broadcasting/auth` subscribes as well as authorizes** when the payload includes the `clientId`, returning `{ authorized, subscribed }` per channel.
  - **Unregistered `private-`/`presence-` channels now default to deny** instead of public access — a missing channel registration no longer silently exposes a private channel.

- 11e876c: first release

## 1.0.0-rc.27

### Minor Changes

- f7de890: Final API freeze pass before 1.0, driven by an adversarial pre-release review:

  - **`QueryBuilder.update()` now enforces the fillable allowlist** exactly like `Model.update()` (it previously bypassed mass-assignment protection entirely); `QueryBuilder.forceUpdate()` is the trusted-data escape hatch.
  - **Redis stores are now importable**: `@guren/core/redis` (and `@guren/server/redis`) ship `RedisSessionStore`, `RedisRateLimitStore`, `RedisSlidingWindowRateLimitStore`, `RedisApiTokenStore`, `RedisPasswordResetStore`, `RedisEmailVerificationStore`, and the new `RedisOAuthStateStore`. The default `MemoryOAuthStateStore` is now bounded (10k entries with expiry sweep) to prevent memory-exhaustion DoS.
  - **`PaginationMeta` name collision resolved**: the ORM's pagination meta is now `ModelPaginationMeta`; `PaginationMeta` from `@guren/core` unambiguously refers to the resource/paginator shape.
  - **React is a peer dependency**: `@guren/inertia-client` moves `react`/`react-dom` to peerDependencies, and `@guren/server` makes `@guren/inertia-client` an optional peer — API-only apps no longer pull React transitively.
  - **`@guren/testing/vitest` subpath**: vitest/React helpers move out of the root barrel so `bun:test` users don't need the React test stack; the related peer deps are marked optional.
  - **`Hash` is runtime-safe**: it now points at `DefaultHasher`, which delegates to Bun's scrypt on Bun and the Node implementation elsewhere (Lambda on Node no longer crashes).
  - Smaller freeze items: `ApplicationOptions`/`AuthPluginOptions` exported, unimplemented `Command.callSilent()` removed, `FormRequest` marked `@deprecated`, `MemoryQueueDriver`/`SyncQueueDriver`/`RedisQueueDriver` aliases added, internal ORM plumbing removed from the `@guren/core` allowlist, `nodemailer` bumped to v9 (HIGH advisory), stray `./dist/*` export wildcard removed.
  - **Docs**: broadcasting client flow rewritten around the `connected` handshake and `clientId` subscription (the previous example authorized but never subscribed), array-style query params documented, rc → 1.0.0 migration notes added, MySQL support matrix corrected, rate-limiting/serverless guides point at the shipped Redis stores.

## 1.0.0-rc.26

### Minor Changes

- a1fc6ec: Two security defaults locked in ahead of 1.0:

  - **Strict mass assignment.** When a model defines `fillable`, `create()`/`update()` now throw a `MassAssignmentException` naming any field outside the allowlist instead of silently discarding it (silent drops surfaced as NOT NULL violations far from the cause, and masked injection attempts). Use the new `forceCreate()` / `forceUpdate()` for trusted server-side data, or set `static strictFillable = false` per model to restore the old behavior. The `guarded` path is unchanged.
  - **`auth.user()` never exposes credentials.** The session guard sanitizes user records before caching or returning them: the password column, remember-token column, and the model's `static hidden` fields are stripped. Credential checks still run on the raw record internally, so login and remember-me behave exactly as before — but sharing `auth.user` into Inertia props no longer leaks `passwordHash` to the browser. Custom user providers can opt in via the new optional `UserProvider.sanitize()`. `guren add auth` now generates the User model with `static hidden = ['passwordHash', 'rememberToken']`.

## 1.0.0-rc.25

### Patch Changes

- c10691c: Three bug fixes ahead of 1.0:

  - **Nested eager loading now works at any depth** (#15). `User.with('posts.comments.author')` previously loaded two levels and silently left deeper relations unloaded when going through the query builder. `QueryBuilder` now delegates the full dotted path to `Model.loadRelationInto`, which recurses correctly.
  - **Auth context is available to middleware registered before `boot()`** (#13). The fallback auth context (apps without `options.auth`) is attached in the `Application` constructor, and the context resolves its session lazily — so `app.use(requireAuthenticated())` before `boot()` responds 401 instead of throwing, regardless of session middleware ordering.
  - **Route contracts accept array-style query strings** (#12). `?tag=a&tag=b` now reaches query schemas as `{ tag: ['a', 'b'] }` (single occurrences stay plain strings), matching the controller-side `validateQuery` behavior. Schemas that expect a plain string for a key clients may repeat should switch to `z.array(...)` or accept both.
  - **`guren add oauth` now generates code that compiles.** The scaffolded controller named its action `redirect`, shadowing the base `Controller.redirect()` helper (infinite recursion) and failing to typecheck; the route-param validator also rejected `string | undefined`. The action is now `redirectToProvider` and the validator handles missing params.

## 1.0.0-rc.24

### Patch Changes

- d3a0d2c: DX fixes from the i18n dogfooding lap:

  - **Middleware `c.header()` now reaches controller responses.** Handlers and controllers return raw `Response` objects, which bypassed Hono's response construction — headers staged via `c.header()` in upstream middleware (e.g. a locale cookie) were silently dropped. Route responses are now rebuilt through `c.newResponse()`, merging prepared headers (`Set-Cookie` appended, the handler's own headers winning otherwise).
  - **`TestApp.withHeaders()` / `withHeader()`**: send custom request headers on every request (Accept-Language, bearer tokens, …). Like `actingAs()` and `json()`, they return a new `TestApp` and compose freely.
  - **`shareInertiaProps()`** merges shared props over previously registered resolvers, so multiple providers can each contribute (auth, i18n, flash, …) without clobbering one another. `getInertiaSharedPropsResolver()` is now exported for manual composition.
  - **Docs**: global middleware must be attached in a provider's `register()` — routes mount before `boot()`, so `app.use()` from `boot()` never applies. Documented in the architecture guide (en/ja).

## 1.0.0-rc.23

### Patch Changes

- afe4bfd: Two fixes surfaced by dogfooding i18n in a real app:

  - **CSRF cookie refresh no longer wipes other cookies.** `setXsrfCookie` replaced the `Set-Cookie` header on the finalized response, silently dropping any cookie appended by inner middleware or handlers (e.g. a `locale` cookie). It now appends.
  - **`I18nConfig` accepts a `loader` option** as the i18n guide documents. Previously only `path` existed, so `MemoryLoader` (or any custom `TranslationLoader`) could not be injected into `createI18n` / `new I18nManager()`. `loader` takes precedence over `path`.

- 7fbf1de: Accept Hono middleware as a terminal route handler:

  - **`RouteHandler` now includes `(c, next)` signatures**, so any Hono `MiddlewareHandler` — including `broadcast.sseMiddleware()` and `broadcast.authMiddleware()` — can be passed directly to `router.get()` / `router.post()` as the docs show, without wrapper closures or `as Promise<Response>` casts.
  - **Responses set via `c.res` are honored**: a middleware mounted as a handler that finalizes the response through `next()` or `c.res =` no longer gets clobbered by a synthesized `204 No Content`. Plain handlers returning `undefined` still produce `204`.

## 1.0.0-rc.22

### Patch Changes

- 42c6053: Make SSE broadcasting actually reachable from clients:

  - **The SSE stream announces the connection** with a `connected` event carrying the `clientId` and any already-subscribed channels. Previously clients had no way to learn their id, and no HTTP path ever subscribed a client to a channel — SSE connections received pings but never a single broadcast event.
  - **`?channels=a,b` query subscriptions** on the SSE endpoint: requested channels are authorized against the connecting user (`sseMiddleware({ getUser })`) and subscribed before the stream starts, so a bare `EventSource` works for public channels.
  - **`POST /broadcasting/auth` subscribes as well as authorizes** when the payload includes the `clientId`, returning `{ authorized, subscribed }` per channel.
  - **Unregistered `private-`/`presence-` channels now default to deny** instead of public access — a missing channel registration no longer silently exposes a private channel.

## 1.0.0-rc.21

### Patch Changes

- 379d57e: First-class file uploads:

  - **`this.file(name)` / `this.files(name)` controller helpers** — read uploaded files from multipart requests (null/empty-safe, composes with other body reads via Hono's cached parseBody). Previously controllers had to call `this.request.parseBody()` and duck-type the result.
  - **`TestApp` accepts `FormData` bodies** — `csrf.post('/tasks/1/attachments', formData)` sends real multipart requests, so upload endpoints are finally testable.

## 1.0.0-rc.20

### Patch Changes

- 4011200: Second round of real-app (Kadai) fixes:

  - **@guren/cli codegen: inherited page props are no longer dropped.** `interface Props extends PaginatedPageProps<T> { ... }` now extracts as an intersection of the heritage clauses and the body. Previously only the body was captured — an empty-bodied extends silently degraded the page contract to `{}` (no type checking at all), and adding any own member made the inherited members vanish from the contract, rejecting valid controller props.
  - **@guren/testing: `TestApp.withCsrf()`** primes CSRF like a real browser — GETs a page, captures the session and XSRF-TOKEN cookies, and sends them (plus `X-XSRF-TOKEN`) on subsequent requests, so mutating endpoints are finally testable against apps with CSRF enabled.
  - **@guren/orm: `GUREN_QUIET_DUPLICATE_ORM=1`** silences the duplicate-copy warning for environments where two copies coexist by design (e.g. monorepo dev with src + dist).

## 1.0.0-rc.19

### Patch Changes

- 57f6f35: Fixes and features from building a real app (Kadai) on the published packages:

  - **@guren/server: entry bundles now share chunks** (tsup `splitting: true`). Each entry point previously bundled its own copy of module-level state, so `registerJob()` via the root entry and `Worker` via `./queue` used different job registries — jobs failed with "Job class not found". The same duplication affected the mail manager and queue driver globals.
  - **@guren/server: new `SyncDriver` (queue) and `LogTransport` (mail)** — the template `.env` defaults (`QUEUE_CONNECTION=sync`, `MAIL_MAILER=log`) previously named drivers that did not exist. Sync dispatch executes jobs inline with no worker process; the log transport writes full messages to server output. The `add queue` / `add mail` blueprints now honor these env vars and default to sync/log.
  - **@guren/orm: multi-relation type fix** — `findWith(id, ['a', 'b'])` and `with(['a', 'b'])` typed their results as a union of single-relation picks instead of an intersection, making relation properties inaccessible.
  - **@guren/orm: `QueryBuilder.paginate()` accepts an options object** (`{ page, perPage }`) in addition to positional arguments, matching `Model.paginate()`.

## 1.0.0-rc.18

### Patch Changes

- 77049eb: Load the `postgres` and `mysql2` driver packages lazily. Importing `@guren/orm` previously executed `import postgres from 'postgres'` at module load, so any environment without the optional peer installed (SQLite-only apps that prune unused drivers, or the CLI resolved outside an app) crashed with "Cannot find package 'postgres'" before any code ran. Drivers now load on first use of `createPostgresDatabase()` / `createMySqlDatabase()`, with a clear install hint when missing.

## 1.0.0-rc.17

### Minor Changes

- 8ee89bb: Quality hardening: database-matrix runtime gates, upgrade-path protection, and add-on runtime smokes:

  - **PostgreSQL golden-path gate**: the scaffold→auth→CRUD runtime smoke now also runs against PostgreSQL in CI and the release workflow (dedicated `guren_smoke` database locally so developer data is never touched), verifying dialect-aware scaffolds, `resetDatabase()`, and `migrationStatus()` on pg for every release.
  - **`guren upgrade` works for the rc channel**: previously only `--canary` was supported, leaving rc users with no tool-assisted upgrade. `guren upgrade` now aligns every `@guren/*` package to a resolved dist-tag version (default `rc`, override with `--tag`), and warns when nested duplicate `@guren` copies survive in node_modules with the exact dedupe command.
  - **Duplicate-copy runtime guard**: loading two copies of `@guren/orm` (mixed versions) now prints a loud diagnostic explaining why database access fails and how to fix it, instead of failing silently with "database has not been configured".
  - **`Mail#build()` runs automatically**: scaffolded mailables previously threw "Email must have a subject" because `send()`/`queue()` never invoked `build()` — every user following the `add mail` scaffold hit this. Found by the new add-on runtime smoke, which now dispatches the scaffolded queue job and sends the scaffolded mailable on every release.

## 1.0.0-rc.16

### Patch Changes

- 7687a0f: Fix array values in object-form `where()` producing `eq(column, array)` instead of an IN clause. On bun:sqlite this threw "SQLite query expected 1 values, received N" whenever an eager load (`Model.with(...)`) ran against two or more parent records; with a single value it silently used wrong equality semantics. `where({ id: [1, 2] })`, `where('id', [1, 2])`, and the `orWhere` equivalents now compile to `IN`, matching `whereIn()`. Adds a real bun:sqlite integration test suite for relations, which fake-adapter tests could not cover.

## 1.0.0-rc.15

### Minor Changes

- bba40d6: Runtime release gate, unified drizzle-kit migrations, and richer relations:

  - **Golden-path runtime smoke**: the release workflow now boots a scaffolded app and drives login, CRUD, CSRF, and auth rejection over HTTP before publishing — the class of published-artifact-only breakage fixed in rc.20 can no longer ship.
  - **Migrations unified on drizzle-kit**: `createSqliteDatabase`/`createPostgresDatabase`/`createMySqlDatabase` now expose `resetDatabase()` and `migrationStatus()`, making `guren db:reset`, `db:fresh`, and `db:status` work out of the box (all three previously failed on scaffolded apps). `db:rollback` now explains that drizzle-kit migrations are forward-only and points to `db:reset` or a compensating forward migration; the dead flat-SQL rollback tracker was removed.
  - **Relations**: nested eager loading with dot notation (`User.with('posts.comments')` — previously documented but not implemented) and `withCount()` (`users[0].postsCount`) for hasMany/hasOne/belongsTo/morphMany. Relation declarations no longer need `typeof` guards or `as any` casts; the testing mocks now include relation registrars so model modules load cleanly under Vitest.
  - Templates export `resetDatabase`/`migrationStatus` from config/database.ts and ship `db:reset`/`db:status` scripts; relationship docs updated (EN/JA) with the clean declaration pattern and `withCount`.

## 1.0.0-rc.14

### Patch Changes

- 83ca2c2: Fix critical scaffold-to-runtime breakages found by dogfooding the published packages:

  - **@guren/server**: stop bundling `@guren/orm` (now a real dependency). The bundled copy created a second `Model`/`DrizzleAdapter` instance, so `configureOrm()` never reached `AuthenticatableModel` and every auth query failed with "database has not been configured" in published apps.
  - **@guren/cli `add auth`**: schema updates and the users migration now respect the app's database dialect (sqlite/postgres/mysql) instead of always emitting Postgres SQL; the migration is generated via drizzle-kit instead of a loose `.sql` file that `db:migrate` never executed; `createApp()` is patched with `auth: {}` so sessions and CSRF actually mount.
  - **@guren/cli `add resource`**: honors `--fields` (previously silently ignored) and adds `--public`; delegates file generation to the `make:feature` templates; registers the route group with typed body contracts — the previous insertion regex never matched the starter template, so routes were silently never registered.
  - **@guren/cli `codegen`**: generates route/data/channel/API-client artifacts by default (previously skipped silently unless `--routes` was passed, leaving `routes.gen.ts` empty).
  - **@guren/orm**: warn when the migrations folder contains loose `.sql` files that the drizzle migrator will not execute; export `jsonb` from `@guren/orm/drizzle`.
  - **@guren/inertia-client**: add missing `./typed-forms` and `./components` export map entries (imports failed to resolve in published apps).
  - **create-guren-app**: `--auth` now runs after dependency installation using the app-local CLI and reports failures honestly (previously it always failed silently when run via bunx, yet printed a success message).
  - Docs: quick start now pins `create-guren-app@rc` (npm `latest` still points at the old 0.2.0 alpha) and reflects the SQLite default.

## 1.0.0-rc.13

### Patch Changes

- Secure-by-default hardening and AI-agent tooling:

  - `guren audit` command: validates auth/validation coverage on mutating routes, detects raw SQL, secrets, and mass assignment risks
  - `make:feature` now scaffolds auth checks by default (`--public` to opt out) and supports `--policy`
  - Authorization gate wiring, hardened auth/storage/mail/error rendering
  - Inertia asset version mismatch handling
  - drizzle-orm / drizzle-kit upgraded to 1.0.0-rc.1
  - Migration tracker SQL escaping fix and dependency vulnerability patches

## 1.0.0-rc.12

### Patch Changes

- feat(cli): add @guren/plugin-vercel and remove legacy deploy vercel target
  fix(create-app,orm,cli): fix blog blueprint SQLite support and DX issues
  fix(create-app): comment out VITE_DEV_SERVER_URL in template .env

## 1.0.0-rc.11

### Patch Changes

- fix(ci): upgrade to Node 24 for npm OIDC trusted publishing

## 1.0.0-rc.10

### Patch Changes

- Move drizzle-orm from peerDependencies to dependencies so it resolves transitively when create-guren-app is invoked via bunx.

## 1.0.0-rc.9

### Patch Changes

- Align all packages to rc.9.

## 1.0.0-rc.8

### Major Changes

- v1.0 Release Candidate

  New subsystems: OAuth, MySQL adapter, typed broadcasting, OpenAPI generation,
  production error pages, request ID/logging middleware, plugin test harness,
  API-only and worker starter kits.

  DX: Golden path standardization, doctor autofixes, CLI consistency,
  upgrade productization, security defaults.

  Quality: Playwright E2E, CI matrix, nightly canary, benchmarks,
  smoke tests for all starter kits.

  Docs: Task-completion guides (en/ja), plugin authoring guide,
  deployment recipes (Docker, Fly.io, VPS, serverless).

  Governance: API stability tiers, deprecation policy, SemVer guidance,
  RFC process, release cadence, issue triage SLAs.

## 0.2.0-alpha.7

### Patch Changes

- Fix the project created with the `create-guren-app` command so it can start successfully.

## 0.2.0-alpha.6

### Minor Changes

- Added SSR support, ORM relationships, pagination, and authentication enhancements.

## 0.1.1-alpha.5

### Patch Changes

- Ensure dev asset server resolves and serves Inertia client chunks so the scaffold works in dev.

## 0.1.1-alpha.4

### Patch Changes

- Fixed registerDevAssets to resolve the bundled Inertia client via @guren/inertia-client/app, rebuilt @guren/server, and confirmed the scaffolded app now loads without blank-screen 404s.

## 0.1.1-alpha.3

### Patch Changes

- The release build runs build:create-app so the CLI binary is bundled.

## 0.1.1-alpha.2

### Patch Changes

- Updated the scaffolded app template so new projects pull in the freshly published prerelease.

## 0.1.1-alpha.1

### Patch Changes

- Pinned dependencies to specific versions for consistency across packages

## 0.1.1-alpha.0

### Patch Changes

- 7f52ba4: Add open-source metadata, licensing, and community docs to prepare the packages for an initial public release.
- first release
