# RFC: Implementation Plans (`guren plan`)

**Author:** Urata Daiki (@7nohe)
**Date:** 2026-09-19
**Status:** Draft

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
  openQuestions: string[]        // what it could not decide
  baseline: { rev: string; contextHash: string }   // filled by Guren, never by the model
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

A first build is the case where nothing is `existing`. There is no separate
greenfield mode: the plan is always a delta against the code at `baseline.rev`.

The sections, in the terms of a conventional design document:

| Section | Fields |
|---|---|
| Model | table, columns (name, type, nullable, default, unique, index), foreign keys, relationships, fillable, and for `alter` / `rename` / `drop` on a table with rows: `dataMigration` (required) |
| View | page id, purpose, `Props`, form fields (each naming a validator field, never restating its rules), actions a user can take and the route each one calls, empty / error / loading states |
| Controller | class, action, params, query, body (a validator id), authorization (middleware, policy ability), response (Inertia page id, redirect, or resource id), business rules as prose |
| Routing | method, path, name, action id, middleware, `bind`, agent exposure |
| Validator | one definition per payload; views and controllers reference it by id |
| Resource / Policy | output shape; abilities and who holds them |
| Task intent | entity or story, `acceptance[]` (below), element ids it covers |

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

Every section is optional. A plan that adds one column and one form field is
four elements long, and `guren plan` may answer "this needs no plan" with a
one-line reason instead of a document (the docs' one-sentence-diff rule).

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
- `dataMigration` missing where a column becomes `NOT NULL` without a default,
  and a `drop` + `add` pair on one table that reads as a rename;
- an `alter` on a controller action with no acceptance behaviour naming its
  route, since nothing else can judge a change that alters no shape;
- an added or altered route with a validator and no `validation` behaviour,
  with authentication and no `unauthenticated` behaviour, or with a policy and
  no `forbidden` behaviour.

**Existing tests are read as the baseline.** A static scan of the test files
collects which routes they exercise (`app.get('/posts')`, `app.post(...)` on a
`TestApp`, matched against the route graph). The result feeds Impact, and one
rule: a plan that alters or drops a route no existing test reaches gets a
*characterization* step inserted before the change, whose tests pin the
current behaviour and must pass before anything is edited. A path assembled at
runtime is reported as unreadable, never as uncovered.

**Impact** is computed, never written by the model: for every non-`add`
element, the existing routes, pages, tests, `.agent()` tools and `ApiRoutes`
entries that reference it (`referencedBy`, the route graph, `deriveAgentTools()`).
Dropping a column, changing a type, renaming a route and altering a published
agent tool are flagged as breaking.

Failures do not block rendering. They appear in the page beside the element
they concern, and `guren plan:approve` refuses while any remain.

### 3. The rendered plan

`guren plan:render <plan>` writes one HTML file: a fixed template under
`packages/cli/templates/plan/`, with the plan, the check results and (later)
the status inlined as `<script type="application/json">`. No network, no build
step, opens from disk. The serialization escapes `</script` and `<!--`; the
template renders every string as text, never as HTML.

- Tabs per section, a filter per entity, and a "changes only" toggle that
  hides `existing` elements.
- Every id is a link: route → action → validator → page → model and back.
- The ER diagram is drawn from the plan merged over the current schema, reusing
  the generator in `spec-er.ts`. Existing tables are muted; added and altered
  ones carry a badge; clicking a table opens its columns.
- Breaking changes and failed checks are pinned to the top.
- Each element has an approve toggle and a comment box. "Export feedback"
  downloads `feedback.json` (`{ elementId, verdict, comment }[]`), which
  `guren plan --revise` takes as input. The page never writes to the project.

### 4. Approval and revisions

`guren plan:approve <plan>` records `{ hash, approvedAt, approvedBy }` where
`hash` is the SHA-256 of the canonicalized plan. An approved plan is immutable:
every later command recomputes the hash and refuses a plan that no longer
matches.

Changing an approved plan produces a revision:

```bash
bunx guren plan --revise comments --feedback feedback.json
```

The revision is stored as a delta against the approved plan (elements ADDED,
MODIFIED, REMOVED), the page shows only that delta, and only the delta is
approved. A decision taken during implementation that contradicts the plan is
recorded the same way, with a required `reason`; it is never a silent edit.

### 5. Tasks are derived, not written

The model supplies `tasks[]`: what each slice must achieve, and its acceptance
behaviours. Guren supplies the breakdown and the order, in
`packages/cli/src/plan/tasks.ts`:

1. **Foundation**: `commands`, and anything several entities share.
2. **One task per entity**, a vertical slice, ordered by foreign keys
   (`comments` after `posts`). Steps inside a slice are fixed:

   | Step | Work | Verify |
   |---|---|---|
   | scaffold | deterministic, no model (see below) | `typecheck` |
   | tests | skeletons generated from `acceptance[]` (no model); the agent fills `given` setup and what `expect` cannot express | every generated test runs and fails |
   | data | schema delta, migration, model | `db:migrate`, `typecheck` |
   | http | validator, resource, policy, controller, routes | `guren check`, codegen, the slice's tests |
   | pages | page components | `typecheck`, `guren check` |

3. **Cross-entity tasks** (a dashboard) depend on every slice they read.

The same plan always yields the same tasks. `hints[]` may reorder tasks that
the dependency graph leaves unordered, and nothing else.

**Scaffolding is step one, and it is not the agent's.** For an `add` entity,
Guren computes the `make:feature` arguments from the plan (`--fields`,
`--policy`, `--attach`, `--test`, `--module`) and runs it. One slice is around
ten files, which is past the width at which agent success rates fall; after
the scaffold, what is left for the agent is the difference between generated
code and the plan: relationships, business rules, non-default form fields.
A step whose remaining work exceeds a threshold (files touched, elements
covered) is split, pages by screen group first. The threshold starts at five
files and is tuned from the metrics in §7.

**Test skeletons are generated the same way.** Each acceptance behaviour
becomes one `TestApp` test whose title starts with its id
(`test('[AC-comments-3] a signed-in author can delete their own comment')`),
with the actor, the request and the `expect` assertions written out. A
generated test must fail before the implementation exists, must still call the
route its behaviour names (checked statically), and may not be edited once its
step is verified without turning `drifted`. Those three together are what
keeps a test an agent touched from being one that cannot fail.

For `alter` / `rename` / `drop` there is no scaffold. Those steps are agent
edits, and the narrow step width matters most there.

**Writes are single-threaded.** No parallel implementation in this RFC:
`db/schema.ts`, the route registrar and migration numbering are shared by
every slice, and separate worktrees only move the conflict to the merge.

### 6. Status is derived from the code

`guren plan:status <plan>` computes one state per element. The agent cannot set
any of them.

| State | Meaning | Read from |
|---|---|---|
| `planned` | not in the code | |
| `present` | exists with the planned shape (for `drop`: is absent) | `schema-parser.ts`, `model-parser.ts`, registered route definitions, `classActionMembers`, `inertia-pages.ts`, discovery |
| `wired` | reachable: route mounted from a registrar, page returned by an action, validator referenced by a route or action | `routes-check.ts`, `route-registrar.ts`, controller body scan |
| `verified` | its step's verify commands exited 0 at the current tree | the recorded run in state |
| `drifted` | exists and differs (column type, route method, missing prop), or a test file changed after its step was verified | same scanners |
| `unjudged` | no static signal exists | |

Acceptance behaviours have a status of their own. `plan:status` runs the
slice's tests with `bun test --reporter=junit`, reads the ids out of the test
titles, and reports each behaviour as `pending` (no test carries its id),
`failing` or `passing`. An element is `verified` when its step's verify
commands pass *and* every behaviour naming it is `passing`; the page shows the
behaviours under the element they cover.

`unjudged` is the honest case: a change to the business rules of an existing
action alters no shape. Such an element goes from `planned` to `verified` on
its acceptance behaviours alone, which is why §2 refuses an action `alter`
that has none. What stays `unjudged` after that is what `TestApp` cannot
reach: client-side state, conditional rendering inside a page. `assertInertia`
sees the props a page was given and nothing past them, and this RFC does not
extend to browser tests.

Shape comparison for a column is type, nullability, default and uniqueness as
`schema-parser.ts` reads them; for a route, method, joined path, name and
action; for a page, the `Props` keys. Anything the scanners cannot read (a
spread in the schema aggregate, a computed route path) is reported as
unreadable, never as `present`.

A step is complete when every element it covers is at least `wired` and its
verify commands pass. A task is complete when its steps are. Existing tests
may be edited only where the plan lists them under Impact.

**State** lives in `.guren/plans/<slug>.state.json`, git-ignored and written
only by `plan:status`: verify results keyed by tree hash, the decision log, and
per-step metrics. It is a cache. Deleting it loses the metrics and nothing else.

### 7. The implementation loop

```bash
bunx guren plan:next comments --json
```

returns the next step whose dependencies are complete, with exactly the context
it needs: the elements it covers, the confirmed shape of what it depends on
(`generateEntityContext()`), the acceptance behaviours, and the verify
commands. It never returns the whole plan. It refuses when the working tree is
dirty or when `baseline` no longer matches (the application moved since
approval): then `plan:status` re-runs the reference checks and names what went
stale.

One step is one agent session and one commit. The hand-off between sessions is
the code, the git history and the decision log, so a session that dies
mid-task costs one step.

The harness template gains a `plan-implement` skill that loops
`plan:next` → implement → `plan:status`, and a `Stop` hook that runs
`guren plan:status --step <id> --ci` and exits 2 while the step is incomplete.
The hook honours `stop_hook_active`. `PostToolUse` is not used for this: it
cannot block.

On completing a task, the skill starts a reviewer in a separate context, given
only the task's plan elements and its diff. Its findings are advisory: a
reviewer asked for gaps reports some whether or not they exist.

`plan:status` appends to state, per step: `total_cost_usd` and duration where a
producer reported them, stop-hook continuations, files touched, lines changed.
The split threshold in §5 is set from these numbers, not from the literature.

`guren plan:close <plan>` requires every element `verified` or an explicit
waiver with a reason, offers `make:adr` for each recorded deviation, archives
the plan, and leaves `spec:generate` as the description of record. A plan is a
proposal with an end, not a second specification to keep in sync.

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

`guren plan --print-prompt` writes the prompt and the schema to stdout and
calls nothing, for any other agent, and for a Claude Code session already in
progress, where the harness skill has the running agent write the JSON and
call `plan:render` rather than nesting a second `claude`.

Like `ai:eval`, `guren plan` is opt-in, costs money, and is never part of
`check` or `gate`. `guren check --plan` is advisory: it reports approved plans
with `drifted` elements and two open plans that touch the same element.

### 9. Stores

Where the approved plan, its revisions and the decision log live is an adapter.

**`file`** (default): `docs/plans/<slug>/plan.json` plus `revisions/`,
committed. One file per plan; tasks are never files, since they are derived.

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
- An issue body is editable by anyone with write access, so it is untrusted
  input: only JSON that passes the schema *and* matches the approved hash is a
  plan, and comment text is never passed to an agent. Approval caches the plan
  at `.guren/plans/<issue>.json` so the loop does not depend on the API.

The rendered HTML is never committed under either store.

### Package boundaries

Everything lives in `@guren/cli` (`src/plan/`, `templates/plan/`, the harness
skill and hook). No runtime package changes. `zod` 4 is already a CLI
dependency. `claude` and `gh` are optional external binaries: their absence is
a clear error on the one command that needs them, and `plan:render`,
`plan:status` and `plan:next` need neither.

### Phasing

1. **Part 1**: schema (§1), reference checks (§2), `plan:render` (§3),
   proven against a hand-written plan for `examples/blog`. No model involved.
2. **Part 2**: `plan:status` (§6) and task derivation (§5), measured for false
   `present` / `wired` verdicts on the blog and on a plan for a dogfood app.
3. **Part 3**: the `claude -p` producer and `--print-prompt` (§8),
   `plan:approve` and revisions (§4), the scaffold step.
4. **Part 4**: `plan:next`, the harness skill and `Stop` hook, metrics (§7),
   `plan:close`.
5. **Part 5**: the `github` store (§9), `guren check --plan`, the guide.

Part 2 precedes the producer on purpose: status derivation is the claim this
design rests on, and it can be tested before a model is ever called.

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
   applications, and is `unjudged` rare enough for the progress view to be
   worth reading? Part 2 exists to answer this; a poor answer reshapes §6.
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
9. **A behaviours view.** Id-tagged test titles are enough to generate
   `docs/spec/behaviours.md` per entity, deterministically, under the existing
   drift gate. In this RFC, or a follow-up once plans have produced such tests?
