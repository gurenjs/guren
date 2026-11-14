# RFC: The Factory Line: Stage Records, Review Lanes and the Learning Loop

**Author:** Guren contributors
**Date:** 2026-11-13
**Status:** Draft

## Problem

A software factory is a line: work enters, passes through stages, ships, and
what goes wrong in production comes back as new work. Guren covers the middle
of that line well and leaves both ends, and every hand-off, to chance.

| Stage | What Guren has | What is missing |
| --- | --- | --- |
| Intake | `issues:` links and the `github-projects` skill (RFC 0018) | No issue or PR templates, no rule for which work needs a plan, no path from production or maintenance into the ledger; the headless plan producer is deferred (RFC 0030, D1) |
| Plan | `plan`, `plan:render`, `plan:approve`, `plan:revise` (RFC 0030) | Approval does not say what it delegates: which parts of the implementation will still stop for a person |
| Implement | `plan:next`, `plan:scaffold`, the harness, the Stop hook | Only the planned-feature path has a procedure; a bug fix has none. Everything assumes a local session with hooks |
| Verify | `guren gate`, `plan:verify`, `browser:record` (RFC 0033) | Results live under the git-ignored `.guren/`; the scaffolded CI runs `guren gate --deps` and nothing else |
| Review | The `code-review` agent, with rounds and a cap | Advisory prose, Claude Code only, the same depth for every change |
| Merge | Nothing | No required check, no code owners, no rule for which change needs a person |
| Release | `guren deploy`, the Workers, Lambda and Vercel builds, the destructive-migration guard (RFC 0034) | No record of what was released from which change; no check after deploy |
| Operate | `ExceptionHandler.report()`, health checks, `tool:log` | `runtime:errors` is development-only by design (RFC 0032); nothing turns a production failure into work |
| Maintain | `audit --deps-baseline` (RFC 0039), `doctor --fix`, `agent:sync` | Nothing schedules them or files what they find |
| Learn | Waivers in `decisions.json`, ADRs | Review findings, declined findings and stalls are discarded; no place for a lesson, no route from a lesson to a check |

Four gaps run across the stages.

1. **No stage hands its result to the next.** `plan:verify` writes
   `.guren/plans/<slug>.state.json`, which is git-ignored on purpose: a
   committed "verified" is a claim nobody on a fresh clone has checked. The
   consequence is that a pull request carries no evidence at all, and the
   reviewer, the merge and the deploy each start from nothing.
2. **Human decisions are not placed.** `plan:approve`, `plan:waive` and
   `plan:close` are a person's call. Everything after the plan is undefined, so
   a team either reads every diff (the bottleneck this framework exists to
   remove) or reads none.
3. **The line runs only where hooks run.** A cloud agent with no Stop hook
   never runs the gate, and the dev MCP endpoint is loopback-only (RFC 0008
   documents that and stops). For those agents CI is the only gate, and CI
   knows less than the local session did: the Stop hook sends an audit warning
   on a changed file back to the agent, while the gate passes with it.
4. **Nothing learned is kept.** The reviewer's findings, the reasons a finding
   was declined, and every stall are gone when the session ends.
5. **A person has no one place to look.** Plans are in the Dev Center, stalls
   and every decision command in a terminal, the gate in CI, review on the
   pull request, and the rest in issues. Following the line means watching
   all five, and work a cloud agent did shows up in none of the local ones.

### Verified landscape (2026-11)

Read from the vendors' own pages unless marked.

| Source | What it does | What Guren takes |
| --- | --- | --- |
| Anthropic, "How the Claude Code team does code review" | Three risk tiers; a low-risk change needs no human once automated review and security checks are green. A classifier sets the tier, a second one may ask for a person, and paths the owners listed plus every CI workflow always need one. Merge queue, flags, staged release, rollback. Every incident becomes a reviewer eval case; three-round cap | The tiers, the always-human paths, revert rate as the guardrail |
| Cursor, PR Routing & Approval and Bugbot | A risk score with a maximum the agent may approve; routing from `.cursor/approval-policies/ROUTING.md`. Bugbot turns reactions and replies into candidate rules, promotes them on signal, retires them on negative feedback | Policy as files in the repository; lessons with a lifecycle |
| pstack (`cursor/plugins`) | One playbook per kind of work (bug fix reproduces first, shipping verifies each PR with a fresh agent), a per-app verification skill, `/reflect` whose proposals a person accepts, and the principle "encode lessons in structure": a lint, a flag, a runtime check or a script before more prose | A procedure per kind of change; structure before prose |
| Factory, Agent Readiness and Missions | Five readiness levels over nine pillars (style, build, testing, documentation, environment, observability, security, task discovery, experimentation); Missions want level four. A mission is a plan a person approves, then milestones validated as they complete | A readiness report, keyed by stage here |
| OpenAI, "Harness engineering" (read through Böckeler's memo; the original returned 403) | Architecture enforced by custom linters and structural tests, the repository as the knowledge base, periodic agents against drift, an agent's struggle fed back into the repository | Scheduled sweeps; the lesson loop |
| StrongDM (read through Simon Willison) | No human writes or reads code; scenarios are kept outside the codebase as a holdout | The evaluator must not be the implementer (Open Question 9) |

Two points decide the shape of this RFC. First, the review model and the
approval bot are platform products now, so Guren should not build either.
Second, both vendors set the tier with a model and keep only a path list as the
deterministic floor. Guren knows what a change means (a route lost its policy,
a migration drops a column, a sensitive column reaches a response), so it can
supply a much stronger floor than a path list.

### Existing implementation to reuse

| Capability | Source | Use here |
| --- | --- | --- |
| Git plumbing | `changed-files.ts` (`runGit`, `runGitRaw`) | Under the new change boundary (§3). `getChangedFilesFromBase()` is not reused: it takes no base, guesses among four branch names, and with no merge base returns only uncommitted files |
| Application Graph | RFC 0032, `application-graph.ts`: `route`, `controller`, `model`, `page`, `middleware`, `validator`, `policy`, `test` nodes; `handles`, `binds`, `renders`, `usesMiddleware`, `validates`, `authorizes`, `tests` edges | The input to per-route security records (§3). `authorizes` and body `validates` edges start at the controller with the action in their evidence, so no fact is read off raw edges |
| Destructive migrations | `@guren/orm/internal/migration-guard` (`judgeMigrations`) | The `migration-destructive` fact |
| Audit findings | `audit.ts`, `audit-taxonomy.ts` (`escalatesOnChange`), `data-exposure-audit.ts`, `csrf-exemption-audit.ts` | Security facts. `escalatesOnChange()` selects warnings for the Stop hook and never fails the gate, so the lane has to count them itself |
| Advisory keys | `audit --deps-baseline` (RFC 0039 §5) | The `dependency-advisory` fact |
| Plan targets, approval standing, open plans | `plan/app-targets.ts`, `plan-approve.ts` (`readPlanApprovalStanding`), `plan/open-plan.ts` | The identities a declaration matcher starts from (§3) |
| Plan verification | `plan/verify.ts` (`PlanVerifier`, which accepts the records a run starts from), `plan/state.ts`, `plan/verification.ts` (`behaviourShape`, `carriedRedRuns`) | The plan half of the evidence; where reproduced red runs enter (§4) |
| Acceptance ids in tests, requests per test case | `docs-acceptance.ts`, `test-requests.ts` | Acceptance tests removed or emptied |
| Browser run and spec report | `browser-record.ts` (`browserRunSchema`), the run's `spec-report.json` | The browser half of the evidence. A run has steps and no result of its own, and `browser:record` does not read the spec report, so §4 defines the aggregate |
| Gate report | `gate.ts` (`GateReport`) | The gate half of the evidence |
| Marker blocks | `marker-blocks.ts` | Generated sections inside author-owned files |
| Linked docs per entity | `entity-context.ts`, `docs-index.ts` | Where a lesson reaches the next agent. The bundle prints each linked document's path, title and status, not its body (§11) |
| Harness targets | `agent-targets.ts` (RFC 0008) | One review contract rendered for every agent |
| Dev Center | `dev-center.ts` and its pages (RFC 0032): the plan page's attention model (`who: 'person'`, a title, the decision), `dev-center-readiness.ts` (a decision dry-run as a child process), `dev-center-evidence.ts` (verify records and browser screenshots beside each step), one write (saved review feedback) | The person's one surface (§12) |

## Proposed Solution

### 1. Principles and scope

- **One human decision per change, placed at the plan.** A person approves
  what will be built and how it will be judged. After that a person is asked
  only when a fact about the change says so.
- **A person looks in one place.** Every decision the line waits on is listed
  in the Dev Center, with what to read and the decision to make. What is not
  listed there needs no person (§12).
- **Every stage leaves a record the next stage can re-check.** A record is
  either committed (a plan, an approval, a lesson) or recomputed from a fresh
  clone in CI (the evidence). Nothing local is trusted.
- **Guren supplies facts and a floor.** A reviewer model or a platform's risk
  score may raise the lane a change is in. Nothing lowers it below the floor.
- **Unreadable is never low.** A reader that could not read raises the floor,
  as it does in `check`, `audit` and `plan:status`.
- **Report before enforce.** The first deliverable reports and records. No
  change merges without a person on the strength of this RFC until the
  enforcement specification of §8 exists and the shadow data supports it.
- **Platforms run the agents, the reviews, the merge and the deploy.** Guren
  owns what they cannot know: the application's meaning.

Out of scope, each named as a follow-up in §14: provisioning a cloud
environment for agents, feature flags, a production error reporter, and the
headless plan producer.

### 2. The line

The unit that moves through the line is a change: the commits between a base
and a head, both named by SHA. Each stage has one record and one owner of the
decision.

| Stage | Record | Decided by | Added by this RFC |
| --- | --- | --- | --- |
| Intake | The issue (RFC 0018) | A person, or a sweep (§10) | Templates; what needs a plan (§6) |
| Plan | `plan.json`, `approvals.json` | A person | The delegation forecast (§5) |
| Implement | One commit per step | The agent | A procedure for a fix (§6) |
| Verify | The evidence, recomputed in CI | The CLI | `change:evidence` (§4) |
| Review | Findings on the pull request | A reviewer model, advisory | Review inputs (§7) |
| Merge | The lane in the change record | The floor, then a person where it says so | Facts and the floor (§3); enforcement specified separately (§8) |
| Release | The release record | A person or the pipeline | Migration impact, post-deploy check (§9) |
| Operate | An issue | A person | The escaped-defect record (§9) |
| Maintain | An issue per finding class | A sweep files, a person triages | The sweep template (§10) |
| Learn | `docs/lessons/` | A person accepts each lesson | `make:lesson`, `change:stats` (§11) |

**Each record names the one before it.** A plan names its issue; an approval
names the plan hash; a change record names its base and head and the hash of
every plan it touches; a release record names the merge commit and the change
record; a defect issue names the release and, once known, the commit. With
those links an incident can be walked back to the evidence that let the change
through, which is what the learning loop needs.

**Closing a plan is its own change.** `plan:close` takes the plan out of the
open plans, and delegation (§5) reads open plans only. So the plan is closed
after its last implementation change merged, in a change that touches only
plan records, which a person reads.

**What the evidence needs from an environment.** Bun, an install from the
lockfile, `codegen`, an application key in the environment (without one the
application does not boot and every test fails), a database the application's
test configuration reaches, and the Playwright browsers when the application
has browser tests. That is
the whole requirement on CI or on a cloud agent's sandbox. Providing it is the
platform's (§14).

### 3. Change facts and the lane floor

`guren change:lane --base <sha> --head <sha> [--json]` reads the change and
prints the facts it found and the floor they set. It calls no model and writes
nothing.

**The change boundary.** A new `resolveChange(cwd, base, head)` is the one
reading of what a change is. Both SHAs are required and must exist in the
clone; the merge base is computed from them; an absent history is a refusal,
never an empty change. It returns each path with its status (added, modified,
deleted, renamed with its old path), since a deletion and a rename are facts of
their own. The base and head it resolved are written into every record.

```typescript
export type Lane = 'low' | 'medium' | 'high'

export interface ChangeFact {
  code: string                 // 'migration-destructive'
  lane: Lane                   // the floor this fact sets
  target?: string              // a route name, a table, a model, a path
  files: string[]
  evidence: 'registered' | 'static' | 'path'
  declaredBy?: string          // the plan element whose declaration matched
  message: string
}

export interface ChangeLaneReport {
  schemaVersion: 1
  base: string
  mergeBase: string
  head: string
  floor: Lane
  facts: ChangeFact[]
  /** Readers that could not read; each sets the floor to at least medium. */
  unjudged: { reader: string; reason: string; lane: Lane }[]
  plans: { file: string; hash: string; standing: string }[]
}
```

Every changed path ends in at least one fact. The floor is the highest lane
among them.

**Always high.** No plan lowers these.

| Fact | Read from |
| --- | --- |
| `gate-input` | What the gate itself runs. The gate's stages are the app's own scripts, so this is `package.json` scripts, every file a script names, `scripts/`, `bin/`, `.oxlintrc.json`, `tsconfig.json`, `guren.arch.ts`, `guren.review.ts`, `.github/**`, the harness hooks and settings, `playwright.browser.config.ts` and, under RFC 0033 §13, `e2e.browser.config.ts`. A change that rewrites `scripts.test`, or the file it runs, passes the gate it disabled |
| `plan-record` | A plan file, its approvals or its decision log. An approval that arrives with its implementation is a claim, so the plan lands first, in a change a person reads (§5) |
| `migration-destructive` | `judgeMigrations()` on the migrations the change adds, acknowledged findings included; an existing migration edited or deleted |
| `authorization-removed` | Per-route security records, below |
| `validation-removed` | Per-route security records, below |
| `audit-warn-changed` | An audit warning that `escalatesOnChange()` selects (`policy`, `force-write-request-data`) on a file the change touches, and a security toggle set to `false` (`autoCsrf`, `securityHeaders`, `csrf`, `hostAuthorization`) that the base did not have |
| `audit-suppressed` | A `guren-audit-ignore` comment the base did not have |
| `audit-fail` | Any audit failure absent at the base |
| `csrf-exemption` | A new exemption in source, or a new exempting package from `csrf-exemption-audit.ts` |
| `sensitive-exposure` | An `exposure-sensitive-column:*` key absent at the base |
| `policy-removed` | A policy file deleted, or an ability removed from one |
| `acceptance-changed` | A test file carrying an `[AC-…]` id deleted, an id no longer carried, a case that no longer requests its behaviour's route, or any edit to such a file that existed at the base. The readers see a lost id or request, not an assertion relaxed to accept a wrong response, so an edit is read by a person |
| `test-removed` | A test file deleted |
| `dependency-advisory` | A `deps:*` advisory key absent at the base |

**Per-route security records.** `authorization-removed` and
`validation-removed` are not read off graph edges. For each route the reader
builds one record: the route's middleware and `authentication`, the contract
`validates` edges that start at the route, and, through `handles` and the
`controller:<action>` evidence, the validators and policies its action
consults. Records are compared between base and head:

- A route is matched to its base counterpart by controller action first, then
  by method and path, so a rename or a move does not turn a removal into an
  unrelated addition. A plan that declares the rename declares nothing about
  its security.
- A head record weaker than its counterpart is the fact. A new mutating route
  with no authorization is `audit-warn-changed` already.
- An ambiguous match, and an action whose authorization the graph lists as
  unresolved, are `unjudged` at high: unreadable authorization is not a
  medium question.

**The base is never rebuilt.** Each commit's records are computed while that
commit is the head, in an environment prepared for it. The workflow's run on a
push to the default branch writes them into the record of §4 and uploads it
under the commit's SHA; a pull request's run fetches the record of its merge
base and passes it as `--base-record`. With no base record (the run never
happened, or the artifact expired) these two facts are `unjudged` for any
change that touches a routes file, a controller, a policy or a middleware, and
the report names the fix: run the workflow once on that commit. On this
repository's last 60 merged pull requests every merge base was a commit whose
push run had completed, at most four days before the merge.

**Declarable.** Medium by default. A fact takes the lane in the last column
only when a declaration in an approved, open plan matches it.

| Fact | Read from | Declared |
| --- | --- | --- |
| `route-added`, `route-changed`, `route-removed` | Graph `route` nodes | low |
| `migration` | A migration with nothing destructive | low, when every statement's table and column is one the plan adds |
| `schema-changed` | `parseSchemaTables()` on both sides | low |
| `policy-added` | A new `policy` node | low |
| `policy-changed` | An existing policy file edited | medium |
| `agent-tool` | A route gaining or changing `.agent()` | low |
| `file-added` | A source file the change adds | low, when an `add` element owns the file |
| `dependencies-changed` | `bun.lock` or a manifest's dependency fields | medium |

**What a declaration is.** `listPlanAppTargets()` gives identities, and a
mention is not a permission. A declaration matches a fact only when all of
these hold: the element's `change.kind` is the fact's operation (`add` for an
addition, `alter` or `rename` for a change, `drop` for a removal); the module
is the same; the identity matches before and after (a route by name and
endpoint, a column by table and name); and the property that changed is one
the element plans. An `existing` element declares nothing.

**Edits to existing source stay medium.** A source file that existed at the
base and is not covered above is `source-edited`, medium, whatever plan names
it. The fingerprint of a verified step does not change that: the fingerprint
lists the files whose change expires a verification, shared controllers and
route files among them, and says nothing about which edits in those files were
planned or exercised. So a plan that adds a feature in new files can flow, and
a plan that alters existing code is read by one person.

**Wiring files are judged by what they register.** Every plan measured (see
Measurements) edited the same three files to wire its work in: `db/schema.ts`,
the routes entry and the application entry. An edit there is not
`source-edited`. The schema file is read by `schema-changed`, which needs only
the two versions of the file and ships in deliverable 1. The routes entry is
read by the route facts and the security records, and the application entry by
`registration-changed` (the providers, middleware and options the introspected
application reports, compared with the base record and declarable by the
plan's policies and providers); both need a base record, so they stay medium
until deliverable 4. A line in one of these files that changes nothing it
registers is `source-edited` as anywhere else.

**Accounting for an edit inside a file is not scheduled.** The idea: give each
target a span in its file (a controller action, a policy ability, a validator
export, a model member) and let an edit flow when every changed line lies in
the span of a target a matching `alter` declares. A prototype ran on the
measured histories. Of the 27 existing server files a plan edited, 4 were
fully accounted for (7 when imports are ignored), and 24 of 166 changed lines
fell in a declared span. What the plans left undeclared was not noise: the
starter's dashboard action rewritten (66 lines), environment keys, a model's
types. Those are edits a person should see, or that the plan should have
declared. So an edit to existing source stays medium, and the evidence names
the span each such edit fell in (`outside the plan:
DashboardController.index`). The reading list shows it, and it tells the
plan's author what to declare next time.

**Ambient.** Low: documentation outside `docs/plans/` and `docs/lessons/`,
`lang/` catalogs, added tests that carry no existing id, and generated files a
drift gate already judges (`docs/spec/`, the browser specs `browser:map`
writes). Under RFC 0033 §13 the recordings in `.e2e/cache/` are ambient too:
a recording asserts nothing, the generated spec does, and the evidence replays
both (§4). A file under `docs/lessons/` is
`lesson`, medium: a person reads a rule before the agents follow it.

**Policy file.** `guren.review.ts` is optional and exported through a new
`@guren/cli/review` subpath, the way `guren.arch.ts` uses `@guren/cli/arch`.

```typescript
import { defineReviewPolicy } from '@guren/cli/review'

export default defineReviewPolicy({
  approvals: { low: 0, medium: 1, high: 2 },
  paths: {
    high: ['app/Billing/**', 'config/session.ts'],
    medium: ['config/**'],
  },
  facts: { 'agent-tool': 'high' },      // raise a fact's lane
  review: { check: 'Claude Code Review' }, // the reviewer's check; low needs it to pass (§8)
})
```

A fact may be lowered here too, and every report then prints
`lowered by guren.review.ts` beside it. The policy that applies to a change is
the base's: the file is a `gate-input`, so the change that edits it is high,
and its new content takes effect only once merged.

### 4. Change evidence

`guren change:evidence --base <sha> --head <sha> [-o <dir>]` is what CI runs in
place of the bare gate. It recomputes everything from the checkout and writes
`evidence.json`, a compact `record.json`, and `evidence.md` for the job
summary.

```typescript
export interface ChangeEvidence {
  schemaVersion: 1
  lane: ChangeLaneReport
  gate: GateReport
  plans: PlanEvidence[]
  browser: BrowserEvidence
  migrationImpact: 'none' | 'additive' | 'destructive'
  /** What `low` would need and does not have; empty when nothing is missing. */
  holds: { code: string; lane: Lane; message: string }[]
  ok: boolean
}

export interface PlanEvidence {
  file: string
  hash: string
  standing: 'approved' | 'unapproved' | 'baseline-removed' | 'unreadable'
  steps: { id: string; outcome: 'verified' | 'failed' | 'blocked' | 'incomplete'; staleContext: boolean }[]
  redRuns: { id: string; state: 'reproduced' | 'landed' | 'exempt' | 'unobserved' | 'passed-before'; commit?: string }[]
  /** Elements the overlay did not lift, as `plan:close` would list them. */
  open: { id: string; state: string }[]
}
```

`ok` is false when the gate fails, a plan step fails, a red run is
`passed-before`, or a browser case fails. Everything short of that is a hold.

**What low requires of a plan.** One row short and the change is held at
medium.

| Condition | Otherwise |
| --- | --- |
| Standing is `approved` at the plan's current hash | `unapproved`, `baseline-removed`, `unreadable`: hold |
| Every step the change's commits name is `verified` | `incomplete` or `blocked`: hold. `failed`: `ok` is false |
| No step carries stale context | Hold |
| No element of those steps is left open by the overlay | `waived`: hold (a person granted it, a person reads the result). `accepted`: no hold |
| Every behaviour's red run is `reproduced`, `landed` or `exempt` | `unobserved`: hold. `passed-before`: `ok` is false |
| The state file and decision log read | Hold |

**Red runs.** A fresh clone has no carried red runs, so a `tests:fail` step
cannot pass once the implementation exists. The evidence supplies the
observation per behaviour, by the identity `carriedRedRuns()` uses (the id and
`behaviourShape()`), never by step id, and hands the result to `PlanVerifier`
as the records the run starts from, the input a local run fills from the state
file.

- `exempt`: the behaviour is marked `alreadyHolds`.
- `landed`: a test case titled with the id already requests its route at the
  merge base. Its red run was the business of the change that added it, which
  either reproduced it or was read by a person. No history older than the
  change is ever searched.
- Otherwise the test first appears in this change. The evidence finds the
  first commit of the change where the case exists and requests its route,
  checks that commit out in a temporary worktree, and runs that test file
  there. A case that fails there and passes at the head, in the same runner
  with the same environment, is `reproduced`. The head is the control: a
  missing application key, or a helper importing a model that does not exist
  yet, fails every case just as a missing implementation does, and only the
  head passing tells them apart. A pass at the first commit is
  `passed-before`: the test never proved anything. Measured on one plan of 42
  behaviours, the three earlier commits took about two seconds in all.
- `unobserved`: that first commit also holds the implementation (the change
  was squashed before review), or it cannot be prepared. The worktree is
  prepared from its own lockfile: the head's install is reused when the two
  lockfiles are identical (95% of the step commits measured), and otherwise
  `bun install --frozen-lockfile` runs there. `codegen` runs in the worktree
  either way.

**Browser.** A run has no result of its own, and `browser:record` reads
neither Playwright's report nor its server's errors. The evidence defines the
aggregate:

```typescript
export interface BrowserEvidence {
  configured: boolean
  cases: { passed: number; failed: number; skipped: number; fixme: number }
  /** Features the change touches (by the browser map) with no passing case. */
  uncovered: string[]
}
```

Cases are read from the run's `spec-report.json`. A failed case makes `ok`
false. A feature the change touches that is `uncovered`, because its spec is a
`test.fixme` or the application has no browser configuration at all, is a hold
whenever the change edits a page or a route that renders one.

**Behaviour specs (RFC 0033 §13, proposed).** If that amendment is accepted
and the application has `e2e.browser.config.ts`, the evidence also runs
`test:behaviours:ci` and counts the cases of the runner's `.e2e/report.json`
in the same aggregate. The report is the runner's own document, so its
`schemaVersion` is checked first (`report-1` in the version §13 pins), and one
the CLI does not know is `unjudged`, never read on a guess. A case that does
not pass there is a hold and never makes `ok` false. It shows in three ways:
`REPLAY_STALE`, a recording that no longer replays; `MODEL_PROVIDER_FAILED`,
which in CI means a step with no recording, since by the runner's
documentation such a step runs live even under `--strict-cache` and CI has no
login (the fix is to commit the recording, not to give CI a login); and an
outcome the locators do not find. §13 keeps
behaviour specs out of every gate, and this keeps to it: the change is not
failed, it is read by a person. A stale recording means a page a behaviour
starts on changed and nobody recorded it again. These specs are generated from
the plan and replayed with no model, so they are a check the implementing
session did not write (Open Question 9).

**The record.** `record.json` is what outlives the run: base, head, the
classifier version, the fact codes with their lanes, the floor, the holds,
whether `ok`, and the head's per-route security records (§3). The workflow
uploads it as an artifact named for the head SHA, with the longest retention
the repository allows. It is the base record of later changes, the unit
`change:stats` counts (§11) and the input to the shadow comparison (§8). The
evidence is never committed, and nothing is lost when a record expires: a base
record is recomputed by running the workflow on that commit, and the numbers
are kept elsewhere (§11).

### 5. The plan as the delegation

The plan is where a person decides, so approving it should say what is being
delegated. `planLaneForecast(plan)` applies §3 to the plan's elements before
any code exists, and `plan:render` and `plan:approve` print it:

```
A person will still read the implementation of:
  - model.comment/column.body   drop     always high (migration-destructive)
  - policy.post                 alter    medium (policy-changed)
  - controller.post             alter    medium (edits existing source)
Everything else this plan adds can merge on evidence once enforcement is on.
```

The forecast is a lower bound: the implementation can add facts the plan did
not predict, and those keep their own lane.

**The unit that flows is the step.** Taken as one change, none of the 11 plan
implementations measured would have been low: each edits the wiring files and
the layout, and ten edit existing server code. Taken per step, 49% edit
nothing that existed before the plan and 83% edit nothing but wiring files.
So an implementation arrives as one pull request per step or per task,
stacked where one depends on another, and the person is asked about the few
that need it. Nothing in the lane depends on this: it is what makes the low
lane worth having.

The plan and its approval land in their own change, ahead of the
implementation. That change is high (`plan-record`), so a person reads the
rendered plan there. 
**Approval on the pull request.** At a terminal nothing changes: a person runs
`plan:approve`. For a plan that arrives as a pull request, the agent runs
`plan:approve --propose`, which stamps the baseline and writes the approval
entry with `proposed: true` and no approver. `readPlanApprovalStanding()`
reads that entry as `proposed`, which every gated command refuses as it
refuses `unapproved`, until the commit that introduced the entry is an
ancestor of the default branch on the remote. From then on the standing is
`approved`, and the approver is whoever GitHub records as having approved and
merged that pull request. `docs/plans/` is an owned path, so the pull request
does not merge without an owner, who approves it from the Dev Center (§12).
No workflow writes to the branch and no token is involved. The
`plan-implement` skill's rule becomes: never run `plan:approve`; `--propose`
is the agent's, and it approves nothing. On a repository with no owner rule,
merging the plan is still a person's act, and `factory:status --remote`
reports the missing rule.

### 6. Changes without a plan

Most small changes have no plan. Their source facts are undeclared, so they are
medium: one person reads them. A fix has no plan, so nothing declares its
targets, and this RFC gives it no low lane (Open Question 6).

The harness gains one skill, `fix`, so that a fix has a procedure as a planned
feature does:

1. Reproduce the defect as a failing `TestApp` test, and commit the test alone.
2. Fix it, and commit the fix naming the issue.
3. Run `guren change:evidence` and report the lane and the holds.

What needs a plan is stated once, in the `plan-write` skill and the issue
template: a change that adds or alters a model, a route, a policy or a page.

### 7. Review inputs

Guren ships no reviewer. It gives whichever reviewer the team uses the facts
and the contract.

`guren add review` writes, once:

- `guren.review.ts` (§3).
- `REVIEW.md`, author-owned, with one generated block between
  `<!-- guren:review … -->` markers: the always-high paths, the models with
  sensitive columns, the routes that mutate with their policies, and the
  agent-exposed routes, all read from the graph and the audit. Claude Code
  Review reads this file.
- `.github/workflows/change.yml`, which runs `change:evidence` and reports
  (§8), a pull request template that asks for the issue and the plan, and two
  issue templates (feature, defect).

`guren change:policy` regenerates the block, and `--check` exits 1 on a stale
one, as `browser:map --check` does.

The review contract (what a finding is, the three tags, the round cap) moves
from `targets/claude/agents/code-review.md` to canonical content under
`templates/agent/core/`, rendered per target by `agent-targets.ts`, so a
reviewer on any harness reads the same contract. The contract gains one line
of structured output per finding (tag, class, disposition), which the record
carries when present.

**A review the implementer has to ask for does not happen.** The
`plan-implement` skill tells the session to call the `code-review` agent after
each task. In the 52 implementation runs of the two dogfooding nights the
agent was called in four, and in none of the 11 that went through the plan
loop step by step. So the review does not rest on the session: it runs on the
pull request, by the platform's reviewer, and the lane job reads its result
(§8).

For the Cursor target the same block is written to the root
`.cursor/BUGBOT.md`, which Bugbot always includes (a rule is cut at 30,000
characters, and the block is capped well under that), and one instruction is
written to a root `APPROVAL_POLICY.md`, the exact file name PR Routing &
Approval discovers: approve nothing whose `guren/lane` floor is above low.
Cursor reads a policy the pull request changed from the base branch, the rule
§3 applies to `guren.review.ts`. `.cursor/approval-policies/ROUTING.md` is
left to the team: its entries name products and owners Guren does not know.

### 8. Merge

This RFC ships the report and specifies what enforcement has to prove. It does
not ship enforcement.

**Report.** The scaffolded workflow runs on every pull request, never fails on
the lane, and prints what each lane would have required.

```yaml
on:
  pull_request:

jobs:
  change:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx guren change:evidence --base "$BASE" --head "$HEAD" -o .guren/change
        env:
          BASE: ${{ github.event.pull_request.base.sha }}
          HEAD: ${{ github.event.pull_request.head.sha }}
      - run: cat .guren/change/evidence.md >> "$GITHUB_STEP_SUMMARY"
      - uses: actions/upload-artifact@v4
        with: { name: change-record, path: .guren/change/record.json, retention-days: 90 }
```

The job fails only when `ok` is false, which is what the gate step does today.

**Shadow.** During the report period a team compares, per pull request, the
floor with what its reviewers did: approvals given, changes requested, and
later reverts. `change:stats --remote` reads the records and the reviews
through `gh` and prints the comparison, and whether the default bar is met:
at least 50 pull requests over at least four weeks; among those the floor
called low, no revert and no "changes requested" for a defect; and at least
95% agreement overall. The bar is the team's to change, and the numbers it is
judged from are printed with it.

**Enforcement.** A required check that the pull request itself can edit,
computed by code the pull request supplies, is not a boundary. GitHub's
documentation (read 2026-11) gives the pieces for one that is.

| Piece | What GitHub documents | Use |
| --- | --- | --- |
| A trusted place to run | `pull_request_target` runs in the context of the default branch, where `pull_request` and `pull_request_review` run the merge commit's own workflow file | The lane job. It never checks out or runs the change |
| A native floor on paths | "Require review from code owners": a pull request that modifies owned content must be approved by an owner. On organization repositories the ruleset's required-reviewers rule does the same per team and file pattern (public preview) | The `gate-input` paths, `docs/plans/` and `docs/lessons/`, enforced outside anything the change computes |
| No approval by default | A pull request rule "doesn't necessarily have to be approved", and zero required approvals is a documented configuration | Low changes |
| An organization-level workflow | Ruleset workflows, at organization or enterprise level, on Enterprise Cloud and Server | Replaces the `pull_request_target` job where available |
| A merge queue | Public repositories owned by an organization, and private ones on Enterprise Cloud; workflows need the `merge_group` trigger | Optional. Without it, the rule that a branch be up to date before merging |

The lane job does four things, none of which runs the change: it recomputes
the path facts from the pull request's file list, reads `guren.review.ts` at
the base, reads the record the evidence run uploaded (as data), and counts
approvals from the reviews API. It then sets the `guren/lane` status on the
head SHA, which is the required check. A change that rewrote its own evidence
still cannot hide a `gate-input` path and cannot count itself approved.

Low also needs a review. `guren.review.ts` names the check the team's reviewer
reports (`review: { check: 'Claude Code Review' }`), and the lane job requires
it to have passed on the head SHA. With none named, low is not available, and
the report says that this is why (**decided 2026-11-14** by the maintainer).

- **What an approval is.** Bound to the head SHA, from a distinct person who
  is not the author; dismissed and stale approvals and a standing "changes
  requested" handled. A reviewer model's approval is never counted.
- **When a review arrives.** A review event runs the pull request's own
  workflow file, so it is used only as a signal: a `workflow_run` on its
  completion runs the lane job from the default branch. A change that removes
  the signal leaves the status unrefreshed and the merge blocked.
- **Refusal.** Approval data that cannot be read refuses the merge. It is
  never zero and never a previous success.

A `workflow_run` is documented to run on the default branch's last commit with
a write token "even if the previous workflow was not" privileged, which covers
a pull request from a fork.

**Tried on a repository (2026-11-14).** A ruleset on the default branch
requiring a pull request, zero approvals and code owner review:

| Pull request | Result |
| --- | --- |
| Touches no owned path | Mergeable with no approval |
| Touches an owned path, opened by `github-actions` | Blocked: "Waiting on code owner review from" the owner. Mergeable once the owner approved |
| Touches an owned path, opened by the owner | Mergeable with no approval |

So the native floor works with zero required approvals, and it holds only
against an author who does not own the path. An agent that opens pull requests
under the owner's account, as a local session or a cloud session signed in as
the owner does, is not held by it. Two consequences. Where the native floor is
wanted, the agents open pull requests under an identity of their own (an app
or a bot account), and `factory:status --remote` reports `partial` at merge
when agent-authored pull requests carry an owner's login. Where that cannot be
arranged, the `guren/lane` status is the only gate, which is why it is
computed outside the change. A ruleset on a private repository needs a paid
plan: on a free one the API answers 403 until the repository is public.

Until deliverable 5 ships, the lane is information for the person who merges.

### 9. Release and operate

- **Migration impact.** The evidence says `none`, `additive` or `destructive`
  for the migrations in the change. It is not a statement about rollback: a
  release with no migration can still write data the previous version cannot
  read, and an additive migration can break it too.
- **Release record.** A deploy workflow writes one small record: the merge
  commit, the change records it contains, the environment, the migrations
  applied, and the post-deploy result. The first three exist at deploy time;
  the template collects them. Containment is the platform's rollback to the
  previous artifact, and the record's migration impact says when that alone
  is not enough.
- **After deploy.** `browser:doctor --url <origin>` already checks each
  feature's landmark against the graph. In production the runtime-error
  collector is absent by design, so the window is `unavailable` and the run
  cannot pass. `--landmarks-only` judges the landmarks alone and says so in
  the report.
- **Escaped defects.** A defect that reached production is recorded where the
  ledger is: an issue from the defect template, naming the release and, once
  known, the commit that introduced it. A reporter that files the issue from
  `ExceptionHandler.report()` is a follow-up (§14).

### 10. Maintenance sweeps

A scheduled workflow template runs the commands that report without writing
(`audit --deps-baseline`, `agent:sync --dry-run`, `check --docs`,
`check --spec`, `change:policy --check`, `factory:status`) and opens or
updates one issue per finding class. The sweep files work and does none: the
issue enters the line at intake like any other.

### 11. Lessons

A lesson is a short committed document with a one-line rule.

```markdown
---
type: lesson
status: stable
rule: Load a comment through its post, never by id alone.
entities: [Comment]
paths: []
source: { pr: 412, commit: 4501ef4, kind: review-finding }
enforcedBy: guren.arch.ts#controllers-no-drizzle
review: 2027-05-01
---

# Load a comment through its post

`Comment.find(id)` skips the post's policy. …
```

- `guren make:lesson "<title>" --entity Comment --from <commit|pr>` scaffolds
  `docs/lessons/NNNN-slug.md`, as `make:adr` does for ADRs.
- **Delivery.** `guren context <Entity>` prints a linked document's path,
  title and status today. For a `stable` lesson it also prints `rule`, under
  a "Lessons" heading, within the module scope the bundle already applies to
  duplicate entity names. The body stays one read away. A lesson with
  `paths` and no entity is cross-cutting: its rule is rendered into the
  generated block of `REVIEW.md` and into a managed harness rule file scoped
  to those globs.
- **Lifecycle.** The existing `draft | stable | deprecated`. A proposed
  lesson is `draft` and reaches nobody; merging it as `stable` is the
  acceptance; `deprecated` with `supersededBy` retires it. `review` is the
  date after which `check --docs` warns that nobody confirmed it still
  applies.
- `check --docs` validates the type, the `rule` length, and that
  `enforcedBy`, when present, names a rule or a test that exists.

**Structure before prose.** A lesson that can be checked becomes a check: an
architecture rule in `guren.arch.ts`, a lint rule, or a test. The lesson then
keeps its rule line and the pointer. `make:lesson --from <commit>` with
`enforcedBy` records whether the named check fires on the parent of that
commit (`reproduced: true | false | not-run`), since a check that exists is
not yet a check that catches the failure.

**When a lesson is proposed.** The harness skills tell the agent to draft one.
`docs/lessons/` is medium by §3, so a person reads it before it merges.

| Trigger | Where it is seen |
| --- | --- |
| The same class of finding in two review rounds | The review contract |
| A step the Stop hook gave up on | `plan:next` reporting the stall |
| A waiver | `plan:waive` |
| A revert, or an escaped defect with its commit | `make:lesson --from <commit>` |
| A finding declined with a reason | A `draft` lesson with `paths` or `entities` and a `review` date. A decline is one author's judgment on one change and becomes a standing exclusion only by this route |

**What can be measured.** `guren change:stats` reads git and `docs/` (reverts,
closed plans, waivers, lessons by status). With `--remote` it also reads the
change records and reviews: floor against approvals given, holds by code,
review rounds, and reverts by the lane the reverted change had. Whether a
lesson reduced recurrence needs the finding class in the record over time,
which is why the contract gains the structured line in §7.

Records expire with their artifacts, so the sweep (§10) writes each month's
numbers into one pinned issue, and a trend is read from there. A revert of a
change the floor called low is listed by itself, at the top. Nothing tightens
the lanes automatically: the person who sees that line edits
`guren.review.ts`.

### 12. The Dev Center: the person's one surface

The Dev Center becomes the one place a person follows the line from. It keeps
its mount and its guards (development only, `GUREN_MCP=1`, loopback peer and
origin).

**The inbox.** The first page lists every decision the line is waiting on, and
nothing else. It extends the attention model the plan page already has.

| Item | Appears when | The decision |
| --- | --- | --- |
| Plan to review | A draft or an edited plan, in the working tree or in an open pull request | Approve it, or send the review back |
| Stalled step | The Stop hook gave up on a step | Waive, revise the plan, or fix the environment |
| Held change | A pull request whose floor is medium or high, or that carries a hold | Approve or request changes |
| Plan ready to close | Every step verified and the last change merged | Close |
| Lesson proposed | A `draft` lesson in an open pull request | Accept or decline |
| Intake | An untriaged issue from a sweep or the defect template | Plan it, assign it, or close it |
| Line | A stage `factory:status` reports `missing` | Run the command it names |

A low change with no hold is in none of these rows. It is listed under
"Flowing", collapsed, and a failed change under "With the agent".

**The change page.** `/_guren/changes/<id>` shows one change: the floor, each
fact with its file and lines, the holds, the gate stages, the plan steps with
their red runs, the browser cases with the screenshots the plan page already
serves, and the reviewer's findings with their dispositions. It opens with the
reading list: the files and hunks the medium and high facts name, in place of
the whole diff. A person who read that list has read what the line could not
judge. The full diff is one link away.

**The line page.** `factory:status` (below) and the numbers of §11.

**Where it reads from.** Locally, what it reads today (plan files, `.guren/`)
plus the output of a local `change:evidence`. Remotely, the open pull
requests, their change records, reviews and issues, through `gh` under the
person's own login, spawned by the Dev Center process the way the readiness
check spawns the CLI. That is how work a cloud agent did reaches the person
without access to its sandbox. With no `gh` or no login the remote half is
`unavailable`, and the inbox says so at its top: it is never shown as empty.
Remote text (titles, bodies, findings) is escaped and never run.

**Knowing when to look.** Three signals and no service: GitHub's own
notification when review is requested (code owners are requested
automatically, and from deliverable 5 the lane job requests a reviewer for
any medium or high floor); the harness's hand-off line, which ends with the
inbox count; and the count in the Dev Center's tab title.

**Deciding there.** Today the Dev Center has one write and copies every
decision command for the person's terminal (RFC 0030 §8, amended 2026-11-01).
For the Dev Center to be enough, a decision has to be possible in it, so it
gains a closed set of actions:

| Action | Runs |
| --- | --- |
| Approve or close a plan, waive an element | `plan:approve`, `plan:close`, `plan:waive --reason` |
| Approve or request changes on a pull request | `gh pr review`, with the person's text |
| Triage an issue | `gh issue edit` (label, assignee), `gh issue close` |

- Off unless `GUREN_DECISIONS=1`. No template sets it; `guren add review`
  offers to add it to the `dev` script, so turning it on is the owner's act.
- Confirmed on an origin of its own. The application answers on `127.0.0.1`
  as it does on `localhost` (the MCP Apps sandbox notes that its proxy's
  origin "is the application itself"), so a second hostname on the same port
  is not a separate place. The Dev Center opens a listener on another
  loopback port that serves the confirmation document and the decision
  endpoint and nothing else, and the endpoint accepts no other `Origin`. A
  script injected into a page of the application is on the application's
  origin, whichever hostname loaded it, and can neither read the confirmation
  nor post as it.
- The listener answers one `Host` (its own address and port) and 404s every
  other, which closes DNS rebinding. The endpoint requires that exact
  `Origin` and a per-process token in a custom header, so a cross-origin
  request is preflighted and a plain form post is refused. The confirmation
  is sent with `frame-ancestors 'none'` and
  `Cross-Origin-Resource-Policy: same-origin`, so it cannot be framed or
  fetched.
- A prototype of this was attacked from an application page in a browser,
  from `localhost` and from `127.0.0.1` on the application's port: reading
  the confirmation, framing it, loading it as a script, and posting to the
  endpoint by `fetch` and by form were all refused, and only the click on
  the confirmation itself was accepted (Measurements).
- What a script can still do is bring a confirmation up, by opening its
  address. It cannot answer one. So the confirmation states the command and
  its target in full and does nothing until clicked.
- A request names an action and an id. The server builds the command; nothing
  from the request reaches a shell.
- The confirmation shows the exact command and what it changes, and the
  action is refused unless the existing dry run says it would go through.
- Every action is appended to `.guren/decisions.log`.
- Merging is not an action. The repository's own auto-merge does it once the
  approvals are there.

This reverses a choice RFC 0030 made on purpose (**decided 2026-11-13** by the
maintainer, Open Question 14). It ships as its own deliverable, and RFC 0030
§8 is amended in place when it does. The page keeps showing the command it
will run, so a person who prefers the terminal loses nothing.

**Readiness.** `guren factory:status [--remote] [--json]` reports, per stage
of §2, whether the application has what the line needs: `ready`, `partial`,
`missing` or `unknown`, each with the file or setting it read and the command
that fixes it. It is read-only, and it is what the line page renders.
Examples: issue templates and the `issues:` field at
intake; `docs/plans/` at plan; the harness and the `fix` skill at implement;
`change:evidence` in CI at verify; `REVIEW.md` with a current block at review;
with `--remote`, the repository rules at merge (through `gh api`, and
`unknown` without it); a release record at release.

Factory's Agent Readiness scores a repository on generic pillars. This report
is keyed by stage and reads the application, so it can say which stage stops
a change from flowing.

### 13. Trust boundary

Printed at the end of `change:lane` and `change:evidence`, as RFC 0039 §9
does for the dependency reports.

- The floor guards against mistakes. It does not stop an author who writes
  code to defeat it; only enforcement run from outside the change can (§8),
  and none ships here.
- The evidence runs the change's own code (tests, introspection), so it is
  not evidence about a change that attacks the runner.
- Facts are lower bounds. A security record that did not weaken has not
  proved the action's body unchanged.
- An approved plan declares targets, not their implementation. Low means the
  evidence held, not that the code is good.
- The reviewer model's findings are advisory and never counted as approval.
- What the Dev Center shows from a pull request or an issue is another
  party's text. It is displayed, never followed.

### 14. Phasing

Six deliverables. The first three are specified here. The fourth and fifth
get their own specification before they ship, with the measurements listed
under Open Questions as their acceptance criteria.

| Deliverable | Ships | Produces |
| --- | --- | --- |
| 1. Evidence, record and the read side | `resolveChange()`; `change:lane` with the facts that need only the head and the diff (paths, migrations, audit, acceptance, dependencies), the rest `unjudged`; `change:evidence` with the gate, a fresh-clone `plan:verify` and the browser aggregate; the record; `guren add review`; `factory:status`; the Dev Center inbox, change page and line page, reading local files and `gh`. Report only | Lanes and holds on every pull request; one page that lists what waits on a person, cloud work included; the records the shadow comparison needs |
| 2. Decisions in the Dev Center | The action set of §12 behind `GUREN_DECISIONS=1`, with the amendment to RFC 0030 §8 | A person who never opens a terminal or the pull request page to decide |
| 3. Lessons | The `lesson` type, `make:lesson`, delivery through `context` and the harness, the `fix` skill, the canonical review contract, the tests step handed to `test-writer` | The loop from a finding to a rule or a check |
| 4. Historical evidence and delegation | Base preparation and per-route security records; red runs from history; the declaration matcher; the forecast in `plan:render` and `plan:approve` | Measured on real histories: the share `unjudged`, the share `unobserved`, declarations matched |
| 5. Enforcement | The GitHub adapter that meets §8's list | Low changes merging without a person, where the shadow data supports it |
| 6. Release and sweeps | The release record, `browser:doctor --landmarks-only`, the sweep template, `change:stats --remote` | The line closed from production back to intake |

Follow-up RFCs, named so they are not mistaken for done: provisioning a cloud
environment for agents (an amendment to RFC 0008), feature flags, a
production error reporter that files issues, the headless plan producer
(RFC 0030 D1), and reviewer eval cases.

## Alternatives Considered

- **Ship a reviewer or an approval bot.** Claude Code Review, Bugbot and PR
  Routing & Approval exist, improve monthly, and are measured against far
  more pull requests than Guren will see. None of them knows that a route
  lost its policy. Supplying that is the smaller and more durable job.
- **Commit `.guren/plans/` state.** It would put evidence on the pull request
  for free, and it is the claim RFC 0030 refused: a "verified" nobody
  re-checked. Recomputing in CI costs minutes and removes the claim.
- **Treat a verified step's fingerprint as delegation.** The first draft made
  a source file low when a verified step fingerprinted it. The fingerprint
  covers shared controllers and route files, so an unrelated edit in the same
  file would have ridden through on the planned one.
- **Compare graph edges directly.** `authorizes` edges start at the
  controller, so one action losing its check while another keeps it leaves
  the edge in place; and a renamed route is a new node. Hence the per-route
  records.
- **Set the lane with a model.** Both vendors do, above a deterministic
  floor. A model inside `guren` would need a key in CI and would make the
  check nondeterministic. The floor stays in Guren and the model stays in the
  platform, which may only raise the lane.
- **Ship enforcement with the first part.** The scaffold could add a required
  check that counts approvals. Without a trusted place to run it from, it
  would be a check the gated change can rewrite, and the lanes would be
  enforced before any data said they were right.
- **Extract lessons automatically.** Bugbot promotes candidate rules on
  signal across 110,000 repositories. One application has no such signal, and
  a wrong lesson misleads every later session. A person merges each one.
- **A GitHub App.** It could run from outside the change and count approvals.
  It would also be a hosted service with write access to user repositories,
  which this project does not run. The enforcement specification may still
  conclude that nothing less is a boundary.
- **Make the pull request page the person's surface.** It shows the whole
  diff first and knows none of the facts, so a person there reads everything
  or nothing. The pull request still gets `evidence.md` as a fallback; the
  reading list is in the Dev Center.
- **A hosted dashboard.** It would reach a phone and need no local server. It
  is also a service holding repository access, which this project does not
  run. The Dev Center reads through the person's own `gh` login.
- **One RFC per stage.** The stages are small; the design is the record that
  crosses them. Split, each part would define its own hand-off.
- **Adopt pstack or Factory's workflow as the harness.** They are procedures
  for an agent in any repository, and they compose with this: a pstack
  shipping playbook can call `change:evidence`. They do not replace facts
  read from the application.

## Migration Path

Additive. An application that never runs `guren add review` is unchanged.
New scaffolds get the report workflow, which fails exactly when the gate
would. `guren upgrade` offers `add review` to existing applications and does
not run it. The scaffolded `ci.yml` keeps `guren gate --deps` until the
application opts in, after which `change:evidence` covers the same stages.

## Open Questions

Every question is settled in the design. Each is kept, struck through, with
how it was settled: by the maintainer (4, 14, 15), by documentation read in
the original (3, 7), or by a change to the design. What still has to be
measured is listed at the end, with the deliverable that measures it.

1. ~~**Reading the base.** Can the base graph be rebuilt in a temporary
   worktree, statically or by introspection?~~
   **Resolved (2026-11-14):** it is never rebuilt. Static mode cannot give
   route facts, and introspecting an old commit needs its dependencies,
   `codegen` and environment. Each commit's records are computed while it is
   the head and fetched by SHA as the base record (§3).
2. ~~**Reproducing red runs.** Cost, and the share of histories where a
   test's first commit holds no implementation.~~
   **Resolved (2026-11-14):** only a test that first appears in the change is
   reproduced, among the change's own commits, in a worktree prepared from
   that commit's lockfile; a test present at the merge base is `landed`. No older history
   is searched, so a squash merge of an earlier change costs nothing (§4).
3. ~~**GitHub's rules.** Zero required approvals with code owner review, a
   workflow the pull request can edit, the merge queue by plan.~~
   **Resolved (2026-11-14)** from GitHub's documentation: `pull_request` and
   `pull_request_review` run the merge commit's workflow file and
   `pull_request_target` the default branch's; code owner review is a rule of
   its own beside a pull request rule that needs no approval; ruleset
   workflows are organization-level on Enterprise; the merge queue is for
   organization public repositories and Enterprise Cloud private ones (§8).
4. ~~**Approving a plan from the pull request.** Who runs `plan:approve`?~~
   **Resolved (2026-11-14):** merging the plan's pull request is the
   approval. The agent runs `plan:approve --propose`; the standing is
   `approved` once that entry is on the default branch (§5).
5. ~~**Leaving shadow mode.** What agreement justifies enforcement?~~
   **Resolved (2026-11-14):** a default bar the team may change: 50 pull
   requests over four weeks, no revert and no defect found among the low
   ones, 95% agreement overall (§8).
6. ~~**A low lane for fixes.**~~
   **Resolved (2026-11-14):** not in this RFC. A fix has no plan, so nothing
   declares its targets, and it stays medium. Revisited with the shadow
   numbers on how often a person changes a fix.
7. ~~**Cursor's files.** The formats of `BUGBOT.md` and `ROUTING.md`.~~
   **Resolved (2026-11-14)** from Cursor's documentation: the root
   `.cursor/BUGBOT.md` is always included; approval policy is the exact file
   name `APPROVAL_POLICY.md`, found per directory; `ROUTING.md` is a YAML
   list of `product`, `boundary` and `policies`; a policy the pull request
   changed is read from the base branch (§7).
8. ~~**Reviewer eval cases.**~~
   **Resolved (2026-11-14):** a follow-up RFC. This one supplies its data:
   the structured line per finding and the link from a revert to its change.
9. ~~**An independent evaluator.** Should the tests and the browser run
   belong to a session that never sees the implementation?~~
   **Resolved (2026-11-14):** the order already separates them. A tests step
   is written before the implementation exists, the browser specs are
   generated from the plan, and an edit to an acceptance test is always
   high. Where the harness has a `test-writer` agent, `plan-implement` hands
   it the tests step, so the bodies are written in a context that holds the
   plan step and the skeleton only. A holdout cannot be kept from an agent
   with a checkout, and an external scenario store is out of scope. RFC 0033
   §13, if accepted, adds behaviour specs generated from the plan and
   replayed in CI, which the evidence counts (§4).
10. ~~**A circuit breaker.**~~
    **Resolved (2026-11-14):** none. A revert of a low change is shown at the
    top of the numbers, and a person edits `guren.review.ts` (§11).
11. ~~**Stores other than GitHub.**~~
    **Resolved (2026-11-14):** GitHub only. `change:lane` and
    `change:evidence` take SHAs and files, and everything that speaks to
    GitHub (the workflow, the Dev Center's remote reads, `--remote`) sits
    behind one adapter, so another store is an adapter.
12. ~~**Record retention.**~~
    **Resolved (2026-11-14):** correctness needs no old record: a missing
    base record is recomputed by running the workflow on that commit. The
    numbers are written monthly into one pinned issue (§11).
13. ~~**Edits inside a file.**~~
    **Resolved (2026-11-14):** an edit to existing source is medium, and
    span accounting is not scheduled: a prototype accounted for 4 of 27
    edited files, and what it left over were edits a person should see (§3).
14. ~~**Deciding in the Dev Center.** RFC 0030 kept the Dev Center to one
    write and a copied command, on purpose.~~
    **Resolved (2026-11-13):** the Dev Center runs the decision, under the
    rules of §12. The confirmation and the endpoint sit on a listener of
    their own, since the application answers on `127.0.0.1` as on
    `localhost`, so a script injected into the application's pages can
    neither read nor post.
15. ~~**Away from the machine.**~~
    **Resolved (2026-11-14):** the pull request's `evidence.md` and GitHub's
    notification are enough. No snapshot, and the Dev Center stays
    loopback-only.
16. ~~**Knowing when to look.**~~
    **Resolved (2026-11-14):** GitHub's review-request notification, the
    count in the harness's hand-off line, and the count in the Dev Center's
    tab title (§12).

### Measurements (2026-11-14)

Read from the git histories of the 11 applications, out of two dogfooding
runs, that headless sessions built through the plan loop with commits naming
their steps: 195 step commits and 423 acceptance ids. The plan composition is
over every plan of both runs, 3,216 elements with a change kind. No test was
run: these are counts over commits, diffs and plan files.

| Question | Measured | Consequence |
| --- | --- | --- |
| Do commits carry step ids? | 195 of the 238 commits after a plan's approval are named `task/…`; the rest are the driver's own | The convention holds unenforced, and nothing here depends on it |
| Does a test arrive before its implementation? | 403 of 423 ids (95%) first appear in a commit that touches no controller, routes file or policy | Most red runs can be reproduced; about 5% would be `unobserved` |
| Is the lockfile stable inside a plan? | 1 of 195 step commits changes `bun.lock`; 185 (95%) have the lockfile of the plan's last step | The head's install is reusable almost always (§4) |
| What is a plan made of? | add 2,949, alter 131, existing 119, drop 17 | 92% additions, in applications built from a starter |
| Can a whole plan be one low change? | 0 of 11. Every one edits `db/schema.ts`, the routes entry, the application entry and `Layout.tsx`; ten edit existing server files (the starter's `User` model, its auth controllers, `config/env.ts`) | The unit that flows is the step (§5) |
| Can a step? | 95 of 195 (49%) edit no file that existed at the plan's base; 66 more (34%) edit only the three wiring files; 34 (17%) edit other existing source | 49% low as first specified, 83% once wiring files are judged by what they register (§3) |
| Which steps are held? | Tests: 34 of 36 edit nothing existing. Scaffold: 25 of 29 edit only wiring files, http 30 of 48. Pages: 13 of 27 edit existing client code, the layout's navigation in every application | The person's share is mostly the navigation link |

Limits. All 11 are new applications, so "existing" means the starter's code; a
plan on a mature application alters more. Two runs of one driver are not a
population. The dependencies added in these histories (`playwright`,
`@axe-core/playwright`) came from the driver's verification phase, not from a
step.

Three more were run the same day.

| Question | How | Result |
| --- | --- | --- |
| What does reproducing red runs cost? | One of the histories (42 behaviours) in GitHub Actions, Bun 1.4.4: a worktree per commit that first carries an id, the head's install linked in, `codegen`, that commit's test files | Three commits, 0.3 s to prepare and 0.1 to 0.7 s to run each; every case failed there and all 46 passed at the head. About two seconds for the plan |
| Is a failure there a red run? | The same run | Two commits failed on assertions (a 404 where the plan expects a redirect). One failed on a test helper importing a model a later step adds. A first run with no application key failed every case at the head as well. Hence the head as the control (§4) |
| Does code owner review block with zero required approvals? | A public repository, a ruleset, three pull requests | Yes for an author who does not own the path, and it clears on the owner's approval. A pull request the owner opens is not blocked (§8) |
| Can edits inside a file be matched to the plan? | A parse of each edited file's spans against the plan's declarations, over the 11 histories | 4 of 27 files, 24 of 166 lines. Not scheduled (§3) |

And four that needed something running.

| Question | How | Result |
| --- | --- | --- |
| How often is there no base record? | This repository's last 60 merged pull requests: the merge base of each, and whether a push run of CI completed on it | 0 of 60 missing. The base was at most four days older than the merge, inside any artifact retention |
| Does storing and fetching a record work? | A workflow on a test repository: the push run uploads `guren-record-<sha>`, the pull request run asks the artifacts API for its merge base's, with a read-only token | Found for a branch cut from a commit that had a push run; reported missing for one cut before the workflow existed |
| Can an application page reach the decisions listener? | A prototype listener on its own port and an application page on another, driven in a browser from `localhost` and from `127.0.0.1` | Eight attempts from each origin refused, a foreign `Host` and a request with no `Origin` refused, no other route answered; the click on the confirmation was accepted. Opening the confirmation from a script works, answering it does not (§12) |
| Does the harness's own review run? | The implementation logs of 52 runs | The `code-review` agent was called in 4, and in none of the 11 step-by-step runs (§7) |

One could not be measured. The independent evaluations of the 11 applications
name a file for only six of the application defects they found (five of them
in files the plan added), too few to say what share of defects a low lane
would have let through. An evaluation that names `file:line` for each defect
would make that countable.

### Still to be measured

- **The shadow period.** Whether the default bar is met, and how often a
  person changes a fix. It needs real pull requests with human reviews beside
  the floor, which only the report workflow in use produces.

## Sources (verified 2026-11)

- https://claude.dev/blog/solving-code-review-at-anthropic/
- https://claude.com/resources/articles/code-review
- https://cursor.com/guides/ai-code-review
- https://cursor.com/docs/approval-agents
- https://cursor.com/blog/bugbot-learning
- https://cursor.com/blog/self-driving-codebases
- https://github.com/cursor/plugins/tree/main/pstack
- https://flaviocopes.com/pstack/
- https://docs.factory.com/agent-readiness/overview.md
- https://docs.factory.com/cli/features/missions
- https://www.martinfowler.com/articles/exploring-gen-ai/harness-engineering-memo.html
- https://simonwillison.net/2026/Feb/7/software-factory/
- https://rewind.com/blog/ai-approve-pull-requests-safely/
