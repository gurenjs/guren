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
| Prototype mode | RFC 0021: the fixture module, `build:prototype`, the `prototype` route handler and its production refusal, `check --prototype`, the `prototype-routes` doctor check, the backlog in `guren context` | The screens a person walks before approving a plan, and the release hold while a route is on its fixture (§5) |
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

Out of scope, each named as a follow-up in §14: cloud environments other than
Claude's, feature flags, a production error reporter, and the headless plan
producer.

### 2. The line

The unit that moves through the line is a change: the commits between a base
and a head, both named by SHA. Each stage has one record and one owner of the
decision.

| Stage | Record | Decided by | Added by this RFC |
| --- | --- | --- | --- |
| Intake | The issue (RFC 0018) | A person, or a sweep (§10) | Templates; what needs a plan (§6) |
| Plan | `plan.json`, `approvals.json`, and the prototype where the plan orders screens first | A person | The delegation forecast; the walk (§5) |
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
has browser tests. That is the whole requirement on CI or on a cloud agent's
sandbox.

For Claude's cloud environments the pieces exist, by their documentation: a
setup script (Bash, as root on Ubuntu 24.04, cached when it finishes within
about five minutes), environment variables in `.env` format, and a network
level that reaches package registries by default; PostgreSQL 16, Redis, Docker
and Chrome for Testing are installed. Bun is installed too, "but has known
proxy compatibility issues for package fetching", for which the documentation
points to a session-start hook. So the harness ships one script,
`bin/agent-setup.sh` (install, `codegen`, an `.env` from the example with a
generated key, migrate), which is that environment's setup script and any
other sandbox's first command. Two things differ in such a session and the
harness skills have to follow: `gh pr` and `gh issue` are refused there, since
GraphQL is blocked and only `gh api` on REST passes, and the dev MCP endpoint
is loopback-only, so the agent reads the application through the CLI. Other
vendors' environments were not read (§14).

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

**Always high.** No plan and no policy lowers these.

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
`validation-removed` are not read off graph edges, which start at the
controller and keep a middleware's name without its capabilities. For each
route the reader builds one record from the introspection manifest and the
action evidence: the route's middleware entries with their `capabilities`
(authentication, and authorization with its `abilities` and `mode`), the
contract schemas the route declares, and, through `handles` and the
`controller:<action>` evidence, the validators and policies its action
consults. Records are compared between base and head.

A route is matched to its base counterpart by controller action first, then by
method and path, so a rename or a move does not turn a removal into an
unrelated addition. A plan that declares the rename declares nothing about its
security. The comparison is conservative, and equal names are never taken for
equal security:

| Base to head | Verdict |
| --- | --- |
| The same capabilities, abilities and mode in the same order, and the same validators | Same |
| An authentication or authorization capability absent at the head; an ability dropped from an `all` list or added to an `any` list; a validator absent | Weaker: the fact |
| Authorization `mixed` on either side, an ability resolved at request time, a middleware the manifest marks unresolved, a changed order, one validator replaced by another | Incomparable: `unjudged` at high |
| A capability, an ability in an `all` list or a validator added | Stronger: no fact |

A new mutating route with no authorization is `audit-warn-changed` already. An
ambiguous match, and an action whose authorization the graph lists as
unresolved, are `unjudged` at high: unreadable authorization is not a medium
question.

**The base is never rebuilt.** Each commit's records are computed while that
commit is the head, in an environment prepared for it. Every run of the
workflow, on a pull request's head or on a push to the default branch, writes
them into the record of §4 and uploads it under that commit's SHA. A later run
fetches the record of its merge base and passes it as `--base-record`.

- **Compatibility.** A record carries `recordVersion` for the format of its
  security records, the `@guren/cli` and `@guren/server` versions that
  produced it, and the deploy target and environment the introspection ran
  under. A base record that differs from the head's in any of these is not
  compared: the facts are `unjudged`, and the report names the fix, which is
  to run the workflow on the base commit again.
- **Where the merge base is.** For a pull request cut from the default branch
  it is a default-branch commit, whose push run stored a record. For a stacked
  pull request it is its parent's head, whose own run stored one. When the
  parent is squash-merged that commit is gone, GitHub rebases the child (§5), and its
  merge base is a default-branch commit again. A force push makes a new head
  and a new run. A base branch that moved changes nothing until the pull
  request is updated against it, which starts a new run.
- **Missing.** With no base record (the run never happened, or the artifact
  expired) the two facts are `unjudged` for any change that touches a routes
  file, a controller, a policy or a middleware, and at medium: a missing
  record says nothing against the change, where an incomparable one does. It
  is still most changes: 38 of the 43 measured tasks touch such a file, so
  until base records exist one of the 43 is low. On this repository's last 60
  merged pull requests every merge base was a default-branch commit whose push
  run of CI had completed, at most four days before the merge. That shows the
  runs exist, not yet that their records would be comparable.

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
| `file-added` | A source file the change adds | low, when an `add` element owns the file: it is at the path the element's generator gives it and exports the element's name, or it is a policy's provider. Low too when a generator the plan's `commands` name writes it, as `PLAN_GENERATOR_TARGETS` lists what each one writes |
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

"Existed" is judged against the plan and not against the change. In a stack
a later task's base holds the files earlier tasks added, and read against
that base their edits would all be `source-edited`: on the measured tasks 19
of 43 edit such a file. So a file that is absent at the plan's baseline and
owned by an `add` element of that plan is that element's addition in every
task that touches it. A source file deleted is `source-removed`, medium, and
low when a `drop` element owns it.

**The schema and the routes entry are judged by what they declare.** Every
plan measured (see Measurements) edited `db/schema.ts` and the routes entry to
wire its work in. An edit there is not `source-edited`. The schema file is read
by `schema-changed`, which needs only the two versions of the file and ships
in deliverable 1. The routes entry is read by the route facts and the security
records, which need a base record and ship in deliverable 5; until then it is
medium. A line in either that changes nothing it declares is `source-edited`
as anywhere else.

The application entry is medium until a plan can declare what it registers
(§5). Two of its lists, `providers` and `config` in the `createApp()`
literal, can be read from the file. Middleware added with `app.use()` goes
straight to Hono and the other options are not lists, so an edit that touches
those stays medium.

**Accounting for an edit inside a file is not scheduled.** The idea: give each
target a span in its file (a controller action, a policy ability, a validator
export, a model member) and let an edit flow when every changed line lies in
the span of a target a matching `alter` declares. A prototype ran on the
measured histories. Of the 26 existing server files a plan edited, 6 were
fully accounted for (7 when imports are ignored), and 48 of 134 changed lines
fell in a declared span or imported a file the plan added. What the plans left undeclared was not noise: the
starter's dashboard action rewritten (39 lines), environment keys, a model's
types. Those are edits a person should see, or that the plan should have
declared. So an edit to existing source stays medium, and the evidence names
the span each such edit fell in (`outside the plan:
DashboardController.index`). The reading list shows it, and it tells the
plan's author what to declare next time.

**Ambient.** Low: documentation outside `docs/plans/` and `docs/lessons/`,
`lang/` catalogs, added tests that carry no existing id, and generated files a
drift gate already judges or the gate regenerates (`docs/spec/`, the browser
specs `browser:map` writes, `.guren/`, `.env.example`). Without the last two
named, 2 of the 43 measured tasks would be low, since 38 change them. A
helper under `tests/` that carries no id is not ambient: an edit to one can
change what an acceptance test asserts, so it is `source-edited`. Under RFC 0033 §13 the recordings in `.e2e/cache/` are ambient too:
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
  review: { reviewer: 'claude-code-review' }, // or 'bugbot'; low needs it to report no finding (§8)
  identities: 'auto',                   // or 'several' | 'one-owner': who can approve whom (§8)
  merge: { low: 'lane-job' },           // or 'person': the lane then only informs (§8)
})
```

The policy may raise any fact. It may lower a declarable or an ambient one,
and every report then prints `lowered by guren.review.ts` beside it. It cannot
lower an always-high fact: those are the floor the rest stands on. The policy
that applies to a change is the base's: the file is a `gate-input`, so the
change that edits it is high, and its new content takes effect only once
merged.

### 4. Change evidence

`guren change:evidence --base <sha> --head <sha> [-o <dir>]` is what CI runs in
place of the bare gate. It recomputes everything from the checkout and writes
`evidence.json`, a compact `record.json`, and `evidence.md` for the job
summary.

Three things are kept apart. **The gate** is the exit code: the command fails
exactly when `guren gate --deps` would, so adopting it changes no build's
result. **Completeness** is what the evidence could not establish, each named
as a hold. **Eligibility** is the conclusion: a change is eligible for low
when its floor is low and it carries no hold. Nothing but the gate makes the
command fail.

```typescript
export interface ChangeEvidence {
  schemaVersion: 1
  lane: ChangeLaneReport
  gate: GateReport
  plans: PlanEvidence[]
  browser: BrowserEvidence
  migrationImpact: 'none' | 'additive' | 'destructive'
  /** Why this change cannot be low, however low its facts are. */
  holds: { code: string; lane: Lane; message: string }[]
}

export interface PlanEvidence {
  file: string
  hash: string
  standing: 'approved' | 'proposed' | 'unapproved' | 'baseline-removed' | 'unreadable'
  /** The tasks this change contains, by the step ids its commits name. */
  tasks: string[]
  steps: { id: string; outcome: 'verified' | 'failed' | 'blocked' | 'incomplete'; staleContext: boolean }[]
  redRuns: { id: string; state: 'reproduced' | 'landed' | 'exempt' | 'unobserved' | 'passed-before'; commit?: string }[]
  /** Elements the overlay did not lift, as `plan:close` would list them. */
  open: { id: string; state: string }[]
}
```

**The change is a task, not a step.** A tests step fails by design, so a
change holding it alone cannot pass the gate. The smallest change the evidence
can judge is a task: its tests and its implementation, with the red commit
kept inside it. The evidence asks for the steps and behaviours of the tasks
the change contains, and never for the plan's later tasks.

**What low requires of a plan.** One row short and the change is held.

| Condition | Otherwise |
| --- | --- |
| Standing is `approved` at the plan's current hash | `proposed`, `unapproved`, `baseline-removed`, `unreadable`: hold |
| Every step of the change's tasks is `verified` | `incomplete`, `blocked` or `failed`: hold |
| No step carries stale context | Hold |
| No element of those steps is left open by the overlay | `waived`: hold (a person granted it, a person reads the result). `accepted`: no hold |
| Every behaviour's red run is `reproduced`, `landed` or `exempt` | `unobserved` or `passed-before`: hold |
| The state file and decision log read | Hold |

**Red runs.** A fresh clone has no carried red runs, so a `tests:fail` step
cannot pass once the implementation exists. The evidence supplies the
observation per behaviour, by the identity `carriedRedRuns()` uses (the id and
`behaviourShape()`), never by step id, and hands the result to `PlanVerifier`
as the records the run starts from, the input a local run fills from the state
file.

- `exempt`: the behaviour is marked `alreadyHolds`. That is an exemption the
  approval granted, not an observation.
- `landed`: a test case titled with the id already requests its route at the
  merge base. Its red run was the business of the change that added it, which
  either reproduced it or was read by a person. No history older than the
  change is searched.
- Otherwise the test first appears in this change. The evidence finds the
  first commit of the change where the case exists and requests its route,
  checks that commit out in a temporary worktree, and runs that test file
  there. The case is `reproduced` when all of these hold: the junit report
  marks that case failed; the file loaded, which is to say the output carries
  no module-resolution error and not the skeleton's boot failure, as
  `plan:verify` already reads for `tests:fail`; the text of the case is the
  same at that commit and at the head; and the case passes at the head in the
  same runner.
- `passed-before`: the case passed at its first commit. The test never proved
  anything.
- `unobserved`: anything else. The file did not load there, the case was
  edited between the two commits, the first commit also holds the
  implementation (the change was squashed before review), or the commit could
  not be prepared.

The worktree is prepared from its own lockfile: the head's install is reused
when the two lockfiles are identical, and otherwise `bun install
--frozen-lockfile` runs there; `codegen` runs in the worktree either way.

**Browser.** A run has no result of its own. `browser:record` measures each
step's screenshots and runtime-error window, and reads neither Playwright's
report nor the errors of the server Playwright started. The evidence defines
the aggregate:

```typescript
export interface BrowserEvidence {
  configured: boolean
  /** `unavailable` when the runner did not finish or left no report the CLI can read. */
  report: 'read' | 'unavailable'
  cases: { passed: number; failed: number; skipped: number; fixme: number }
  /** Features the change touches (by the browser map) with no passing case. */
  uncovered: string[]
}
```

Cases are read from the run's `spec-report.json`. A failed case, an
`unavailable` report, and a feature the change touches that is `uncovered`
(its spec is a `test.fixme`, or the application has no browser configuration)
are each a hold whenever the change edits a page or a route that renders one.

**Behaviour specs (RFC 0033 §13, proposed).** If that amendment is accepted
and the application has `e2e.browser.config.ts`, the evidence also runs
`test:behaviours:ci` and counts the cases of the runner's `.e2e/report.json`
in the same aggregate. The report is the runner's own document, so its
`schemaVersion` is checked first (`report-1` in the version §13 pins), and one
the CLI does not know is `unavailable`, never read on a guess. A case that
does not pass there is a hold, and the report says which of these it was:

- `REPLAY_STALE`: a recording that no longer replays. It may be a page that
  changed or a regression (the runner's documentation lists a replayed action
  the application refused and an end state that does not match), which is why
  a person reads it and nothing records it again unattended.
- `MODEL_PROVIDER_FAILED`: a step that ran live where CI has no login, because
  it was never recorded or because its recording has a gap the runner cannot
  replay, such as a value the agent read off the screen. By the runner's
  documentation both run live even under `--strict-cache`. The fix is a
  recording, or a behaviour worded so that it replays, not a login for CI.
- An outcome the locators do not find.

A case the generated spec skips by design, with its reason (no outcome a
locator or a URL can check, an input that is not a scalar), is not a hold: the
behaviour's `TestApp` test covers it.
§13 keeps behaviour specs out of every gate, and this keeps to it. These specs
are generated from the plan and replayed with no model, so they are a check
the implementing session did not write (Open Question 9).

**The record.** `record.json` is what outlives the run: `recordVersion`, the
`@guren/cli` and `@guren/server` versions, the target and environment, base,
merge base and head, the fact codes with their lanes, the floor, the holds,
the gate's result, and the head's per-route security records (§3). The
workflow uploads it whether or not the gate passed, as an artifact named for
the head SHA with the longest retention the repository allows. It is the base
record of later changes, the unit `change:stats` counts (§11) and the input to
the shadow comparison (§8). The evidence is never committed.

An expired record cannot be had again as it was. Running the workflow on that
commit recovers its facts and security records, not what the reviewer or the
person said at the time. Those live on the pull request, where the lane job
writes its decision (§8), and so an incident can be traced for as long as the
pull request exists, not for as long as the artifact does.

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

**The unit that flows is the task.** A plan's implementation arrives as one
pull request per task (§4), stacked where one depends on another. Read from
paths alone on the 10 plan implementations measured: taken whole, none could
be low; of their 43 tasks, 5 edit nothing that existed before the plan and 6
more edit only the schema and the routes entry, so 11 of 43 is the most the
low lane could take once the routes entry is judged structurally. The other 32
edit the application entry (7), existing client code (5) or existing server
code (20). These are upper bounds: declarations, security records, evidence
and review can only lower them.

A prototype of `change:lane` then read the same 43 tasks with the
declaration matcher of §3, and they did. With every security record taken to
compare the same, 5 tasks are low, 30 medium and 8 high. Paths had counted
only files from before the plan, and two things they could not see hold most
tasks. Nineteen tasks edit a file an earlier task of the same plan added (a
model in 12, a controller in 7), which exists at their base. And 24 add at
least one file no element owns: 67 files, among them 21 service and support
modules, 9 client components, 8 config modules and 7 providers, 29 of them
written by a generator the plan's `commands` name. The eight high are two
edits to `bin/serve.ts`, three edits to an acceptance test an earlier task
wrote, and three policies whose `make:policy` stub the plan's own step
rewrote with fewer abilities, a plan that RFC 0030's `plan:command-target`
check now refuses. Where the facts could be matched they matched: all 112
added routes, all 24 added policies, 194 of 261 added files, 23 of 27 added
tables (the other four carry an `id` or timestamps the plan does not list).

So §3 gains two rules from this, stated there: a file the plan added stays
the plan's addition in every task, and a file a plan's command writes is
declared by that command. With those and the plan sections below, 13 of the
43 are low, 22 medium and 8 high.

Counting tasks overstates what a person does. A floor is the highest lane
among a task's facts, a task here changes about 440 lines in 13 files, and
one edit outside the plan makes the whole task medium. What the person reads
is the reading list (§12), which holds what each fact above low points at
and not the file it is in. The 22 medium tasks change 11,196 lines,
migration snapshots aside. What their facts point at is 642 changed lines of
existing files, a median of 20 a task and at most 90; 13 columns and
statements the plan does not list; 19 added files, 960 lines if every one is
opened; and 9 deletions, which are names. That is 6% of the diff to read and
14% with every added file read through. The lists are mostly the starter
being rewired: 17 of the 22 edit a file from before the plan, the layout in
9 and the `User` model in 9, and 14 add a file no element owns: 38 files,
24 of them helpers under `app/Support`, `app/Services` and `resources/js`
and 12 uploads a test left under `storage/`.

**A smaller unit is not a readable one.** The other way to give a person
less to read is to cut the task. The same histories say what that buys, with
each task cut along its steps into at most four slices (commands, scaffold,
the tests with the data and http that make them pass, pages) and then into
single steps, which the gate would not even let merge alone:

| Unit | Units | Median size | Stop for a person | Lines in the units that stop |
| --- | --- | --- | --- | --- |
| Task | 43 | 338 lines | 30 | 17,538 of 20,161 |
| Slice of a task | 89 | 194 | 48 | 13,903 |
| Step | 170 | 121 | 70 | 11,094 |
| Task, read by its targets | 43 | 338 | 30 | 642, and 19 added files |

Cutting finer raises the stops from 30 to 48 to 70 and still leaves more
than half the lines in a unit that stops, because the edits outside the plan
are spread over the steps: 70 of 170 step commits touch one. A stop is what
costs a person, and each unit is also a run of the workflow and a review by
the platform's reviewer. So the task stays the unit that merges, since it is
the smallest that passes the gate with its tests, and the reading list is
the unit a person reads: it gathers what the cuts would scatter.

So on a new application about half the tasks stop for one person, who reads
a few dozen lines of each, and what the line gives that person first is the
evidence and a reading list, not an empty queue. Three further readings would move
tasks and are not adopted here: the layout's edits as navigation entries
(15 low, at best), added helper files of a kind no plan section describes
(16 with the layout), and a declared `alter` on a model taken for the whole
file (18). With an edited test helper read as ambient as well it is 21 of
43. Each trades a line a person would have read for one nobody reads.

**A plan's tasks are a stack.** GitHub's stacked pull requests (public preview
on Free and Enterprise Cloud, and enabled on this repository) are this unit:
one pull request per task, each based on the one below. From GitHub's
documentation:

| GitHub documents | So |
| --- | --- |
| Every pull request in a stack is judged against the rules of the stack's base: required reviews, required checks, code owners | The lane status and the native floor apply to every task, not only the bottom one |
| A workflow on `pull_request` for the default branch runs for every pull request in the stack, with no change to the workflow | The evidence runs per task |
| They merge from the bottom up, and one merges only when everything below it also meets the rules | A low task above a held one waits for it, which is the order the tasks depend in |
| Merging the bottom rebases the rest automatically, and a rebase that leaves a diff unchanged keeps its approvals | The cascading rebase is GitHub's work, not the agent's |
| A merge queue takes the stack in order | Nothing to add |
| A stack is merged through the asynchronous merge API, as one operation | The merge is one request for the highest task that is ready, not one per pull request |

The harness's `gh-stack` skill opens and extends the stack. A stacked pull
request's own base is the head of the one below it, which is what
`github.event.pull_request.base` names, so the change the evidence reads is
that task's layer; `github.event.pull_request.stack` gives the stack's base
and the task's position. Two limits: every branch of a stack is in one
repository, so a fork cannot use it, and whether GitHub's auto-merge applies
to a stacked pull request is not in the pages read. If it does not, the lane
job (deliverable 6) requests the merge once a task and everything below it
are satisfied.

**What a plan cannot declare yet.** The low lane is small because a plan has
no way to state the commonest edits to existing files. Every existing source
file the 43 measured tasks edited, by what the plan said about it (72 files,
counted once per application):

| What the plan said about the file | Files |
| --- | --- |
| It is the schema or the routes entry, read structurally already | 20 |
| A changed element owns it: an `alter` on a controller, a model, a validator or a page | 13 |
| The application entry: `providers` and `config` in `createApp()` | 10 |
| The layout: navigation links | 9 |
| `config/env.ts`: environment keys | 5 |
| A page, a validator or a controller with no element in the plan | 9 |
| An element the plan called `existing` | 2 |
| Middleware, or a routes file beside the entry | 4 |

Three of these rows are a list with an entry added: a provider or a config
module in `createApp()`, a key in `defineEnv()`, a link in the navigation. A
plan that could declare them, and a reader that could tell an added entry from
any other edit, would make them declarable facts, as the schema is. On the
same 43 tasks, first by paths alone, then with the rule below applied to both
sides of every edit by a prototype reader:

| Judged structurally | By paths | Nothing but the entries | By the facts of §3 |
| --- | --- | --- | --- |
| The schema and the routes entry (today) | 11 | 11 | 5 |
| and the application entry | 18 | 18 | 7 |
| and environment keys | 23 | 23 | 7, and 13 with the two rules of §3 |
| and navigation | 28 | 24 | not run |
| and edits a changed element owns, if they could be accounted for (§3) | 35 | 28 | not run |

The last column is the prototype of `change:lane` described above, with every
security record taken to compare the same. A section seldom frees a task by
itself, because the task has another reason to be read: the five foundation
tasks that add an environment key also add config modules and providers no
element owns. Every entry the sections would have declared had a source in
the plan: 20 providers a policy element implies, and 9 providers, 8 config
modules and 8 keys that an `add queue`, `add schedule` or `add storage`
command explains.

The application entry and the environment keys keep the whole of their bound:
all 25 edits to `src/app.ts` and all 5 to `config/env.ts` added entries and
the imports they need, and nothing else. So did all 27 edits to the routes
entry, each one registrar call. Navigation keeps one task of five as a list
of links alone, and four of five with the layout and the declared removals
designed under the module below (27 of 43). The schema is read by what the plan declares:
22 of its 33 edits add tables only, and the other 11 change a table that
exists (six add columns, most to `users`), which is low only where the plan
declares that column (§3).

So by paths two sections move the bound from a quarter of the tasks to a
half, and by the facts from 5 tasks to 7, or to 13 once a command declares
what it writes. Navigation adds up to four more once the layout holds nothing
but what the module gives it. Proposed, as an amendment to RFC 0030's plan
format:

```typescript
env: [{ id: 'env.queueConnection', change: { kind: 'add' }, key: 'QUEUE_CONNECTION', type: 'string', default: 'sync', required: false }]
providers: [{ id: 'provider.jobs', change: { kind: 'add' }, className: 'JobsProvider', purpose: 'Registers the queue jobs' }]
config: [{ id: 'config.queue', change: { kind: 'add' }, name: 'queue' }]
navigation: [
  { id: 'nav.jobs', change: { kind: 'add' }, route: 'jobs.index', label: 'Jobs' },
  { id: 'nav.dashboard', change: { kind: 'drop' }, route: 'dashboard' },
]
```

| Section | Read from | Fact | Needs first |
| --- | --- | --- | --- |
| `env` | The keys of the object given to `defineEnv()` in `config/env.ts`, in both versions of the file | `env-added`, low when declared. A key removed or changed is medium | Nothing. `env:example` already derives `.env.example` |
| `providers`, `config` | The `providers` and `config` arrays of the `createApp()` literal, which `composeAppProviderRegistration()` already locates. A policy's provider is implied by its `policies` element, as `plan:scaffold` writes it | `provider-added` and `config-added`, low when declared or implied | Nothing for these two arrays. `app.use()` and the other options are not lists and stay medium |
| `navigation` | The entries of `config/navigation.ts`, which the server filters and the layout renders | `nav-added`, `nav-changed` and `nav-removed`, each low when declared | The navigation module, below |

One rule keeps all of them honest, the one the schema follows: an edit is the
structural fact only when the file differs from its base by exactly those
entries and the imports they need. Anything else in the same file is
`source-edited`.

Each section costs what any plan element costs: a check in `plan:render`, a
state in `plan:status`, a line in the producer prompt, and an entry for
`plan:scaffold` to write. The plan format's version moves, since an older CLI
refuses a section it does not know. `env` and the two `createApp()` arrays
need nothing else. All three go into deliverable 5, navigation with its
module.

**Navigation as a module.** Nine of the 10 measured plans edited the layout,
each time in a `pages` step. They added 26 links, 25 of them by a literal
path, and removed 14 the starter shipped; six renamed the brand from "Guren".
Of the 26, 7 are shown to everyone, 12 to a signed-in user, 1 to a guest and
6 behind a check of the user's role or an admin flag.

Only one of the nine edits was links, their conditions and the brand alone.
Seven also changed the width of the page, three added a `wide` prop for it,
three typed the user for a role check and two named a class constant for the
links; and seven removed or relabelled a link the starter shipped (Home,
Dashboard). A list of links removes the user's type and the class constant
and nothing else, and would move one task of the five the paths promised. So
the module is three things together: the entries, a layout a page can widen
without editing it, and a plan that can declare an entry removed or changed.
Read against the same nine edits, that leaves seven as declared entries
alone, and four of the five tasks low. The other two edits also changed the
page's vertical padding, which stays an edit to the layout.

Who may see a link is the harder half. `authorizeMiddleware` is used in none
of the 10 applications, against 73 calls of `this.authorize()` and
`this.can()` in controllers; one application guards two route groups with a
role middleware of its own. So a link's visibility can seldom be derived from
its route's middleware, and the role checks in the layouts restate by hand
what the server already says: of the six, four restate an ability the route's
action authorizes with the bare class (`JobPolicy.create`: employers only),
one a role middleware on the route, and one has nothing on the server behind
it. Four applications also pass a page a boolean such as `canApply` that a
controller computed from the gate. The gate is on the server, so the
navigation is defined there and the client receives only what the current
user may see.

```typescript
// config/navigation.ts
import { defineNavigation } from '@guren/core'
import { Job } from '@/app/Models/Job'

export default defineNavigation([
  { label: 'Jobs', route: 'jobs.index' },
  { label: 'Post a job', route: 'employer.jobs.create', show: { can: ['create', Job] } },
  { label: 'Dashboard', route: 'dashboard', show: { auth: 'required' } },
])
```

- **An entry is data.** A literal label, a route name, and an optional `show`
  with any of three conditions, all of which must hold: `auth` (`any`,
  `required`, `guest`), `can` (an ability and the model class its policy is
  bound to), and `where` (fields of the user compared by strict equality, so
  a string never matches a numeric id, for an application with no policy to
  ask). `auth` and `where` are judged first, so an entry that requires
  sign-in never asks the gate for a guest. There is no function, so the CLI reads
  the file by its syntax; a spread, a computed value or a function makes the
  file unreadable, and an edit to it `source-edited`.
- **`can` asks the gate.** `['create', Job]` is evaluated as
  `gate.forUser(user).allows('create', Job)`, the call `this.authorize()`
  makes with the bare class. It is the policy's own rule, written once. A
  navigation entry has no record, so only an ability that needs none can be
  named. `guren check` reads the method's parameters: it warns on a required
  second parameter, since the gate would call the method without it, and
  reports an optional one as unverifiable. Of the 45 policy methods in the
  measured applications, all read by syntax, 8 take the user alone, 29
  require a second parameter and 8 make it optional; of those 8, 2 mean
  something without a record and 6 return a constant. A check that denies or
  throws hides the entry, and a throw is logged once per ability and model
  for the life of the process: a guest is asked with a `null` user, as
  `this.authorize()` asks, so a policy that reads the user without a guard
  throws on every guest visit. Two things the runtime cannot see are left to
  that warning: a method that requires a record and never reads it shows its
  entry to everyone, and an ability the policy lacks falls through to a gate
  of the same name defined with `gate.define()`.
- **The server filters, the client renders.** The module is a config
  definition, given to `createApp({ config })` like the others, so adding it
  is the `config-added` fact above. Unlike the others it works in the
  definition's `boot` hook and not in `bind`: by then the routes are
  registered and the gate is bound, so it links every entry once and
  registers the shared prop for that application. It shares `navigation` as
  a lazy prop: for each entry the user may see, its label, its path and
  whether it is the current one, and nothing else of the entry. The engine
  resolves a lazy prop on a full visit and skips it on a partial reload that
  does not ask for it and on a JSON response. The layout maps that prop to
  links and holds no condition. Ability names, hidden routes, `where` fields
  and a denial's message never reach a browser: a prototype's guest payload
  held none of them. The current entry is the one whose path equals the
  request's, else the longest that is a prefix of it by whole segments, among
  the entries the user may see; `/` is a prefix of nothing.

  The cost is one gate check per distinct ability and model each time the
  prop is resolved, asked together and not in turn: ten abilities whose
  policy waits 5 ms added 5.8 ms to a visit asked together and 56.5 ms asked
  in turn. It is once per resolution and not once per request, since an
  action that authorizes the same ability asks again, and a `gate.after()`
  callback runs for every navigation check. Ten checks took 12 microseconds
  measured on the gate alone.
  Of the eight `create` and `viewAny` methods in the measured applications,
  the three that take the user alone are synchronous and read only the user.
  The other five take a second argument (`{ teamId }`, `{ projectId }`, the
  state of a job) and are called as `[Model, context]`; four of them query,
  once or twice. In these applications no ability an entry could name
  queries. That is a count and not a bound: a warning keeps nothing out, and
  a `before` hook or an ability that takes the user alone may query too.
- **A route is named, not spelled.** The route must exist, be a `GET` with
  no path parameter (`isParameterless()`, the rule the browser map picks a
  landmark by) and render a page. Three readers hold it to that. Codegen
  writes the names an entry may use into `.guren/routes.gen.ts` as a type the
  definition is checked against, which it does not write today; the config
  imports nothing generated, so there is no cycle, and until codegen has run
  any name passes. The runtime links each entry at boot and hides one whose
  route is missing, is not a `GET` or has a parameter, with a warning: left
  to the request, `Router.route()` throws on a missing name and every page
  of the application answers 500. `guren check` reports the same three and
  the one the runtime cannot see, a route that renders no page.
- **Showing is not authorizing.** Hiding a link protects nothing. `guren
  check` compares an entry with what its route does, advisory only, in three
  readings. An entry everyone sees whose route requires sign-in, read from
  the route's resolved middleware in the manifest: the applications attach
  sign-in through an alias, a local constant and an inline call, which a
  reading by syntax would have to know one by one. An action that authorizes
  an ability an entry could name (`this.authorize()` with a literal ability
  and the bare class, on a method that takes the user alone) while the entry
  does not name it: the direction that finds a role check restated in
  `where`. And an entry whose `can` names another ability than that call.
  `this.can()` is not read as a requirement, since a controller also calls it
  to compute a prop, and a body that cannot be read is unverifiable. A
  prototype ran the three on the measured links: the first warns on 4 of 31,
  each rightly (the layout is also served to guests on the sign-in pages),
  and on the starter's own Dashboard link in a fresh application; the second
  finds the four restated checks; and 74 of the 85 routes an entry could name
  make no `authorize()` call, so on most entries there is nothing to compare.
- **The layout the auth scaffold ships** renders the prop, marks the current
  entry, wraps on a narrow screen and keeps the account controls, which no
  entry can hold: sign-in, sign-out (a `POST`) and the profile link labelled
  with the user's name. Their labels come from the translation catalog, since
  two applications edited the layout only to translate them, and `lang/` is
  ambient (§3). The starter's home route gets a name, which it lacks today
  and an entry needs.
- **A page sets its width.** `<Layout wide>` gives the page the wide measure
  and the layout's header keeps one measure on every page, so it does not
  move between visits. Three of the nine plans added this same prop, and four
  more widened `main` for every page. Two measures, the
  narrow one for a form and the wide one for a table or a board, are what the
  plans used the layout for. Any other change to the layout is an edit to it.
- **The brand.** Its text is the application's name from a shared prop
  (`app.name`, from `APP_NAME`), and it links to the first entry the user may
  see, else to the home route. Three plans re-pointed the brand to their
  first signed-in entry, and the one that kept guests on the home page is
  the rule here.
- **One writer.** `appendNavigationEntry()`, beside `appendTableToSchema()`.
  `guren nav:add "<label>" --route <name> [--auth required] [--can
  create:Job]` calls it, and `guren nav:remove <route>` its counterpart. Both
  are generators, so a plan's `commands` may run them; `make:feature` calls
  the first for its index page, with the ability when it also writes the
  policy, and passes `wide` to the index page it writes; `plan:next` names
  the commands for the step that owns a navigation element: a task's pages
  step, or under screens first the steps named there. The writer adds the
  model's import for a `can` and refuses when the model's file does not
  exist, since the application entry imports this file and would fail to
  start. Removing an entry removes that import only when nothing else in the
  file uses the name.
- **Existing applications.** `guren add navigation` writes the module and
  replaces the layout only when the layout is still byte for byte one the
  framework shipped, judged by a hash of every version it shipped, as
  `guren upgrade` judges the UI components. This rule is new: `guren add ui`
  itself never replaces a file.
  Otherwise it writes the module, prints the lines the layout needs, and
  leaves the layout alone; its edits stay medium.

In a plan, an entry is an element of the `navigation` section, with a change
kind like any other: `{ id, change, route, label?, auth?, where?, can?: { ability,
policy } }`. An entry is identified by its route, so a file holds one entry
per route, and `route` is the id of a route the plan adds or the name of one
the application has. `plan:render` checks that the route is a parameterless
`GET` that renders a page, that `policy` is the id of a policy element and
the ability one it lists, and that an `alter` or a `drop` names an entry the
file holds. The entry belongs to the task of the view its route renders, in
that task's pages step. The facts are `nav-added`, `nav-changed` and
`nav-removed`, read from the entries on both sides. Each is low when the plan
declares it: the same route, label and `show` for an addition or a change,
the route for a removal. Undeclared, each is medium. A declared removal can
be low because an entry grants nothing: what a wrong one costs is a missing
link, and the person who approved the plan saw it listed. Left out of
this first shape: entries a module contributes (an application has one
navigation, and its file may name a module's route), grouped or nested entries, a label as a translation key (a
label is written in the default locale, as a plan's view labels are), and
abilities for anything but navigation: a button on a page keeps receiving its
boolean from the controller.

Two rows are not the format's to fix. The nine files with no element are
plans that were incomplete: `plan:verify` already records the files a step
touched, and would name any that no element of the plan owns, so the agent
revises the plan while its session is open and a person does not meet the
edit first in a pull request. And an edit a changed element owns stays medium
(§3).

**Screens first.** RFC 0030 left pages out of the plan's scaffold and gave
layout to prototype mode (its Open Question 4), and RFC 0021 ships that mode:
a fixture module that answers each route by name, a static build with no
server, and a `prototype` route handler that `plan:status` already
recognises by name. The line uses none of it, and
the measured histories show what that costs. Pages are the last step of each
task, and nobody looks at them until an evaluation: 27 of the 80 defects a
task introduced came from a pages step, among them every accessibility defect
(11) and 13 of the 20 in user experience. No fact of §3 reads one of them.
They are a person's to see, and the cheapest moment is before the backend
exists.

So a plan may order its screens first, with `screens: 'first'`. It covers
what the plan adds and nothing else: a view, a route or a validator the plan
alters stays in its task as today. Putting an existing route on a fixture
would take a working feature out of production, and editing an existing page
before approval would change a route that is live. On an application that is
already released, screens first reaches its new screens only.

The task derivation then gives an element two owners where it has one today:
the step that creates it and the step that completes it. A prototype of the
derivation ran over the ten measured plans and corrected the first table,
which gave the view one owner and took only the routes a view names.

| Element the plan adds | Created by the screens task | Completed by |
| --- | --- | --- |
| A view and its page | The page, judged at `present` | The `http` step whose action renders it, at `wired`. `plan:status` calls a view wired only when a controller action returns its page, so with one owner the screens task could never verify |
| A route a fixture can answer: one that renders a view, redirects or returns errors | Registered on the `prototype` handler, without its `bind` and `.agent()`, which name a model no task has written | The `http` step of its task, which replaces the handler with the planned action and adds the binding |
| A route that returns JSON | Not created: a fixture has no such answer | Its task, as today |
| A validator a screens route's contract or form names | The validator. It reads `wired` from that commit, through the route's contract | Nothing more |
| The page's data type | Written from the fields of the resource the view shows | The resource, in its task, typed against it |
| A navigation entry with no `can` | The entry | The screens task |
| A navigation entry with `can` | Not created | The `http` step of the task that adds its policy |

Over the ten plans that moves 45 added views into the screens task. Of the
112 routes the plans add, a view names 66 as a link or a form's target, 38
more only render a view, and 8 do neither, most of them the update route of
a form that create and edit share. The screens task takes them by routes
file and not by what a view names: no screen opens without the route that
renders it, and a file two tasks write is a file the second is refused. Four
routes return JSON and stay behind. 35 of the 36 added validators move. The
43 tasks become 53, one more per plan, and the steps 174 become 177.

- **One screens task, after the foundation and ahead of every entity.** It
  waits for the foundation's commands, since a route can carry a middleware
  one of them creates. Where the application has no fixture module yet, it
  runs `guren add prototype` first: a `prototype` route does not boot without
  the loader in `createApp()` and an entry in the fixture. `plan:scaffold`
  writes the fixture entries, the route registrations and their mount, and
  the page data types; the page components stay the agent's, as RFC 0030
  decided. Today's emitter writes none of this: it names a validator file
  after the model its step adds and writes a route only beside the action it
  writes, and the screens step has neither.
- **Its steps are tests, then pages.** A route registered with its
  middleware and its contract already answers some behaviours with no action
  behind it: a guest is redirected to sign in, an invalid body is refused.
  RFC 0030 puts a behaviour in the task whose work makes it hold, so those
  move to the screens task, whose tests step fails before the routes are
  registered and passes after. Of the 325 behaviours on the routes the
  screens task registers in the ten plans, a guard answers 99 and a contract
  46. Their red runs are kept, and the screens task needs what any tests step
  needs. The pages step then verifies with `codegen`, the typecheck,
  `guren check`, which already runs the prototype checks, and
  `build:prototype`, which joins the closed list of verify commands. The
  static build needs no database or environment, so a cloud session with no
  services can build what the person walks.
- **The other tasks lose their pages step and gain a promotion.** Their
  scaffold step writes no routes file. The `http` step edits the one the
  screens task wrote: the handler, the controller's import and the binding.
  The resource is typed against the page's data type (RFC 0021 §6), which
  `make:feature` does at promotion and the plan scaffold does not yet, so
  the typecheck is what holds the backend to the screens a person walked.
- **A promotion is the plan's addition, completed.** At the task's base the
  route exists, on its fixture, so the fact is a changed route and the plan's
  element says `add`. The declaration matcher of §3 reads a route whose base
  handler is `prototype` and whose head is the planned action as that
  addition. Without this the promoted routes file is an edit to existing
  source, and every task that promotes is medium.
- **`plan:status` says a route awaits promotion.** Today a route on its
  fixture reads `drifted`, the state of work that went wrong, because its
  action differs. The difference is withheld as a mount is: the route is
  present and waits for its `http` step.
- **An entry with `can` waits for its policy.** It imports a model and names
  an ability that no task has written when the screens are built.

This is the largest change this RFC asks of RFC 0030. Today `plan/tasks.ts`
gives each element one completing step, the scaffold only creates files and
refuses a target that exists, and a verification's fingerprint follows that
one owner.

**The walk is part of approving the plan.** A plan with screens first is
proposed as before (`plan:approve --propose`), and under the `proposed`
standing the screens task and nothing else can be worked: `plan:next`,
`plan:scaffold` and `plan:verify` accept a proposed plan for that task alone,
and the Stop hook verifies it. `plan:waive` and `plan:close` refuse as
before. The only work that can be built before approval is work that cannot
run in production, and three checks hold it to that, none of which exists
today. A draft with `screens: 'first'` is refused until it is proposed,
where other drafts keep their behaviour: a prototype ran `plan:verify` on an
entity step of an unproposed draft and it recorded `verified`. Each command
tests the task of the step it is given, and a whole-plan `plan:verify` under
`proposed` runs the screens task only. And the screens task does not verify
while an element outside it has left `planned` or one of its routes is off
the `prototype` handler, so a full implementation cannot pass as screens.
(**Decided 2026-11-14** by the maintainer, over building the screens after
approval, which stops the person twice and makes every change after the walk
a revision to approve again.)
The pull request then carries the plan, the proposal and the screens. Its
evidence names the static build as an artifact (`guren-prototype-<sha>`), and
the Dev Center's "Plan to review" row opens it, built locally from the
change's head. A comment made on the walk is saved against the view whose
page was open, in the review the Dev Center already keeps, and the agent
reads it and revises the plan. Merging the pull request approves the plan and
the screens together. The person stops once, and what they approve is
something they clicked.

**A revision made on the walk.** The baseline is stamped at the proposal,
before any screen exists, which is how approval tells the plan's own work
from a collision: an added element absent at the stamp and present now reads
as built (RFC 0030 §4). A prototype confirmed it on a small application:
after the screens commit the checks found ten collisions (two validators,
two pages, three route names and three endpoints), all ten were settled as
built, and the approval was accepted.

A revision is where it breaks. Today `plan:revise` refuses a proposed plan,
since no approval or revision record names its hash. Carried past that, the
baseline is kept, so a view and a route the revision adds have no stamp, and
once built the approval refuses them as collisions. A rename is the same: a
page renamed on the walk and then built reads as fresh and not as built, and
the approval refuses it. And the stamps cannot simply be added to the
baseline: a revision is required to carry it unchanged, and its digest is
the key an `alter`'s readings carry over by.

So under `proposed` the order is the rule, revise and then build, and the
stamps live beside the baseline and not in it. `plan:revise` accepts a
proposed parent. For each element whose target names differ from the
parent's, added or renamed, it writes a stamp in a separate field of the
plan, and refuses unless the tree reads as that element's start: an added
name absent, a renamed one still under its old name. `--propose` runs again
and writes the proposal at the new hash, and the screens task's record,
taken at the old digest, is stale and is verified again. The baseline is
never restamped, an approved plan gains no stamp, and a stamp taken after
the element was built settles nothing, so no collision is let through.

Four rules keep this from weakening what is already decided, and a fifth says
what the walk cannot show.

- **A fixture never stands in for a behaviour.** The screens task mounts
  every route ahead of the tests that request it, so a test that asserts only
  a page would pass on fixture data before any action exists. So a plan's
  tests run with the fixtures off, and the switch is in the test file: the
  skeleton `plan:scaffold` writes takes its `TestApp` with
  `TestApp.fromApp(app, { prototypeFixtures: false })`. It cannot be a
  setting read at boot, since the test files of one run share one booted
  application. The option does two things: it defers the fixture's load, so
  a first boot evaluates nothing, and it marks each of that `TestApp`'s
  requests, a mark honoured only under `GUREN_TESTING` as the testing user's
  header is. A marked request to a `prototype` route passes the route's
  middleware and its contract and then answers 501. `plan:verify`, the
  replay of red runs in §4 and the gate all run that file, so the three see
  the same route, and a `TestApp` taken without the option renders fixtures
  as it does today. A prototype showed both orders working on one shared
  application.

  The 501 comes after the route's middleware and its contract, so it does
  not cover a behaviour those two answer without an action. Those are the
  behaviours the screens task's own tests step holds (above), where their
  red run is observed before the route is registered. A behaviour that needs
  the action, a write or a 403 from a policy, meets the 501 and keeps its
  red run in its entity's task.
- **Promotion keeps the route's guards.** A route on its fixture already runs
  its middleware, and the `prototype` handler enforces the contract's params,
  query and body itself (not its output): a prototype saw a guest redirected
  and an invalid body refused with the same 422 a controller route gives. The
  route's definition carries its middleware, schemas and capabilities
  whatever its handler. So its security record
  has a base, and a promotion is compared like any other change (§3): a
  middleware or a contract schema the promoted route no longer has is
  `authorization-removed` or `validation-removed`. Only what the action
  brings, the policies it consults and the validators it calls, has no
  counterpart, and that part is judged as an added route's.
- **The release holds while a route is on its fixture.** The application
  refuses to boot in production with a `prototype` route (RFC 0021 §4: a
  fixture's state is shared by every request of the process). Nothing ahead
  of that boot stops such a release today: `guren gate` does not run
  `guren doctor`, whose `prototype-routes` check is the one that fails, and
  no deploy build reads the handler, so an application that deploys on merge
  would find out at its first start, which on Lambda or Workers is after the
  new version is live. So the deploy workflow of §9 runs that check before it
  deploys, the release record carries the result, and the line page lists
  the routes left, which is the plan's progress in a form a person can read.
  What the hold costs depends on the application. Before its first release,
  nothing. After it, every release waits from the plan's merge to its last
  promotion, a fix that has nothing to do with the plan among them.
- **An application may keep such routes dark in production instead.** The
  refusal stays the default, and an application chooses otherwise in its
  entry (**decided 2026-11-14** by the maintainer, as an amendment to
  RFC 0021 §4):

  ```typescript
  createApp({
    prototype: { load: () => import('../resources/js/prototype/index.js'), inProduction: 'skip' },
  })
  ```

  Under `skip` a production boot mounts each route on the `prototype` handler
  in its registered place with a handler that answers 404, never evaluates
  the fixture, and logs those routes once per start. The route is answered
  and not left out, because a route registered after it would otherwise take
  its requests: in a prototype, `/posts/new` left out was answered by
  `/posts/:id`. The 404 is the answer an unregistered path gets, and the
  route's own middleware does not run in front of it, so a dark route cannot
  be told from a path nothing registers. Behind its middleware a guest would
  be redirected to sign in and meet the 404 after it. Global middleware runs
  as for any path. No fixture is served, which is what the refusal was for.
  `GUREN_PROTOTYPE_ROUTES=1` still serves fixtures on purpose, and the loader
  given alone keeps today's meaning. Then the default branch can release at
  any commit, and a release contains what has been promoted so far, which is
  what merging task by task already gives a plan without screens.

  The route stays registered, so the typed route manifest and
  `Router.route()` keep it. The introspection manifest states the choice for
  each such route. It cannot state what a deployed process does, where
  `GUREN_PROTOTYPE_ROUTES` is read, and it is not available to a running
  application, so the application itself says which routes are dark and the
  navigation reads that. `prototype-routes` in `guren doctor` is a warning
  where the manifest shows `skip` and stays a failure where it is read
  without introspection, which cannot see the choice. The release record
  names the routes not served. `guren add prototype --remove` and the
  backlog line of `guren context` learn the new form. A link inside a page is
  not filtered, so a promoted page can link to a 404 until its target is
  promoted. A forgotten promotion is quiet where the refusal was loud, and
  the release record is where it shows. Choosing `skip` is an edit to the
  application entry outside its lists, so a person reads it (§3).

- **The static build has no server to filter the navigation.** There the
  shared props come from the fixture, so `build:prototype` asks the CLI for
  the navigation and adds it to the build's shared props without touching the
  fixture's source. The CLI reads `config/navigation.ts` by syntax and never
  imports it: it is the reader `guren check` uses, since a second one would
  come to disagree with it, and an import would load models and the framework
  into a build that has no server. `auth` and `where` are decided against the
  fixture's one user, and an entry with `can` is shown, since no gate runs in
  a browser. Under screens first the entries with `can` arrive after the
  walk, so the walk shows the navigation without them. It shows the screens
  one identity reaches. It does not show who else may see a link, or that a
  route refuses anyone: RFC 0021 left personas to a follow-up, and those are
  the tests' and the security record's to say.

What this buys the lanes, by paths on the same 43 tasks with each task's
pages step taken out: 13 could be low today, 25 with the application entry
and 30 with environment keys, where the same tasks with their pages gave 11,
18 and 23. That is the bound for a plan whose screens are all new, and it
assumes the matcher reads a promotion as the plan's addition; an altered
screen keeps its task as it was. Paths overstate: the 11 they gave was 5 by
the facts, so this shows the direction and not the count. The screens task is one more unit per plan
and always a person's. None of this has run through the plan loop: no
measured history has a screens task, and the one application built
prototype-first was built outside the loop.

**Approval on the pull request.** At a terminal nothing changes: a person runs
`plan:approve`, there or from the Dev Center (§12). For a plan that arrives as
a pull request, merging it is the approval, by this protocol:

1. The agent runs `plan:approve --propose`. It stamps the baseline and writes
   `proposal.json` beside the plan: the hash, the readings of each `alter`
   and the elements accepted without a behaviour, which the approval will
   bind. It never writes `approvals.json`, so a CLI that predates the
   proposal reads the plan as unapproved and not as approved. The standing is
   `proposed`, which every gated command refuses as it refuses `unapproved`,
   but for a screens task (above): nothing else is implemented on that
   branch, and the plan lands first.
2. A person approves the pull request, from the Dev Center, bound to its head
   SHA. The change is `plan-record`, so it is high.
3. After the merge, `plan:approve --from-merge` asks the store, not git: the
   pull request is merged into the default branch, the plan and proposal in
   the merge result have the proposed hash, and an approving review by a
   person other than the pull request's author covers its last head. Then the
   standing is `approved`, with that reviewer as the approver and the pull
   request and merge commit as where it happened. The answer is cached under
   `.guren/plans/` and recomputed on a fresh clone; nothing more is committed,
   so approving takes no second change.

An ancestor commit approves nothing. A proposal that reached the default
branch by a direct push, by an owner merging their own unreviewed pull
request, or by a local ref that was moved stays `proposed`, since no review
covers it. Where there is no second person, as for a single owner whose agents
open pull requests under the owner's account, GitHub lets nobody approve, and
the person approves with `plan:approve`. Either way the approval reached the
default branch through a `plan-record` change, which is always high, so a
person merged it.

The `plan-implement` skill's rule becomes: never run `plan:approve`.
`--propose` and `--from-merge` are the agent's, and neither approves anything
by itself.

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
agent was called in four, and in none of the 10 that went through the plan
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

Deliverable 1 ships the report. Enforcement is deliverable 6, and this section
specifies what it has to prove first.

**Report.** The scaffolded workflow runs on every pull request and on every
push to the default branch. It fails only when the gate fails, and prints
what each lane would have required.

```yaml
on:
  pull_request:
  push:
    branches: [main]

jobs:
  change:
    runs-on: ubuntu-latest
    permissions: { contents: read, actions: read }
    env:
      BASE: ${{ github.event.pull_request.base.sha || github.event.before }}
      HEAD: ${{ github.event.pull_request.head.sha || github.sha }}
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0, ref: '${{ env.HEAD }}' }
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      # Downloads guren-record-<merge base> into base/ when a run stored one.
      - run: bunx guren change:base-record --base "$BASE" --head "$HEAD" -o base
        env: { GH_TOKEN: '${{ github.token }}' }
      - run: bunx guren change:evidence --base "$BASE" --head "$HEAD" --base-record base/record.json -o .guren/change
      - if: always()
        run: cat .guren/change/evidence.md >> "$GITHUB_STEP_SUMMARY"
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: 'guren-record-${{ env.HEAD }}', path: .guren/change/record.json, retention-days: 90 }
```

The checkout names the head, so what the record attests is the commit it
names and not GitHub's merge commit; the merge result is the merge queue's to
test, or the rule that a branch be up to date. The summary and the upload run
whether or not the gate passed. `change:base-record` is the one command here
that speaks to GitHub, through `gh`.

**Shadow.** During the report period two things are recorded per pull request:
the floor, and what a person thought it needed. The pull request template
asks the reviewer for one label, `lane:low`, `lane:medium` or `lane:high`.
`change:stats --remote` reads the records, the labels, the reviews and later
reverts through `gh`, and prints the table of floor against label. It also
prints what the low lane would have let through: of the pull requests whose
floor was low, how many a person labelled higher, how many drew "changes
requested", and how many were reverted. The default bar for enforcement is at
least 50 pull requests over at least four weeks, with none of the low ones
reverted or labelled high and at most one in twenty labelled medium. The bar
is the team's to change, and the numbers it is judged from are printed with
it.

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

The lane job runs nothing from the change. What it believes, and from where:

| Input | Read from | Trusted for |
| --- | --- | --- |
| Path facts | The pull request's file list, recomputed | The always-high paths |
| Policy | `guren.review.ts` at the base | Lanes and required approvals |
| The gate | The conclusion of the evidence workflow's check on the head SHA, from the checks API | Whether the gate passed. Never from the record |
| The record | The artifact the evidence run uploaded | Raising the lane only: a fact or a hold in it counts, its absence proves nothing |
| The review | The reviewer's check run on the head SHA, the latest completed one, by the app that reviewer is, read the way that reviewer reports (below) | Low |
| Approvals | The reviews API | The lane's required count |

It then sets the `guren/lane` status on the head SHA, which is the required
check, and writes its decision as a comment on the pull request, where it
outlives the artifact. A change that rewrote its own evidence still cannot
hide a `gate-input` path, cannot pass the gate by saying so, and cannot count
itself approved.

- **What an approval is.** Bound to the head SHA, from a distinct person who
  is not the author; dismissed and stale approvals and a standing "changes
  requested" handled. A reviewer model's approval is never counted.
- **When it runs again.** On every event that can change an input: the
  evidence workflow finishing, the reviewer's check finishing, a review
  arriving. A review event runs the pull request's own workflow file, so it is
  used only as a signal: a `workflow_run` on its completion runs the lane job
  from the default branch. A change that removes the signal leaves the status
  unrefreshed and the merge blocked.
- **A reviewer that never reports.** `review.timeoutMinutes` (60 by default)
  after the head was pushed, the lane job stops waiting: the change is held at
  medium with "the reviewer did not report", and a person reads it. With no
  `review` named, low is not available at all, and the report says that this
  is why (**decided 2026-11-14** by the maintainer).
- **Refusal.** Approval data that cannot be read refuses the merge. It is
  never zero and never a previous success.

A `workflow_run` is documented to run on the default branch's last commit with
a write token "even if the previous workflow was not" privileged, which covers
a pull request from a fork. `check_run`, `check_suite` and `status`
events are documented to run the default branch's workflow as well, so the
reviewer's check finishing can start the lane job, and a check run names the
app that produced it (`app.slug`, read from this repository's own check runs).

**How a reviewer reports.** Neither reviewer fails a check, so "the check
passed" is not the question. Each has a documented result the lane job reads:

| Reviewer | Its check run | Low needs |
| --- | --- | --- |
| Claude Code Review | Named `Claude Code Review`. It "concludes as neutral" and "never concludes as a failure". The last line of its details is `<!-- bughunter-severity: {"nit":1,"normal":2,"pre_existing":0} -->`, which its documentation gives for gating a merge from CI | `normal` is 0, and the title is not the one that says earlier findings are still open |
| Cursor Bugbot | `success` with no finding. `neutral` when it found issues, was cancelled by a newer commit, or hit an internal error | `success` |

Another reviewer is named by its check, its app and the conclusion that means
no finding.

**Who opens the pull request.** The floor on paths and the count of approvals
both rest on the author not being the approver. On this repository the last
100 pull requests were all opened under the owner's login, agent work
included. A Claude cloud session is the same: its GitHub requests "go out with
your real credentials substituted". So there are two modes, and `factory:status
--remote` says which one a repository is in.

- **Several identities.** Agents open pull requests as an app or a bot (Claude
  Code in GitHub Actions does), or as members who are not the approver. The
  design above applies as written.
- **One owner.** Every pull request is the owner's, and GitHub lets nobody
  approve it. Here `guren/lane` is not a required check. The lane job merges a
  low change itself and leaves every other one for the owner to merge, and
  that merge is the decision. Nothing separates the owner from the owner's
  agents in this mode, and none is claimed: an agent holding the owner's
  credentials can merge today (**decided 2026-11-14** by the maintainer as
  the default, with the settings below).

Both modes are settings in `guren.review.ts`, and neither is fixed for a
repository:

| Setting | Values | Effect |
| --- | --- | --- |
| `identities` | `auto` (default), `several`, `one-owner` | `auto` decides per pull request: one whose author owns a path it touches, or is the only person who could approve it, is handled as one-owner, and any other as several identities. A repository with both kinds of author gets both |
| `merge.low` | `lane-job` (default), `person` | Who merges a low change. `person` leaves every merge to a person, and the lane is information only |
| `approvals` | A count per lane | Used where someone other than the author can approve |

So a team can start with `merge.low: 'person'` and the report alone, turn on
merging for low changes later, and add a bot identity for its agents at any
point: that identity's pull requests are simply not the owner's, and `auto`
handles them as several identities with nothing else changed.

A workflow cannot supply the second identity cheaply: a pull request opened
with `GITHUB_TOKEN` creates workflow runs "that require approval" by a person
with write access.

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

Until deliverable 6 ships, the lane is information for the person who merges.

### 9. Release and operate

- **Migration impact.** The evidence says `none`, `additive` or `destructive`
  for the migrations in the change. It is not a statement about rollback: a
  release with no migration can still write data the previous version cannot
  read, and an additive migration can break it too.
- **Release record.** A deploy workflow writes one small record: the merge
  commit, the change records it contains, the environment, the migrations
  applied, and the post-deploy result. The first three exist at deploy time;
  the template collects them. Containment is the platform's rollback to the
  previous artifact. The record does not say whether that is safe: it says
  which migrations ran, which is where a person starts when it is not.
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
| Plan to review | A draft or an edited plan, in the working tree or in an open pull request | Approve it, or send the review back. Where it has screens, walk the prototype first |
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
reading list, in place of the whole diff. A person who read that list has
read what the line could not judge. The full diff is one link away.

**The reading list holds targets, not files.** A medium or high change stops
for a person because of particular facts, and the list shows what each of
those facts points at and the question it leaves, nothing more of the file.

| Fact above low | What the list shows | The question |
| --- | --- | --- |
| An edit to existing source | The changed hunks, each with the span it fell in: inside a declared `alter` (`model.user: fillable`) or outside the plan (`DashboardController.index`). Outside first | Is this edit part of the work? |
| A column, index or statement the plan does not list | That declaration in the schema and its statement in the migration, beside the declared table. Not the migration file, and never its snapshot | Did the plan leave this out, or did the change add it? |
| An added file no element owns | Its path, size, exports and the files that import it. The body opens on request | Is this a helper of declared work? |
| A deleted file | Its name and what imported it at the base | Is anything left that needed it? |
| A changed policy | The abilities added, removed or rewritten, method by method | Who can do what now? |
| A changed dependency | The package and the versions on both sides | Is this one meant? |
| An acceptance test edited, a gate input changed, a removed guard | The hunks, with the ids or the route they concern | These are high: two people |

Items are ordered by lane, then existing server code, schema, added files and
deletions, and an item the reviewer commented on carries the comment. The
list ends with a count of what it left out, the facts at low, so the person
sees how much was not shown. `evidence.md` carries the same list as links to
the lines at the head, for a person away from the Dev Center.

The list is also where a plan gets better. An item that reads "the plan left
this out" is one the next plan can declare, and `plan:verify` already names a
file no element owns while the agent's session is still open (§5), so the
cheapest item is the one that never reaches the list.

**The line page.** `factory:status` (below) and the numbers of §11.

**Starting it.** Today the Dev Center exists only while the application's dev
server runs, which needs its database and environment. It becomes something
that is simply there:

- `guren dev-center` serves `/_guren` by itself, on a loopback port the system
  picks, under the guards it has today, and writes its address to
  `.guren/dev-center.json`. The handler already takes a directory and never
  imports the application: it reads plan files, `.guren/` and `gh`, and builds
  the graph through the introspection child. So it needs no database and no
  boot. What does need the running application (runtime errors, the UI
  catalog's preview) is shown as unavailable until `guren dev` runs, which
  keeps mounting the Dev Center as it does now.
- The harness starts it. The session-start hook runs `guren dev-center
  --ensure`, which starts one for the checkout when none is running and
  prints the address, so whenever a session is open on the person's machine
  the inbox is one link away, and the agent's hand-off line can point at it.
- It starts read-only. The decisions listener still needs `GUREN_DECISIONS=1`
  from the owner, and no hook sets it.

This covers a person at their machine, including one whose agents run in the
cloud: their own Dev Center shows that work through `gh`. It does not cover a
person away from the machine, who has the pull request's `evidence.md` (Open
Question 15).

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
automatically, and from deliverable 6 the lane job requests a reviewer for
any medium or high floor); the harness's hand-off line, which ends with the
inbox count; and the count in the Dev Center's tab title.

**Deciding there.** Today the Dev Center has one write and copies every
decision command for the person's terminal (RFC 0030 §8, amended 2026-11-01).
For the Dev Center to be enough, a decision has to be possible in it, so it
gains a closed set of actions:

| Action | Runs | Bound to |
| --- | --- | --- |
| Approve or close a plan, waive an element | `plan:approve`, `plan:close`, `plan:waive --reason` | The plan file and its digest |
| Approve or request changes on a pull request | `gh pr review`, with the person's text | The repository, the pull request and its head SHA |
| Triage an issue | `gh issue edit` (label, assignee), `gh issue close` | The repository and the issue |

**What a confirmation holds.** The action, its target and the exact candidate:
a plan's digest, or a pull request's head SHA. The person confirms that tuple
and the text they wrote. At the click the listener reads the candidate again
and refuses when it moved: a plan edited since, or a pull request that gained
a commit, is shown again and not acted on. A plan that exists only in a pull
request is decided by approving that pull request (§5), never by running
`plan:approve` on a local file that may differ from it.

**The listener.** The application answers on `127.0.0.1` as it does on
`localhost` (the MCP Apps sandbox notes that its proxy's origin "is the
application itself"), so a second hostname on the same port is not a separate
place. Decisions are confirmed on a listener of their own:

- It is opened by the provider that mounts the Dev Center, after the
  application's listener has bound its port, on a loopback port the system
  picks. Its address is published in the Dev Center's JSON, so nothing
  derives it from a port that `bin/serve.ts` may have walked past. It is
  closed with the application, and replaced on a hot reload with a new token.
- It starts only under the guards the Dev Center has (development,
  `GUREN_MCP=1`) and `GUREN_DECISIONS=1`. No template sets that flag;
  `guren add review` offers to add it to the `dev` script, so turning it on is
  the owner's act. `browser:serve` never sets it and removes it from the
  child's environment: the instance an agent drives for browser verification
  has no decisions listener.
- It answers one `Host` (its own address and port) and 404s every other, which
  closes DNS rebinding. It serves the confirmation document and the decision
  endpoint and nothing else.
- The token is per process and exists only in the confirmation document. The
  Dev Center's own pages, which share the application's origin, never hold
  it: they open the confirmation's address with the action and the target,
  and that is all they can do.
- The endpoint requires the listener's exact `Origin` and the token in a
  custom header, so a cross-origin request is preflighted and a plain form
  post is refused. The confirmation is sent with `frame-ancestors 'none'` and
  `Cross-Origin-Resource-Policy: same-origin`, so it cannot be framed or
  fetched.
- A request names an action and a target. The server builds the command;
  nothing from the request reaches a shell. The action is refused unless the
  existing dry run says it would go through, and every action is appended to
  `.guren/decisions.log`.
- Merging is not an action. The platform does it once the approvals are
  there: the repository's auto-merge, or for a stack the merge of the highest
  task that is ready (§5).

A prototype of the listener was attacked from an application page in a
browser, from `localhost` and from `127.0.0.1` on the application's port:
reading the confirmation, framing it, loading it as a script, and posting to
the endpoint by `fetch` and by form were all refused, and only the click on
the confirmation itself was accepted (Measurements).

**What this does not do.** It separates the confirmation from scripts in the
application's pages. It does not tell a person from an agent: an agent that
drives a browser can open a confirmation and click it, which is why RFC 0030
kept the buttons from executing ("nothing here can tell the person from the
agent"). Three things stand against that, none of them a proof. The listener
does not exist in the instance `browser:serve` starts, the one an agent's
browser verification uses. The flag is the owner's to set. And an agent with a
shell can already run `plan:approve`: the harness rule that forbids it, and
the decisions log that shows it, are the same guard there as here.

This reverses a choice RFC 0030 made on purpose (**decided 2026-11-13** by the
maintainer, and confirmed 2026-11-14 with the limit above stated, Open
Question 14). It ships as its own deliverable, and RFC 0030
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
  which is deliverable 6 and not before.
- A decision made in the Dev Center is separated from scripts in the
  application's pages, not from an agent that drives a browser (§12).
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

Seven deliverables. The first is the smallest thing that is useful by itself
and produces the data the rest is judged on. Each later one names what it
needs first.

| Deliverable | Ships | Needs first | Produces |
| --- | --- | --- | --- |
| 1. Report | `resolveChange()`; `change:lane` with the facts read from the head and the diff (paths, migrations, schema, audit, acceptance, dependencies), every other fact `unjudged`; `change:evidence` wrapping the gate, with plan and browser evidence reported as unavailable; the versioned record, uploaded even on failure; the pull request summary; the `lane:` label; `guren add review` | Nothing | A floor and its reasons on every pull request, and the floor-against-label data of the shadow comparison |
| 2. The Dev Center, read side | `guren dev-center` and the session-start hook that starts it; the inbox, the change page with its reading list, the line page and `factory:status`, reading local files and `gh` | 1 | One page that lists what waits on a person, cloud work included |
| 3. Decisions and plan approval | The listener and the action set of §12; `plan:approve --propose` and `--from-merge`; the amendment to RFC 0030 §8 | 2 | A person who decides without a terminal, and a plan approved by merging it |
| 4. Lessons | The `lesson` type, `make:lesson`, delivery through `context` and the harness, the `fix` skill, the canonical review contract, the tests step handed to `test-writer` | Nothing | The loop from a finding to a rule or a check |
| 5. Structural evidence and delegation | Per-route security records and base records; a fresh-clone `plan:verify` with red runs from the change's commits; the browser aggregate and behaviour specs; the declaration matcher; the forecast; the plan sections `env`, `providers` and `config`, and the navigation module with its layout and the `navigation` section (§5) | 1, and for approval standing 3 | Evidence complete enough for a low lane, measured on real histories: the share `unjudged`, the share `unobserved`, declarations matched |
| 6. Enforcement | The lane job and the GitHub settings of §8 | 5, and the shadow bar met | Low changes merging without a person |
| 7. Release and sweeps | The release record, `browser:doctor --landmarks-only`, the sweep template, the monthly numbers | 1 | The line closed from production back to intake |
| 8. Screens first | `screens: 'first'` in the plan and its task derivation, the screens task under the `proposed` standing, the two owners in the task derivation, the `TestApp` option that turns fixtures off, the prototype artifact and the Dev Center's walk, the deploy workflow's `prototype-routes` check, and `inProduction: 'skip'` (§5) | 3, and RFC 0021 as shipped | A plan approved on its prototype through the loop, with the page defects found at the walk counted against those found after |

Until deliverable 5, a plan's evidence is reported as unavailable and a change
under a plan is held, so nothing is called low on evidence that was not
gathered. Until deliverable 6, the lane is information for the person who
merges.

Follow-up RFCs, named so they are not mistaken for done: cloud environments
other than Claude's (an amendment to RFC 0008), feature flags, a
production error reporter that files issues, the headless plan producer
(RFC 0030 D1), reviewer eval cases, and `app.use()` in the introspection
manifest.

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
   approval. The agent runs `plan:approve --propose`, which writes a proposal
   and no approval; the standing is `approved` once the store shows the pull
   request merged with an approving review by someone other than its author.
   An ancestor commit alone approves nothing (§5).
5. ~~**Leaving shadow mode.** What agreement justifies enforcement?~~
   **Resolved (2026-11-14):** a default bar the team may change, judged from
   the floor against a person's `lane:` label: 50 pull requests over four
   weeks, none of the low ones reverted or labelled high, at most one in
   twenty labelled medium (§8).
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
    span accounting is not scheduled: a prototype accounted for 6 of 26
    edited files, and what it left over were edits a person should see (§3).
14. ~~**Deciding in the Dev Center.** RFC 0030 kept the Dev Center to one
    write and a copied command, on purpose.~~
    **Resolved (2026-11-13):** the Dev Center runs the decision, under the
    rules of §12. The confirmation and the endpoint sit on a listener of
    their own, since the application answers on `127.0.0.1` as on
    `localhost`, so a script injected into the application's pages can
    neither read nor post. That separates the confirmation from page
    scripts, not a person from an agent driving a browser, which RFC 0030
    gave as its reason; the listener is therefore absent under
    `browser:serve`, and the rest is the harness rule and the log.
15. ~~**Away from the machine.**~~
    **Resolved (2026-11-14):** the pull request's `evidence.md` and GitHub's
    notification are enough. No snapshot, and the Dev Center stays
    loopback-only.
16. ~~**Knowing when to look.**~~
    **Resolved (2026-11-14):** GitHub's review-request notification, the
    count in the harness's hand-off line, and the count in the Dev Center's
    tab title (§12).

### Measurements (2026-11-14)

Each row says what was counted and what that supports. None is a measurement
of the design in use: the commands do not exist yet.

**From git histories.** The 10 applications, out of two dogfooding runs, that
headless sessions built through the plan loop with commits naming their
steps: 170 step commits in 43 tasks, and 364 acceptance ids. An eleventh
history repeats one application's task commits and then makes a change
request outside the loop; it is counted once, under that application. The
10 are five application ideas: one built once, three built twice and one
three times, each time by a separate session from the same brief, so they
are less than ten independent samples, and all are new applications. The
plan composition is over every plan of both runs, 3,144 elements with a
change kind. No test was run for these: they are counts over commits, diffs and plan
files. "Existing" means present at the commit before the plan's first step,
which for a later task is not that task's own merge base.

| Counted | Result | What it supports |
| --- | --- | --- |
| Commits after a plan's approval named `task/…` | 170 of 207; the rest are the driver's own | The convention holds unenforced. Nothing here depends on it |
| Ids whose first commit touches no controller, routes file or policy | 364 of 364. The 20 ids of the change request made outside the loop all arrive with their implementation | Candidates for reproducing a red run. It does not show the test failed there, or why. Outside the loop nothing orders the test first |
| Step commits changing `bun.lock` | 1 of 170; 160 have the lockfile of the plan's last step | The head's install can usually be reused (§4) |
| Plan elements by change kind | add 2,881, alter 130, existing 116, drop 17 | 92% additions, in applications built from a starter |
| Whole plans editing nothing but new files | 0 of 10 | A plan is not the unit that flows (§5) |
| Tasks editing nothing existing | 5 of 43 | An upper bound, by paths alone, on what could be low as first specified |
| Tasks editing only the schema and the routes entry beyond that | 6 more (11 of 43) | The same bound once both are judged by what they declare (§3) |
| Tasks editing the application entry, existing client code, existing server code | 7, 5 and 20 | Where one person reads. The layout's navigation is edited in nine of the ten applications |
| Tasks that could be low once the application entry, environment keys and navigation are judged structurally | 18, 23 and 28 of 43, cumulatively; 35 with edits a changed element owns | The upper bound the plan sections of §5 would buy. Paths alone, as above; the prototype under **Run** applies the rule |
| What the plans did to the layout | 9 of 10 edited it, always in a pages step: 26 links added (25 by a literal path) and 14 of the starter's removed, the brand renamed in 6; of the 26, 7 for everyone, 12 for a signed-in user, 1 for a guest, 6 behind a role or admin check | What the navigation module has to make unnecessary (§5) |
| Where the applications authorize | `authorizeMiddleware` in 0 of 10; 73 calls of `this.authorize()` or `this.can()` in controllers; a role middleware of the application's own on two route groups in 1; a `can…` boolean passed to a page in 4 | A link's visibility can seldom come from its route, so the navigation is filtered on the server by the gate (§5) |
| Step commits editing nothing existing; only the schema and routes entry | 80 and 38 of 170 | The per-step figures. A step is not a mergeable unit, since a tests step fails the gate |

**Run.**

| Question | How | Result | What it supports |
| --- | --- | --- | --- |
| What does reproducing red runs cost? | One history (42 behaviours) in GitHub Actions, Bun 1.4.4: a worktree per commit that first carries an id, the head's install linked in, `codegen`, that commit's test files | Three commits, 0.3 s to prepare and 0.1 to 0.7 s to run each | A warm run with identical lockfiles. Not the cost of a cold preparation or of a commit with another lockfile |
| Is a failure there a red run? | The same run | Two commits failed on assertions (a 404 where the plan expects a redirect). One failed loading a helper that imports a model a later step adds. A first run with no application key failed every case at the head too | Why a load failure is `unobserved` and the head is the control (§4). Under that rule one of the three would not have counted |
| Does code owner review block with zero required approvals? | A public repository, a ruleset, three pull requests | Yes for an author who does not own the path, and it clears on the owner's approval. A pull request the owner opens is not blocked | §8 |
| Can edits inside a file be matched to the plan? | A parse of each edited file's spans against the plan's declarations, over the 10 histories | 6 of 26 files, 48 of 134 lines | Not scheduled (§3) |
| Do the list edits hold nothing but entries? | A prototype that parses both sides of every step commit's edit to the application entry, `config/env.ts`, the routes entry, the schema and the layout, checked against mutated copies of each | Application entry 25 of 25, environment keys 5 of 5, routes entry 27 of 27 (each one registrar call), schema 22 of 33 (the rest change an existing table), layout 1 of 9. Tasks that could be low: 18, 23, 24 of 43 where paths gave 18, 23, 28 | `env`, `providers` and `config` buy what paths promised. The navigation module alone buys one task (§5) |
| Which step brings the defects a person has to see? | The 80 task defects by the kind of step whose commit introduced them | Pages 27 (13 user experience, 11 accessibility, 2 performance, 1 correctness), http 36, scaffold 14, tests 2, data 1. Every accessibility defect came from a pages step | Why the screens come before approval (§5) |
| What do the tasks look like without their pages? | The same paths with each task's pages step left out (23 steps) | 13 could be low today, 25 with the application entry, 30 with environment keys, of 43 | The bound screens first would give the tasks that remain. The screens task is a person's |
| Does the navigation design cover what the plans did to the layout? | The nine layout edits read against §5: entries added, changed or removed, the account controls and their labels, the brand, `<Layout wide>` | 7 of 9 are declared entries alone; the other 2 also change the page's vertical padding. Of the five tasks that only the layout kept out of low, 4 fit: 27 of 43 | The layout, the width and the declared removal are part of the module, not additions to it |
| What floor do the facts of §3 give the measured tasks? | A prototype of `change:lane` over the 43 tasks: the path facts, `judgeMigrations()`, the schema and routes files read on both sides, and a matcher against the plan at the head (change kind, identity, planned properties), checked by 20 cases that mutate a plan and expect the match to fail. Security records, audit facts and advisories were not computed | 5 low, 30 medium, 8 high where paths gave 11. 7 low with `env`, `providers` and `config`; 13 with a plan's commands declaring what they write and a plan-added file staying an addition. 1 low while base records are missing. Matched: 112 of 112 routes, 24 of 24 policies, 194 of 261 added files, 23 of 27 added tables, 24 of 28 migrations. 19 of 43 tasks were not contiguous in these histories and were read run by run | The floor paths could only bound, and the rules §3 was missing: what "existed" means in a stack, files a command writes, generated files, a deleted file, a missing base record |
| How much of a medium task does a person read? | The reading list of each of the 43 tasks under the rules of §3, against every changed line of the task (lockfiles, generated files and binary uploads left out), first as the files behind the facts above low, then as what those facts point at | Medium, 22 tasks, 11,196 changed lines with migration snapshots left out. By target: 642 changed lines in existing files (median 20 a task, at most 90), 13 undeclared columns and statements, 19 added files (960 lines), 9 deletions. By file the same facts cover 3,618 lines, half of them snapshots. High, 8 tasks, 5,236 lines. Low, 13 tasks, 2,405 lines, none to read | That the lane counts tasks and the person reads targets (§5, §12): 6% of a medium task's diff, 14% with every added file opened |
| Would a smaller unit be a readable one? | Each task cut along its step commits into slices (commands; scaffold; tests, data and http; pages) and into single steps, a unit stopping when it touches a file behind one of its task's facts above low | Tasks: 43, median 338 lines, 30 stop, holding 17,538 of 20,161 lines. Slices: 89, median 194, 48 stop, 13,903 lines. Steps: 170, median 121, 70 stop, 11,094 lines | Why the task stays the unit that merges and the reading list is the unit a person reads (§5). The lanes of slices and steps are read from files, not from facts recomputed per unit |
| Does the screens-first derivation work on real plans? | A prototype in a worktree: `screens: 'first'` in the schema and the derivation, run over the ten plans, and the approval, status, verification and revision functions called on a small application in its own repository | 43 tasks become 53. 45 views move; of 112 added routes a view names 66, 38 more only render one, 8 do neither, 4 return JSON; 35 of 36 validators move; 65 registrations bind a model not yet written. Approval after the screens settles all ten collisions as built. A view owned by the screens task alone never verifies. A route on its fixture reads `drifted`. `plan:revise` refuses a proposed plan, and a revision's added or renamed element is refused at approval. An unproposed draft passes `plan:next` and `plan:verify`. Today's scaffold writes no file of a screens step in any of the ten | The corrected table of owners in §5, the tests step of the screens task, the stamps beside the baseline, and the three checks that keep work before approval to screens |
| Do `skip` and fixtures-off work on the framework as it is? | A prototype in a worktree, driven by probes on a minimal application, one process per scenario, and a bundle built with the production define | Under `skip` the boot succeeds, the fixture is never evaluated, a dark `/posts/new` answers 404 where the omitted route was answered by `/posts/:id`, and the refusal's read of `NODE_ENV` survives bundling. Fixtures off cannot be a boot setting on a shared application; carried per request by the `TestApp` it works in both orders, and a guard and a contract answer before the 501. A route on its fixture already redirects a guest and refuses an invalid body | The rules of §5 for `skip`, for the test switch, for promotion, and the behaviours that lose their red run |
| Does the navigation module work on the framework as it is? | A prototype in a worktree: the definition, the filter, the lazy prop, a syntax reader and both writers, driven by probes on minimal applications with four identities | A config definition's `boot` hook can share the prop, with routes and gate in reach. A guest's payload carries no ability, hidden label, hidden route or denial message. The prop is skipped on partial reloads that do not ask for it and on JSON. A missing route name answers 500 on every page unless the entry is linked at boot. No type lists route names today. A policy that reads a `null` user throws for every guest. All 24 append round trips read back; 19 removals restored the bytes | The runtime rules of §5 that the first text left to `guren check` or did not state |
| Can the navigation checks be read, and are they right? | A prototype over the 31 links the plans wrote, their routes, actions and policies, by syntax | Every link, route, action and policy method read. Sign-in mismatch: 4 warnings, 4 right. Role checks that restate an ability the action authorizes: 4 of 6, all nameable. Policy methods: 8 user only, 29 a required second parameter, 8 an optional one. 74 of 85 candidate routes make no `authorize()` call | The three readings of §5, and that the comparison has to start from the action, since no layout names an ability |
| Do merge bases have a completed push run? | This repository's last 60 merged pull requests | 60 of 60, at most four days before the merge | That the runs exist. Not that their records would be comparable, and not stacked pull requests, of which there were none |
| Does storing and fetching a record work? | A workflow on a test repository: the push run uploads `guren-record-<sha>`, the pull request run asks the artifacts API for its merge base's, with a read-only token | Found for a branch cut from a commit that had a push run; reported missing for one cut before the workflow existed | The mechanism of §3 |
| Can an application page reach a decisions listener? | A prototype on its own port and an application page on another, driven in a browser from `localhost` and from `127.0.0.1` | Every read, frame, script load and post refused; a foreign `Host` and a request with no `Origin` refused; the click on the confirmation accepted. A script can open the confirmation and cannot answer it | The isolation of §12 from page scripts. Nothing about an agent that drives the browser |
| What does filtering the navigation cost? | The gate alone, a policy with two synchronous abilities, ten checks per visit | 12 microseconds per visit; a guest is denied | The framework's share of the cost (§5). Of the 8 `create` and `viewAny` methods in the measured applications, the 3 that take the user alone are synchronous; the 5 that take a context cannot be named in navigation, and 4 of those query (1 or 2 queries) |
| Does the harness's own review run? | The implementation logs of 52 runs | The `code-review` agent was called in 4, and in none of the 10 step-by-step runs | §7 |

**From the independent evaluations.** Each of the 10 applications was walked
and probed by a separate evaluating session, whose report lists the defects
of the application's own code. Three read-only agents located every such
defect in the code and blamed the line to a commit: 97 defects, each then
joined to the path class of the task that commit belongs to.

| Where the defect came from | Defects | High, medium, low |
| --- | --- | --- |
| A task that edits existing server code | 38 | 1, 12, 25 |
| A task that edits existing client code | 20 | 0, 8, 12 |
| A task that edits the application entry | 16 | 0, 6, 10 |
| A task that adds files only, or edits only the schema and routes entry | 6 | 0, 1, 5 |
| The starter, left as scaffolded | 13 | 0, 7, 6 |
| After the steps (the driver's verification, or a squashed history) | 3 | 0, 1, 2 |
| A task whose class did not resolve | 1 | 0, 1, 0 |

So of the 80 defects a task introduced, 6 sit in the 11 tasks that paths
alone would let be low: none high, one medium. That is about 0.5 per such
task against about 2.3 per task among the other 32. It is a first estimate
and no more: the defects are what one evaluator noticed, a model located
them, and a blamed line is a best fit for defects like a missing check. What
the 80 are also says what the floor does not see: 20 are user experience, 18
performance, 14 correctness, 11 accessibility, 8 validation and 7 security,
and no fact of §3 reads any of them. They are the reviewer's and the reading
person's, which is why low requires a review (§8).

**Cost.** Not measured, and stated so that it is not guessed. A plan here has
about four tasks (43 in 10), so about five pull requests with the plan's own.
The platform reviewer is priced by the vendor per review and by depth; at the
15 to 25 dollars a review that Anthropic gives as its own average, that is
roughly 75 to 125 dollars a plan before any second round. The evidence adds
seconds to the gate for red runs, and a stack runs the workflow once per task.
How long the gate takes on a real application was not measured.

### Still to be measured

- **Deliverable 1, in use.** The shadow comparison: the floor against the
  person's `lane:` label, and what became of the low ones.
- **Deliverable 5.** The same task and defect counts on real merge units with
  the security records in place (the declaration matcher has run, above); the share of red
  runs that are `reproduced` under the rule of §4; cold preparation time.
- **Deliverable 6, on a repository.** The lane job end to end, including
  whether GitHub's auto-merge applies to a stacked pull request, and the
  reviewer's check as it arrives on a real pull request: its conclusion and
  the severity line are taken from the vendors' documentation, and this
  repository has no reviewer installed to read them from.
- **Screens first.** Nothing of it has run through the plan loop: whether a
  session builds the screens task from a proposed plan, what the walk finds
  that the evaluations found after, and whether the promoted tasks keep the
  pages untouched as the paths assume.
- **Lessons.** Whether a lesson delivered through `guren context` changes
  what the next session writes: the same task run with and without it.

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
- https://code.claude.com/docs/en/code-review-pull-requests.md
- https://code.claude.com/docs/en/cloud-environments.md
- https://cursor.com/docs/bugbot.md
- https://docs.github.com/en/pull-requests/reference/stacked-pull-requests
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
