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

**Freshness.** `baseline.rev` records where the plan was written and gates
nothing: the implementation's own commits move it on the first step.
`baseline.contextHash` is scoped, a hash per *referenced* element (each
`existing`, `alter`, `rename` and `drop` target, and every name an `add` must
not collide with) of the shape the scanners read at that revision. An
unrelated commit leaves it alone. A change to a referenced element marks that
element stale, re-runs the §2 checks for it, and blocks only the steps that
depend on it.

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

Routes go in their own file because the existing patch mounts a registrar
call and does not insert route lines into `routes/web.ts`.

The migration is not generated here: `db:make` needs drizzle-kit and
`db:migrate` a database, which makes it the `data` step's and `plan:verify`'s
business (§6). What the agent is left with after the scaffold is relationships
on the model, fillable, business rules, and form fields the generated pages
do not have.

An API-only application gets no scaffold step: `make:feature` refuses one
(`assertNotApiOnly`), since it generates Inertia pages. Its slices are
`make:controller` and `make:validator` plus agent steps, and `views` must be
empty in its plans (a §2 check).

A step whose remaining work exceeds a threshold (files touched, elements
covered) is split, pages by screen group first. The threshold starts at five
files and is tuned from the metrics in §7.

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
property is a validator its body merely names is `unjudged`, not `wired`.
Prose (`purpose`, `rules`, a description) is not
a planned property and is not counted as one. Flows, tasks, behaviours and
questions are not judged; a `command` and a `mail` / `notification` class are
`unjudged`, since nothing reads whether one was run or discovers the other.

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
resource, a policy and a side effect have no mount point a static reader can
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
  broader one would turn failed migrations into environment problems.
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
  schema file for a column, the entry routes file for an entry route and every
  routes file of a module for a module's, the page component, a validator's
  file) plus the selected test files, and the environment (`runtime`,
  `platform`, `arch`, `hostname`). A file that cannot be read at verify time is
  recorded as `null`, which never matches. The environment is recorded and
  shown, and not compared: a machine is not a reason to call an element drifted.
- The state file is `.guren/plans/<slug>.state.json` under the application
  root, `<slug>` the plan file's name without `.plan.json` / `.json`, with one
  record per step id and a `.gitignore` written beside it. A record names the
  digest of the plan it ran against, the hash for a plan with a baseline and the
  same computation over a draft; `plan:status` lifts an element only from a
  record of the plan it is reading, and reports the steps of another plan or
  revision as stale. Two plan files of one name share a state file and a step
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
  and per step and the `Stop` hook's continuations; `total_cost_usd`, files
  touched and lines changed are not recorded yet. `--ci` exits 1 when a step
  the run covered did not verify.
- The `.gitignore` written beside the state ignores itself as well, so a
  verify leaves the working tree as clean as it found it, which `plan:next`
  relies on.

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
  `generateEntityContext()` and the freshness skip of §4 are not in it yet:
  nothing stamps `contextHash` so far, so there is no stale element to skip.
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
- The command refuses an element the plan does not declare, one in a section
  `plan:status` does not judge (flows, tasks, behaviours, questions), a
  missing `--reason`, and a draft, which has no hash a waiver could name.
  `--remove` deletes a waiver. Out of scope here: `plan:close`, which is what
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

`guren plan --print-prompt` writes the prompt and the schema to stdout and
calls nothing, for any other agent, and for a Claude Code session already in
progress, where the harness skill has the running agent write the JSON and
call `plan:render` rather than nesting a second `claude`.

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
4. **Part 4**: `plan:next`, the harness skill and `Stop` hook, metrics (§7),
   `plan:waive`, `plan:close`.
5. **Part 5**: the `github` store (§9), `guren check --plan`, the guide.

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
key to manage and a dependency to the CLI. `claude -p` reuses the login and the
read-only tools the user already has, and the producer boundary keeps the
choice reversible.

**Generate code straight from the plan, with no agent.** The scaffold step
does this for what `make:feature` covers. Past that, the plan's business rules
are prose, and generating from prose is the agent's job.

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
   decides whether Parts 3 to 5 happen.
2. **One call or two.** Is the full schema within what `--json-schema` produces
   reliably, or does generation split into an outline call and per-entity detail
   calls with `--resume`? Decided by the measured rate of
   `error_max_structured_output_retries`.
3. **Step width.** Five files is a starting guess. The published number
   describes bug fixing in unfamiliar repositories, which this is not.
4. **View detail.** Fields, actions and states are in. Should a plan also carry
   layout (a wireframe-level description), or does that belong to prototype
   mode (RFC 0021), with a plan able to request `make:feature --prototype`?
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
11. **GitHub approval provenance.** `author_association` plus an unedited
    comment is the strongest signal the issue API offers, and it still trusts
    every collaborator equally. Is that enough, or does the `github` store keep
    `approvals.json` committed and only the tasks on GitHub?
12. **`--resume` under `--bare`.** `--ask` assumes the second call can resume
    the first one's session in scripted mode. If it cannot, the second call is
    a fresh one carrying the questions and answers, at the cost of re-reading.
13. **Editing in the page.** Feedback is comments today. Simple edits (rename a
    column, change a type, drop a route) could be made in the page and
    exported as `ops` directly, with no model call. Worth the template's added
    weight, or is editing `plan.json` by hand enough?
