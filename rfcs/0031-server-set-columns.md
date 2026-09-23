# RFC: Server-Set Columns on Mass-Assigned Writes

**Author:** Urata Daiki (@7nohe)
**Date:** 2026-09-23
**Status:** Accepted (2026-09-23; the standard two-week discussion window was
shortened by the deciding maintainer, after a code review and simplify pass
recorded in PR #1033)

> A write that carries request data and one column the server chooses, such as
> the post's author, has no call today that keeps `fillable` on the request
> data. This RFC adds one: `Post.create(data, { set: { authorId: user.id } })`.

## Problem

A controller that stores a post needs two kinds of value in one row: the
fields the request supplied, which the validator checked, and an owner the
request must never choose. Guren offers two ways to write that row, and each
gives up one of RFC 0006's protections.

**Owner in `fillable`.** `Post.create({ ...data, authorId: user.id })` works
once `authorId` is in `fillable`, and the explicit key after the spread keeps
that call safe. The cost is every other fillable path. The `update` action is
usually `Post.update({ id }, data)`, and from then on a request can reassign a
post whenever its validator admits `authorId`: a schema that uses
`.passthrough()`, or one that later gains the field, is enough. `fillable` was
the net meant to catch that, and it now lists the column.

**Owner outside `fillable`, written with `forceCreate`.** The tutorial does
this: `Post.forceCreate({ ...data, authorId: author.id })` after
`validateBody()`. `authorId` stays out of every fillable path, but `forceCreate`
skips `filterFillable` for the whole payload, so the spread request data loses
the second of RFC 0006's three nets (the Zod schema, `filterFillable`, the
`force*` boundary). It is also the shape of RFC 0006's residual risk 1, an
agent that hits `MassAssignmentException` and switches the call to
`forceCreate()` with the same request-derived payload, so every mitigation
RFC 0006 put in place fires on the tutorial's own code:

- `MassAssignmentException` ends with "Never call forceCreate/forceUpdate with
  request input."
- The harness rule `orm-models.md` says a `MassAssignmentException` "is never
  fixed by switching the same payload to `force*`".
- `guren audit` warns on a method that validates a body and calls a force
  write, and tutorial chapter 6 teaches the reader to accept that warning.

The audit cannot tell the tutorial's shape from risk 1: the difference is
whether the schema admits keys `fillable` would refuse, and the schema is not
in the action body. The first version of PR #1024 let the owner shape through
with an AST allowlist and was reverted within that PR for that reason.

Both forms have spread across the project:

| Form | Where |
|---|---|
| `forceCreate({ ...data, ownerId })` | tutorial chapters 6 to 13 (16 controller sites per locale), `upgrading.md`, the create-app `blog` template, the guren.dev home page sample |
| `create({ ...data, ownerId })` with the owner in `fillable` | harness `entry-body.md`, `rules/orm-models.md`, `skills/guren-api/SKILL.md`, `skills/feature/SKILL.md`, `examples/api`, `examples/blog` (#1024 moves it to the first row) |
| `create({ ...data, ownerId })` with no model shown | the routing, authentication, error-handling and controllers guides, `README.md`, the root `CLAUDE.md` |

The third group throws against the `fillable` the docs' own `Post` declares.
An agent reading the harness learns the second form, while the code-review
agent in the same harness says to keep owner columns out of `fillable`.

The problem is not limited to owners. The server also chooses a comment's
`postId` (from the route-bound post), a default `status: 'draft'`, and the
`emailVerifiedAt` and `{provider}Id` that `make:auth`'s OAuth controller
writes.

## Prior art

Laravel (`$request->user()->posts()->create($validated)`), Rails
(`current_user.posts.create(post_params)`), AdonisJS Lucid
(`user.related('posts').create(payload)`) and Django (`form.save(commit=False)`,
then set the owner) all keep request data and server data apart until the last
step, and all do it through a relation or a model instance. Guren has neither:
records are plain objects, and a relation is metadata registered with
`belongsTo()`/`hasMany()`, with no create through it. A separate argument is the
form that fits.

## Proposed Solution

### 1. The API

```ts
const author = await this.auth.userOrFail<UserRecord>()
const data = await this.validateBody(PostPayloadSchema)
const post = await Post.create(data, { set: { authorId: author.id } })
```

`data` goes through `filterFillable` exactly as it does today. `set` holds the
columns the server chose; its keys are exempt from `fillable`, and from nothing
else.

`create` and `update` gain an overload. The existing signatures are kept
word for word, so a call without `set` typechecks and costs exactly what it does
today:

```ts
// packages/orm/src/Model.ts
export type ModelSetOptions<T extends typeof Model, S extends SetFor<T>> =
  ModelWriteOptions & { set: S }

type SetFor<T extends typeof Model> = Omit<Partial<TCreateFor<T>>, 'id'>

type CreateDataFor<T extends typeof Model, S> =
  Omit<TCreateFor<T>, keyof S> & { [K in keyof S]?: never }

// unchanged
static create<T extends typeof Model>(this: T, data: TCreateFor<T>, writeOptions?: ModelWriteOptions): Promise<TRecordFor<T>>
// new
static create<T extends typeof Model, S extends SetFor<T>>(
  this: T,
  data: CreateDataFor<T, NoInfer<S>>,
  options: ModelSetOptions<T, S>,
): Promise<TRecordFor<T>>

// unchanged
static update<T extends typeof Model>(this: T, where: WhereClauseFor<T>, data: Partial<TCreateFor<T>>, writeOptions?: ModelWriteOptions): Promise<TRecordFor<T>>
// new
static update<T extends typeof Model, S extends SetFor<T>>(
  this: T,
  where: WhereClauseFor<T>,
  data: Partial<CreateDataFor<T, NoInfer<S>>>,
  options: ModelSetOptions<T, S>,
): Promise<TRecordFor<T>>
```

- `SetFor` reuses `TCreateFor`, so `set` keys are checked against the same
  shape `data` is, for models written by hand as well as with `defineModel`.
  `id` is left out at the type level.
- `CreateDataFor` drops the `set` keys from `data`, so a column `set` supplies
  is no longer required there and `data` can be the validator's output without
  a cast. A literal that names the same key in both places fails to compile.
- `NoInfer<S>` keeps `data` from being an inference site: `S` comes from `set`
  alone. (`{ [K in keyof S]?: never }` is a homomorphic mapped type, which
  TypeScript would otherwise reverse-infer from `data`.)
- `forceCreate` and `forceUpdate` keep their signatures and their one
  `createType`, so RFC 0006's amendment against a second payload marker holds.
- The transaction scope's `create` and `update` pass an options argument
  through (`create: (data, options) => this.create(data, { ...options, trx })`).
- `set` is removed from the options before they reach the adapter. All of this
  happens inside one `if (options.set)` branch; the path without `set` passes
  `writeOptions` through untouched.

### 2. The rules, in the one input step

RFC 0006 made `filterFillable` the framework's single input-protection step and
rejected enforcing input rules separately in each write runner. The `set` rules
go there too: `filterFillable(data, set?)` returns the payload, and `runCreate`,
`runUpdate` and (later) `QueryBuilder.update` call it as they call it today.
When `set` is present, it checks, in order:

1. **The model declares `fillable`.** Without an allowlist every column is
   already writable through `data`, so `set` would promise a separation that
   does not exist. A `set` on such a model throws, naming `fillable`.
2. **No `set` key is `id`.** A server-chosen primary key is a system write and
   belongs to `forceCreate`.
3. **No `set` key is in `deniedFields()`.** It throws with `reason: 'denied'`, as
   it would in `data`: credential columns stay reachable only through the model's
   own derivation or a force write.
4. **No `set` key is in `fillable`.** A column a request may set belongs in
   `data`, and a column the server sets must not be fillable, or every other
   write would accept it from a request. It throws with `reason: 'not-fillable'`
   and a message that says the key is fillable. This is the check that closes the
   escalation `set` would otherwise reopen: `create({}, { set: { ...data, authorId } })`
   puts `data`'s fillable keys into `set`, and throws here.
5. **`data` is filtered as today.** Because a `set` key is never fillable, a
   `data` key that `set` also carries is refused as `not-fillable`. When the
   refused key is also in `set`, the message says so ("`authorId` is set by the
   server in this call; it must not also arrive in the data") rather than
   suggesting `set`, which the caller already used.

The merged payload then goes through `preparePersistencePayload` (mutators,
casts, password hashing), the lifecycle hooks and observers, and the adapter, as
every write does today. `deniedFields()` is resolved once per call and shared by
steps 3 and 5.

No new `reason` is added to `MassAssignmentException`: every refusal above is a
`denied` or `not-fillable` one, so RFC 0006's single `catch` target holds and
the public union does not widen.

### 3. `MassAssignmentException`

The `not-fillable` remediation names `set`, and the closing negative covers
`set` as well as the force writes:

> `Post: mass assignment blocked for field(s) "authorId". Add them to fillable
> if a request may set them; if the server chooses the value, name it in set:
> Post.create(data, { set: { authorId } }). Never pass request input to
> forceCreate/forceUpdate or spread it into set.`

### 4. `guren audit`

RFC 0006's mitigation (c) is unchanged: a method that validates a body and
calls a force write still warns, as a review prompt. Its fix text names
`create(data, { set })` for the owner case. Once the tutorial and the templates
stop using force writes for request data, the warning stops appearing in code
the project ships, and chapter 6 no longer needs a paragraph asking the reader
to accept it.

`set` needs no audit finding of its own. Step 4 refuses a spread of fillable
data into `set` at runtime, which is where RFC 0006 put the authoritative
checks, and it does so whatever shape the call has in the source.

`set` keys are judged; `set` values are not. A key written under a column name
is a choice the author made, which is what mass assignment protection is about.
Whether the value is right, `authorId: user.id` rather than a value read from
the body, is an authorization question for policies and tests.

### 5. What force writes are for

Force writes keep their meaning and are narrowed, in the docs and the harness,
to writes that carry no request data at all: seeders, the runtime stores
(sessions, API tokens, attachments, AI conversations), and OAuth hash sentinels.

### 6. Implementation plan

1. **`@guren/orm`** (minor), with `ModelSetOptions` re-exported from
   `@guren/core` (minor; core's ORM exports are an allowlist):
   - the overloads, `filterFillable(data, set?)`, the runners and the
     transaction scope passing options through;
   - the new messages;
   - runtime tests for every step in section 2, including the spread into
     `set` and a `set` on a model without `fillable`;
   - type tests beside the existing `optionalOnCreate`/`requireOnCreate` ones:
     `set` removes a required key from `data`, a key in both fails, `id` in
     `set` fails, and `S` is inferred from `set` alone.
2. **`@guren/cli`** (patch), after part 1 is released, since what it ships is
   read by apps against their installed `@guren/core`:
   - the force-write finding's fix text;
   - the harness `rules/orm-models.md`, `entry-body.md`,
     `skills/guren-api/SKILL.md` and `skills/feature/SKILL.md` move to `set`, with
     owner columns out of `fillable`.
3. **Docs and shipped code**, also after part 1 is released, so that
   `smoke:starter:npm` never sees a template using an unpublished API: the
   first and third rows of the table in Problem, chapter 6's force-write section
   rewritten around `set`, and chapter 8's agent rule 3.

Left for follow-ups, each small and independent of this design:

- **The audit's view of `this.validated()`.** The force-write trigger looks
  only for `validateBody`, so a route-contract body plus a force write is never
  flagged. The trigger shares its pattern with the route-validation check, so the
  fix is a "returns request data" classification in `controller-methods.ts`
  that both use, not a hand-written widening.
- **`make:auth`.** Its `User` model declares no `fillable`, and its OAuth and
  profile controllers write `emailVerifiedAt` and the provider id through plain
  `create`/`update`. Giving the model a `fillable` and those writes `set` is a
  scaffold change of its own.
- **`QueryBuilder.update(data, { set })`.** It already calls `filterFillable`,
  so it takes `set` without a design change once a caller needs it.
- **A declared group of server-owned columns**, which is RFC 0006's Open
  Question 4 (public `deniedFields()`). It would let a model refuse an owner
  column in `data` even on a path that does not use `set`.

## Alternatives Considered

**Keep the owner in `fillable`, or keep `forceCreate` with validated data.**
These are the two forms in Problem, and each gives up a net.

**Let the audit recognise the owner shape.** Reverted in PR #1024, for the
reason given in Problem.

**Guard `set` with an audit finding instead of a runtime rule.** The first draft
of this RFC warned on a `set` argument that was not an object literal or held a
spread. It misses an options object passed by variable, it needs a second AST
pass over the controllers, and it is a syntactic proxy for what step 4 checks
directly.

**Create through a relation** (`user.posts().create(data)`,
`Post.createFor({ author: user }, data)`). It needs a relation API Guren does
not have, and it covers only foreign keys, not `status: 'draft'` or
`emailVerifiedAt`. It could be built later on top of `set`, which it would
compile down to. Deriving server-owned columns from `belongsTo` is not an
option either: many foreign keys, a post's category for one, are the request's
to choose.

**A request-scoped context that stamps owner columns.** It covers owners only,
and it puts authentication knowledge inside the ORM's write path, the coupling
RFC 0006 rejected; `packages/orm` does not import `@guren/server`.

**A separate method, such as `createWith(set, data)`.** It keeps `set` apart
from `trx`, at the cost of a second vocabulary and an argument order that is
easy to swap.

**Widen `fillable` per call** (`create(data, { fillable: [...] })`). It opens
the allowlist for the request data itself, which is the opposite of what is
needed.

## Migration Path

The ORM change is additive. Existing `create`, `update`, `forceCreate` and
`forceUpdate` calls behave as before, and an existing
`forceCreate({ ...data, ownerId })` keeps working and keeps its audit warning,
whose fix text now points at `set`. Nothing is deprecated.

Moving a call is mechanical: `Post.forceCreate({ ...data, authorId: author.id })`
becomes `Post.create(data, { set: { authorId: author.id } })`. A model that
lists the owner in `fillable` removes it in the same change, since step 4
refuses a fillable key in `set`. No codemod is proposed: the audit warning
already lists the force-write sites, and deciding which columns a request may
set needs a person.

## Open Questions

1. **The name.** `set`, `with`, `assign` or `server`.
   **Decision:** `set`. It reads as what the server does at the call site and
   names nothing else in the ORM.
2. **A key in both `data` and `set`.** Throw, or let `set` win as
   `{ ...data, authorId }` does today.
   **Decision:** throw. With step 4 it follows from the other rules (the key is
   not fillable), and a schema that admits a server-owned column is the bug to
   surface.
3. **`id` in `set`.**
   **Decision:** refused, at the type level and at runtime. The runtime stores
   that choose ULIDs carry no request data and stay on `forceCreate`.
4. **Relation sugar** (`Post.create(data, { for: { author: user } })`).
   **Decision:** not in this RFC. It can derive `set` later, once RFC 0025's
   relation descriptors settle. RFC 0025's example, which listed `authorId` in
   `fillable`, is amended by this RFC.
5. **Bulk writes.** There is no `createMany` today (RFC 0006 recorded the same).
   **Decision:** one added later takes `set` for the whole batch, through the
   same `filterFillable(data, set)` step.
6. **A new `reason` for the conflict case.**
   **Decision:** none. Every refusal is `denied` or `not-fillable`, so the
   public union keeps its members and RFC 0006's single `catch` target holds.
7. **`set` on a model without `fillable`.**
   **Decision:** it throws (section 2, step 1).
