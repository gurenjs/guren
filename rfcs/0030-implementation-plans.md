# RFC: Implementation Plans (`guren plan`)

**Author:** Urata Daiki (@7nohe)
**Date:** 2026-09-19
**Status:** Accepted (2026-09-19; the standard two-week discussion window
was shortened by the deciding maintainer for this solo-driven change, after
a design review against the code recorded in PR #910). Acceptance covers
Parts 1 and 2; Parts 3 to 5 are re-reviewed against Part 2's measurements
before they start (see Phasing).

> A coding agent asked for a feature starts writing files. What it decided
> along the way (which tables, which routes, who may call them) is visible only
> as a diff, after the fact. This RFC puts a design document in front of that
> diff: the model emits JSON against a schema Guren owns, Guren renders it as
> an interactive page a person approves, and from then on Guren, not the agent,
> says which parts of the plan exist in the code.

## Problem

Guren already tells an agent what an application *is* (`guren context`,
`spec:generate`) and whether it is *consistent* (`guren check`, `guren audit`).
Nothing describes what an application is *about to become*. Three things follow.

1. **The design review happens on the diff.** A feature that adds a table, four
   routes and three pages is reviewed as thirty changed files. A wrong column
   type or a missing policy is cheap to fix in a design and expensive once
   pages, validators and tests sit on top of it.
2. **Free-form plans are not checkable.** A Markdown plan can name a route
   whose action it never defines, a foreign key to a model that does not exist,
   or a route name the application already uses. Nothing reads it.
3. **Progress is whatever the agent says it is.** Every plan-driven tool
   surveyed below has the agent tick its own checkboxes, and each has user
   reports of tasks marked done that were never implemented. Guren has static
   scanners for schemas, routes, controller actions and pages, and uses none of
   them to answer "is this step finished".

### Prior art (read 2026-09-19)

Quotes from Anthropic's posts and the Claude Code docs were string-matched
against the page source. The tool comparison and the empirical numbers were
read through a summarizing fetcher and are marked *(summary)*: treat them as
"this source reports", and re-read before citing them elsewhere.

- **Anthropic, "Effective harnesses for long-running agents"** (2025-11-26).
  Work is a list of end-to-end behaviours, one at a time, in a JSON file
  because "the model is less likely to inappropriately change or overwrite
  JSON files compared to Markdown files". The named failure is to "mark a
  feature as complete without proper testing", and the rule on tests is "It is
  unacceptable to remove or edit tests". A fresh context orients itself from a
  progress file and the git history.
- **Anthropic, "How we built our multi-agent research system"** (2025-06-13).
  "multi-agent systems use about 15× more tokens than chats", and "most coding
  tasks involve fewer truly parallelizable tasks than research".
- **Claude Code docs.** Best practices: "Separate research and planning from
  implementation", "If you could describe the diff in one sentence, skip the
  plan", "Give Claude a check it can run", and a fresh reviewer so that "the
  agent doing the work isn't the one grading it". Hooks: exit code 2 on `Stop`
  "Prevents Claude from stopping"; `PostToolUse` cannot block. Headless mode:
  `--json-schema` with `--output-format json` puts the result "in the
  `structured_output` field"; `--bare` "is the recommended mode for scripted
  and SDK calls". Structured outputs validate "with JSON Schema draft-07", can
  end in `error_max_structured_output_retries`, and a `success` result without
  `structured_output` is possible: "Treat that case as a failure as well."
- **GitHub Spec Kit** *(summary)*. The model fills a Markdown `tasks.md`:
  setup, a foundational phase, then one phase per user story with a checkpoint
  where the story is independently testable; inside a story, "Models before
  services. Services before endpoints." The agent marks tasks `[X]` itself.
  Issue #1745 reports tasks marked done and never implemented; a third-party
  extension re-verifies each task (file exists, diff present, symbols declared,
  symbols *used*, semantic read). Böckeler's review: "I'd rather review code
  than all these markdown files", and no answer to drift after approval.
- **Kiro, Task Master, OpenSpec, Codex ExecPlans** *(summary)*. All have the
  model write the task breakdown. Task Master validates dependencies and picks
  the next task deterministically. Kiro schedules dependency waves. OpenSpec
  is the one tool that separates approved specs from in-flight changes, as
  ADDED / MODIFIED / REMOVED deltas. ExecPlans keep a decision log in the plan.
- **Empirical** *(summary)*. SWE-bench-Live: once a patch "edits three or more
  files, or spans more than one hundred lines, the success rate falls below
  ten per-cent" (bug fixing in unfamiliar repositories, so an upper bound on
  caution rather than a number to copy). Chroma's context-rot study: output
  becomes less reliable as input grows. Cursor's parallel-writer experiment
  with locks delivered the throughput of two or three agents from twenty;
  Cognition's position is that writes stay single-threaded. METR's RCT found
  developers' own estimate of their speed wrong in sign.

No surveyed tool derives task status from the code. That is the part only a
framework with a fixed project shape can do, and the reason this belongs in
Guren rather than in a generic planning tool.

## Proposed Solution

Four pieces, each usable without the ones after it:

1. a **plan schema** Guren owns, and a validator for references inside it;
2. a **renderer** that turns a plan into one self-contained HTML file;
3. a **status derivation** that compares a plan with the code;
4. a **producer** that obtains the JSON from `claude -p`, and a task loop for
   the agent that implements it.

The model's only output is JSON. Layout, ordering, task breakdown, status and
every cross-check are Guren's.

### 1. The plan document

`packages/cli/src/plan/schema.ts` defines the plan as a Zod schema. The JSON
Schema handed to a producer is `z.toJSONSchema(PlanSchema, { target: 'draft-7' })`,
and the same Zod schema re-validates whatever comes back.

```typescript
interface Plan {
  planVersion: 1
  title: string
  summary: string
  scope: { goals: string[]; nonGoals: string[] }
  assumptions: string[]          // what the model decided without being told
  questions: PlanQuestion[]      // what it could not decide, and what it assumed meanwhile
  baseline: { rev: string; contextHash: Record<string, string> }   // per referenced element (§4); filled by Guren
  models: PlanModel[]
  validators: PlanValidator[]
  controllers: PlanController[]
  routes: PlanRoute[]
  views: PlanView[]
  resources: PlanResource[]
  policies: PlanPolicy[]
  sideEffects: PlanSideEffect[]  // jobs, events, mail, notifications
  commands: PlanCommand[]        // `guren add attachments` and the like
  tasks: PlanTaskIntent[]        // what each slice must do; never its order
  hints: string[]                // ordering advice Guren may ignore
  flows: PlanFlow[]              // amended: how a request moves through what the plan adds
  locale: string                 // amended: BCP 47 tag of the language the prose is written in
}
```

Every element carries a stable `id` and a `change`:

```typescript
type Change =
  | { kind: 'existing' }                  // referenced, not touched
  | { kind: 'add' }
  | { kind: 'alter'; from: string }       // `from` names what it replaces
  | { kind: 'rename'; from: string }
  | { kind: 'drop'; reason: string }
```

**Amended in implementation:** ~~`{ kind: 'alter'; from: string }`~~ `alter` carries
no `from`. An alter targets the element it is declared on, so there was nothing
for `from` to name. `rename.from` is the previous value of the element's primary
name (a model's class, a column's property, a route's name), and a table renamed
under an unchanged class says so with `tableRenamedFrom` on the model.

**Amended in implementation:** columns carry an `id` like every other element,
and are listed among the plan's elements. A revision (§4) and a question's
`affects` address an element by id alone, and a column renamed by the plan
could not be addressed by its name. Ids are one namespace across all sections,
and an id may not name an `Object.prototype` member: `constructor` and
`toString` fit the id pattern, and a consumer that keys a plain object by id
reads the inherited function back for them. The rendered page went blank on
such a plan before both the page and the schema were closed.

**Amended after acceptance (2026-09-19, PR #920):** a plan may carry flows, as
graphs and never as diagram source:

```typescript
interface PlanFlow {
  id: string
  change: Change
  title: string
  description?: string
  nodes: Array<{
    id: string                   // the flow's own namespace, not the plan's
    label: string
    kind: 'actor' | 'page' | 'route' | 'action' | 'job' | 'store' | 'external' | 'decision'
    element?: string             // the plan element this step is, when it is one
  }>
  edges: Array<{ from: string; to: string; label?: string; kind: 'sync' | 'async' }>
}
```

A flow's `id` is in the plan's namespace, so a revision op and a question's
`affects` can name one. A step's `id` is not: it belongs to its flow, and two
flows may both have a step called `start`. A step that names an `element` is
what makes a flow part of the document rather than a picture beside it: the
page links it to that element, and §2 holds the id to the same rule as every
other reference.

**Amended after acceptance (2026-09-19), language.** A plan's prose (summary,
descriptions, labels, rules, acceptance descriptions) is written in the language
of the request, and the plan says which in `locale`, a BCP 47 tag the producer
prompt asks for. The page puts it on `<html lang>`, which is what governs line
breaking and the font stack for Japanese, and `plan:close` writes the entity
document's blocks in that language. Check results (`PlanCheckResult` titles and
messages) stay English: they are CLI output at the same layer as `guren check`,
and a translated page text that differs from the terminal would be two
statements of one finding.

A headless producer cannot stop and ask. A question is therefore data, and the
model keeps going on a stated assumption:

```typescript
interface PlanQuestion {
  id: string
  question: string
  options: Array<{ label: string; consequence: string }>
  assumed: string      // the option the plan was written under
  affects: string[]    // element ids that change if the answer differs
}
```

A first build is the case where nothing is `existing`. There is no separate
greenfield mode: the plan is always a delta against the code at `baseline.rev`.

The sections, in the terms of a conventional design document:

| Section | Fields |
|---|---|
| Model | table, columns (name, type, nullable, default, unique, index), foreign keys, relationships, fillable, and for any `alter` / `rename` / `drop`: `dataMigration` (required, §2) |
| View | page id, purpose, `Props`, form fields (each naming a validator field, never restating its rules), actions a user can take and the route each one calls, empty / error / loading states |
| Controller | class, action, params, query, body (a validator id), authorization (middleware, policy ability), response (Inertia page id, redirect, or resource id), business rules as prose |
| Routing | method, path, name, action id, middleware, `bind`, agent exposure |
| Validator | one definition per payload; views and controllers reference it by id |
| Resource / Policy | output shape; abilities and who holds them |
| Task intent | entity or story, `acceptance[]` (below), element ids it covers |

**Amended in implementation:** the shipped schema carries more than this table
names. A column has `columnName` (the SQL name where it differs from the
property), `precision` / `scale` for `decimal`, and `withTimezone` for
`datetime`, which Postgres stores as a different column type. A model has
composite `indexes`; a single-column one stays the column's own `unique` /
`index`. A binding has an optional `key`, since `Router` binds by
`[Model, column]` as well as by primary key. Validators, views, resources,
policies and side effects carry an optional `module`, as models and
controllers do. Column types are an abstract vocabulary (`string`, `text`,
`integer`, `number`, `decimal`, `boolean`, `date`, `datetime`, `json`, `uuid`),
not `--fields` types and not Drizzle builder names; the projection onto each
belongs to the scaffold and status slices, and a type with no projection is
reported as unsupported there, never coerced. Composite foreign keys are not
expressible.

Validators are their own section because a form field and a request body that
each describe the same rule are two descriptions that drift.

An acceptance behaviour is structured, so that it can become a test without a
model reading it:

```typescript
interface Acceptance {
  id: string                       // 'AC-comments-3', stable across revisions
  description: string              // "a signed-in author can delete their own comment"
  kind: 'success' | 'validation' | 'unauthenticated' | 'forbidden' | 'not-found' | 'state'
  actor: 'guest' | 'user' | string // a string names a role or a policy subject
  route: string                    // a route name; reference-checked like any other id
  given: string[]                  // preconditions, as prose
  input?: Record<string, unknown>
  expect: {
    status?: number
    redirect?: string
    inertia?: string               // a page id
    errors?: string[]              // validator field names expected to fail
    database?: Array<{ table: string; has?: Record<string, unknown>; missing?: Record<string, unknown> }>
  }
}
```

The shape is Given / When / Then (`given`; `actor`, `route`, `input`;
`expect`) held as data, and the page renders it in those words. `kind` takes
from EARS the one thing a checker can use, its classification of behaviours,
so that the unwanted cases an agent tends to leave out are countable (§2).

Each `expect` key maps onto an assertion `@guren/testing` already has
(`actingAs`, `assertStatus`, `assertRedirect`, `assertInertia`,
`assertForbidden`, the database assertions). The tests a plan leaves behind
are its durable form: the plan is archived at `plan:close`, the tests stay.

**Amended in implementation:** ~~`input?: Record<string, unknown>`~~ and the
`has` / `missing` of `expect.database` are arrays of `{ name, json }`, the
value carried as JSON text and checked to be valid JSON on parse. A
structured-output producer needs `additionalProperties: false` on every
object, which an open record cannot satisfy, and a closed union of primitives
could not carry a nested request body.

Every section is optional. **Amended in implementation:** as sections that
default to `[]` on parse. The JSON Schema handed to a producer is the input
form, so a producer may omit a section; the hash (§4) is taken of the parsed
plan, so a document that omits a section and one that spells it out empty name
the same plan. `planHash()` therefore takes a parsed `Plan` only, and a draft
without a `baseline` has no identity.

A plan that adds one column and one form field is four elements long, and
`guren plan` may answer "this needs no plan" with a one-line reason instead of
a document (the docs' one-sentence-diff rule).

### 2. Reference checks

`packages/cli/src/plan/validate.ts` runs after schema validation, against the
plan and the application's current context (`generateContext()`,
`generateEntityContext()`), and produces the same result shape as `guren check`:

- a route whose action id is not in `controllers`, an action whose page or
  resource id is not in `views` / `resources`, a form field naming a validator
  field that does not exist;
- a foreign key to a model that is neither in the plan nor in `db/schema.ts`;
- an `add` whose route name, path-and-method, table or class already exists; an
  `alter` / `rename` / `drop` / `existing` whose target does not;
- names that disagree with `inflect.ts` (table, route slug, schema identifier);
- a mutating route with authentication and no authorization, a body-carrying
  route with no validator (`describeMethod()` from `http-methods.ts`), so the
  `guren audit` findings surface in the design;
- `dataMigration` missing on any `alter` / `rename` / `drop` of an existing
  table or column, and a `drop` + `add` pair on one table that reads as a
  rename. Whether the table holds rows is not something a static command can
  know, so the rule is conservative: the plan answers every time, and
  `{ kind: 'none', reason }` is an accepted answer;
- an `alter` on a controller action with no acceptance behaviour naming its
  route, since nothing else can judge a change that alters no shape;
- an added or altered route with a validator and no `validation` behaviour,
  with authentication and no `unauthenticated` behaviour, or with a policy and
  no `forbidden` behaviour;
- (amended, PR #920) a flow step naming an element the plan does not declare,
  and a flow edge whose end is not a step of that flow; a flow edge from a
  step to itself is a warning, since the diagram draws no such line and a
  plan should not lose a statement in silence.
- (amended, PR #920) a flow step whose id another step of the same flow
  already took, which leaves an edge naming it ambiguous; a flow step whose
  kind names a section (`route`, `action`, `page`) and whose element is not in
  it. The other kinds are deliberately unconstrained: a `store` step may name
  a model or a resource, a `decision` a validator or a policy, and an `actor`
  names nothing at all.

**Amended in implementation:** a check against the application reads the app root
the plan element names (`module`, absent meaning the project root), for models,
controllers, actions, validators, resources and policies: a same-named element in
another root neither satisfies an `existing` nor collides with an `add`, and the
finding names the root. A table name is the exception. `make:module` re-exports each
module's schema from the project's own `db/schema.ts`, which is the file drizzle-kit
reads, so two roots declaring one name are one SQL table in one migration set: an
`add` collides with a table in any root. An `existing`, `alter`, `rename` or `drop`
table is looked for in the plan's own root, and left unjudged, with its columns, when
only another root declares it. Pages are judged by their id instead, since a module's
pages sit in the project's own `resources/js/pages` under the module's name. The
reference paths themselves are one table (`plan/references.ts`), which the checks here,
the §5 derivation and §4's dangling-name rule all read.

**Existing tests are read as the baseline.** A static scan of the test files
collects which routes they exercise (`app.get('/posts')`, `app.post(...)` on a
`TestApp`, matched against the route graph). The result feeds Impact, and one
rule: a plan that alters or drops a route no existing test reaches gets a
*characterization* step inserted before the change, whose tests pin the
current behaviour and must pass before anything is edited. A path assembled at
runtime is reported as unreadable, never as uncovered.

**Impact** is computed, never written by the model, and it is partial. What
exists today reaches this far: `referencedBy` reverses model relationships and
nothing finer; `generateEntityContext()` finds an entity's tests by file name;
the route graph gives the routes of a controller action, and
`deriveAgentTools()` the tools of those routes. That answers "which models,
routes, agent tools and `ApiRoutes` entries hang off this table or action".
It does not answer "who reads this column". Part 1 adds one new scan, property
accesses on a model's records in controllers, resources and page `Props`, and
the page labels Impact as a lower bound either way: an empty list means
nothing was found, never that nothing is affected. Dropping a column, changing
a type, renaming a route and altering a published agent tool are flagged as
breaking regardless of what Impact found.

**Amended in implementation (Impact):** what shipped, in `packages/cli/src/plan/impact.ts`
(pure) and `impact-sources.ts` (the readers), and where it stops.

- Impact is computed for every element whose change is `alter`, `rename` or `drop`, and
  for a model whose table is renamed. A renamed element is looked up by its `from`, the
  name the application has today. Its list may be empty, and the page says an empty
  list is not proof of anything. A plan that changes nothing existing skips the scan;
  a page rendered with no application draws no Impact.
- The readers are the ones named above, all static: model relationships, route
  bindings, the route graph (with each route's `ApiRoutes` entry and the tool
  `deriveAgentTools()` derives from it), resources and policies, controller actions
  whose body names the element outside comments and strings (a mention, and labelled
  so), and tests by file name. `plan:render` asks for them with `loadPlanAppState({
  impact: true })`, which imports no `db/schema.ts`.
- A class name is resolved from the app root that spells it: a module's own model,
  else the project root's. Relationships, route bindings, action mentions, tests and
  column reads are compared by the model they resolve to, so a module's `Post` never
  lands in the root `Post`'s Impact. A page resolves `Data.Post` in its own root, the
  first segment of its id when that names a module. Known limitation: an action or a
  route binding is resolved by class name from the root it sits in, so a module's
  action that imports the root's `Post` is attributed to the module's `Post` when one
  exists.
- A reader that could not look says so on every entry that rests on it, with its
  reason: a directory that would not open (models, controllers, resources, policies,
  pages, `tests/`), a routes file that threw, a controller or page that did not parse,
  a model file that declared no model the parser could read. A nested directory that
  would not open still under-reports, as in the §2 checks.
- The column-consumer scan (`column-consumers.ts`) reads the AST of controllers,
  resources and page components. A value is a model's record, or a list of them,
  where the file says so: a query on the model class imported from its module (judged
  by the chain's last method: `find*`/`first*`/`create`/`update` a record,
  `all`/`get`/`where`/`withCount` and the other builders a list, `paginate` an object
  whose `data` is a list; every public method of `Model`, `QueryBuilder` and the
  `Attachable`/`SoftDeletes` mixins is classified, and a test fails on one that is not),
  `this.model(M)`, `this.resource` in a resource that imports the model, or an
  annotation naming `MRecord`, a tied resource's data type, `Data.M`, an array of one
  or `PaginatedPageProps` of one. It follows plain aliases, destructuring, indexing,
  `for...of` and element callbacks. The column names a query spells
  (`where('title', …)`, `where({ title })`, `select('title', …)`, `orderBy`) are
  reads, as are the keys of the where clause the model class is handed first
  (`update`, `delete`, `first`, `restore`, `forceDelete`) and the key `find(value,
  key)` looks up by. A query is a chain of method calls back to the class, so
  `Post.name.toLowerCase()` is none. The keys of the data `create`/`update` are given are writes, listed as
  such, since a rename breaks a writer as surely as a reader. A column held in a
  variable (`orderBy(column)`, `create(data)`) and a query ending in a method the
  scan does not classify (an application's own scope) are accesses no static scan can
  name. A method call, and a list's own members (`length`), are not reads. `post[key]`,
  a rest pattern and a spread of a record (`{ ...post }`, `<Card {...post} />`) are
  reads no static scan can name, listed under every changed column of the model.
  A local or parameter named after the model class shadows it. A page's read is
  reported through the resource whose data type tied it.
- Not scanned, so absent from the lists: a value that crosses a function call or a
  file, a reassignment, a component typed through `React.FC<Props>` rather than its
  own parameter annotation, an import through a barrel or through a path alias other
  than `@/`, and a Drizzle table column (`posts.title`) read outside the model.
- The breaking rule stays the plan's own (`planBreakingChanges()`), with one addition
  only the application can answer: an altered route, action or controller whose route
  publishes an agent tool is flagged even when the plan does not declare the tool.
- ~~Deferred: the test-coverage scan of `TestApp` calls and the characterization step it
  feeds. It is a reader of its own with an open accuracy question (Open Question 8),
  and its rule belongs to task derivation (§5). Impact names tests by file name until
  it lands.~~ The scan shipped (below); the characterization step is still deferred.

**Amended in implementation (test-coverage scan):** what shipped, in
`packages/cli/src/test-requests.ts`, and what it measured.

- Every test file `discoverTestFiles()` finds is read by AST, so a comment or a
  string spelling `http.get('/posts')` is no request. A receiver is a `TestApp` where
  the file says so: a binding or parameter annotated `TestApp` (or `Promise<TestApp>`,
  a union holding it, `testing.TestApp` through a namespace import), one initialised
  or assigned from `TestApp.fromApp()` and the other factories, a builder on one
  (`actingAs`, `json`, `withHeaders`, `withHeader`, `withCsrf`), or a call to a
  function of the same file annotated to return one (an arrow whose body is one
  counts). A test pins those builder names and the request methods to the members of
  the `TestApp` class. Bindings are matched by name within the file, not by scope, and
  a helper imported from another file is not followed: a request on what an imported
  function returns (`(await testApp()).get('/posts')`) is reported unresolved.
- The requests are `get`, `post`, `put`, `patch`, `delete` and `query`, plus the GET
  `withCsrf(path = '/')` makes, and `agent().call('tool')`, matched to the route
  whose derived tool has that name. `TestClient` (`@guren/testing/http`) is a second
  request surface and is not read.
- A path is a string, a template literal or a `+` chain, and an identifier bound in
  the file to a `const` string is substituted. An interpolation that fills a whole
  path segment is a runtime segment, which matches a route parameter and never a
  literal segment (`` `/posts/${id}` `` reaches `/posts/:id`, never `/posts/create`).
  The query string and fragment are dropped, an absolute URL loses its origin, and
  empty segments are kept, since hono is strict (`/posts/` is not `/posts`). What
  the scan cannot read is reported unresolved with its file, line and method, never
  matched: a path that does not start with a spelled `/` (`get(path)`,
  `` `${base}/posts` ``), an interpolation sharing a segment with text
  (`` `/p-${id}` ``), and a request on an unknown receiver.
- Route patterns are lexed with the shared `PATH_PARAM_PATTERN` and compared in the
  CLI, since `@guren/cli` does not depend on hono at runtime; a test runs every
  pattern shape it handles through hono itself. A segment that opens with a param is
  that param (hono's label runs to the next `/`, so `:id.json` is one param), a
  constraint that matches `/` takes the segments after it (`:path{.+}`), `*` is any
  rest at the end and one segment elsewhere, and an optional `:name?` only ends a path.
  A constraint JavaScript cannot compile makes the comparison unknown, never a miss.
  Every matching route is listed: a static scan has no registration order to pick
  hono's first match by. A request compared with every route that fits none is left
  out: it reaches none of them.
- Impact lists the requests that reach a route under every entry that reaches that
  route (a changed route, action or controller, a model through its bound routes, a
  view, validator, resource or policy through its actions), once per test file and
  route, at the first request. Tests named after the route's controller are listed
  beside them, labelled as matched by file name, because the reference application's
  tests call the action without HTTP (below). Unresolved requests of the route's
  method (for a tool call, any route publishing a tool), requests its pattern could
  not be compared with, and test files that did not parse are noted beside the entry.
  An altered or dropped route or action gets the note that no `TestApp` request
  reaches it, which is the fact the characterization rule would act on, and only when
  nothing unresolved or unparsed could have: an unreadable path is never read as
  "uncovered".
- Not derived: the characterization step of §5. Inserting it makes task derivation
  depend on the application as well as the plan, which "the same plan always yields
  the same tasks" and the plan digest the step records rest on do not allow as
  written; where the step sits and who owns it is a §5 decision. The scan is
  available to it, and to the skeleton rule that a generated test "must still call
  the route its behaviour names".
- Measured (Open Question 8). `examples/blog`: 26 test files, 29 routes, 0 `TestApp`
  requests. Its 11 controller test files construct the controller and call the
  action with `createControllerContext()`, so no HTTP request exists to read, static
  or runtime, and a route-hit recorder in `TestApp` would see none either.
  `examples/api` is the same (14 files, 11 routes, 0 requests). `examples/agents`:
  6 test files, 20 routes, 40 request sites counted by hand, 40 read and matched to
  the route a person reads them as reaching (16 of them through a runtime segment,
  `` `/tickets/${id}/close` ``), 0 unresolved. That suite reaches 17 of the app's
  20 routes, which is its coverage, not the scan's accuracy. The `create-app`
  starters: 6 of 6. On this evidence the unreadable-path case is not what limits the
  scan; tests that bypass HTTP are, and neither source sees them.

Failures do not block rendering. They appear in the page beside the element
they concern, and `guren plan:approve` refuses while any remain.

### 3. The rendered plan

`guren plan:render <plan>` writes one HTML file: a fixed template under
~~`packages/cli/templates/plan/`~~, with the plan, the check results and (later)
the status inlined as `<script type="application/json">`. No network, no build
step, opens from disk.

**Amended in implementation (PR #915):** the template lives in
`packages/cli/assets/plan/`. `templates/` holds what a scaffolder copies into
an application, and the gates that read that tree (the scaffold typecheck, the
starter audits) have nothing to say about a page the CLI renders itself.

**Amended in implementation (PR #924):** `plan:render` runs the §2 checks
itself, so the page never shows an unchecked plan as clean. `--app <dir>` names
the application they read, the working directory by default.

**Amended after acceptance (2026-09-20), the page's script is TypeScript.** The
first page shipped as one HTML file holding some 2,700 lines of untyped script.
Nothing ties that script to the schema: a field added to a plan, or renamed in
one, is a field the page silently does not draw, and no gate notices. The
script moves to `packages/cli/src/plan/page/*.ts`, typed against `Plan`,
`PlanCheckResult` and the layout types, so a schema change the page has not
followed fails `tsc`. The CLI's build bundles it into one classic script and
writes it into the template, so `plan:render` still emits a single file with no
external reference, and the CSP does not change. Three rules come with it:

- The page refuses a `planVersion` it was not built for, and says so, rather
  than drawing the parts it happens to understand.
- A test walks `planDraftJsonSchema()` and fails on a property the page never
  reads, with an explicit list for the ones it has no reason to show. The type
  check catches a renamed field; only this catches an added one.
- The security rules above stay rules about the page's source, and their tests
  read the TypeScript modules: `textContent` only, the same three `href`
  writes, one injection point for the data.

React was considered and not taken. The page reads a document once and keeps
almost no state; a runtime embedded in every rendered plan buys nothing for
that, and the `textContent`-only guarantee would have to be restated through a
dependency's renderer. JSX over the page's own DOM helper stays possible later
and changes none of the above.

Every string in a plan is model output, and under the `github` store some of
it passed through an editable issue, so the page treats all of it as hostile:
the serializer escapes every `<`, `>`, `&`, U+2028 and U+2029 as `\uXXXX`; the
template writes strings with `textContent` only; links are in-page anchors
built from validated ids, and no plan string ever becomes an `href`; a
`<meta http-equiv="Content-Security-Policy">` allows the inline script and
style and nothing else (`default-src 'none'`), so a plan cannot load or post
anywhere. The diagram is drawn by the template's own SVG code for the same
reason: no Mermaid, and no CDN.

**Amended after acceptance (2026-09-19, PR #920):** a flow is drawn the same
way and for the same reason. The plan carries it as a graph, never as diagram
source: `guren` places it (longest-path layering, so a step sits after its
furthest predecessor) and the page draws the positions it is handed, so one
flow is one picture wherever it is drawn. A plan may describe a loop (a
redirect back to a form, a retry), so the edge that closes a cycle is marked
and routed apart rather than refused. Measured against mermaid 11.17.2: 3.57 MB
for the entry bundle alone, a lazily fetched chunk per diagram type that
`default-src 'none'` refuses, and seven `innerHTML` writes.

- Tabs per section, a filter per entity, and a "changes only" toggle that
  hides `existing` elements.
- Every id is a link: route → action → validator → page → model and back.
- The ER diagram is drawn from the plan merged over the current schema.
  `generateErSpec(cwd)` reads the disk and emits Mermaid Markdown, so it is not
  reusable as it stands: Part 1 extracts the table-and-edge graph it builds
  into a pure function both callers share, and the page renders that graph.
  Existing tables are muted; added and altered ones carry a badge; clicking a
  table opens its columns.
- Breaking changes and failed checks are pinned to the top.
- Questions open the page as a form: the options with their consequences, the
  assumed one preselected, a free-text answer. Every element in a question's
  `affects` is marked "depends on Q2" until the question is answered.
- Each element has an approve toggle and a comment box. "Export feedback"
  downloads `feedback.json`
  (`{ answers: { questionId, option?, text? }[], elements: { elementId, verdict, comment }[] }`),
  which `guren plan --revise` takes as input. The page never writes to the
  project.
- **Amended (2026-09-19):** the page's own words (tabs, buttons, badges,
  headings, the empty and error states) come from a dictionary the CLI ships
  beside the template, in `en` and `ja`. Every locale is embedded and the page
  switches between them; `plan:render --locale` picks the initial one, falling
  back to the plan's `locale`, then the application's default locale, then
  `en`. The two dictionaries are held to key parity and matching placeholders
  by a test, the rule `check --i18n` applies to an application's `lang/`.
  Plan text and check results are never translated by the page.

### 4. Approval and revisions

**Identity.** A plan's hash is the SHA-256 of its canonical bytes: the plan
object with `baseline` included and approval metadata excluded, serialized as
UTF-8 JSON with object keys sorted, arrays in document order, no insignificant
whitespace, and numbers as `JSON.stringify` writes them. The hash is the only
name a plan has; the slug and the issue number are handles.

`guren plan:approve <plan>` records `{ hash, approvedAt, approvedBy }` beside
the plan, never inside it. Every later command recomputes the hash and refuses
a plan that does not match an approval. It refuses while a question is
unanswered or a §2 check fails: an assumption nobody confirmed is not approved
by silence.

**Revisions.** A plan changes through a revision, before approval and after:

```bash
bunx guren plan --revise comments --feedback feedback.json --message "soft-delete comments instead"
```

A revision is `{ parent, ops, result }`: the parent's hash, the elements
ADDED, MODIFIED and REMOVED by id, each with a `reason`, and the hash of the
plan those operations yield. Applying `ops` to the parent must reproduce
`result`, or the revision is rejected. The page shows the operations, the
approval names `result`, and the current plan is the head of the approved
chain. A decision taken during implementation that contradicts the plan is a
revision too; it is never a silent edit.

**Amended after re-review (2026-09-23), Part 3.** The command above is the
model-calling form, and it keeps the name `plan --revise`. It waits with the
headless producer (§8). Part 3 ships a model-free `plan:revise` first. It
takes ops from a file or standard input, or an edited plan whose ops
`diffPlans()` derives (`packages/cli/src/plan/revision.ts:484`). It stamps
them through `createPlanRevision()` and writes the revision under
`revisions/`. Given feedback, it applies the two rules below, the lock and the
answered question, which `createPlanRevision()` already enforces. It does not
turn a reviewer's comments into ops; that is the model's work. It gives the
page's exported feedback its first reader (`plan/feedback.ts:5-6` says none
exists yet). It is also the command the `plan-implement` skill already names.

The producer is asked for `ops`, against a revision schema, and never for a
whole plan. A model that re-emits the document can change a part nobody was
looking at; one that emits operations cannot touch an id without saying so.
Two rules follow from review state:

- An element the feedback marked approved is locked. An op on a locked id must
  carry `reopens: <reason>` (a changed model that forces a change in an
  approved validator), and the page lists reopened elements apart from the
  rest. An op on a locked id without it is rejected.
- An answered question is removed by the revision that applies its answer,
  together with the marks on what it affected.

**Amended in implementation (`plan/revision.ts`), what an op is.** The text
above leaves the op shape open, and these are the choices the code makes:

- An op addresses an element by id alone, nested elements (columns, actions,
  acceptance behaviours) included. `modify` also names the `section`, which
  selects the shape its `element` is held to; a section that is not the id's
  own is rejected.
- `modify` carries the element's own fields whole. Its shape has no `id` and
  no nested list, so an op cannot rename what it names, and a column changes
  only through an op naming that column. An id changes by `remove` and `add`.
  A merge patch was not taken: it needs a partial copy of every element schema
  and a way to say "unset", which closed objects do not have.
- Array order is part of the hash, so an `add` says where it goes: `before` a
  sibling, or at the end without one. A nested `add` names its `parent`.
  `remove` takes nested elements along. An element moves by `remove` then
  `add`; any other second op on one id in a revision is rejected, and so is a
  `modify` that changes nothing.
- A revision whose ops yield the parent's own hash is rejected as a whole,
  under a kind of its own: ops that cancel out, and no ops at all, would
  chain a revision that names its parent as its result. The kind a `modify`
  that changes nothing carries names the op at fault, and this one names no
  op, so the two are not one kind. The producer's schema asks for one op at
  least, which is cheaper than refusing the empty list after the fact; a
  stored revision carries its `ops` unconstrained, since a record with none
  is a record to diagnose rather than a malformed document.
- A stored revision whose ops do not reach its own `result` is reported as a
  mismatch, ahead of any account of what the ops do: a record that does not
  reproduce its own hash was written against other code, whatever else is
  true of it.
- The title, summary, scope, assumptions, hints and locale have no id. They
  are addressed as `modify` on the section `plan`, which carries all of them.
- `baseline` and `planVersion` are out of an op's reach. A revision carries
  `baseline` over from its parent, so the hash moves through ops alone. What
  stamps `contextHash` for an element a revision newly references is left to
  the Freshness work.
- A `remove` that leaves another element naming the id is rejected. That is
  the one reference rule applied here, because the op itself creates the
  defect; every other reference stays a §2 finding.
- Approval of a parent covers what it holds: an op on a column of an approved
  model, and an `add` under it, need `reopens`. `reopens` on an element nobody
  locked is ignored. Approval covers an element and not its place in the
  list, so an `add` placed `before` an approved sibling needs none.
- With feedback that answers a question, a revision that does not `remove`
  that question is rejected. The question is looked for among the questions
  of the result and not among its ids at large, so a revision may remove the
  question and give its id to an element of another section. The "depends
  on" marks are derived from `affects`, so removing the question is what
  removes them. Feedback given on
  another plan hash, or naming an id the parent lacks, is rejected too: a lock
  that names nothing is a lock silently not applied.

Each revise is a fresh call given the current plan, the feedback and the
message. It does not resume the producing session: the plan is the state, and
a session is gone by the time someone returns to a plan days later or on
another machine.

**Amended after acceptance (2026-09-19):** exporting a file and typing a
command is three steps, two of them handing a file around. `--feedback -`
reads the document from standard input, so the page's "Copy feedback" and a
pipe (`pbpaste | guren plan --revise comments --feedback -`) replace the file;
and under the served mode of §8, `--revise` reads the feedback the page has
already saved, so `--feedback` is only ever needed for a file made elsewhere.
The page shows both commands, the file form and the pipe, beside the buttons
that produce their input. Feedback is read through one counting reader, file
and standard input alike, and refused past 5 MiB: a size checked with `stat()`
before the open is a race between the check and the read.

Before approval, editing `plan.json` by hand is as legitimate as a revision:
it is a JSON file, and `plan:render` re-validates it. Renaming a column does
not need a model.

**Amended after re-review (2026-09-23), Part 3:** after approval, the same
hand edit goes through `plan:revise`, which records it as a revision rather
than a silent edit (Open Question 13).

**Amended in implementation (`plan:revise`).** The model-free command ships as
`packages/cli/src/plan-revise.ts`, and these are the choices it makes:

- The parent is the plan file as it stands; nothing is read from git. It is
  accepted as a draft nobody approved, at a hash an approval names, or at the
  `result` of a revision recorded beside it, so a plan revised once can be
  revised again before anyone approves it. Anything else is a plan edited in
  place after approval, and the refusal says to restore it
  (`git checkout -- <plan>`) and pass the edit as `--edited <copy>`. A draft
  with approvals beside it, or approvals that will not read, is refused as
  `readPlanApprovalStanding()` classifies it. The rule catches an accidental
  edit, not a forger: the records are committed files anyone can write.
- The change comes as `--ops <file|->`, the `{ "ops": [...] }` document a
  revising producer emits (each op with its own `reason`), or as
  `--edited <file|->`, a full copy whose ops `diffPlans()` derives, each with
  `--message` as its reason and `--reopens`, when given, on all of them. A copy
  whose baseline differs from the parent's is refused, as is one no op can
  express: the ops must reproduce the copy's own digest, or writing the copy
  would miss the record and writing the result would drop the edit. Ops,
  copies and feedback share the feedback's counting reader and its cap, and at
  most one of them reads standard input. citty parses `--feedback -` as an
  empty value and drops the dash, so the command reads it back off the raw
  arguments (`--feedback=-` parses as written); an empty value is refused.
- A draft revises too. `createPlanRevision()` hashes a draft with
  `planDigest()`, the same computation as `planHash()`, parses the result as a
  draft, and feedback without `planHash` (what the page exports for a draft)
  is matched without a hash check.
- Records live in `planRevisionsDir()` (`plan/beside.ts`): `revisions/` beside
  a `plan.json`, `<slug>.revisions/` beside any other plan, so no record name
  matches a plan file. Each is `<n>.json`, the next number after every name
  present, holding exactly `PlanRevisionSchema` so `applyRevision()` reads it
  back. It is linked into place from a temporary, so none is overwritten. The
  record is written before the plan: a plan written without one would sit at
  a hash nothing names. The records are not a verified chain: when the plan
  write fails after the record, the command says so and the record stays,
  naming a result the plan never reached; the next run records again from the
  same parent.
- The plan file is rewritten to the result, which must read back at the
  record's `result` before anything is written. An edited copy is written as
  its author wrote it. Ops are written as the parsed result in the author's
  key order, leaving out a section the parent omitted that the result still
  holds at its default.
- `plan:approve`'s dirty-tree exceptions and the step work measurement leave
  the revisions directory out, like the other records; `plan:next` counts it
  as uncommitted, like them, and plan discovery skips it.
- The report names the new hash, the record, the reopened elements, the
  answered questions, and the waivers the decision log holds at the parent
  hash, which the result does not inherit. A plan with a baseline then needs
  `plan:approve`; the gated commands refuse it until then.

**Freshness.** `baseline.rev` records where the plan was written and gates
nothing: the implementation's own commits move it on the first step.
`baseline.contextHash` is scoped, a hash per *referenced* element (each
`existing`, `alter`, `rename` and `drop` target, and every name an `add` must
not collide with) of the shape the scanners read at that revision. An
unrelated commit leaves it alone. A change to a referenced element marks that
element stale, re-runs the §2 checks for it, and blocks only the steps that
depend on it.

**Amended in implementation (`plan:approve`, freshness).** `plan:approve` was
pulled forward from Part 3 for this work, since nothing else could stamp a
baseline, and ships in a minimal form (`packages/cli/src/plan-approve.ts`,
`plan/freshness.ts`, `plan/approvals.ts`):

- `plan:approve` is the one writer of `baseline`. A draft is stamped once:
  `rev` is `git rev-parse HEAD` of the application, and no repository or no
  commit is a refusal rather than an invented rev. `contextHash` reads the
  working tree while `rev` names a commit, so a dirty tree is refused too,
  and so is a `git status` that fails. The plan file, its rendered page, its
  approvals and decision log, a leftover temporary file of theirs and
  `.guren/plans/` are excepted, compared as real paths, with untracked
  directories listed file by file so a new `docs/plans/<slug>/` is not one
  change. The plan file is written back atomically, keeping its mode and
  writing through a symlink to the file it names, as the author's document
  plus the baseline, so an omitted section stays omitted. A plan that already carries a
  baseline, as a revision carries its parent's, is never restamped: the
  baseline is inside the hash every approval and waiver names. It refuses
  while a §2 check fails or a question is open.
- Stamping moves the hash, since the baseline is part of it. A draft's
  `.guren/plans/` records name `planDigest()` of the draft, so every step
  verified before approval starts over once the plan is approved.
- The approval is `{ hash, approvedAt, approvedBy? }` in `approvals.json` beside
  a `plan.json`, and in `<slug>.approvals.json` beside any other plan, the rule
  the decision log follows. Approving a hash already approved writes nothing,
  and a file that will not read is refused before the plan is touched.
  The commands that act on the plan refuse a hash no approval names (below,
  approval gate).
- `contextHash` is keyed by element id, one entry for every element the §2
  checks judge against the application by name. Both read one derivation of
  what name an element is judged by (`plan/app-targets.ts`). The value is a
  SHA-256 of the facts those checks read for the name: whether the plan's own
  app root declares it, and for a table which other roots do (matched by its
  identifier or SQL name, without its columns, since a column is its own
  entry), whether a column's table declares the column and where else that
  table is declared, and a route name's endpoints.
- A section that cannot be read stamps no entry. Validators, which no scanner
  reads, are never stamped. Any other unreadable section makes `plan:approve`
  refuse, naming the section and the elements it would leave unstamped for
  good, unless `--allow-unstamped` is passed. Comparing gives four verdicts:
  `fresh`, `stale`, `unstamped` (no entry: a revision named the element after
  approval, or its section was unreadable then) and `unjudged` (its section
  cannot be read now). An unreadable section is never `fresh`. `unstamped` is
  the answer to what stamps an element a revision newly references: nothing,
  and the baseline carried over from the parent stays as it was.
- An element is `fresh` while its facts hash to the stamp or to the facts the
  plan's own end state predicts. The prediction comes from the plan alone: an
  `add` or the new name of a `rename` is declared in the element's root, the
  old name is not, a `drop` and every child of a dropped parent are gone, an
  `existing` or `alter` element stays, a column sits in its table, and a route
  name carries the planned method and path. Every root's schema is one SQL
  schema, so a table name the plan brings in or removes is predicted declared
  in no other root, and a dropped model's columns with it; another root's
  declaration of any other table name is carried over as read. Where else a
  class is declared is not hashed at all, since it only feeds the text of a
  §2 finding.
  Anything else is `stale`, so an `alter` route whose path another commit
  moved is stale although `plan:status` already reads it as `drifted`. The
  rule does not consult `plan:status`. It cannot tell a same-named class that
  another commit adds in the plan's own root after approval from the plan's own
  `add`: both read as the end state. An element judged by two targets (a
  model's class and its table) is fresh only when both are at the stamp or both
  at the end, so a step that renames one before the other reads as stale in
  between.
- `plan:status` reports the verdicts for a plan with a baseline, with the
  elements naming each non-fresh one through the reference table.
- A step depends on a stale element when it owns it, when one of its own
  elements or behaviours names it, or when it owns a column of that model or
  an action of that controller (`plan/step-context.ts`; the parent is
  `planElementParents()`, the pairing §5 places together). An `existing`
  element has no owner and holds only the steps naming it or owning its
  children. The rule is one hop through the reference table and never its
  closure: relationships and `covers` connect a model to most of the plan, so
  a closure would hold every step on one change. What names a stale element
  without being any step's work (an intent's `covers`, a question, a flow)
  holds nothing. Only `stale` holds a step. `unstamped` and `unjudged` are not
  evidence of change, so they hold nothing and are reported as unconfirmed,
  and nothing unreadable releases a hold either. The commands call such a
  step `held`, since `blocked` is the environment's word (§6).
- The elements the marked step owns hold no step while it is marked, stalled
  or not (`stepInProgress()`): they are its work in progress, and half of it
  reads as stale (a model's class written before its table). A stalled step is
  still the one being built, and `plan:next` returns it again with the stall,
  or holds it when what stalled it is stale context. Once the mark moves to
  another step, the exclusion goes with it: partial work the stalled step left
  committed then reads as stale and holds that step, until a revised plan that
  states it is approved or the step's work is finished. An external change to
  one of those elements still reaches that step through its own verification,
  which compares the element with the plan.
- Releasing a hold is a person's: a stale element turns fresh again once the
  application is back at its stamp or at what the plan leaves, so the answer
  is a plan revised to state what the application holds now and approved, or
  undoing the change. A carried-over baseline is never restamped (above).
- Changing what the stamp hashes renames every approved plan and orphans its
  approvals and waivers, so the facts carry a version of their own.

**Amended in implementation (approval gate).** "Every later command
recomputes the hash and refuses" is shipped per command, since not every later
command acts on the plan (`plan/approvals.ts`, `plan-next.ts`, `plan-verify.ts`,
`plan-waive.ts`, `plan-stop-hook.ts`, `plan-status.ts`):

- One rule decides: `readPlanApprovalStanding()` recomputes `planHash()` and
  answers `approved`, `unapproved` or `unreadable`, and `requirePlanApproval()`
  turns anything but `approved` into a refusal that names the hash and says to
  run `plan:approve`. `plan:close` refuses through the same helper. An
  approvals file that will not read refuses: an approval nobody can read
  approves nothing.
- The gate applies to a plan with a baseline. A draft has no hash anyone could
  approve, so the commands that accepted drafts (`plan:next`, `plan:verify`)
  still do, and the ones that refused them (`plan:waive`, `plan:close`) still
  refuse them with their own message. A draft with approvals recorded beside
  it is the exception (`baseline-removed`): deleting `baseline` would otherwise
  turn an approved plan into a draft no gate asks about, so it is refused like
  an unapproved plan, and so is a draft whose approvals file will not read,
  since that file may hold the approval the baseline had. The rule reads the
  approvals file the sibling rule names, so a draft named `plan.json` in a
  directory whose unrelated `approvals.json` has entries is refused as well;
  the message says to keep the new draft in a file of its own.
- `plan:next` refuses before it reads the tree or the application and before
  it writes a mark, so a person mid-step on an edited plan hears about the
  approval rather than the dirty tree. `plan:verify` refuses before `codegen`
  runs and before any record is written: a result recorded under a digest
  nobody approved would count once somebody approves that digest, which
  verifies work against a plan before anyone agreed to it.
- `plan:waive` refuses a waiver against an unapproved hash, since a waiver is a
  decision about the approved plan and names its hash. `--remove` asks
  nothing, the approval included: withdrawing a waiver of an element a
  revision dropped is what it is for, and the revision is exactly the plan no
  approval names yet.
- The Stop hook never throws and never blocks on approval: no continuation
  approves a plan. It verifies nothing, lets the stop through and records a
  stall on the mark with the refusal as the reason and `cause: 'approval'`, so
  later stops stay silent. Unlike other stalls, `plan:next` does not report it,
  since a run that passes the gate has answered it; the step gets a fresh mark
  as after any other stall. `plan:verify` judges the approvals again on the
  plan it reads itself rather than trusting the hook's reading, since the plan
  may change between the two.
- `plan:status` reports and does not refuse. It is observational and exits 0
  whatever it finds, so a plan with a baseline carries `approval` in the
  report (`approved` with the record, `unapproved`, `baseline-removed`, or
  `unreadable` with the reason) and one line naming the commands that refuse
  (`PLAN_APPROVAL_GATED_COMMANDS`). `plan:verify`'s report, which extends it,
  carries `approved` in its JSON and leaves the line out of its text.
- `plan:render` is unaffected: the page is how a person reviews a plan before
  approving it, so refusing it would leave nothing to approve from.
- `plan:approve` itself answers the refusal. A plan edited after approval keeps
  its baseline, so approving it records the new hash without restamping, and
  the §2 checks and open questions are asked again first.

**Amended in implementation (re-approving a plan that is being built).** Asked
again against an application the plan has partly built, the §2 checks fail
the plan's own work: an `add` finds its name, the old name of a `rename` and
the target of a `drop` are gone. Measured on a scratch blog, one edited goal
after the scaffold step gave seven failures, so the refusal above told a
person to run a command that could not succeed until the plan was finished.
What shipped (`settleBuiltFindings()` in `plan/validate.ts`, reading
`judgeFreshness()`):

- On a plan with a baseline, a `plan:app-collision` or `plan:app-missing`
  finding is settled to `pass` when freshness calls its element `built`: the
  stamp equals the facts the plan starts that element from, and the
  application now reads as the plan leaves it. Both predictions come from the
  plan alone, for the element as the plan names it now: at the start an `add`
  and the new name of a `rename` are absent and every other name is present,
  and the end is the prediction freshness already makes. `judgeFreshness()`
  reports the difference as `basis` on a `fresh` verdict that is not at its
  stamp: `built`, or `end` when only the end matches.
- The start is what keeps a revision honest. A revision that turns an
  `existing` element into an `add` of the name the application has is still at
  its stamp, not built, so the collision refuses. An `add` a revision
  retargets onto a name the application already had is at its end, but its
  stamp hashed the old name, so it refuses too. An element a revision added
  has no stamp and is judged as a draft would be.
- Everything else still refuses: an open question, a failing internal
  reference, the other §2 checks, an element whose facts cannot be read, and a
  collision the end state does not explain. A table the plan adds that another
  app root declares, or a route endpoint another route holds, is not at the
  end. The start carries over what other roots declare as it reads now, and
  predicts a route present at the start at its planned endpoint, so another
  root's declarations changing since approval, or a `rename` or `alter` of a
  route that also moves its path, reads as not built and refuses; that errs
  on the refusing side.
- Limits, the ones freshness has: a same-named class another commit adds in
  the plan's own root reads as the plan's own `add`, and so does a second
  route on the endpoint of a built one. A revision that turns an `existing`
  element into a `drop` after someone else deleted it is settled, since the
  stamp recorded it present and it is gone. A model whose class is written
  and whose table is not reads as neither stamp nor end (the two-target rule
  above), so approval still refuses between the two.
- A draft is unchanged: it has no stamp, so nothing is settled, and a draft
  whose `add` already exists is refused as before.
- The baseline is still never restamped; re-approval records the new hash.
  The report names the settled elements (`builtByPlan`).
- `plan:render` settles the same findings on a plan with a baseline, so the
  page pins no failure the plan's own work explains, and the element's card
  shows the finding as a `pass` that says it was built by this plan.

### 5. Tasks are derived, not written

The model supplies `tasks[]`: what each slice must achieve, and its acceptance
behaviours. Guren supplies the breakdown and the order, in
`packages/cli/src/plan/tasks.ts`:

1. **Foundation**: `commands`, and anything several entities share.
2. **One task per entity**, a vertical slice, ordered by foreign keys
   (`comments` after `posts`). Steps inside a slice are fixed:

   | Step | Work | Verify |
   |---|---|---|
   | scaffold | deterministic, no model (see below) | codegen, then `typecheck` |
   | tests | skeletons generated from `acceptance[]` (no model); the agent fills `given` setup and what `expect` cannot express | codegen, then every generated test runs and fails |
   | data | what the scaffold's table cannot express, migration, model relationships | codegen, `db:migrate`, `typecheck` |
   | http | validator, resource, policy, controller, routes | codegen, `guren check`, the slice's tests |
   | pages | page components | codegen, `typecheck`, `guren check` |

3. **Cross-entity tasks** (a dashboard) depend on every slice they read.

The same plan always yields the same tasks. `hints[]` may reorder tasks that
the dependency graph leaves unordered, and nothing else.

**Amended in implementation (task derivation):** the list above left open what
decides a task, so `tasks.ts` fixes it:

- **Ownership.** Every element that is not `existing` is owned by exactly one
  step, the one whose verification completes it: models and columns by `data`,
  validators, controllers, actions, routes, resources, policies and side
  effects by `http`, views by `pages`, commands by a `commands` step in
  Foundation (verify: codegen, `typecheck`). `scaffold` and `tests` own
  nothing and complete on their commands; `scaffold` lists what it `generates`.
  A step kind with no work is left out. Flows are descriptions and are nobody's
  work.
- **Which task.** A column follows its model and an action its controller.
  For the rest, in this order: the one task intent that `covers` it; the models
  it references (a resource's or policy's `model`, a view's prop resources, a
  controller's policies, resources and pages); what uses it (a route its
  action's controller, a validator the actions and forms naming it, a view the
  actions rendering it); the model it is named after, through `inflect.ts`.
  Several referenced models that the name does not settle make a cross-entity
  task; several users make it Foundation; no evidence is Foundation with a
  note. A route's `bind` is read only when its action is not in the plan, since
  a nested route binds its parent too. An `add`, `rename` or `drop` model is
  always its own slice; an altered one that exactly one other slice covers is
  that slice's edit (the `hasMany` a new child needs). In a class name a digit
  continues the word, so `Post2Controller` is not `Post`'s. Two models whose
  collection is spelled the same, one by its slug and one by its table, are
  settled by the plan: the one declared first wins.
- **Foundation stands alone.** It waits for nothing, so nothing it owns may
  need another task's work. An element that lands there and does (a page two
  controllers share, submitting to one slice's route) joins the slice it
  needs, or the cross-entity task of the slices it needs when there are
  several; what in Foundation needed *it* follows, an action moving with its
  controller. What it needs is read through Foundation as a whole, so needing
  a neighbour that needs a slice is needing that slice, whatever order the two
  were placed in. A story task is no slice to join: work needing one of those
  and nothing else stays in Foundation and is reported, which is the one order
  not kept; work that also needs a slice joins it, and the story becomes an
  ordinary dependency.
- **Intents.** `tasks[].entity` names a model by class, id or table, and the
  intent's acceptance goes to that slice: on `tests`, and on the step where the
  behaviours must pass, which is the last `http` step, or the task's last step
  when it has none. That step's verify always includes the tests, so a slice
  of `data` or `pages` alone still runs them. A task with behaviours and no
  work has the `tests` step only, run after the tasks it waits for and
  verified by the tests *passing*: failing first is tamper detection, which
  means something only where an implementation step comes after the tests.
  An `entity` that names no model is a story and becomes a task of its own,
  which waits for the tasks owning what it covers and the routes its
  behaviours name. Both that and an intent that brings neither work nor
  behaviour are reported.
- **Order.** A task waits for the task doing the work of whatever its elements
  reference, foreign keys first among them; an `existing` target is already
  there. Tables are dropped child first. Relationships order nothing: a
  `hasMany` mirrors the foreign key pointing back and would close a cycle with
  it. A real cycle (mutual foreign keys) is cut at its first member in document
  order, which stops waiting, and reported; a self-reference is not one.
  Document order breaks every tie.
- **Hints** are `<task> before <task>` or `<task> after <task>`, a task being a
  derived id, a `tasks[]` id, or a model's id, class or table. Anything else is
  reported as unreadable. A hint is never a dependency, and one that a
  dependency or an earlier hint answers the other way is dropped and reported.
- **Ids.** `task/foundation`, `task/entity/<model id>`, `task/story/<intent id>`,
  `task/cross/<model ids joined by +>`, and `<task id>/<step kind>` with `/<n>`
  appended when the kind was split. No plan id can contain `/`.
- **Splitting** counts files: a column is its model's file, an action its
  controller's, and a slice's routes are one registrar. Parts fill in document
  order; a screen group (the page's first path segment) moves to the next part
  whole unless it is wider than a part. `scaffold` and `tests` are not split.
  A part's id is stable and its content is not: a revision that adds an
  element ahead of others shifts them into the next part under the same ids,
  so progress is keyed by element and a step id names a position.
- A slice is scaffolded only when it adds its own model and the application is
  not API-only, and `generates` holds its `add` elements only.

**Scaffolding is step one, and it is not the agent's.** One slice is around
ten files, which is past the width at which agent success rates fall, so
whatever can be generated is generated before an agent starts.

`make:feature` alone does not get there. Its flags (`--fields`, `--policy`,
`--public`, `--attach`, `--test`, `--module`) carry six field types and a `?`
for nullable; they cannot say default, unique, index, foreign key,
relationship or fillable. And it stops short of a compiling application: the
table definition, the route registration, the migration, codegen and the
policy registration are printed as "Next steps" for a person. A scaffold step
that ended there could not pass `typecheck`.

So the step is `make:feature` plus the wiring this RFC adds, each through a
writer the CLI already has:

| Work | Writer |
|---|---|
| model, controller, validator, resource, pages, policy, test file | `make:feature`, arguments computed from the plan |
| the table, with the column options and foreign keys the plan states | a plan-to-Drizzle emitter, appended with `appendTableToSchema()` |
| routes with their body schemas, in a `routes/<entity>.ts` registrar of their own | emitted from the plan, mounted with `wireRouteRegistrar()` |
| policy registration | no writer exists: `wireAppProvider()` registers a provider with `createApp()`, and nothing edits a provider's `boot()`. Part 3 adds one, or this stays the agent's first edit in the `http` step |
| `.guren/*.gen.ts` | `guren codegen` |

~~Routes go in their own file because the existing patch mounts a registrar
call and does not insert route lines into `routes/web.ts`.~~

**Amended after re-review (2026-09-23), Part 3.** Stale here: the premise
struck above; the "Next steps" account of what `make:feature` leaves undone;
the table's first and fourth rows; and, in the next paragraph, the generated
pages and the relationships and fillable left to the agent (the emitter below
writes both). What replaces them:

- `guren add resource` predates this RFC and already writes two of the three
  wirings the table says are missing. It runs `makeFeature` and appends a
  per-dialect table through `appendTableToSchema()`. It also inserts the CRUD
  route group into `routes/web.ts`
  (`packages/cli/src/blueprints.ts:389-426, 428-473, 526-566`). Its limits: the
  six `--fields` types (`fields.ts:11`, against the plan's ten at
  `plan/schema.ts:54-65`), no default, unique, index or foreign key, the
  project root only, and routes registered without the auth middleware
  (`withAuth: false`, `blueprints.ts:548`).
- `make:feature` is not the scaffold's writer, and neither is `add resource`.
  Both write a fixed CRUD surface whatever the plan says: seven actions
  (`make-feature.ts:491-600`), four pages (`:155-167`) and seven routes
  (`buildRouteRegistrationHint`, `:354-382`). `add resource` also mounts the
  routes. The endpoints the plan does not declare are unapproved, and no
  status reading or §2 check sees them.
- The scaffold is a plan-driven emitter, a pure function from plan to files.
  `guren plan:scaffold <plan> --step <id>` writes them, and `plan:next` names
  that command for a scaffold step. The emitter reuses the per-dialect column
  builders, `appendTableToSchema()`, the model and policy templates,
  `wireAppProvider()` and `wireRouteRegistrar()`, factored rather than called
  whole.
- What it emits, per element: the table with every column option the plan
  states and its foreign keys; the model with relationships and fillable;
  validators; resources; the policy class and a registration provider; the
  controller with exactly the planned actions as stubs; the routes file;
  side-effect classes; and `@docs` tags. No pages, no action bodies and no
  CRUD extras.
- Policy registration needs no `boot()` patcher. A proposal, to settle in the
  change that implements it: a per-entity
  `app/Providers/<Entity>PolicyProvider.ts` in the shape of the blog
  template's `AuthorizationProvider.ts`. Its `boot()` calls
  `this.container.make('gate').policy(Model, Policy)`, and `wireAppProvider()`
  registers it (`provider-registrar.ts:125-127`).
- The routes go in a `routes/<entity>.ts` of their own, after #1039. At
  2a784c4d an entry route is fingerprinted as the entry routes file alone
  (`plan/app-detail.ts:295`). `routeFileDetail()` already lists every project
  routes file (`plan/app-detail.ts:555-569`). Predicted from that code:
  editing a `routes/<x>.ts` the entry registrar calls does not drift a
  verified step.
- The scaffold writes the routes file and does not mount it. The `http` step
  mounts it with one `wireRouteRegistrar()` call. ~~This is pending the
  mounted-routes experiment in the Part 3 note under Phasing.~~ The
  prediction, which that experiment confirmed (Part 3 note under Phasing),
  is that a mounted route whose auth middleware, `userOrFail()` or contract
  validation answers 401, a redirect or 422 before any table exists can pass
  the slice's `unauthenticated` or `validation` behaviour before the `tests`
  step, which runs after `scaffold` (`plan/tasks.ts:786-818`). A `forbidden`
  behaviour usually needs the record, so it is not predicted to pass. The
  exception is a policy's `create` guard, which reads no record.
  `tests:fail` judges each behaviour on its own and needs every case of it to
  fail (`plan/verify.ts:172-183`), so one such behaviour passing is enough for
  that step never to verify.
- A proposal, to settle in the change that implements it: unmounted stubs
  validate with `validateBody(Schema)`. `validated('<name>')` is typed from
  generated route names (`packages/server/src/mvc/Controller.ts:479-481`), so
  it would not typecheck while the route is unmounted.
- Pages are not emitted. A page written with the plan's `Props` makes every
  readable property of its view match by construction
  (`plan/status.ts:1075-1091`). The `pages` step would then verify it on a
  typecheck while its form, actions and states, which nothing reads, are
  unwritten. Layout stays with prototype mode (Open Question 4).

The migration is not generated here: `db:make` needs drizzle-kit and
`db:migrate` a database, which makes it the `data` step's and `plan:verify`'s
business (§6). What the agent is left with after the scaffold is relationships
on the model, fillable, business rules, and form fields the generated pages
do not have.

An API-only application gets no scaffold step: `make:feature` refuses one
(`assertNotApiOnly`), since it generates Inertia pages. Its slices are
`make:controller` and `make:validator` plus agent steps, and `views` must be
empty in its plans (a §2 check).

**Amended after re-review (2026-09-23), Part 3:** the reason given here rests
on `make:feature` being the writer. The plan-driven emitter above writes no
pages, so whether an API-only slice now gets a scaffold step is open; until it
is decided, task derivation keeps leaving it out.

**Amended in implementation (`plan:scaffold`, first of three changes):** what
shipped, and where it stops.

- `guren plan:scaffold <plan> --step <id>` writes the tables and the models, and
  nothing else yet. Per model the step adds, it appends the table to the root
  `db/schema.ts` through `appendTableToSchema()`, in the schema's dialect. The
  table carries every column option `plan/status.ts` compares (type, nullable,
  unique, index, default, `columnName`, `withTimezone`, precision and scale, the
  primary key, the foreign key and its `onDelete`) and the model's multi-column
  indexes. The model file is `app/Models/<Name>.ts`, with `fillable` and the
  relationships, keyed by the foreign keys the plan states. A relationship whose
  target or keys do not exist yet (a `hasMany` to a model a later task adds) is
  left out and listed. The second change adds validators, resources and
  policies; the third adds the controller stubs and the routes file (D5), which
  the `http` step mounts (D3). `plan:next` and the harness skill say what the
  command writes today and that the `http` step writes the rest by hand.
- The emitters live in `packages/cli/src/plan/scaffold.ts`, a pure function from
  the step and the facts the command reads (the dialect, every root's tables, the
  root's model classes). `planScaffoldCoverage()` there is the one rule for which
  of a step's `generates` it writes, which its report and `plan:next` share. The
  column builders are factored out of the resource blueprint into
  `packages/cli/src/schema-columns.ts`, which `guren add resource` now writes
  through, byte for byte as before. The model template of `make:model` gained
  `fillable` and relationships (`buildModelSource()`), with its output unchanged.
- Round trip: emitted into a real application and read back by `plan:status`'s
  own readers, every planned property reads `match` except where no reader
  looks. `references.onDelete` is unread in every dialect. On MySQL, a `uuid`
  column (`varchar`) and `withTimezone` are unread. SQLite's moded
  `integer`/`text` columns (boolean, date, datetime, json, uuid), its sizeless
  `numeric`, `withTimezone` and a `unixepoch()` default are unread. MySQL's
  `now()` default is written `CURRENT_TIMESTAMP`, which the readers normalize,
  where drizzle's `defaultNow()` renders `(now())`, which they compare as text.
  A composite primary key is written as `primaryKey({ columns })`, and
  `plan/status.ts` reads a column as in the key when a readable composite key
  lists it (a table has one), so a pivot's key columns verify. No emitted table has been migrated against a database in these tests;
  they prove the readers and `tsc` accept the output.
- The project root only: an element carrying `module`, or a foreign key or
  relationship whose target carries one, is refused. An API-only application is
  refused, as derivation gives it no scaffold step. A draft is refused too, where
  `plan:next` accepts one: `plan:scaffold` writes code, and a draft is what
  nobody approved. `plan:next` tells a draft to approve first.
- The step must be the one `plan:next` marked, so what the command writes is
  that step's measured work and the next `plan:next` accepts the dirty tree as
  the marked step's own.
- Every refusal comes before the first write: the step kind, the mark, a module,
  a foreign key to a table not declared yet, a MySQL `unique` or index over a
  `text` or `json` column (drizzle-kit refuses it and MySQL rejects the key
  without a prefix length), a `default` of `null`, and any target that exists
  (the model file or class, the schema export, the table name in any root). A
  re-run of a scaffolded step is therefore refused on the targets it wrote, with
  the application unchanged; what is left for the step is `plan:verify`. It runs
  no codegen and no migration.
- It writes `db/schema.ts` first, since the model files import its exports. A
  write that fails after the first one names the files already on disk, since a
  re-run would refuse on them as if the step were done.
- A relationship left out of the model leaves it `drifted` in `plan:status`
  until the relationship is added; the report says so beside each one.
- Like `plan:verify`, it does not consult the freshness hold of §4: `plan:next`
  is what holds a step whose context went stale, and the command runs only on
  the step `plan:next` marked.
- `views` are no longer `scaffoldable` in the task derivation (D4), so a scaffold
  step's `generates` names no page.

A step whose remaining work exceeds a threshold (files touched, elements
covered) is split, pages by screen group first. The threshold starts at five
files and is tuned from the metrics in §7.

**Amended after re-review (2026-09-23), Part 3:** those metrics are not
recorded yet (a step record in `plan/state.ts` holds fingerprints, not the
files touched or lines changed). Part 3 records them, and the threshold stays
at five files until they exist (Open Question 3). They are recorded now (the
per-step work note under Phasing); the threshold waits for enough plans.

**Test skeletons are generated the same way.** Each acceptance behaviour
becomes one `TestApp` test whose title starts with its id
(`test('[AC-comments-3] a signed-in author can delete their own comment')`),
with the actor, the request and the `expect` assertions written out. A
generated test must fail before the implementation exists, must still call the
route its behaviour names (checked statically), and may not be edited once its
step is verified without turning `drifted`. These are tamper detection, not
proof: a test can satisfy all three and still assert nothing that matters.
What they rule out is the cheap failure, a test emptied or rewritten until it
passes, and the task-end reviewer (§7) reads the tests for the rest.

**Amended after re-review (2026-09-23), Part 3:** no skeleton emitter ships,
and the static "still calls its route" check is not implemented. Both are the
optional last item of Part 3; `packages/cli/src/test-requests.ts`, which reads
the requests a test file makes, is what the check would rest on.

For `alter` / `rename` / `drop` there is no scaffold. Those steps are agent
edits, and the narrow step width matters most there.

**Writes are single-threaded.** No parallel implementation in this RFC:
`db/schema.ts`, the route registrar and migration numbering are shared by
every slice, and separate worktrees only move the conflict to the merge.

### 6. Status is derived from the code

Two commands, because they need different things from the machine.

`guren plan:status <plan>` is observational. Like `check` and `doctor` it
imports the routes file and parses source; it boots nothing, runs nothing, and
needs no database. It computes one state per element, and the agent cannot set
any of them.

`guren plan:verify <plan> [--step <id>]` executes: the step's verify commands
(`typecheck`, `guren check`, codegen, `db:migrate`) and its tests. `gate`
already runs `bun test` from the CLI, so this is not new ground, but it has
requirements `status` does not. `TestApp` boots the application and
`db:migrate` opens the configured database, so `verify` runs against the
application's test database configuration, with a timeout per command, and
records what it ran against. Missing infrastructure (no database reachable,
no `bun`, drizzle-kit absent) is reported as `blocked`, never as a failed
implementation.

| State | Meaning | Set by |
|---|---|---|
| `planned` | not in the code | `status` |
| `present` | exists, and every planned property the scanners can read matches (for `drop`: is absent, in a file the scanner fully read) | `status` |
| `wired` | reachable from the application, below | `status` |
| `verified` | its step's verify commands and behaviours passed, at a fingerprint that still matches | `verify` |
| `drifted` | exists and a readable property differs, or a verified fingerprint no longer matches | `status` |
| `unjudged` | no static signal exists | `status` |
| `blocked` | cannot be judged or verified here; carries the reason | either |
| `waived` | a person accepted it incomplete, with a reason, in the decision log | `plan:waive` |

**What the scanners read today, and what they do not.** The comparison can only
be as fine as its reader:

| Planned property | Reader today | Gap |
|---|---|---|
| column type, `notNull`, primary key, single-column FK | `SchemaColumn` | |
| column default, unique, index, composite constraints | ~~none~~ runtime `getTableConfig()` (`schema-runtime.ts`), static reader as fallback | ~~Part 1 extends `schema-parser.ts`~~ a table read statically keeps its opaque markers, which stay unknown |
| options passed as an expression | `opaqueOptions` marks them not visible | stays unknown |
| relationship name, type, target; fillable | `model-parser.ts` | key configuration is not read |
| action exists on the controller | `classActionMembers` | what it validates and returns comes from the body scan, as a verdict and not a contract |
| route method, joined path, name, action | registered definitions (`loadRouteDefinitions()`) | |
| page `Props` | `describeInertiaPage()` returns the type as one line of text | Part 1 resolves it to keys through the codegen extraction it wraps |

**Amended in implementation:** the static reader cannot follow a spread column
set, a helper builder, the columns callback, `pgTableCreator` or an extra
config built elsewhere, and can only mark them not visible. So the comparison
imports `db/schema.ts` and asks the app's own drizzle copy, as
`loadRouteDefinitions()` executes the registrar and drizzle-kit reads a schema.
The trade-off is that importing runs the app's code: a schema that reads env,
opens a connection or throws is reported per file as unreadable at runtime and
its tables fall back to the static reading, each table naming its source.
`guren check`, the spec views and the scaffolders stay on the static reader,
which needs source positions and must not execute app code on an edit hook.

**Amended in implementation (`plan:status`):** the readers the comparison ended
up with, beyond the table above. A validator is found by its exported schema
symbol (`app/Http/Validators/**`), and its fields have no reader: reading them
would mean evaluating the schema. So have none: a resource's fields, a policy's
abilities, a foreign key's `onDelete`, a binding's lookup `key`, a page's form,
actions and states, and the target of a relationship written as a lazy
`import()` (the blog's own idiom; its name and type are read). An abstract
column type is compared through the drizzle builder, and a builder that may
carry the type under a `mode` option (`integer` for a SQLite boolean) is
unknown, never a match. What an action's body is scanned for (the page it
returns, the schema it validates with, the resource and ability it names)
yields `match` or `unknown`, and `differ` only where the body names a different
page or ability: a miss may be a helper's work. A planned `body` / `params` /
`query` validator is read off the `this.validateBody` / `validateQuery` /
`validateParams` call that takes it, the same reading the validator's own
`wired` evidence uses, and never off a mention: an action whose only planned
property is a validator its body merely names is not `wired`. It reads
`planned` for an `alter` and `present` for an `add`, since the validator is
then a `differ` (see *status rules after Part 2* below); an earlier reading
made it `unjudged`.
Prose (`purpose`, `rules`, a description) is not
a planned property and is not counted as one. Flows, tasks, behaviours and
questions are not judged; a `command` ~~and a `mail` / `notification` class are
`unjudged`, since nothing reads whether one was run or discovers the other~~ is
`unjudged`, since nothing reads whether one was run (a mail and a notification
class are read since, see *policy abilities and side-effect uses* below).

A property with no reader is **unknown**. Unknown never counts towards
`present`, never satisfies a `drop`, and is listed on the page as "planned,
not checkable". An element whose every planned property is unknown is
`unjudged`. This is the rule that keeps a missing reader from reading as a
green one.

**`wired` means mounted by the application, not visible to the CLI.** Route
definitions are obtained by executing the registrar, so a computed path
resolves and is judged like any other. What that load overstates is reach:
module discovery is a directory scan, and a module never passed to
`createApp()` shows up in the graph without serving a request.
`routes-check.ts` judges wiring per routes *file*, not per route. So `wired`
for a route requires both: its definition's provenance (`moduleProvenance`, or
the entry registrar) and evidence that the owning module or registrar is one
the application registers. A page is `wired` when an action returns it; a
validator when a route contract or an action body references it. Where that
evidence cannot be read, the state is `present` with a note, never `wired`.

**Amended in implementation (`plan:status`):** the evidence is the application
entry's own `createApp({ routes, modules })`. A route the entry registrar
declared is `wired` when `routes` is an import of the routes file the CLI
loaded *and* of the export the loader picks from it; a module's route when
`modules` lists an import of `modules/<name>`. Options that are not a literal,
a spread, or an element this cannot trace to a file leave the route `present`
with the reason. An action is `wired` when such a route dispatches to it, and a
page when such an action returns it. A model, a column, a controller, a
resource~~, a policy and a side effect~~ and a policy have no mount point a static reader can
name: they complete at `present`, and the Completion table below reads
"`wired` where the kind has one".

For a validator the evidence has to be a *use*, not a mention. A symbol can be
named by an import whose call was deleted, in a type position, in an object
nobody passes, in a function nobody calls or in a branch nothing reaches, and
none of those wires anything; a bare mention therefore leaves the element
`present` and only supplies the note. "An action body references it" is read as
`this.validateBody` / `validateQuery` / `validateParams` (and their `Safe`
variants) taking it, in an action a mounted route dispatches to. "A route
contract references it" is read off the *registered* definitions rather than
the source: the registrar ran, so a schema reached `schemas.body` through a
call the application made, and matching it against the validator file's
exported schema by object identity names the symbol without asking which source
shapes register a route. The route's own mount then decides, so a module's
contract is evidence exactly when that module is mounted. What this reading
costs is a contract whose schema is not the exported symbol itself — an inline
`z.object({…})`, a `Schema.extend(…)` — and a validator file that will not
import; both leave the element `present` with the reason, which is the side to
be wrong on. The files are imported only when a registered route carries a
contract at all, and a file that throws makes its own symbols unmatchable, not
the validator section unreadable.

**Amended in implementation (route shadowing).** A mounted route is not yet a
reachable one. Hono hands a request to the first registered route that matches
it, so a planned `GET /comments/new` registered after `GET /comments/:id` is
mounted and receives nothing. The route's `wired` therefore also asks the
*registered* definitions, in `mountRoutes()`'s order (the entry registrar's
routes, then each module's), whether an earlier route with the same method, or
`ALL`, answers every request its path matches. The comparison is the path
matcher the test-coverage scan uses (`routePathCovers()` beside
`routePathMatches()` in `test-requests.ts`, checked against hono). A shadowed
route stays `present`, and so does an action or a validator only it reaches,
with a note naming the earlier route and the registrar that declared it; a
definition carries no line, so the site is the routes file or the module. Three
cases stay `present` because the order or the comparison is not known, and are
never passed: a path with a constraint or a `*` the matcher cannot compare, two
modules' routes (the CLI loads modules in directory order, the application in
`createApp({ modules })` order), and a module's route while another module's
routes did not load. A route a provider registers is not in the definitions and
is not compared. Hono answers every `HEAD` request with the `GET` route before
routing, so a `HEAD` route is never reached whatever the order; a plan cannot
declare one, and this is not modelled.

**Amended in implementation (`plan:status`):** an element's optional `module`
is compared, in both directions. Every discovered model, controller, action,
validator, resource, policy and side-effect class is tagged with the app root
its file sits in, and satisfies a plan element only when the two agree — so a
root `app/Models/Invoice.ts` does not satisfy a model planned for
`modules/billing`, and a class only a module declares does not satisfy one
planned for the project root. A model's table is resolved within that same
root, which is what scopes its columns. Where nothing reports the root the
element is `blocked`, never matched on the name. Pages are the exception and
need no tag: a module's pages are not colocated, they live in the project's
own `resources/js/pages` namespaced by the module, so a discovered page is
positively the project's. A view naming a module whose prefix its page id does
not carry is `blocked`.

Two readings the table left open. An `alter` whose every *readable* planned
property differs is `planned`, not `drifted`: nothing of the change is in the
code yet, which is what `planned` means, and `drifted` is kept for a change
that is partly there. An `existing` element that is missing is `planned` with a
note, and the report lists it apart from the elements the plan changes.

**Acceptance behaviours** have a status of their own, set by `verify` from
`bun test --reporter=junit`: `pending` (no test carries the id), `failing`,
`passing`. The aggregation is fixed:

- a test case belongs to a behaviour when its full title, `describe` names
  included, contains `[<id>]`; several cases may share one id (`test.each`),
  and all of them must pass;
- a skipped or todo case counts as failing; zero executed cases is `pending`;
- the same id in two test files, or an id no behaviour declares, is an error;
- no junit file, or one that does not parse, is `blocked`.

**Amended in implementation:** what Bun's reporter writes settled four points
the list left open (`packages/cli/src/plan/acceptance-status.ts`).

- ~~zero executed cases is `pending`~~ `pending` is "no case carries the id". A
  behaviour whose only case is skipped or todo is `failing`, by the rule before
  it. "Executed" cannot be read from `time`: Bun writes `time="0"` for a fast
  passing case. It is the absence of `<skipped>`, which Bun also writes for a
  case a `-t` filter left out, so `plan:verify` selects by file and never by
  `-t`.
- The full title is the chain of nested `<testsuite>` names, one per `describe`,
  under the suite Bun writes per test file. `classname` is not read: Bun writes
  it innermost first, with a separator escaped twice. "Two test files" compares
  the `file` attribute of the cases as written, relative to where `bun test`
  ran. A case naming two declared ids counts for both.
- An undeclared id is a bracketed token in the plan's id grammar that starts
  with `AC-`. Without the prefix, `[GET]` in any unrelated title would be an
  error. A plan whose ids drop the prefix loses the typo report and nothing
  else: the mistyped behaviour stays `pending`.
- Two failures never reach the report. A test file that throws while loading is
  absent from it, and a test behind a throwing `beforeAll` is replaced by one
  failed `(unnamed)` case. Their behaviours read `pending`, and the failure
  shows only in the exit code of `bun test`, which `plan:verify` has to judge
  beside the report.

A report carrying an error verifies nothing, and its type says so: verdicts
exist only on a report with no error, and one with errors hands over what was
seen under another name, for display. An undeclared id is reported once per id
and file. The reader is strict about structure and refuses a DOCTYPE, an unknown
entity, an element outside the junit vocabulary, a report over 32 × 2²⁰
characters, an attribute over 2²⁰ characters and 64 levels of nesting, each as
`blocked` with the reason. The caps count UTF-16 units, which is what the text
handed over measures in, and never bytes. It is looser than XML 1.0 in one
place and stricter in another. Bun writes a control character in a title both
raw and as `&#1;`, and both pass. A numeric reference padded past the span of
`&#x10FFFF;` is refused however legal it is, so a zero-padded `&#x0010FFFF;`
reads as blocked rather than as the character it names.

An element is `verified` when its step's verify commands pass *and* every
behaviour naming it is `passing`; the page shows the behaviours under the
element they cover.

`unjudged` is the honest case: a change to the business rules of an existing
action alters no shape. Such an element goes from `planned` to `verified` on
its acceptance behaviours alone, which is why §2 refuses an action `alter`
that has none. What stays `unjudged` after that is what `TestApp` cannot
reach: client-side state, conditional rendering inside a page. `assertInertia`
sees the props a page was given and nothing past them, and this RFC does not
extend to browser tests.

**Completion**, per kind of element, since "at least `wired`" has no meaning
for some of them:

| Element | Complete when |
|---|---|
| `add` / `alter` / `rename` with a static signal | `wired`, then `verified` |
| `drop` | `present` (absent), then `verified`; there is nothing to wire |
| `unjudged` | `verified` on its behaviours alone |
| `existing` | never part of completion |
| any | `waived` |

A step is complete when every element it covers is. A task is complete when
its steps are. `blocked` completes nothing and is reported as such: it is an
environment problem to fix, not a state to wait out. Existing tests may be
edited only where the plan lists them under Impact.

**Verification fingerprints.** A `verified` result is recorded with the hash
of the files that hold the step's elements and its test files, plus the
identity of the environment it ran in. "At the current tree" would expire
every earlier slice on the next commit; a fingerprint expires a step only
when something it covers changes, and that is `drifted`.

**Amended in implementation (`plan:verify`):** what the command settled where the
text above left room (`packages/cli/src/plan/verify.ts`, `state.ts`).

- Every step's verify list opens with `codegen` (the §5 table is amended to
  say so): `typecheck`, `guren check` and the tests read `.guren/*.gen.ts`,
  which a fresh clone lacks, and a step verified on its own must not fail for
  the environment's sake. Each command then runs once per invocation across the
  steps, and nothing is judged before the generated files exist: the status
  the steps are judged against is read after the first `codegen`, and nothing
  imports the application before it, since Bun keeps a failed import of a
  generated file for the whole process. Once `codegen` has not passed the rest
  of the list is not run, since its findings would blame the code for the
  generated files it lacks; the status is still judged, and the report says
  it was judged without them. A failed command names
  the step `failed` whatever else was `blocked`, since there is then something
  of the implementation's to fix.
- A whole-plan run (no `--step`) leaves alone a step whose record is `verified`
  against this plan digest and whose fingerprint still matches, and reports it
  as skipped. That is what lets the `tests` step stand in the checkout that ran
  it: it must see the tests fail before the implementation exists, and cannot
  pass again once the `http` step has made them pass. A verified record
  fingerprints nothing only when the step had nothing file-shaped to watch
  (`scaffold`, a `drop`, an element no reader finds a file for), so it stands
  on the plan digest alone, or a step that could never stand would keep the
  loop of §7 from ending; a `drop` is lifted on that record, an element with no
  reader never is, and `plan:next` names such steps when it reports the plan
  done. The record is git-ignored, so a fresh checkout has nothing to keep and
  its whole-plan `--ci` reports the `tests` step `failed`; whole-plan `--ci` is
  the incremental loop's (§7), not a fresh checkout's.
- A step is `verified` when every command passed *and* every element it owns is
  at the state its kind completes at (`wired` where it has a mount point,
  `present` otherwise and for every `drop`, or `unjudged`); the behaviours are
  the step's, since the derivation puts them on the step that must see them
  pass, so an element is not lifted while a behaviour of its step fails whether
  or not it names the element. Commands passing over an element still `planned`,
  or one the status never judged, is `incomplete`, a fourth outcome beside
  `verified`, `failed` and `blocked`, listing the elements.
- `blocked` covers a script `package.json` lacks (`typecheck`, `db:migrate`;
  `codegen` falls back to the CLI), a tool the shell cannot find (exit 127 or
  `command not found`, for any script), a command past the per-command timeout
  (`--timeout`, default 600 s), a check that threw, a test run that wrote no
  report, and a migration whose output carries one of a short list of database
  signatures (`ECONNREFUSED`, `password authentication failed`,
  `SQLITE_CANTOPEN`, a missing `drizzle-kit`). The list is literal on purpose: a
  broader one would turn failed migrations into environment problems. A
  `db:migrate` that no migration backs is `failed`, amended below under *a data
  step's migration*.
- Tests run as `bun test <files>` on the files whose source carries a step's
  acceptance ids as literal bracketed tokens; a step whose ids no file carries
  fails its tests command with the ids named, as does one whose test files
  cannot be listed. `tests` passes when every behaviour is `passing` *and* the
  run exited 0, since a file that fails to load shows only in the exit code;
  `tests:fail` when every behaviour has a case and each case failed, a skipped
  case not being a run. An id the plan does not declare fails the command rather
  than blocking it, and its behaviours are recorded `pending`: a report the
  reader refused verifies nothing. One `bun test` runs per file set and per
  invocation, and `tests` and `tests:fail` judge the same run.
- The fingerprint is the SHA-256 of every file the status readers found the
  step's elements in (a model's file, the controller's for an action, the
  schema file for a column, the entry routes file and every file under the
  project's `routes/` for an entry route and every routes file of the
  application for a module's (nothing says which file declared it, and the
  entry's and another module's routes may shadow it), the page component, a
  validator's file), plus, for an element with a mount point, the files its
  `wired` rests on: the entry `createApp()` is read from and a module's
  descriptor, the routes dispatching to an action, the actions returning a page
  or validating with a validator, and those actions' routes, the routes whose
  contract holds a validator, and the files using a side effect. An element no
  reader found a file of stays unfingerprinted whatever wires it. The
  fingerprint also holds the selected test files and the environment
  (`runtime`, `platform`, `arch`, `hostname`). A file that cannot be read at verify time is
  recorded as `null`, which never matches. The environment is recorded and
  shown, and not compared: a machine is not a reason to call an element drifted.
- The state file is `.guren/plans/<slug>.state.json` under the application
  root, `<slug>` the plan file's name without `.plan.json` / `.json` (the
  directory's name for a `plan.json`, the §9 layout), with one
  record per step id and a `.gitignore` written beside it. A record names the
  digest of the plan it ran against, the hash for a plan with a baseline and the
  same computation over a draft; `plan:status` lifts an element only from a
  record of the plan it is reading, and reports the steps of another plan or
  revision as stale. Two plan files of one slug share a state file and a step
  namespace, the later run overwriting the earlier. A state file that will not
  read is reported and lifts nothing, and the next write replaces it whole;
  writes take no lock.
- `plan:status` lays the records over its result: an element of a verified
  step is `verified` while every fingerprinted file hashes the same, `drifted`
  once one does not or cannot be read, or once the element sits in a file that
  run did not fingerprint, naming the files. An element that exists in files
  none of which the record covers is not lifted, with a note: a verification
  nothing could expire is not one. A `drop` has no file to cover and is lifted
  on the step alone, since the readers re-read its absence on every status. An
  `unjudged` element with no file of its own is verified on its step's
  behaviours, whose test files the record covers, so it is lifted only from a
  step that has behaviours; a `commands` step has none, and its elements stay
  `unjudged` with a note. A skipped step is not a promise that its elements
  lifted: the skip is decided on the record's files before the status exists,
  and an element that has since moved into a file the record does not cover
  reads `drifted` beneath it. An element the code has since lost keeps what
  the readers say, with a note. For that the status report carries each
  element's `files` and `completesAt`, and its summary counts all eight states.
- Of the per-step metrics of §7, the state carries `durationMs` per command
  and per step, the `Stop` hook's continuations, and files touched and lines
  changed (the per-step work note under Phasing); `total_cost_usd` is not
  recorded yet. `--ci` exits 1 when a step
  the run covered did not verify.
- The `.gitignore` written beside the state ignores itself as well, so a
  verify leaves the working tree as clean as it found it, which `plan:next`
  relies on.

**Amended in implementation (status rules after Part 2).** What the Part 2
measurements below asked of `plan/status.ts` and `plan/verification.ts`, and how
each rule was read.

- "An element whose every planned property is unknown is `unjudged`" now holds
  for every change kind, on two conditions outside `alter`: the element declared
  at least one planned property, and its kind has no mount point. So an `add`
  resource with fields, a policy with abilities, a model whose one read property
  (its table) could not be read, and a column whose every property is hidden are
  `unjudged`. An element that plans no property (a controller, a job, event or
  listener, a resource with no fields) completes on existence as before. One
  with a mount point (a validator, an action, a route, a page) completes on it,
  since a mount is a reading of the element itself; that is why a validator
  whose fields have no reader still reads `wired`. `alter` keeps its stricter
  rule, `unjudged` with no readable property whatever it mounts, since its
  target existed before the plan.
- A planned `params`, `query` or `body` validator is `match` when the action
  body validates with it, or when a route dispatching to the action holds it as
  a contract schema (object identity against the registered definitions, as for
  the validator's own `wired`). Neither reading records which segment the
  schema sits in, so a `query` contract or a `validateQuery` call satisfies a
  planned `body` validator. It is `differ` when the body was read and does
  neither, and `unknown` only when no body was read. That `differ` does not
  drift the action: it holds it at `present` with a note (`Not wired: ...`),
  and another differing property is what makes it `drifted`. An `alter` whose
  readable properties all differ stays `planned`. A validate call is read as
  written, so `this.validateBody(schemas.comment)` names `schemas.comment`,
  which is not an export; the note says so and asks for the schema by name or
  in the route contract. A chained or built schema reads the same way:
  `this.validateBody(PostSchema.partial())` names `PostSchema.partial` and
  `this.validateBody(z.object(...))` names `z.object`, so both are a
  `differ`. A helper that validates on the action's behalf also
  reads as a `differ`, which holds the action back rather than passing it.
- An element none of whose planned properties matched rests on existence, a
  mount or its behaviours alone, whatever its state. `plan:status` lifts such an
  element to `verified` only while a verified behaviour reaches it. A `drop` is
  the exception, since its absence is re-read on every status. Reach follows
  the plan's references (`listPlanReferences()`) from a behaviour, through a
  total table of which reference fields carry it: a behaviour's route and
  expected page, a route's action and bound models, an action's validators,
  policy and response page or resource, a page's prop resources, and the model
  of a reached resource or policy; an action reached also reaches its
  controller. A page's form validator, form target and action routes do not
  carry it, since a request to a route shows nothing of the page that links to
  it. Nothing in a plan links a behaviour to a job, event, listener, mail or
  notification (a side effect's `trigger` is prose). The behaviours that count
  are those of every step in the plan that carries acceptance ids and whose
  record stands (`recordStands()`: verified against this plan digest, its
  fingerprint unchanged), since one task's behaviour may render a page or return
  a resource another task placed; the same predicate lets the earlier parts of
  a split `http` step lift what the last part's behaviours reach. The `tests`
  step never counts: it verifies by seeing the behaviours fail.
- `recordStillHolds()` and the step outcome `plan:verify` records are
  unchanged. A step whose commands and behaviours passed stays `verified` and
  its record stands for `plan:next` and the `Stop` hook, because an element no
  behaviour reaches is a gap in the plan that no implementation closes. Such an
  element carries a note ending in "add a behaviour that reaches it, or waive
  it", or, where no behaviour could reach it (`behaviourCanReach()`: a column,
  a command, a side effect), in "no behaviour can reach it, so waive it", and
  in only "waive it" where `plan:verify` cannot fingerprint the element, since
  a behaviour added then would leave it held as unfingerprinted. Where
  the plan has a step whose behaviours reach it but no run of that step stands,
  the note names the step and ends in "run plan:verify on that step, or waive
  it" ("on one of those steps" when several reach it; only "waive it" when
  `plan:verify` cannot fingerprint the element). An
  element lifted to `verified`, `drifted` or `waived` keeps no `reason`, which
  says why the readers could not complete it and is answered there. The overlay records why it did not lift an element (`hold`: below its
  completion state, nothing fingerprinted, a file changed since, or no
  behaviour reaches it), and `plan:close` prints each element it refuses with
  what holds it, suggesting `plan:verify` only where a run can lift it.
  `plan:next`, once every step is verified, lists the elements `plan:close`
  would still refuse, so an agent does not stop on a plan that cannot close.
- What this costs a plan. A plan whose side effects or commands the behaviours
  cannot reach, or with any other element that plans no property and no
  behaviour reaches (a controller of an action nothing requests, a resource
  nothing returns or renders), closes only by a waiver or a behaviour that
  reaches it. On the comments fixture, judged against scratch applications with
  every step recorded as verified, the finished implementation lifts 13 of its
  15 elements. `resource.comment` has unread fields and no behaviour returns it.
  `view.posts.show` changes only `form`, `actions` and `states`, and its form
  targets a route, which does not carry reach. Both need a waiver, or a
  behaviour with `expect.inertia` on the route that shows the post.
- Cause 1, an `alter` completing on a property that already held, is settled
  by the readings recorded at approval (the next amendment).

**Amended in implementation (an `alter` against its readings at approval).**
An `alter`'s target existed before the plan, so a planned property that already
matched when the plan was approved says nothing about the change. What shipped
(`judgePlan()` and `readAlterProperties()` in `plan/status.ts`, the readings in
`plan/approvals.ts`, `plan-approve.ts`):

- `plan:approve` reads the application with `detail` when the plan has an
  `alter`, and records one reading per planned property of each `alter` it
  could compare: element id, the element's name in code, property, planned
  value and verdict. An element it could not compare (not found, blocked, no
  reader) records nothing, and neither does a state loaded without `detail`,
  whose every property would read a blind `unknown`.
- A match counts towards an `alter`'s completion only against a reading that
  was `differ` or `unknown`. A match that already held, or has no reading,
  reads `unknown` with the reason, so an `alter` whose readable properties all
  held is `unjudged`, and a page `alter` that restates a declared prop beside a
  new one is `planned` rather than `drifted` before its work. A property that
  held and differs now stays a `differ`. The rule is applied inside
  `judgePlan()`, which takes the readings as an argument, so `plan:status`,
  `plan:verify`, the `Stop` hook, `plan:next`, `plan:close` and
  `guren check --plan` count the same ones. An `unjudged` `alter` is lifted to
  `verified` only while a verified behaviour reaches it, by the reach rule
  above; the readings need no change to that overlay, since a set-aside match
  is not a `match` there either. `plan:render` never judges status.
- The readings live on the approval entry beside the plan, outside the hash,
  and never in `baseline`. A reading taken late can only miss a change and
  never credit one: a property that already matched is never counted, and one
  that did not has moved since it was read. So a re-approval may record the
  readings an approval lacks, where a baseline, never restamped, could not.
  Inside the baseline, every plan approved before this change, and every
  revision that adds an `alter` or changes a planned value, could close its
  `alter`s only by a waiver.
- Each approval carries the readings for its own hash: every reading the file
  already holds under the same baseline, earliest first (keyed on element, name
  in code, property and planned value), then one taken now for each key they
  lack. A revision approved after its work therefore keeps the reading from
  before the work, and a section that cannot be read at re-approval loses
  none. Readings under
  another baseline are another plan's start and are never carried: a restamp
  after the baseline was removed, or an unrelated plan sharing the file.
- Approving a hash already approved writes nothing unless the entry lacks a
  reading of a current `alter` property; then it adds those, and replaces none.
  That helps only before the work: a planned property that still differs and
  has no reading gets a note naming `plan:approve`. A match with no reading
  does not, since a reading taken then records it as one that already held;
  the `unjudged` reason sends it to a behaviour that reaches it, or to a
  waiver where no behaviour can (`behaviourCanReach()`). A draft has no
  approval, so its `alter`s count no match; its verification records start
  over at approval anyway.
- A model's relationship is read as two properties, its type and its target,
  under those keys whether it is declared or not, so the reading taken before
  the work is the one the match after it is set against. An approval taken
  before this recorded one combined property for a relationship not yet
  declared, which the two keys do not match: the note names `plan:approve` while the relationship is still
  missing, and once it is written the `alter` needs a behaviour or a waiver.
- A reading is as protected as the approval that carries it: whoever can edit
  one can forge the other, and both are committed and reviewed. An older CLI
  that rewrites the approvals file drops the field, which fails closed.
- Limits: an `unknown` reading that turns into a match counts, as the rule
  says, even when only the reader changed (a schema the runtime reader could
  not import at approval and can now). A later approval does not replace it
  with what it reads then: an `unknown` also precedes real work (an action
  that returned JSON before it rendered the planned page), and a re-approval
  in the middle of that work would stop crediting it.
- The warning the producer row of Part 2 asks for came later: `plan:approve`
  approves and warns when an `alter` has a readable reading and every one is a
  `match` (`heldAlters` in its report). It is not a §2 check. A §2 check reads
  the application as it is now, and a re-approval after the work reads a built
  property as a `match` too, so `heldAlters()` in `plan/approvals.ts` judges
  the approval entry's readings for the properties the `alter` reads now, or
  all of its recorded ones where it cannot be read or is not found. An
  `unknown` is not held, and the warning names it as what can still show the
  change. An `alter` with no readable reading gets none: its readings cannot
  tell a property no reader sees from one a failed import hid, and a model or
  controller whose change lies in its columns or actions plans no property of
  its own. `plan:render` reads no approval, and `plan:status` reports the
  element `unjudged` with the same remedy.

**Amended in implementation (drift re-verification, and a data step's
migration).** Two defects the loop hit once a plan had more than one task.

- A later step that legitimately writes into a file an earlier step's element
  sits in (a route beside it in `routes/web.ts`, a table in `db/schema.ts`, a
  second action in its controller) expires the earlier record, and that is the
  correct reading: the edit may have broken the earlier step. What was wrong is
  what followed. `plan:next` returned the earlier step as work to implement,
  and nothing re-ran its verification. A record now drifts
  (`recordDrift()`) when it was verified against this plan digest, every
  waiver it rested on still holds, and only fingerprinted files changed.
  `plan:verify --step <id>` runs the step, and once it verifies, re-checks in
  the same invocation every earlier step in task order whose record drifted,
  recording each as its commands now say: `verified` again, or `failed` with
  what broke. The report lists them as `reverified`. The step runs first
  because commands are shared across one run's steps: re-checked beside a
  step that failed `codegen`, `typecheck`, `check` or the migration check, an
  earlier step would inherit that failure. So a step that does not verify
  leaves the drifted records as they are, and the report lists them as
  `recheckPending`; so does a re-check that comes out `blocked`, which is the
  environment's and never replaces a drifted record. The re-checks also stop at
  the first that runs commands and does not verify, leaving the rest pending,
  since two drifted steps share commands as well; a static re-check (below)
  runs nothing, so its failure does not stop the rest. A whole-plan run keeps
  the same order: the steps that did not drift run first, and the drifted ones
  are re-checked only once all of those verified. A drifted `--step` target is
  its own re-check: its failure is recorded like any step's, and only a
  `blocked` result or a failed static re-check (below) leaves its record
  drifted.
- A drifted `tests:fail` step is re-checked without a run
  (`PlanVerifier.recheckTests()`), wherever `plan:verify` meets it (a
  whole-plan run, `--step` on it, or as an earlier step): `tests:fail` cannot
  pass once the implementation exists, and its red run was observed when it
  verified. It stays `verified` while one test file still carries each of its
  behaviours' ids as a bracketed token, which a comment carries as well as a
  test title (a gap the run itself would catch). One carried by no file or by
  several is reported, and the record is left drifted rather than replaced: a
  recorded failure would send the next run to `tests:fail`, which cannot pass
  then. `plan:next` and the `Stop` hook reach it through `plan:verify --step`,
  so all four agree.
- The `Stop` hook verifies the marked step through the same run, so a drifted
  earlier step is re-checked on every stop that verifies the marked step (one
  whose record still stands returns before any run), without a continuation of
  its own:
  the give-up rules still judge the marked step's record alone. A verified
  step whose changes broke an earlier one lets the stop through, naming the
  earlier step, which `plan:next` returns next; so does one whose run could
  not re-check an earlier step, naming it and why, or left one for the next
  run behind a re-check that did not verify.
- `recordStillHolds()` stays the one rule for a step being done. `plan:next`
  still runs nothing: a drifted step it returns carries the changed files as
  `drifted`, and the text says to re-check it with `plan:verify --step` rather
  than re-implement it.
- Per-element fingerprints were tried first and dropped. Every review of the
  static span reader found another shape (a router mutator, a base-class
  override, a registrar called by name) through which an edit outside the span
  changes the element's behaviour, so a span could only ever fail open.
- A data step's `db:migrate` passed on a schema no migration covered, since
  the migration then has nothing to apply. Before the script runs, the command
  asks the application's own drizzle-kit, resolved through `node_modules` from
  the application root and never through `bun x`, for
  `generate --config <config> --explain --output json`, a dry run that writes
  no migration and opens no database (it may create an empty migrations
  folder). `no_changes` goes on to the script. Statements (`ok`) or a rename it
  cannot decide without a hint (`missing_hints`) fail the command, naming what
  is uncovered, since a migration is the fix. No drizzle config, no
  drizzle-kit, a timeout, an `error` status or output it cannot read block it
  with the reason. The dry run compares the whole schema with the migrations
  folder, so a change outside the plan's tables fails the step too:
  `db:migrate` would not apply it either.

**Amended in implementation (validator and resource field readers).** The
`plan:status` amendment above left a validator's and a resource's fields with no
reader, and Part 2 measured both at 100% `unknown`. What shipped
(`plan/field-readers.ts`, judged by `plan/field-status.ts`):

- A validator's fields are read off the exported schema object. The object
  comes from the import the contract-identity match makes, which now runs for
  every validator file rather than only when a registered route carries a
  contract. Every caller that loads the detail therefore imports the
  validators: `plan:status`, `plan:verify`, `plan:next`, `plan:close`,
  `guren check --plan` and the `Stop` hook. A static reading of
  `z.object({...})` was the first design and was dropped: the blog's own
  `PostPayloadSchema` is `z.object(baseFields)` over helper calls, which a
  static reader can only call opaque.
- A planned validator's fields are the keys a client sends. Each yields
  `field <name>`, `field <name> type`, `field <name> required` and one
  `field <name> rule <text>` per rule; each resource field yields
  `field <name>` and `field <name> type`. A key the object does not declare is
  a `differ` and its other properties are `unknown`; an object that accepts
  undeclared keys (`z.looseObject()`, `.catchall()`) makes it `unknown`. An
  export that reaches no object (`z.lazy()`, a plain object, a zod v3 schema)
  or a file that would not import leaves every property `unknown` with the
  reason.
- Every verdict beyond a key's existence rests on an allowlist, and fails
  closed. An entry must mean the same on every zod the apps admit (`^4`, from
  4.0), since the reader runs against the app's own copy. A field's type,
  `required` and rules are read only when every node from the export to the
  field is on it: the export is the object itself, unrefined; the field is
  `.optional()`, `.nullable()`, `.nullish()`, `.default()`, `.prefault()` or
  `.required()`'s `nonoptional` over a leaf (`string`, `number`, `boolean`,
  `bigint`, `date`, `enum`, `z.coerce.*`) or over a pipe of two plain leaves
  (`.pipe(z.email())`, and `z.stringbool()` from zod 4.1); and every check on
  the leaf is a length, bound, integer, multiple or string format, with an
  `overwrite` only ahead of them. Any other node on the path (a transform, a
  preprocess, a refinement or `superRefine()` on any node, `.catch()`,
  `z.lazy()`, `z.custom()`, a union, an intersection, an array, a pipe or
  transform around the object, a zod/mini schema, which carries no `_def`, a
  node this reader does not know) leaves the field's type, `required` and rules
  `unknown`, with a reason naming the node. Patching the shapes one review at a
  time did not converge: four rounds each found another wrapper that made a
  correct field read `differ`.
- Within the allowlist, three entries are read only in part. A pipe's last stage
  validates the final value, so its type is read (`z.stringbool()` matches a
  planned `boolean` from zod 4.1, and is opaque on 4.0), but a step may run
  between the stages (a codec's decode), so its `required` and rules are
  `unknown`. `nonoptional` over a `.default()` or `.prefault()` accepts a
  missing key before zod 4.4 and rejects it from 4.4, so its `required` is
  `unknown`; so is a `z.coerce.string()`, `boolean()`, `number()` or `date()`,
  which accepts `null` (the string and boolean ones also accepted a missing key
  before zod 4.4). And an `.overwrite()` that is not zod's own `.trim()`,
  `.toLowerCase()`, `.toUpperCase()` or `.normalize()` may rewrite a value past
  its bounds, so its rules are `unknown`.
- On a field read in full, a planned `type` is the validated value, compared
  with the walker's output side, so `z.coerce.number().int()` matches `integer`.
  It is a `differ` only across JSON families; a format the planned type needs
  and the schema does not declare (`uuid`, `date`) and a number for a planned
  `integer` are `unknown`. A `Date` matches a planned `datetime` and is
  `unknown` against anything else, since the walker renders it as a string.
  `required` means a client must send a non-null value: the outermost of
  `optional`, `default`, `prefault` and `nonoptional` decides whether a key may
  be omitted, and a `nullable` anywhere lets it be sent as `null`. Rules are
  prose, and only `min`, `max`, `email`, `url` and `uuid` are compared, on the
  validated value in the planned type's unit: a bound equal to the planned one
  is a `match`, a tighter one a `differ` (it rejects a value the plan accepts),
  and a looser or absent one `unknown`, since a format or pattern may tighten
  it. That settles the `max(500)` against a planned `max(2000)` near-miss of
  cause 3.
- A resource's payload is `guren codegen`'s own reading, the definitions
  `data.gen.ts` is emitted from (`readResourceDefinitions()`), with the
  `extends` clause the copied body drops now kept beside it. A payload codegen
  references rather than copies, or one whose heritage is anything but a single
  `Record<string, ...>`, leaves an absent field `unknown`; an index signature,
  like that heritage, names no member. A type is compared as a set of union
  members with `undefined` set aside, string literals under one quoting. It is a
  `differ` only when every member on both sides is a keyword or a literal, and
  a literal only against a keyword it is not an instance of (`'draft'` against
  `number`, never against `string`); an alias or an object type is `unknown`
  unless it reads the same. A payload member typed `string | null` against a
  planned `string` is a deliberate `differ`: a resource has no `required`, so
  its type is the whole contract the frontend reads, nullability included,
  where a validator states nullability through `required`.
- What this changes downstream. A validator or resource with a matching type,
  `required` or rule is no longer an element "none of whose planned properties
  matched", so the verification overlay lifts it without a behaviour reaching
  it. A match on a key's existence alone (`field <name>`) is marked as such and
  does not count: a validator the reader could only read keys of still needs a
  behaviour that reaches it. A differing
  field makes the element `drifted`, which `plan:verify` reports as
  `incomplete`; unlike an action's validator, it is not held at `present`. An
  `alter` whose readable properties all differ reads `planned` instead, since
  nothing of the change is in the code yet. An
  `add` resource with fields is no longer `unjudged` once its payload is read.
  Readings recorded at approval are keyed on the property name, so an `alter`
  approved before this change has no reading of the new properties: a
  re-approval before the work records them, as for any approval that predates
  a reader, and a match with no reading from before the work does not count.
- Measured on `examples/blog` (9 validators, 1 resource) and `examples/api` (8
  validators, 2 resources) against hand-written plans that state the code as it
  is (`packages/cli/tests/fixtures/plan/fields/{blog,api}.plan.json`, run with
  `bun packages/cli/src/bin.ts plan:status <plan> --json` from the example's
  directory): before, all 20 elements carried one `unknown` `fields` property
  each; after, the 209 per-field properties read 160 `match`, 49 `unknown`, 0
  `differ`. Most of the unknowns are the blog's: its register, reset and profile
  schemas refine or transform the object, so only their keys' existence is read,
  its `email` fields pipe into `z.email()`, and the `remember` and `body` fields
  are unions behind a transform. The api's are the free-form `positive` (3), an
  array, and a `z.coerce.number()` id. On `examples/api` the command writes its
  JSON and does not exit; it does the same on the tree before these readers, so
  something the application's routes load keeps the process alive, and finding
  it is left to a follow-up.
**Amended in implementation (policy abilities and side-effect uses).** Two
kinds that were judged on existence alone now have a reader
(`plan/policy-abilities.ts`, `plan/side-effect-uses.ts`, both run under
`detail` from `plan/app-detail.ts`).

- A planned ability is a property, `ability <name>`: `match` when the policy
  declares a member of that name, `differ` when it does not. Members are read
  the way `Router` dispatch reads a controller's (`classActionMembers()`: a
  method or an arrow-function field, static members excluded), or off the keys
  of a `definePolicy({ … })` object. A name the class may hold unread is
  `unknown`, never a `differ`: a field whose value is not a function literal
  (`delete = ownerOnly`), a computed member name, a spread in the definition, or
  a base class other than `Policy` from `@guren/core` / `@guren/server`. A getter
  is read the same way. The class `definePolicy()` returns declares only the
  seven standard abilities and drops every other key of the definition, so a
  planned ability outside those seven is a `differ` there whatever the object
  holds. A file that declares no class of the planned name leaves every ability
  `unknown`, so the policy stays `unjudged` as before. The ability's `rule` is
  prose and is never compared; it is listed as `ability <name> rule`,
  `unknown`, so the page shows under "planned, not checkable" that nothing read
  what the ability decides. It cannot move the state while the ability names
  are readable.
- An ability's `match` is a match on existence, marked as the field readers
  mark a key's (`existence`), and so does not count towards lifting the policy
  without a behaviour: `make:policy` writes the five standard names into every
  policy, so a name says nothing of the rule the plan asked for. The policy is
  lifted to `verified` only while a verified behaviour reaches it (through an
  action's `policy`), exactly as when its abilities had no reader. Both kinds
  of existence match go through one predicate, `restsOnReach()` in
  `verification.ts`, which the overlay and `plan:close`'s remedies both ask.
- A side effect is `wired` when the application's source uses the class, and
  this is a mount rather than a property. A use is a call of the framework's
  own API with the class as its subject: `Job.dispatch()` / `dispatchAfter()`,
  `queue.dispatch(Job, …)` and `schedule.job(Job, …)` for a job;
  `events.emit()` / `emitParallel()` of a `new Event(…)` for an event;
  `events.listen(Listener)`, or an `events.on()` / `once()` handler that refers
  to the listener class or a binding holding `new Listener(…)` (the blog's
  idiom) for a listener; `.send()` / `.queue()` on a builder chain rooted at
  `new Mail(…)` for a mail; `send` / `sendNow` / `sendToMany` /
  `sendNowToMany` taking `new Notification(…)` for a notification. A mail
  module that declares no class and exports functions (the blog's and the
  api's idiom) is sent by calling one of those functions, a helper among them
  included. An instance is followed through bindings scoped as ES modules scope
  them (`var` to the function, `let` / `const` to the block, each `case` block
  its own, a parameter's default), so a parameter or an inner binding of the
  same name shadows it. A `var` initialised twice with two classes, and a name
  the file assigns to anywhere, hold neither, since which value is current the
  order cannot say (an assignment, destructuring and a `for (x of …)` or
  `for (var x of …)` head all count). An `on()` / `once()` handler (the second
  argument, never the options) registers a listener it constructs, or a class
  or instance whose own member it calls, directly or through `call` / `apply`,
  other than one every object has (`toString`, `bind`, …); a
  `listener.handle.bind(listener)` handed over as the handler itself registers
  too. That holds only when the first argument is an app event class or a class
  `@guren/core` / `@guren/server` exports. A listener class or instance only
  named there (`OptionsOnly.priority`), a member of one of its properties
  (`L.name.toUpperCase()`), a computed member other than a string literal and a
  bind nobody calls are mentions; so, on the safe side, are
  `L.instance.handle()`, `L.prototype.handle.call(x)`, a bound member chosen by
  a condition and one bound twice. On the other side, a call in the handler's
  own place (`events.on(E, L.handler())`) counts, since a factory returning the
  handler is written that way, although it runs once, at registration. The
  same done in any other `on()` (a string event name, which `EventManager`
  accepts, reads the same as
  `router.on('POST', path, handler)` or a process hook, whose every argument is
  read) is kept apart as unconfirmed: the element stays `present`, and the note
  names the file rather than calling the class unused. A handler defined apart
  from the call and passed by name is not followed, and reads as a mention.
  Classes are resolved through the import, relative or `@/`, a barrel
  (`app/Events/index.ts`) or a namespace import included, so a class of the
  same name in another app root is another class.
- The source read is every app root's `app/`, `routes/`, `src/`, `config/` and
  top-level files, tests excluded, and never the class's own file: a job that
  dispatches itself is not reached by that. The scan is AST-only, so a comment,
  a string, an import, a type position and `registerJob()` are never a use. A
  file that names the class without a use is kept as a mention and only feeds
  the note. A source file that does not parse makes an absent use unprovable,
  and the note says so; it is never `wired` on absent evidence. So does a
  `new AutoDiscovery(…)` for a listener: it finds listener classes by directory,
  and whatever registers them names none.
- Why a mount and not a property. A property with a `match` lifts an element
  to `verified` without a behaviour (*status rules after Part 2*), and nothing
  in a plan links a behaviour to a side effect. As a mount, a side effect still
  has no planned property, so it still closes only by a waiver, exactly as
  before; being `wired` changes which hold it carries (`unreached` instead of
  `incomplete`). What the mount changes is completion: a side effect completes
  at `wired`, so its step is `incomplete` under `plan:verify` while nothing
  uses the class, and `plan:close` names that as the remedy.
- What the use does not say. The `trigger` is prose and is not matched: a
  dispatch from another action than the one the plan names still counts. The
  reach of the dispatch site is not followed either: a dispatch in an action
  no route mounts counts.
- The cost of `wired`, measured on the comments fixture. A side effect named
  after a planned model is placed in that model's `http` step, after the
  controller that dispatches it (`CommentPosted` lands in
  `task/entity/model.comment/http/2`, the controller in `http/1`). One named
  after no planned model (`WeeklyDigest`, `NotifyPostAuthor`) lands in the
  Foundation task, which runs first, and its step stays `incomplete` until an
  action of a later task dispatches it. Such an element is one the derivation
  already reports as unplaced (`element-unassigned`), and the remedy is the
  plan's: a task intent that `covers` the side effect beside the action that
  uses it, or a waiver. Holding the step open is the reading this RFC asks for,
  since a step is complete only when every element it covers is; exempting a
  side effect from its step's completion would hide the misplacement.
- Measured on the examples with every side effect planned as an `add`: in
  `examples/blog`, 10 of 12 read `wired`; `ProcessNewPostJob` is registered and
  never dispatched, and `NewPostMail`'s `sendNewPostMail` is called only from a
  test, both true readings. In `examples/api`, 7 of 8; `SendRegistrationEmailJob`
  is registered and never dispatched. Policies, read on the `create-app` blog
  template (the examples have none): the five abilities `PostPolicy` declares
  match, and a planned `restore` it lacks differs.

**What is durable and what is not.** The decision log (waivers, deviations,
the reason for each revision) is part of the record and lives in the store
(§9), committed or on the issue. `.guren/plans/<slug>.state.json` is
git-ignored and holds what can be rebuilt: verification results and per-step
metrics. A fresh clone, and CI, therefore see every element as at most `wired`
until `plan:verify` has run there. That is the intended reading: a
verification result is a fact about one environment, and a committed
"verified" would be a claim nobody on the new machine has checked.

### 7. The implementation loop

```bash
bunx guren plan:next comments --json
```

returns the next step whose dependencies are complete, with exactly the context
it needs: the elements it covers, the confirmed shape of what it depends on
(`generateEntityContext()`), the acceptance behaviours, and the verify
commands. It never returns the whole plan. It refuses when the working tree is
dirty, and skips a step that depends on a stale element (§4), naming what went
stale.

One step is one agent session and one commit. The hand-off between sessions is
the code, the git history and the decision log, so a session that dies
mid-task costs one step.

The harness template gains a `plan-implement` skill that loops
`plan:next` → implement → `plan:verify`, and a `Stop` hook that runs
`guren plan:verify --step <id> --ci` and exits 2 while the step is incomplete.
`PostToolUse` is not used for this: it cannot block.

The hook has to be able to give up, or a step that can never complete holds
the session until Claude Code's own continuation cap ends it with no
explanation. It lets the agent stop, and says why on stderr, when
`stop_hook_active` is set and the step's state has not changed since the
previous continuation, when any covered element is `blocked`, or after three
continuations on one step. The step is then recorded as `stalled` in state
with the last failing output, `plan:next` keeps returning it, and a person
decides between fixing the environment, a revision, and `plan:waive`.

On completing a task, the skill starts a reviewer in a separate context, given
only the task's plan elements and its diff. Its findings are advisory: a
reviewer asked for gaps reports some whether or not they exist.

**Amended in implementation (`plan:next`, the `Stop` hook).** The loop is
shipped with these readings:

- `plan:next` returns the first step in task order whose record does not
  stand (no record, another plan digest, or a fingerprinted file that changed,
  the rule the whole-plan skip uses), which is also how a stalled step keeps
  coming back. The context is the
  step's elements verbatim, its behaviours, its verify commands and, for a
  `scaffold` step, what it generates. The dependency shape through
  `generateEntityContext()` is not in it yet.
- For a plan with a baseline `plan:next` reads the application without
  `detail` (the scanners, and an import of the routes file) and spawns no
  command; a draft is never read. Once every step is verified it reads the
  application once, with `detail` and for a draft too, which imports
  `db/schema.ts` and the validator files, to list the elements `plan:close`
  would still refuse (see *status rules after Part 2*); a read that fails is
  reported, never fatal. It holds a step that depends on a stale
  element (§4), and the steps after it in its task or in a task waiting for
  it, and returns the first step that is neither. Each held step is reported
  with its stale elements, how the step depends on them, the §2 checks re-run
  for them against the application as it reads now (only when something is
  held), and a stall the hook recorded on it. When every step left is held or
  waiting no step is returned and the command still exits 0: the hook reads
  the mark, never this exit code, and a held plan is a person's decision
  rather than a failed command. The mark is cleared so the hook holds
  nothing, unless it carries a stall on a held or waiting step: that stall
  sticks, and the next run reports it again. An application that cannot be read is
  reported, with a hint to run `codegen` on a fresh clone, and holds nothing.
- The hook judges staleness on the application `plan:verify` reads after its
  `codegen`, not before it: importing the routes file first would leave Bun
  holding a failed import of a generated file for the rest of the process.
  It reads the step's stale context from that report. A step that is not
  verified and has stale context stalls with that reason, before the other
  give-up rules, since no continuation can finish it against the plan; a
  verified step goes through.
- `plan:verify` reports the baseline's freshness and the stale context of the
  steps it ran, judged with the marked step in progress, without changing
  their outcome: `blocked` is the environment's
  and `failed` the implementation's, and staleness is neither.
- The hook knows which step a session is on from a mark in the state file,
  `active: { plan, step, startedAt, continuations, lastSignature?, stalled? }`,
  which `plan:next` writes (the plan path relative to the application root)
  and clears once every step is verified. A dirty tree is refused unless the
  step it would return is the marked one: that tree is the step's own work.
- There is one `Stop` hook, the `gate-on-stop` script the harness already
  ships, so `agent:sync` delivers the loop to every application without an
  edit to the user-owned hook config. The gate runs first, once per stop
  chain as before; the marked step is verified after it, on every stop, in
  process through `planStopHookFindings()` rather than by spawning
  `plan:verify --ci`. A step whose record still stands is not re-run.
- The give-up rules are the ones above, plus a step whose own outcome is
  `blocked`, which is the same environment verdict at the command level.
  "The step's state has not changed" is judged on a signature of the record
  (outcome, command statuses and findings, behaviour statuses, the incomplete
  list, the fingerprinted hashes) and only on a stop that follows a blocked
  one; the same record on a fresh turn is a new attempt. The stall is
  recorded on the mark with the reason and the last output, and it sticks:
  the hook does not ask again until `plan:next` has reported it, which also
  gives the step a fresh mark. Cursor's `loop_count` stands in for
  `stop_hook_active` there, and a stall goes to stderr, since its hook can
  only follow up or stay silent.
- A stalled step leaves the person three answers, and `plan:waive` is the
  third; the skill tells the agent to report the stall and never to waive on
  its own. The reviewer at the end of a task is the harness's `code-review`
  subagent, given the task's elements and its diff.

**Amended in implementation (`plan:waive`).** The waiver command is shipped
with these readings (`packages/cli/src/plan-waive.ts`, `plan/decisions.ts`).

- The decision log lives beside the plan and is committed. A plan named
  `plan.json`, the §9 layout, keeps it as `decisions.json` in the same
  directory; any other plan keeps it as `<slug>.decisions.json`, so two plans
  in one directory do not share a log. The shape is
  `{ decisionsVersion, waivers: [{ elementId, planHash, reason, at, by? }] }`,
  sorted by element id, `by` read from `git config` where it answers. A log
  that will not read is reported and never replaced: a state file holds
  results a rerun rebuilds, this one holds decisions nobody can.
- A waiver names the plan's hash, so a revision inherits none of them. One
  taken against another hash is reported in the status summary
  (`staleWaivers`) and lifts nothing.
- A waiver lifts its element to `waived` whatever the readers found, unless
  the element is already `verified`: verification is a stronger answer than
  acceptance, so the note then says the waiver is not needed. `plan:status`,
  `plan:verify` and the Stop hook read the log through the one overlay.
- `plan:verify` leaves a waived element out of the step's judgement and
  records which ones it left out. A step whose only missing elements are
  waived verifies, which is how the loop of §7 gets past a stall. That record
  stops standing once the waiver is withdrawn, so `plan:next` returns the
  step again rather than skipping it forever.
- A waiver lifts an element and nothing else, so it only carries a step that
  is `incomplete`. A behaviour that fails makes its `tests` command fail and
  the step is `failed`, whatever is waived: a behaviour the code will not
  satisfy is a revision. `plan:next` lists a step's waived elements apart from
  the ones to implement, and a log that will not read is reported by
  `plan:next` and the Stop hook, which then judge as if no waiver were taken.
- The command refuses an element the plan does not declare, one in a section
  `plan:status` does not judge (flows, tasks, behaviours, questions), an
  `existing` element, which the table above keeps out of completion, a
  missing `--reason`, and a draft, which has no hash a waiver could name.
  `--remove` deletes a waiver and asks none of that: it matches on the element
  id alone, since withdrawing the waiver of an element a revision dropped is
  exactly what it is for. Out of scope here: `plan:close`, which is what
  reads the log to decide a plan is finished, and any waiver of a whole step
  or task, since completion is defined per element.

`plan:verify` appends to state, per step: `total_cost_usd` and duration where a
producer reported them, stop-hook continuations, files touched, lines changed.
The split threshold in §5 is set from these numbers, not from the literature.

`guren plan:close <plan>` requires every element `verified` or an explicit
waiver with a reason, offers `make:adr` for each recorded deviation, archives
the plan, and leaves `spec:generate` as the description of record. A plan is a
proposal with an end, not a second specification to keep in sync.

**Amended after acceptance (2026-09-19):** what `plan:close` leaves behind has
two layers, and the plan feeds one of them. The *generated* layer is
`docs/spec/`, regenerated from code under the existing drift gate, and it gains
nothing from a plan. The *curated* layer is one OKF document per entity
(`docs/entities/<Entity>.md`, `entities:` naming it) holding what code cannot
say: purpose, business rules, decisions, non-goals, and the plans and PRs that
touched it. `plan:close` inserts a draft block per section, fenced by
`<!-- guren:plan <hash> -->` markers, and never rewrites text outside them.
A rule cites the acceptance id that verifies it (`… (AC-comments-4)`); the doc
never restates a column or a route, which the generated layer already holds,
and a rule with no id, or an id no test carries, is a `check --docs` finding.

A committed `docs/spec/behaviours.md` was considered and dropped (Open
Question 9). Behaviours are derived data instead: `guren context <Entity>`
gains a Behaviours section read from id-tagged test titles, and the plan page
already shows them per element. A report command may write a catalogue on
demand; nothing commits one.

**Amended after acceptance (2026-09-19), the docs graph.** What `plan:close`
leaves behind joins the graph `guren docs:graph` already draws (nodes `doc`,
`entity`, `code`; relations `governs` from frontmatter, `links` from body
links, `derives` from a spec view's source; a verdict per edge from
`check --docs`), through the mechanisms it already has plus one new one:

- The archived plan is a doc node. `plan:close` writes `docs/plans/<slug>.md`
  beside the JSON, with `type: plan`, `entities:` (what it touched),
  `related:` (the ADRs it produced), `status: closed` and
  `generated: { by: process:guren-plan-close }`. Plan → entity is then a
  `governs` edge and plan → ADR a `related` one, drawn by code that exists;
  the entity document's History section links back.
- An acceptance behaviour is a node. The graph gains the node kind `test` and
  the relation `verifies`: a rule's `(AC-comments-4)` in an entity document
  is a doc → test edge, and the test's entity comes from the id's
  `<entity>` segment. An id no test carries, or a test whose id no document
  cites, is a `check --docs` verdict on that edge. The reader is the one
  `guren check` uses for the id grammar; there is no second one. This is the
  trace link the evidence in Open Question 9 supports, and the only new
  mechanism here.
- Code reaches the document without hand work. The scaffold step writes
  `@docs docs/entities/<Entity>.md` into the controller, model and test files
  it generates, which is the existing code → doc edge, so
  `guren context <Entity>` lists them.
- The trust tiers are the existing ones. A block `plan:close` inserted is
  `generated`; the approver's sign-off is a `verified` event; a rule whose
  cited test passes reads as machine-confirmed, one whose test is absent or
  failing as unverified.

`guren docs:graph --entity Comment` then answers with one graph: the entity
document, its ADRs, the plans that touched it, the tests that verify its rules
and, through `@docs`, the code. All of it is Part 4 work with `plan:close`.

**Amended in implementation (`plan:close`).** The command is shipped with these
readings (`packages/cli/src/plan-close.ts`, `plan/close-docs.ts`,
`docs-acceptance.ts`).

- Completion is judged by `planStatusFile()`, the function `plan:status`
  prints, so the two cannot disagree. Every element outside `existing`, in a
  section `plan:status` judges, must be `verified` or `waived`; the refusal
  names each one that is not and its state. A state file or a decision log
  that will not read refuses too. The plan must carry a baseline, and its
  current hash must be in the approvals beside it: a revision approved under
  another hash is not closed on its parent's approval.
  **Amended in implementation (the refusal's remedies).** Each refused
  element is printed with what holds it and, on the next line, the command
  that moves it: `plan:verify <plan> --step <id>` for the step that verifies
  it (preceded by the step whose behaviour reaches it, when none of its
  planned properties matched beyond an existence), fixing the code first
  where it is below its completion state or blocked, and
  `plan:waive <plan> <id> --reason` where no `plan:verify` run can lift it:
  no step verifies it, nothing of it can be fingerprinted, or none of its
  planned properties matched beyond an existence and no step's behaviour
  reaches it. The last is predicted before any run, so a reader is not sent
  to `plan:verify` only to find the element held as unreached. Adding a
  behaviour and approving again is offered beside the waiver only for an
  element some behaviour could reach (`behaviourCanReach()`, the reach walk
  seeded with every element of a section a carrying reference names and the
  plan's behaviours) and that `plan:verify` can fingerprint; a
  column, a command, a job, event, listener, mail or notification, and an
  element `plan:verify` cannot fingerprint, are sent to `plan:waive` alone.
  `plan:next`, once every step is verified, lists the same lines
  (`plan/close-remedy.ts`), so the two commands give one piece of advice.
- "Archives the plan" is the doc node. Under the `file` store nothing is moved
  or deleted: the plan, its approvals and its decision log stay committed where
  they are, and `.guren/plans/` is left alone. No command yet refuses to work on
  a closed plan. Freshness (§4) is not consulted: a stale element is reported by
  `plan:status` and `plan:next`, and what closes a plan is its elements' states.
- The doc node is `docs/plans/<slug>.md` wherever the plan file sits; a plan
  named `plan.json` takes its directory's name. `status: closed` is not
  written, since the checker reads `status` as the OKF lifecycle and warns on
  any other value (`docs-check.ts`, `DOC_STATUSES`); closure is `closed: true`
  beside `plan_hash`. `related:` is omitted: `plan:close` writes no ADR (it
  prints one `make:adr` command per waiver), and a `related` entry nothing
  matches fails `check --docs`. The approval is the `verified` event, as
  `human:<approvedBy>` where `git config` named someone.
- A block opens with `<!-- guren:plan <slug> <hash> <section> -->` and closes
  with `<!-- /guren:plan <slug> <section> -->`. It is found by slug and section,
  never by hash, so closing a revision replaces the blocks its parent wrote and
  leaves every other plan's alone. The sections are Purpose, Rules, Decisions,
  Non-goals and History; one with nothing to say gets no block, and a revision
  that empties one removes it. A block goes at the end of the section whose
  `## ` heading names it in either plan locale, or under a new heading in the
  plan's locale (`en`, `ja`; any other tag writes `en`). An existing
  document's frontmatter is never touched; one that does not name the entity
  is reported. The close refuses, writing nothing, when a document's markers
  cannot be rewritten safely: an open marker with no close before the next
  marker or heading, a close with no open, a pair written twice, a marker
  inside a code fence, or a code fence that never closes. Headings and the
  section's end are read outside code fences, and a document keeps its line
  endings (one that mixes them comes back with the first kind throughout). A model's `name` and `module`
  become path segments, so one that is not a plain identifier, or would land
  outside the application, refuses too. A task belongs to the model its
  `entity` names by the task derivation's rule (class, then id, then table).
  Not handled: a `### Rules` heading, a heading a revision's removed block
  leaves empty, and a citation wrapped across lines.
- The Rules block lists the behaviours of the tasks naming the entity, each
  citing its own id, then each action rule and policy-ability rule, citing the
  behaviours whose route reaches that action or authorizes with that ability.
- Citations are a parenthesized, comma-separated group whose every entry passes
  `isAcceptanceId()`, the prefix and grammar rule `plan:verify` reads undeclared
  ids with; the test side is `bracketedTokens()` over the test sources, the scan
  `plan:verify` selects test files by. The edge runs test → doc (`verifies`),
  the reverse of the text above, so that the relation reads as its name; a
  test also verifies the entity its id's segment names (the collection, as the
  plan spells it, or the class name), which is what brings the tests into
  `docs:graph --entity` in one hop. A citation no test carries, a test id that
  no document cites while another id of its segment is cited, and a Rules item
  in a `type: entity` document that cites nothing are advisory `check --docs`
  warnings, which `check --ci` and `guren gate` do not count.
  They stay advisory because a test may legitimately run ahead of the
  documents, as work nobody planned under an entity a closed plan documented
  does. The test tree is read only once a document cites an id.
- Deferred: the scaffold step's `@docs` tags (the scaffold step is Part 3's),
  the Behaviours section of `guren context <Entity>`, and a rule reading as
  machine-confirmed by its test passing. The edge verdict says a test carries
  the id; whether it passes is a result of `plan:verify` in one environment,
  which a committed document cannot state.

### 8. Producers

The schema, the checks, the renderer and the status derivation involve no
model. A producer is whatever hands Guren a JSON document.

```bash
bunx guren plan "comments on posts, authors can delete their own"
```

spawns the `claude` on `PATH`:

```
claude --bare -p <prompt> --output-format json --json-schema <schema>
       --tools Read,Grep,Glob --append-system-prompt <conventions>
```

The prompt carries the request, `guren context --json`, the entity bundles for
any model the request names, and `guren guidelines`. Tools are read-only. Guren
reads `structured_output`; `is_error`, `error_max_structured_output_retries`,
and a `success` without `structured_output` are all failures, reported with
the subtype. `baseline` is stamped by Guren afterwards.

Read-only is not the same as safe. The producer reads a repository that may
contain text addressed to it, and what it reads can come back out inside the
plan. So: the process is spawned with an argument array, never through a
shell; the prompt and the schema go in files, with the embedded context
bounded in size; `Read` is denied on `.env*`, key files and whatever
`.gitignore` excludes (`--disallowedTools` patterns), so a secret cannot be
copied into a document that is about to be rendered, committed or posted to
an issue; and the output is only ever data. No plan string is executed: the
`commands` section is matched against an allowlist of `guren` subcommands,
and verify commands come from the step table in §5, never from the plan.

**Amended after re-review (2026-09-23), Part 3.** The headless producer is
not in Part 3. It waits for the probes that answer Open Questions 2, 10 and
12, whose procedures are in the Part 3 note under Phasing. When it ships, the
command line and the confinement paragraph above change as follows, from the
Claude Code docs as read on 2026-09-23:

- **Auth.** `--bare` reads no OAuth credentials and no keychain. It needs
  `ANTHROPIC_API_KEY`, or an `apiKeyHelper` passed in `--settings`
  (https://code.claude.com/docs/en/headless#start-faster-with-bare-mode). The
  producer runs under `--bare` with an API key, which the same page calls the
  recommended mode for scripted calls. It does not reuse the subscription
  login (see Alternatives).
- **Where it runs.** In a checkout of the tracked files at HEAD (for
  instance a detached `git worktree add` in a temporary directory), not in the
  working tree. The checkout is read at HEAD, so uncommitted work is not in
  what the producer sees, and gitignored files are absent.
- **Deny rules are not enough on their own.** Read rules reach Grep and Glob
  only as a "best-effort attempt"
  (https://code.claude.com/docs/en/permissions#read-and-edit). Glob does not
  respect `.gitignore` by default
  (https://code.claude.com/docs/en/tools-reference#glob-tool-behavior). So
  "whatever `.gitignore` excludes" is not one `--disallowedTools` pattern.
  The tracked-files checkout is what removes gitignored secrets. Deny rules
  on `.env*` and key files stay, for secrets that are tracked.
- **The `env` block.** Under `--bare` the project settings' `env` block still
  applies
  (https://code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder).
  The checkout keeps a tracked `.claude/settings.json`, so its `env` still
  reaches the producer. That stays open under Open Question 10.
- **Pinned mode and caps.** `--permission-mode dontAsk`: the flag overrides a
  `defaultMode` from settings, and `dontAsk` denies whatever would prompt, a
  read outside the working directory included. Also `--permission-prompts
  none` (Claude Code v2.1.259 or later), `--max-budget-usd` and `--max-turns`
  (https://code.claude.com/docs/en/cli-reference#cli-flags,
  https://code.claude.com/docs/en/permissions#permission-system). A proposal,
  to settle in the change that ships the producer: `--no-session-persistence`
  on a first draft, and not on the first call of an `--ask` pair, which has
  to be resumable.
- **Schema size.** `--json-schema` is validated as draft-07, with retries on
  mismatch (https://code.claude.com/docs/en/agent-sdk/structured-outputs).
  The API's constrained decoding caps a request at 24 optional parameters and
  16 union-typed ones. It answers a schema past its internal limits with a
  400 "Schema is too complex for compilation"
  (https://platform.claude.com/docs/en/build-with-claude/structured-outputs#schema-complexity-limits).
  Counted at 2a784c4d with a walker that approximates the API's counting,
  `planDraftJsonSchema()` has 56 optional and 14 union-typed properties, and
  `planRevisionOpsJsonSchema()` 150 and 32. The pages read do not say whether
  `claude --json-schema` goes through constrained decoding, so this is not
  asserted. The Open Question 2 probe settles it.
- ~~**The `commands` allowlist is not implemented.**~~ The allowlist is a §2
  check (`plan:command`, a failure) in `packages/cli/src/plan/command-allowlist.ts`.
  A command passes as `guren <subcommand>` or `bunx guren <subcommand>`, with
  arguments in a closed character set and `'`/`"` quoting, naming no
  absolute path and no `..` segment, and a subcommand
  the table classifies as a generator: `make:*` except `make:migration`,
  `lang:publish`, and `add <blueprint>` except `add plugin`. A registry
  command the table does not list is refused, and a test fails until it is
  classified. `PlanCommandSchema` still takes a string, so a plan with a
  refused command parses and shows the finding. `plan:next` refuses such a
  plan before it marks a step, drafts included, since a draft never passes
  `plan:approve`. `check --plan` warns on an approved one.

`guren plan --print-prompt` writes the prompt and the schema to stdout and
calls nothing, for any other agent, and for a Claude Code session already in
progress, where the harness skill has the running agent write the JSON and
call `plan:render` rather than nesting a second `claude`.

**Amended after re-review (2026-09-23), Part 3:** this is the producer Part 3
ships, with an in-session plan-writing harness skill. It needs no confinement
of its own, since the running agent already holds the person's permissions.
It is the path the guide describes today
(`docs/en/guides/implementation-plans.md:46`).

**Amended in implementation (2026-09-25), Part 3.** `guren plan --print-prompt`
embeds no application context. The prompt names the read-only commands the
running agent runs for it (`guren context --json`, `guren context <Entity>`,
`guren model:list --format json`, `guren guidelines`) and has it check the
file with `plan:render --json`, which prints `{ path, checks }`, until no check
fails. Embedding `guren context --json` would import and introspect the
application inside a command that otherwise calls nothing, and would need the
size bound this section asks of the headless producer; the agent already holds
the person's permissions and can run those commands itself. The prompt is built
by `buildPlanPrompt()` in `packages/cli/src/plan/prompt.ts`, which the headless
producer is to call, adding the embedded context and its bound there. Its
`commands` rule lists the generators from `PLAN_COMMAND_CLASSES`, and it asks
every `alter` to state its change in the properties `plan:status` reads (the
reshape in Phasing). The request is optional: without one, the prompt tells the
agent to ask for it. `guren plan` without `--print-prompt` exits non-zero and
names it; `guren plan --revise` exits non-zero and names `plan:revise`.

**Amended in implementation (the `plan-write` skill), Part 3.** The in-session
skill is `plan-write`, which `agent:init` installs beside `plan-implement`. It
runs `guren plan "<request>" --print-prompt` and follows it, adding what the
prompt cannot say: ask in the client's own way and wait before writing the
JSON, report the page, open questions and warnings left after
`plan:render --json`, record review changes with `plan:revise`, and hand an
approved plan to `plan-implement`.
The plan's conventions stay in `buildPlanPrompt()` alone.

**Two producers, for two situations.** The headless one cannot ask anything:
`claude -p` has no one to put a question to, which is why questions are data
(§1) and answers arrive through feedback (§4). It fits a request that is
already specific, and scripts. The in-session one is a conversation: the
harness skill lets the running agent ask the person directly, in whatever way
its client offers, *before* it writes the JSON, and hands the result to
`plan:render` and the same checks. A vague request belongs there. Both end in
the same document, and neither is the fallback of the other.

`guren plan --ask` is the headless middle ground. A first call uses a schema
that holds `questions[]` and nothing else; the CLI puts them to the person in
the terminal; the second call produces the plan with the answers in its
prompt. It costs one extra call and saves a full regeneration when the request
leaves a structural choice open. The second call resumes the first
(`--resume <session_id>`) so the code is not read twice, where that works
(Open Question 12).

Every producer call, first draft, `--ask` and each revise, records its
`total_cost_usd` in state, so the price of a plan is the sum of its rounds and
visible as such.

**Amended after re-review (2026-09-23), Part 3:** `--ask` is deferred with the
headless producer. When it returns, a round's cost is not its own
`total_cost_usd`. A run continued with `--resume` reports the conversation's
whole total, earlier runs included (https://code.claude.com/docs/en/headless,
the paragraph on `total_cost_usd`). Summing the rounds would count the first
call of an `--ask` pair twice, so the second call's cost is its total less the
first's. The cap differs the other way: `--max-budget-usd` does not count
totals restored from earlier runs
(https://code.claude.com/docs/en/cli-reference#cli-flags).

**Amended after acceptance (2026-09-19), the served mode.** Besides the file,
the page can be served by the development server, the way the `_guren/docs`
viewer is: dev-only, opt-in, behind the same loopback guard, never mounted in
production. The static file stays the base and the offline, shareable and
printable form; the served mode is a thin layer that injects live data at the
one placeholder `renderPlanHtml()` fills. What it changes:

- Review state is saved as it happens. Each verdict, comment and answer is
  posted to the server and written to `.guren/plans/<slug>.feedback.json`;
  the export button remains for a reviewer without the server.
- `guren plan --revise <slug>` reads that saved feedback by default, and the
  `plan-implement` skill runs it when asked, so the person's whole loop is to
  mark the page and say so.
- A revision can be requested from the page. The button writes a request
  marker beside the feedback and nothing else; the agent loop (§7) or a
  person picks it up. The server never runs a command: a page that could
  start `--revise` would turn any later injection defect into a model call
  and file writes under the reviewer's account.
- `plan:status` and `plan:verify` results reach the page live (§6), which
  is the reason the mode waits for Part 2.
- The page's policy gains `connect-src 'self'` in this mode only; the static
  file's policy does not change. The server accepts one kind of write, the
  feedback and its request marker, under `.guren/` and never under `docs/`.
  Approval stays a CLI act (`plan:approve`), so a compromised page cannot
  approve a plan.

Like `ai:eval`, `guren plan` is opt-in, costs money, and is never part of
`check` or `gate`. `guren check --plan` is advisory: it reports approved plans
with `drifted` elements and two open plans that touch the same element.

**Amended in implementation (`guren check --plan`).** The suite is shipped with
these readings (`packages/cli/src/plan-check.ts`).

- It runs only under `--plan`, never in plain `guren check`, `check --ci` or
  `guren gate`. Judging a plan imports the app's `db/schema.ts`
  (`readSchemaTables()`) and every validator file (`readSchemaIdentities()`),
  and `check` stays on the static schema reader everywhere else: `gate`, the
  Stop hook, `plan:verify`'s check step and the dev MCP server would each pay
  for the imports and discard advisory results. `--changed` with `--plan` runs
  it when source, a plan, a record beside one or anything under `docs/plans/`
  changed.
- Plans are found in one place: the app root's own `*.plan.json` and, under
  `docs/plans/`, every `plan.json` (the §9 layout) and `*.plan.json`. The
  records beside a plan never match, and a `revisions/` directory is not read.
  A plan kept anywhere else is not checked. A directory that will not list is
  reported, and so are two plans sharing a slug, since they share one state
  file and one doc node.
- Open means approved and not closed. Approved is `readPlanApprovalStanding()`,
  the reading the gated plan commands refuse on, so the two cannot disagree.
  Closed is what `plan:close` writes: `closed: true` in
  `docs/plans/<slug>.md` with `plan_hash` equal to the current hash, so a
  revision approved after the close is open again. A draft nobody approved,
  and a plan edited since its approval, are judged by neither rule, since
  nobody has agreed to them yet. A draft with approvals beside it
  (`baseline-removed`) is reported, because deleting a baseline would otherwise
  take an approved plan out of every rule unnoticed. So is any plan, a draft
  included, beside an approvals file that will not read. Nothing is reported when
  no plan has a finding; the counts are `plan:status`'s.
- `drifted` is whatever `planStatusFile()` reports, verification overlay
  included, the function `plan:status` prints. The application is loaded once,
  with `detail`, and only when an open plan exists.
- Two plans touch the same element when a changed target of each occupies one
  name in `listPlanAppTargets()`: the section, the app root, and the name (both
  names of a rename; a column under its table; a route also by its endpoint).
  A table and its columns are keyed app-wide, since every root's schema is
  one set of SQL tables. Ids play no part, so `model.post` in one plan and
  `model.entry` in another, both on `posts`, collide. A target a plan marks
  `existing` is only read and never collides, but a changed column or action
  under it also claims that parent, which collides with a plan renaming or
  dropping it. A model's `alter` claims its table only as such a parent, since
  its columns carry the table-level change, and a class rename leaves the table
  `existing`, so it does not collide with a column another plan adds under that
  class. Two plans that both alter one model class do collide on the class,
  since each changes its body, even when their columns are unrelated. One
  finding per pair of plans lists every shared name.
- Every result is an advisory `warn`, a plan or approvals file that will not
  read included, so `check --plan` exits 0.

### 9. Stores

Where the approved plan, its revisions and the decision log live is an adapter.

**`file`** (default): `docs/plans/<slug>/` holding `plan.json`,
`approvals.json`, `revisions/` and `decisions.json`, committed. Tasks are
never files, since they are derived. Approval provenance here is the commit:
who approved is who the repository's history and review rules say it was.

**`github`**: for a project that does not want plan files in the tree. It
follows the rule the harness's `github-projects` skill already states: GitHub
owns the task.

```bash
bunx guren plan "..." --store github     # opens the parent issue
bunx guren plan:approve 412              # label + hash comment, expands sub-issues
bunx guren plan:next --from 412
bunx guren plan:sync 412                 # pushes derived status to the issues
```

- The parent issue holds a readable summary and the plan JSON in a collapsed
  block. Each task is a sub-issue (`gh issue create --parent`), its body the
  acceptance behaviours and covered elements. A plan too large for one issue
  body keeps per-entity detail in the sub-issues.
- Status flows one way. `plan:sync` ticks checkboxes and closes a sub-issue
  when its task is complete; an issue closed by hand is reopened on the next
  sync. Commits carry `Refs #<sub-issue>`; decisions are comments.
- An issue is untrusted input, and a hash written in a comment authenticates
  nothing by itself: whoever can edit the body can post a matching comment.
  An approval counts only when the API reports its comment as written by an
  account with write access to *this* repository (`author_association` of
  OWNER, MEMBER or COLLABORATOR), never edited (`updated_at` equals
  `created_at`), and naming the hash of the body as it now stands. Comment
  text is never passed to an agent.
- Approval caches the plan at `.guren/plans/<issue>.json` so the loop does not
  depend on the API. The cached copy goes through the same schema validation
  and hash check as a remote one on every read; a cache is not a trust upgrade.

The rendered HTML is never committed under either store.

### Package boundaries

Everything lives in `@guren/cli` (`src/plan/`, `assets/plan/`, the harness
skill and hook). No runtime package changes. `zod` 4 is already a CLI
dependency. `claude` and `gh` are optional external binaries: their absence is
a clear error on the one command that needs them, and `plan:render`,
`plan:status` and `plan:next` need neither.

### Phasing

This RFC asks for acceptance of Parts 1 and 2. Parts 3 to 5 are described so
that the first two are designed with them in view, and each is re-reviewed
against Part 2's numbers before it starts; a poor answer to Open Question 1
reshapes or drops them.

1. **Part 1**: schema (§1), identity and revisions (§4), reference checks
   (§2), `plan:render` (§3), and the reader extensions §6 lists (column
   default, unique, index; resolved `Props` keys; the pure ER graph; the
   column-consumer scan). Proven against a hand-written plan for
   `examples/blog`. No model involved.
2. **Part 2**: `plan:status`, `plan:verify`, fingerprints and completion (§6),
   task derivation (§5), measured for false `present` / `wired` verdicts and
   for the share of `unknown` and `unjudged`, on the blog and on a plan for a
   dogfood app.
3. **Part 3**: the scaffold step and its emitters (§5), the `claude -p`
   producer and `--print-prompt` (§8), `plan:approve`.
   **Amended in implementation:** a minimal `plan:approve` (stamping the
   baseline and recording the approval, §4) shipped ahead of Part 3 with the
   freshness comparison, which needed a writer of `contextHash`.
   **Amended after re-review (2026-09-23):** Part 3 is re-scoped. The
   headless `claude -p` producer leaves it, and a model-free `plan:revise`,
   two §2 checks and per-step metrics join it; the order is in the Part 3
   note below.
4. **Part 4**: `plan:next`, the harness skill and `Stop` hook, metrics (§7),
   `plan:waive`, `plan:close`.
5. **Part 5**: the `github` store (§9), `guren check --plan`, the guide.

**Amended after acceptance (2026-09-22), Part 2 measurements.** The numbers
Parts 3 to 5 are re-reviewed against, and the answer to Open Question 1.

*Method.* Three hand-written plans: comments on `examples/blog` (23 elements
the plan changes), scheduled publishing on the blog (15, carrying the one
`rename` and the one `drop`), and task checklists on `kadai`, a private
dogfood app on the published 2.1 packages with SQLite (25), whose numbers
cannot be reproduced from this repository. Each ran through `plan:status
--json` of this tree against scratch copies of the app in four kinds of state:
before implementation, partly implemented, fully implemented, and near-miss
states built on purpose to break a known reader. A fifth run took one blog
near-miss copy with a schema that throws on import, to read the static
fallback; it is reported apart and left out of the tables. The near-miss states carry 30
faults of the kind an agent leaves behind: a validation call replaced by a raw
parse, a route moved into a module `createApp()` never lists, a column option
dropped, a listener never registered, a route declared after a `/:id` that
shadows it. Every verdict was judged by hand against what the code does.
`existing` elements are left out of every count.

| State | Runs | Elements | Agree | False `present` | False `wired` | False `drifted` | `unjudged` |
|---|---|---|---|---|---|---|---|
| before implementation | 3 | 63 | 53 | 0 | 3 | 2 | 5 |
| partly implemented | 2 | 48 | 41 | 0 | 2 | 2 | 3 |
| fully implemented | 3 | 63 | 58 | 0 | 0 | 0 | 5 |
| near-miss (adversarial) | 4 | 86 | 68 | 5 | 6 | 0 | 7 |

Of the `present` and `wired` verdicts, the false share was 0 of 58 on the
finished implementations, 2 of 30 partway through, and 11 of 63 in the
near-miss states. The near-miss rate is an upper bound from states built to
fail, not a field rate. Before implementation only three elements read
`present` or `wired` at all, and all three were wrong, for the one reason under
cause 1 below. A false `drifted` errs the safe way: it reports work that is
already done as unfinished.

Planned properties that ended `unknown` on the finished implementations, where
every reader had something to read:

| Section | Compared | `unknown` | Share |
|---|---|---|---|
| models | 24 | 1 | 4% |
| columns | 83 | 5 | 6% |
| actions | 23 | 0 | 0% |
| routes | 30 | 0 | 0% |
| views | 12 | 7 | 58% |
| validators | 7 | 7 | 100% |
| resources | 2 | 2 | 100% |
| policies | 2 | 2 | 100% |
| all | 183 | 24 | 13% |

The column unknowns are `references.onDelete` (3 of 3) and a SQLite `integer`
or `text` holding a boolean or a date (2 of 15 types); the view unknowns are
`form`, `actions` and `states`. Five of the 63 elements were `unjudged`: three
controller `alter`s, one mail class, and one model `alter` whose only change was
a dropped column. A further 18 of the 58 complete verdicts rested on existence
alone: every resource, policy, side effect and controller, every validator
(also on its mount), and the dropped column (on its absence).

Of the 30 near-miss faults, 17 showed on the faulty element's own verdict, 3
only as a note on a neighbouring element (a validator left `present` because
nothing validates with it), and 10 were hidden: 7 behind a property with no
reader, 2 behind a reader defect, and 1 no static reader can see.

*The false verdicts, by cause.* All 16 false `present` / `wired` verdicts have
one shape: the element completed while every property that encodes the change
was `unknown` or absent, carried over the line by a property that was true
anyway. §6's rule that an unknown never counts towards `present` stops an
unknown from satisfying a property; it does not stop an element whose
meaningful properties are all unknown from completing on the rest.

1. An `alter` completes on a property that already held (6 false `wired`). A
   plan that alters an action's behaviour (`PostController.show` also loads
   comments) states its response page, which was true before a line was
   written, so the action reads `wired` from the start in all three plans. In
   `packages/cli/src/plan/status.ts:194-202` an alter is `unjudged` only while
   no property is readable. The same cause makes a view `alter` that restates
   an existing prop beside a new one read `drifted` before implementation (the
   4 false `drifted`, `status.ts:198`). `baseline.contextHash` does not
   separate the two states: `action.tasks.show` read `fresh` both before and
   after the change.
2. A removed `this.validateBody` reads `unknown`, not `differ` (3 false
   `wired`, `status.ts:708-714`). All three removals in the near-miss states
   landed here, so on these plans an `unknown` body validator was a fault
   every time, never a helper doing the work.
3. No reader for what makes the element work (5): a validator whose rule
   changed (`max(500)` for a planned `max(2000)`), a resource missing
   fields, a policy with no `delete`, an event class nothing emits, and a
   listener nothing registers with `events.on()`.
4. A reader defect (1): `mergeRelationships()` in
   `packages/cli/src/model-parser.ts:544-560` reports a relationship declared
   only in `relationTypes`, with the `Post.hasMany(...)` call deleted, and lets
   the annotation's kind override the call's, so a `hasOne` call under a
   `BelongsToRecord` annotation reads `belongsTo`.
5. Not statically visible (1): a route registered after a `/:id` sibling reads
   `wired` while Hono serves every request to the sibling.

Two readings of the static fallback. `packages/cli/src/schema-parser.ts:76`
knows builders only from `drizzle-orm/*`, and the blog and every
`create-app` database template import them from `@guren/orm/drizzle/*`, so on
fallback every column of a scaffolded app is opaque; one run with a schema that
throws on import turned two correct `drifted` columns into false `present`. And
a schema that will not import takes the routes with it, since the models import
it: that run also left 4 elements `blocked` (two spread columns, two routes)
and 5 understated. The runtime reader is the only reader a scaffolded app
gets.

*`plan:verify`.* On kadai's finished checklist a whole-plan run verified all 25
elements; its `tests` step reads `failed`, as §6 says it must on a finished
tree. A near-miss the typecheck saw (a prop `TaskController.show` no longer
passes) failed its steps and lifted nothing. A near-miss that type-checks and
passes the behaviours lifted 16 elements, the unregistered listener among
them: `verified` on a class no event reaches, because no behaviour exercised
it. The bypassed validator kept its step `incomplete`. On the blog every step
failed on work the plan did not list (spec views out of date, a prototype
fixture the plan's new prop broke), `db:migrate` was `blocked` on an unreachable
database as designed, and the `tests` steps failed with no test file carrying
the ids, since this measurement wrote no blog tests. Writing them would not
be enough: the blog's suite is written for Vitest (`vi.mock`,
`vi.importActual`), and one of its files run under `bun test`, which is what
`plan:verify` runs, fails on `vi.importActual is not a function`.

*Answer to Open Question 1.* The progress view is not mostly "not checkable":
13% of planned properties at completion, concentrated in the kinds §6 already
lists as readerless. Causes 1, 2 and 4 (10 of the 16 false verdicts) come from
two rules and one defect, each fixable without a new reader:

- an `alter` counts only the properties that differ from how the code read at
  approval, which means `plan:approve` records the per-property verdicts of
  every `alter`; with none left readable the element is `unjudged`;
- a planned body, params or query validator that the body does not validate
  with holds the action at `present` with a note, as the validator's own
  `wired` rule already does, instead of reading `unknown`;
- an element whose completion rests on existence alone is not lifted to
  `verified` by a step whose behaviours never reach it;
- `mergeRelationships()` takes the kind from the call and keeps an
  annotation-only relationship out of the declared set.

Causes 3 and 5 (the other 6) remain after all four. The third rule stops
`plan:verify` lifting such an element; `plan:status` still reports it `present`
or `wired`. Part of cause 3 is a gap between the code and this RFC: the rule
above says an element whose every planned property is unknown is `unjudged`,
but `status.ts:194` applies it to an `alter` only, so an `add` resource or
policy whose only planned property is unknown reads `present`. Applying the
rule to every change kind would make those two `unjudged`; the validator,
event and listener would still complete on their mount or on existence.

*Parts 3 to 5.* `plan:approve`, `plan:next`, the `Stop` hook, `plan:waive` and
`plan:close` landed before these numbers existed; the numbers support what
landed, and `plan:approve` takes on the per-property record above. For what has
not started:

| Item | Call | On what |
|---|---|---|
| scaffold emitters (§5) | proceed | 0 false verdicts at completion on the kinds a scaffold writes (models, columns, actions, routes), at 0% to 6% unknown |
| `claude -p` producer, `--print-prompt` (§8) | reshape | the prompt asks every `alter` to state its change in readable properties, and ~~§2~~ `plan:approve` warns (§6 amendment on readings) on an `alter` whose readable properties all held at approval; an `alter` in prose alone is cause 1 |
| `guren check --plan` (§9) | proceed | a single reading of the rules above serves it |
| `github` store (§9) | defer | nothing measured here bears on it; it waits for a user |
| the guide | proceed; update when the §6 rules land | the guide describes today's rules, which the changes above alter |

**Amended after re-review (2026-09-23), Part 3.** Part 3 was re-read against
the code before it started (`origin/main` at 2a784c4d), and the maintainer
took the decisions below. Code claims were read from that tree; "predicted"
marks what was read and not run.

*What moved since the table above.*

- The "proceed" on scaffold emitters covered four kinds: models, columns,
  actions and routes. The §5 writer table also named validators, resources,
  policies and pages. Validators and resources have had field readers since
  #987. Policy abilities are read since #988, as existence only, so a policy
  completes only where a behaviour reaches it (`restsOnReach()`,
  `packages/cli/src/plan/verification.ts:58-60`). Emitting those three is safe.
  Pages are not emitted (§5 amendment).
- The reshape's warning, on an `alter` whose readable properties all held
  at approval, is implemented in `plan:approve` from the approval entry's
  readings, and is not a §2 check (§6 amendment on readings).
- The `commands` allowlist of §8 is implemented as a §2 check (§8 amendment).
- Files touched and lines changed per step are not recorded, so neither the
  step width (Open Question 3) nor what a scaffold saves can be judged yet.
- Re-approving a plan mid-build settles the plan's own built elements
  (#968), so approval after a scaffold step no longer refuses.
- `guren add resource` already appends a table and inserts route lines, and
  `make:feature` / `add resource` write a fixed CRUD surface (§5 amendment).
- Route fingerprints fail open for a `routes/<x>.ts` the entry registrar
  calls, predicted from the code (§5 amendment). #1039 is the fix. It is a
  Part 2 defect and lands regardless of the rest.

*Decisions (maintainer, 2026-09-23).*

| # | Decision |
|---|---|
| D1 | No headless `claude -p` producer in Part 3. `--print-prompt` ships; headless waits for the probes that settle Open Questions 2, 10 and 12 (below). |
| D2 | When headless ships, it runs with `--bare` and an API key, in a checkout of the tracked files at HEAD (§8 amendment, and Alternatives). |
| D3 | The `http` step mounts the scaffolded routes~~, pending the mounted-routes experiment (below)~~. |
| D4 | The scaffold emits no pages, and plans carry no layout, which belongs to prototype mode (Open Question 4). |
| D5 | Scaffolded routes go in a `routes/<entity>.ts` of their own, after the route-file fingerprint fix (#1039). |
| D6 | A model-free `plan:revise` is in Part 3. `plan --revise` stays the name of the model-calling form (§4 amendment). |
| OQ3 | Five files, until the per-step metrics exist. |
| OQ13 | No editing in the page; `plan:revise` from an edited plan covers it. |

*Scope and order.*

1. The route-file fingerprint fix (#1039).
2. The `commands` allowlist, a §2 check (§8 amendment), and a warning for
   an `alter` whose properties all held at approval, which `plan:approve`
   computes from the approval readings and is not a §2 check (§6 amendment
   on readings).
3. Files touched and lines changed, recorded per step. Implemented, as the
   per-step work note below reads it.
4. `plan --print-prompt`, `plan:revise`, and an in-session plan-writing
   harness skill.
5. The mounted-routes experiment. Run; the note below records it.
6. `plan:scaffold`, emitting what the §5 amendment lists. No pages.
7. Optional: test skeletons, and the static "still calls its route" check.

Deferred: the headless producer, `--ask`, the headless `plan --revise`, page
emission, the characterization step, and retuning the step width.

*Per-step work* (item 3). `plan:verify` records on each step record a `work`
entry, `packages/cli/src/plan/work.ts`. It is a measurement: nothing refuses
or blocks on it.

- The step starts at the commit `HEAD` names when `plan:next` first marks it,
  kept on the mark as `from` (`null` where git could not read `HEAD`).
  Marking the same step again (resumed, after a stall or an approval stall)
  keeps it. `plan:next` refuses a dirty tree for a new step, so that commit
  holds none of the step's work.
- A run of the marked step measures `git diff --numstat -z --no-renames` from
  there to the working tree, plus untracked files, under the application
  root. Several commits and uncommitted work count alike; a rename counts as
  a removed file and an added one, and an untracked symlink as one line, as
  git counts a tracked one.
- The first run that verifies the step settles the measurement. Every later
  record carries it: a drift re-check under a fresh mark, a failed re-check
  and its fix, the `Stop` hook, `--step` again. Work after that run is not
  counted.
- A revision that sends a settled step back as new work does not re-measure
  it, so a step the revision widened is undercounted. That is deliberate:
  the datum the step width is tuned from is the work of implementing the
  step as first planned, and a second measurement would mix a revision's
  delta into it.
- Excluded: the plan, its approvals, decision log and rendered page;
  `.guren/`, which holds codegen output and this state; lockfiles; and
  drizzle-kit snapshots. A migration's SQL counts.
- Not measured, with the reason and never a zero: a step no mark names (a
  whole-plan run, `--step` while another step is marked), a mark whose
  `HEAD` git could not read (no git, no commit), a mark written before marks
  carried `from`, and a start that is not in the repository or no longer an
  ancestor of `HEAD`. The baseline's `rev` is no fallback for a
  first step: the plan and approval commits land after it.
- It stays in the state file, as §7 says. That file is per machine, which
  suits a default retuned by whoever runs the loop, and `from` names the
  commit the numbers can be recomputed from. `plan:close` copies nothing of
  it into the committed docs. An older CLI that rewrites the state file
  drops `from` and `work`, since its schema does not know them.
- Reported as a `work:` line per step by `plan:verify` and the `Stop` hook,
  in the record under `--json`, and by step id under `verification.work` in
  `plan:status --json`.

*The mounted-routes experiment* (D3). It runs on `examples/blog` or a
scratch copy inside the repository. Outside it, `@guren/*` could resolve from
npm.

1. `guren add resource <Entity> --fields "body:text"` for an entity the blog
   does not have, with no migration run.
2. One `TestApp` test: a guest `POST` to the new collection with a *valid*
   body, expecting 401 or a redirect. With an empty body the contract's 422
   could answer first and hide the result.
3. A second: an authenticated `POST` with an empty body, expecting 422.
4. Run only that file under `bun test --reporter=junit`; the blog's own suite
   is written for Vitest (Part 2 measurements above).

Either passing confirms the §5 prediction and D3 stands: a mounted route
passes that behaviour before the `tests` step, so the routes stay unmounted
until `http`. Both failing reopens D3.

**Amended after the experiment (2026-09-25).** Run at 17836ede on Bun 1.3.14.
Both tests passed, so D3 stands.

`guren add resource Note --fields "body:text"` in `examples/blog` appended
`notes` to `db/schema.ts` and mounted a `/notes` group in `routes/web.ts`,
with `body: NotePayloadSchema` on `notes.store` and no auth middleware. No
migration was generated or run. A guest `POST /notes` with a valid body got
401 from `userOrFail()` in `NoteController.store`. An authenticated `POST`
with `{}` got 422 from the route contract, answered before the action ran,
so the result does not rest on how `actingAs` resolves the user. Without
`Accept: application/json` both statuses were the same, and a guest `POST`
with `{}` got 422 as well.

- `codegen` ran first: without `.guren/pages.gen.ts` the controller does not
  import. Every `plan:verify` command list opens with it too.
- No database was reachable. The run left `database` out of
  `createApp({ config })` and used the `cookie` session driver. A response
  given with no connection cannot depend on the missing table, so both
  passes hold for a database migrated up to the blog's own migrations.
- `forbidden` was not run. A policy's `create` guard,
  `authorize('create', Note)`, reads no record; `update` and `delete` need
  one, as §5 predicts.

*Probes before the headless producer* (D1). None needs shipped code; a script
in scratch is enough.

- **Open Question 2, one call or two.** Three requests, the Part 2 fixtures:
  blog comments, scheduled publishing, and the checklists plan for kadai,
  which lives outside the repository. Ten calls each with the exact producer
  flags, `--tools Read,Grep,Glob` included, since restricting tools may
  change how structured output is delivered. Record the result subtype, whether
  `PlanSchema` parses the output again, the §2 failures, `total_cost_usd` and
  the duration. Repeat once with the ops schema. A 400 on the first call
  answers the constrained-decoding question at once.
- **Open Question 10, confinement.** Plant a tracked `.env.sample` holding
  one canary and a gitignored `.env` holding another, make the tracked-files
  checkout, and prompt the producer to quote both, the working tree's `.env`
  by absolute path included. Grep the output for either canary. Repeat asking
  for them through Grep and Glob patterns. Keep `--tools Read,Grep,Glob` on
  every run: on macOS, Linux and WSL the default tool set leaves out Glob and
  Grep, and `--tools` brings back the ones it names
  (https://code.claude.com/docs/en/tools-reference#glob-tool-behavior).
- **Open Question 12, `--resume` under `--bare`.** Run `claude --bare -p …
  --output-format json` and keep its `session_id`, then `claude --bare -p …
  --resume <id> --json-schema …`. Check that the second call succeeds and that
  its `total_cost_usd` includes the first. The pages read say `--resume`
  works in print mode (https://code.claude.com/docs/en/headless#continue-conversations)
  and do not say whether bare mode persists the session.

Identity comes first and status second, before any model is called: they are
what the rest stands on, and both can be tested without one.

## Alternatives Considered

**A Markdown plan (Spec Kit, Kiro, ExecPlans).** The format every other tool
uses, and the source of their two most reported problems: review burden and
unverifiable completion. Markdown cannot be reference-checked, and the model is
more willing to rewrite it.

**Gherkin or EARS as the acceptance syntax.** Gherkin text needs a parser and
step definitions, the glue layer that is the long-standing cost of Cucumber,
and here it would sit between a plan and tests Guren can already generate
from data. As a string inside the JSON it is also beyond the reach of the
schema and of the route-name reference check. EARS sentences are clearer
prose and still prose: nothing can check them, no measurement was found that
they improve model output, and the "shall" template reads badly in a plan
written in Japanese. What each offers is kept: the Given / When / Then shape
as fields, EARS's behaviour classes as `kind`.

**Let the model write the task list.** Every surveyed tool does. Their
projects have no fixed shape, so nothing else could. Guren's dependency order
is the same for every application, and a model-written list adds a second
document that can disagree with the design it came from. The cost is
flexibility, which `hints[]` and `tasks[].acceptance` recover where ordering
and intent are judgment calls. This is the least precedented choice here.

**Agent-maintained status with after-the-fact verification** (Kiro's sync, the
Spec Kit verify extension). Verification that runs second is verification
someone can skip. Deriving status makes the false claim impossible to record.

**The Anthropic API or the Agent SDK instead of `claude -p`.** Either adds a
key to manage and a dependency to the CLI. ~~`claude -p` reuses the login and the
read-only tools the user already has,~~ and the producer boundary keeps the
choice reversible.

**Amended after re-review (2026-09-23):** under `--bare` the producer needs
an API key as the API would (§8 amendment, D2). What is left of the argument
is that `claude -p` adds no dependency to the CLI and brings its read-only
tools.

**Generate code straight from the plan, with no agent.** The scaffold step
does this for ~~what `make:feature` covers~~ the elements whose shape the plan
states in full (amended after re-review, 2026-09-23; see §5). Past that, the
plan's business rules are prose, and generating from prose is the agent's job.

**Parallel slices in worktrees.** Rejected for now on the evidence in Prior
art, and because three to six sequential tasks is what a typical feature
derives to.

**Plans as a permanent specification.** `spec:generate` already regenerates
the description of record from code, with a drift gate. A second one kept by
hand would need its own.

## Migration Path

Purely additive: new commands, new templates, one new harness skill and hook.
`agent:sync` delivers the skill to existing applications. Applications built
without a plan are supported as they are, since the baseline is read from
code and never from an earlier plan.

## Open Questions

1. **Status accuracy.** How often are `present` and `wired` wrong on real
   applications, and what share of planned properties ends up `unknown` or
   `unjudged`? A progress view that is mostly "not checkable" is not worth
   reading. Part 2 exists to answer this; a poor answer reshapes §6 and
   decides whether Parts 3 to 5 happen. **Measured (2026-09-22):** 13% of
   planned properties unknown at completion and no false verdict on the
   finished implementations; the false verdicts found elsewhere and the §6
   rules they call for are in the Part 2 measurements under Phasing.
2. **One call or two.** Is the full schema within what `--json-schema` produces
   reliably, or does generation split into an outline call and per-entity detail
   calls with `--resume`? Decided by the measured rate of
   `error_max_structured_output_retries`.
   **Open, with a probe (2026-09-23):** see the §8 amendment and the Part 3
   probes under Phasing.
3. **Step width.** Five files is a starting guess. The published number
   describes bug fixing in unfamiliar repositories, which this is not.
   **Held (2026-09-23):** five files stays until Part 3 records files touched
   and lines changed per step; the width is retuned from those numbers. They
   are recorded now (Part 3, item 3); the retuning waits for enough plans.
4. ~~**View detail.** Fields, actions and states are in. Should a plan also carry
   layout (a wireframe-level description), or does that belong to prototype
   mode (RFC 0021), with a plan able to request `make:feature --prototype`?~~
   **Resolved (2026-09-23):** plans carry no layout; layout belongs to
   prototype mode. The scaffold emits no pages either (§5 amendment).
5. **Test protection.** `drifted` on a verified test file is detection. Is a
   `PreToolUse` hook that denies the edit outright worth its false positives?
6. **Issue body limits.** The size at which a plan must spill into sub-issues
   has to be measured against GitHub's actual limit, not assumed.
7. **Other stores.** GitLab and Linear fit the adapter. Is either wanted before
   the `github` store has users?
8. **Coverage scan accuracy.** How many real test suites build their request
   paths in a way the static scan cannot read? If most do, the
   characterization rule fires on nothing and needs a runtime source instead
   (route hits recorded by `TestApp` during a test run).
   **Partly answered (2026-09-22):** in this repository's suites every `TestApp`
   request the scan met was readable (46 of 46), and the gap is elsewhere: the
   reference applications test controllers without HTTP, which a runtime recorder
   in `TestApp` would miss too. Suites outside the repository are unmeasured (§2,
   test-coverage scan).
9. ~~**A behaviours view.** Id-tagged test titles are enough to generate
   `docs/spec/behaviours.md` per entity, deterministically, under the existing
   drift gate. In this RFC, or a follow-up once plans have produced such tests?~~
   **Resolved (2026-09-19):** not committed. Every living-documentation tool
   surveyed (Cucumber, Serenity, Reqnroll, Pickles, Concordion, Gauge, Spring
   REST Docs, the rspec and mocha reporters) emits a build report and commits
   nothing; the one committed, CI-gated catalogue found had been dropped
   because a forgotten regeneration reddened every open PR and PRs conflicted
   in a file none of them wrote. No study measures whether a generated view is
   read. What the evidence does support is the id itself: maintained trace
   links help (a 2015 experiment: 24% faster, 50% more correct), and manual
   upkeep is what kills them, which an id in the test title avoids. So the id
   grammar stays, `guren check` enforces it, and behaviours surface where a
   reader exists (§7 amendment). Revisited if a catalogue turns out to be
   opened.
10. **Producer confinement.** §8 relies on deny rules holding for `Read` in
    `--bare` headless mode. That has to be tested, not assumed; if they do not
    hold, the producer needs an OS-level sandbox or a copy of the tree with the
    excluded paths removed.
    **Open, with a probe (2026-09-23):** the producer is to run in a checkout
    of the tracked files at HEAD, the second remedy above. See the §8
    amendment and the Part 3 probes under Phasing.
11. **GitHub approval provenance.** `author_association` plus an unedited
    comment is the strongest signal the issue API offers, and it still trusts
    every collaborator equally. Is that enough, or does the `github` store keep
    `approvals.json` committed and only the tasks on GitHub?
12. **`--resume` under `--bare`.** `--ask` assumes the second call can resume
    the first one's session in scripted mode. If it cannot, the second call is
    a fresh one carrying the questions and answers, at the cost of re-reading.
    **Open, with a probe (2026-09-23):** `--ask` is deferred with the headless
    producer. See the §8 amendment and the Part 3 probes under Phasing.
13. ~~**Editing in the page.** Feedback is comments today. Simple edits (rename a
    column, change a type, drop a route) could be made in the page and
    exported as `ops` directly, with no model call. Worth the template's added
    weight, or is editing `plan.json` by hand enough?~~
    **Resolved (2026-09-23):** no editing in the page. A plan edited by hand
    becomes a revision through the model-free `plan:revise`, which derives its
    ops with `diffPlans()` (§4 amendment).
