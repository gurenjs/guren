# RFC: Server-Set Columns on Mass-Assigned Writes

**Author:** Urata Daiki (@7nohe)
**Date:** 2026-09-23
**Status:** Draft

> A write that carries request data and one column the server chooses, such as
> the post's author, has no call today that keeps `fillable` on the request
> data. This RFC adds one: `Post.create(data, { set: { authorId: user.id } })`.

## Problem

A controller that stores a post needs two kinds of value in one row: the
fields the request supplied, which the validator checked, and an owner the
request must never choose. Guren offers two ways to write that row, and each
gives up one of RFC 0006's protections.

**Owner in `fillable`.** `Post.create({ ...data, authorId: user.id })` works
once `authorId` is in `fillable`. The explicit key after the spread wins, so
this `create` call is safe. The cost is every other fillable path. The
`update` action is usually `Post.update({ id }, data)`, and from then on a
request can reassign a post whenever its validator admits `authorId`. A schema
that uses `.passthrough()`, or one that later gains the field, is enough.
`fillable` was the net meant to catch that, and it now lists the column.

**Owner outside `fillable`, written with `forceCreate`.** The tutorial does
this: `Post.forceCreate({ ...data, authorId: author.id })` after
`validateBody()`. `authorId` stays out of every fillable path, but `forceCreate`
skips `filterFillable` for the whole payload, so the spread request data loses
the second of RFC 0006's three nets (the Zod schema, `filterFillable`, the
`force*` boundary). It is also the shape of RFC 0006's residual risk 1, an
agent that hits `MassAssignmentException` and switches the call to
`forceCreate()` with the same request-derived payload. The mitigations RFC 0006
put in place fire on it:

- `MassAssignmentException` ends with "Never call forceCreate/forceUpdate with
  request input."
- The harness rule `orm-models.md` says a `MassAssignmentException` "is never
  fixed by switching the same payload to `force*`".
- `guren audit` warns on a method that validates a body and calls a force
  write. Tutorial chapter 6 then teaches the reader to accept that warning.

`guren audit` cannot tell the tutorial's shape from risk 1, because the
difference is whether the schema admits keys `fillable` would refuse, and the
schema is not in the action body. The first version of PR #1024 let the owner
shape through with an AST allowlist, and was reverted within that PR for this
reason: it removed mitigation (c) from exactly the pattern risk 1 describes.

The two forms have spread across the project:

| Form | Where |
|---|---|
| `forceCreate({ ...data, ownerId })` | tutorial chapters 6 to 13 (16 controller sites per locale), `upgrading.md`, the create-app `blog` template, `examples/blog`, the guren.dev home page sample |
| `create({ ...data, ownerId })` with the owner in `fillable` | harness `entry-body.md`, `rules/orm-models.md`, `skills/guren-api/SKILL.md`, `skills/feature/SKILL.md`, `examples/api` |
| `create({ ...data, ownerId })` with no model shown | the routing, authentication, error-handling and controllers guides, `README.md`, the root `CLAUDE.md` |

The third group throws against the `fillable` the docs' own `Post` declares.
An agent reading the harness learns the first pattern's opposite, and the
code-review agent in the same harness says to keep owner columns out of
`fillable`.

The problem is not limited to owners. The server also chooses a comment's
`postId` (from the route-bound post), a default `status: 'draft'`, and the
`emailVerifiedAt` and `{provider}Id` that `make:auth`'s OAuth controller
writes. The generated `User` model works today only because it declares no
`fillable`; adding one, which `guren audit` suggests, makes those writes throw.

## Prior art

- **Laravel** sets a foreign key through the relationship:
  `$request->user()->posts()->create($validated)` fills `$validated` through
  `$fillable` and sets `user_id` from the relation, which need not be
  fillable. `forceFill()` and `forceCreate()` are the unguarded hatch, as in
  Guren.
- **Rails** writes `current_user.posts.create(post_params)`. Strong parameters
  filter the request, and the association sets the owner.
- **AdonisJS Lucid** writes `await user.related('posts').create(payload)`.
- **Django** saves a `ModelForm` with `commit=False`, sets the owner on the
  instance, then saves.

Each keeps request data and server data apart until the last step. Every one
of them does it through a relation or a model instance, and Guren has neither:
records are plain objects, and a relation is metadata registered with
`belongsTo()`/`hasMany()`, with no create through it.

## Proposed Solution

### 1. `set` on `create` and `update`

```ts
const author = await this.auth.userOrFail<UserRecord>()
const data = await this.validateBody(PostPayloadSchema)
const post = await Post.create(data, { set: { authorId: author.id } })
```

`data` goes through `filterFillable` exactly as it does today. `set` is a map
of columns the server chose. Its keys are exempt from `fillable`, and from
nothing else.

The write options become:

```ts
// packages/orm/src/Model.ts
export interface ModelCreateOptions<T extends typeof Model, S extends SetFor<T>>
  extends ModelWriteOptions {
  /** Columns the server chose; exempt from `fillable`, not from anything else. */
  set?: S
}

type SetFor<T extends typeof Model> = Partial<InsertFor<T>>

static async create<T extends typeof Model, S extends SetFor<T> = {}>(
  this: T,
  data: CreateDataFor<T, S>,
  options?: ModelCreateOptions<T, S>,
): Promise<TRecordFor<T>>

static async update<T extends typeof Model, S extends SetFor<T> = {}>(
  this: T,
  where: WhereClauseFor<T>,
  data: Partial<CreateDataFor<T, S>>,
  options?: ModelCreateOptions<T, S>,
): Promise<TRecordFor<T>>
```

`InsertFor<T>` is the table's insert type (what `InferModelInsert` already
computes), so `set` keys are checked against real columns.
`CreateDataFor<T, S>` is `TCreateFor<T>` with the keys of `S` removed and
forbidden:

```ts
type CreateDataFor<T extends typeof Model, S> =
  Omit<TCreateFor<T>, keyof S> & { [K in keyof S]?: never }
```

A column that `set` supplies is therefore no longer required in `data`, which
is what lets `data` be the validator's output without a cast. A literal that
names the same key in both places fails to compile. `forceCreate` and
`forceUpdate` keep their signatures and their one `createType`, so RFC 0006's
amendment against a second payload marker still holds.

`options` without `set` is today's `writeOptions`, so `{ trx }` callers are
unchanged. `set` is removed before the options reach the adapter.

### 2. What `set` goes through

`runCreate` and `runUpdate` build the payload in this order:

1. `filterFillable(data)`, unchanged: denied fields throw, `id` is stripped,
   anything outside `fillable` throws.
2. The `set` keys are checked:
   - a key in `deniedFields()` throws `MassAssignmentException` with
     `reason: 'denied'` (credential columns stay reachable only through the
     model's own derivation or a force write);
   - `id` throws, since a server-chosen primary key is a system write and
     belongs to `forceCreate`;
   - a key that `data` also carries throws, with a new
     `reason: 'conflict'`. A validated body that contains a server-owned
     column means the schema admits it, and that is the bug to surface. It is
     not resolved in either direction.
3. The two are merged, and the merged payload goes through
   `preparePersistencePayload` (mutators, casts, password hashing), the
   lifecycle hooks and observers, and the adapter, as every write does today.

The only rule `set` skips is the `fillable` allowlist.

### 3. The other write entry points

- **Transaction scope.** The scope's `create(data)` and `update(where, data)`
  gain the same optional `{ set }` argument, so a store inside
  `Model.transaction()` needs no force write either.
- **`QueryBuilder.update(data)`** gains `update(data, { set })` with the same
  checks. `forceUpdate(data)` is unchanged.
- **Force writes** keep their meaning and are narrowed in the docs to writes
  that carry no request data at all: seeders, runtime stores (sessions, API
  tokens, attachments, AI conversations), OAuth hash sentinels.

### 4. `MassAssignmentException`

The `not-fillable` remediation names `set`, and the closing negative stays:

> `Post: mass assignment blocked for field(s) "authorId". Add them to fillable
> if a request may set them; if the server chooses the value, pass it in
> set: Post.create(data, { set: { authorId } }). Never call
> forceCreate/forceUpdate with request input.`

The `conflict` reason reads:

> `Post: "authorId" is in both the data and set. The data comes from the
> request, so its schema admits a column the server sets; remove it from the
> schema.`

### 5. `guren audit`

RFC 0006's mitigation (c) is unchanged: a method that validates a body and
calls a force write still warns, as a review prompt. Two things change around
it:

- The fix text names `create(data, { set })` as the remedy for the owner case.
  The tutorial and the templates stop using force writes for request data, so
  the warning stops appearing in code the project itself ships, and it no
  longer needs chapter 6's paragraph asking the reader to accept it.
- The trigger also covers a body read through `this.validated()` (route
  contracts). Today it looks only for `validateBody`, so the blog template's
  `validated()` plus `forceCreate` is never flagged. Once no shipped code
  relies on that shape, the wider trigger costs no false positives in
  scaffolded apps.

`set` values are not judged. A value written explicitly under a column name
is a choice the author made in the source, which is the property mass
assignment protection is about; whether the value is the right one is an
authorization question for policies and tests.

### 6. Implementation plan

1. **`@guren/orm`** (minor), with the new option types re-exported from
   `@guren/core` (minor; core's ORM exports are an allowlist):
   - `ModelCreateOptions` and the `set` handling in `runCreate`, `runUpdate`,
     the transaction scope and `QueryBuilder.update`;
   - `MassAssignmentException` `reason: 'conflict'` and the new messages;
   - runtime tests for every step in section 2, and type tests beside the
     existing `optionalOnCreate`/`requireOnCreate` tests.
2. **`@guren/cli`** (patch), after part 1 is released, since everything here
   is read by apps against their installed `@guren/core`:
   - the audit's fix text and the `validated()` trigger;
   - harness `rules/orm-models.md`, `entry-body.md`, `skills/guren-api/SKILL.md`
     and `skills/feature/SKILL.md` move to `set`, with owner columns out of
     `fillable`;
   - `make:auth`'s OAuth and profile controllers write `emailVerifiedAt` and
     the provider id through `set`, and the generated `User` model gains a
     `fillable`.
3. **Docs and shipped code**, also after part 1 is released, so that
   `smoke:starter:npm` never sees a template using an unpublished API:
   - tutorial chapters 6 to 13 in both locales, chapter 6's force-write
     section rewritten around `set` and chapter 8's agent rule 3;
   - the create-app `blog` template, `examples/blog`, `examples/api`;
   - the four guides, `README.md`, the root `CLAUDE.md`, the guren.dev home
     page sample, and `upgrading.md`.

## Alternatives Considered

**Keep the owner in `fillable`.** This is the form the harness teaches. It
protects the create call and opens every fillable update to a request-chosen
owner, as described above.

**Keep `forceCreate` with validated data and accept the warning.** This is the
tutorial today. It removes `filterFillable` from the request data, and it
cannot be told apart from RFC 0006's risk 1, so the audit and the exception
message keep contradicting the shipped code.

**Let the audit recognise the owner shape.** PR #1024 tried this with an AST
allowlist: a spread of the `validateBody()` result plus explicit keys from the
session. It was reverted because the unsafe case differs only in the schema's
keys, which the action body does not show, so exempting the shape removes
RFC 0006's mitigation (c) from exactly the pattern it was written for.

**Create through a relation.** `user.posts().create(data)` or
`Post.createFor({ author: user }, data)` would read like Laravel and Lucid. It
needs a relation API that Guren does not have (records are plain objects), it
covers only foreign keys and not `status: 'draft'` or `emailVerifiedAt`, and it
can be built later on top of `set`, which it would compile down to. See Open
Questions.

**A separate method, such as `createWith(set, data)`.** It avoids putting
`set` next to `trx`, at the cost of a second vocabulary for every write and an
argument order that is easy to swap. One option object is one thing to teach.

**Widen `fillable` per call** (`create(data, { fillable: [...] })`). It lets a
caller open the allowlist for the request data itself, which is the opposite
of what is needed.

## Migration Path

The change is additive. Existing `create`, `update`, `forceCreate` and
`forceUpdate` calls behave as before, and an existing
`forceCreate({ ...data, ownerId })` keeps working and keeps its audit warning,
whose fix text now points at `set`. Nothing is deprecated.

Moving a call is mechanical: `Post.forceCreate({ ...data, authorId: author.id })`
becomes `Post.create(data, { set: { authorId: author.id } })`, and an owner in
`fillable` is removed from it once every write uses `set`. No codemod is
proposed; the audit warning already lists the force-write sites, and the
`fillable` sites need a person to decide which columns the request may set.

## Open Questions

1. **The name.** `set` reads well at the call site and names nothing else in
   the ORM today. `with`, `assign` and `server` are the alternatives.
2. **A key in both `data` and `set`.** This RFC throws. The alternative is
   that `set` wins, which is what `{ ...data, authorId }` does today and hides
   a schema that admits the column.
3. **`id` in `set`.** This RFC throws and leaves server-chosen keys to
   `forceCreate`. Allowing it would let the runtime stores that set ULIDs move
   off force writes, but they carry no request data, so they gain nothing.
4. **Relation sugar.** Whether `Post.create(data, { for: { author: user } })`
   should derive `set` from a `belongsTo` definition, and whether that waits
   for RFC 0025's relation descriptors.
5. **Bulk writes.** There is no `createMany` today (RFC 0006 recorded the
   same). If one is added, it should take `set` for the whole batch.
