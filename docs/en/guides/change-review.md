# Change Review

`bunx guren add review` installs a GitHub workflow that judges every pull request before a person reads it. For each change it records the facts that matter to a reviewer (a migration, a route that lost its policy check, a new dependency advisory) and the review lane they set as a floor: `low`, `medium` or `high`. The four `change:*` commands are what that workflow runs, and you can run each of them locally.

| Command | What it does |
|---------|--------------|
| [`change:lane`](#changelane) | Reads the change between two commits and prints its facts and lane |
| [`change:evidence`](#changeevidence) | What CI runs: the gate plus the lane, written as files for the job summary |
| [`change:records`](#changerecords) | Prints each route's security record, the input `change:lane` compares |
| [`change:policy`](#changepolicy) | Regenerates the generated block of `REVIEW.md` |
| [`make:lesson`](#lessons) | Records a lesson that reviewers and agents read |

## Set Up the Workflow

```bash
bunx guren add review
```

`add review` installs the Change workflow, which runs `bunx guren change:evidence` on every pull request and every push to `main`. It is for an application at the root of its repository, since GitHub reads workflows from there alone, and it refuses one below it. The command writes six files once (eight for an app whose harness includes Cursor, with `APPROVAL_POLICY.md` and `.cursor/BUGBOT.md`), and a re-run leaves each one that exists alone unless you pass `--force`, which replaces every one but `REVIEW.md`:

- `guren.review.ts`, the review policy (below).
- `REVIEW.md`, which Claude Code Review reads: your rules for a reviewer, and a block `bunx guren change:policy` generates from the application (what `change:lane` always puts at `high`, the models with sensitive columns, the routes that change data with the middleware and the policies their action names, which says where to look rather than that a policy is enforced, and the routes agents can call on the surfaces they are exposed to). Once it exists, only its generated block is rewritten, by `change:policy`. It is not written when the application does not load, since a block describing nothing would read as current.
- `.github/workflows/change.yml` checks out the pull request's head commit (not GitHub's merge commit) with its full history, fetches a base no branch keeps (after a force push), runs the evidence again when a pull request is retargeted to another base, downloads the record a push run on the default branch stored for the merge base and passes it as `--base-record` (with `actions: read`, and only from such a run, since a pull request writes none of them), adds `evidence.md` to the job summary, and uploads `record.json` as `guren-record-<head sha>`. The job fails only when the gate fails: the summary and the record are kept when it does, and a failed upload does not fail it. Add `--no-deps` to the evidence step if the runner cannot reach the npm registry.
- `.github/pull_request_template.md` asks for the issue and the plan, and asks the reviewer, in text the pull request shows, for one `lane:` label: the review the change needed in their own judgement, whatever floor the workflow printed. The job summary repeats the request, since a pull request opened with `gh pr create --body` never uses the template.
- `.github/ISSUE_TEMPLATE/feature.md` and `defect.md`.
- For an app whose agent harness includes Cursor (`bunx guren agent:init --target cursor`), `APPROVAL_POLICY.md`, which Cursor's PR Routing & Approval reads: approve only a pull request whose Change evidence reads `eligible for low`. `change:policy` then also keeps `.cursor/BUGBOT.md`, which Bugbot includes on every review, with the same block, cut to what is always read by a person when the whole file, your rules included, would pass the 30,000 characters Bugbot reads; one that passes it even so is refused, and neither file is written.

The labels have to exist before a reviewer can pick one, so the command prints the three `gh label create` lines. The Change workflow runs the same gate as the scaffolded `ci.yml`, and the command says so when that file still has its `bunx guren gate` step, which can go once the Change workflow has passed on a pull request.

## Keep `REVIEW.md` Current

Run `bunx guren change:policy` after a change to routes, policies, models, lessons or `guren.review.ts`; `--check` writes nothing and exits 1 while the block is stale, and both exit 1 without writing when the application cannot be read.

The block describes the application as it registers without its env files (`.env` and the rest Bun would load, which a machine keeps out of git), so it reads the same on your machine and in CI: whatever an env file in the application or in the directory you run from sets, under any `NODE_ENV`, is left out, and a variable your shell exports at another value still applies, unless an env file builds its value from another variable (`${PORT}`), which is left out whatever it expands to.

`change:evidence` runs the same check where `REVIEW.md` exists and holds the change while its block is stale (`review-doc-stale`) or the application cannot be read for it (`review-doc-unchecked`), without failing the workflow. `change:lane` reads any edit to `REVIEW.md` as `high` (and to a `BUGBOT.md`, an `APPROVAL_POLICY.md` or `.cursor/approval-policies/`), the generated block included: the reviewer reads the whole file, and nothing in a change checks the block against the application.

## The Review Policy

`guren.review.ts` changes the lane `change:lane` and `change:evidence` give a change:

```ts manual
import { defineReviewPolicy } from '@guren/cli/review'

export default defineReviewPolicy({
  approvals: { low: 0, medium: 1, high: 2 },
  paths: { high: ['app/Billing/**', 'config/session.ts'], medium: 'config/**' },
  facts: { 'agent-tool': 'high', 'schema-changed': 'low' },
  identities: 'auto',
  merge: { low: 'person' },
})
```

- `paths` sets the floor of a change that touches a matching path, relative to the application root. `*` matches within one segment and `**` across any number, and a glob with neither names a file or a directory, as in CODEOWNERS. Any other glob syntax (an empty, `.` or `..` segment, braces, brackets, `?`, an extglob such as `@(a|b)`) makes the policy unreadable rather than match nothing. Each glob that matches is a `review-path` fact.
- `facts` sets the lane of a fact. Any fact can be raised. Only a fact a plan could declare can be lowered, and only as far as a declaration would take it: `schema-changed`, `migration`, `file-added` (an added source file, or an edit read as the plan's addition, which a raise set for `source-edited` still reaches), `policy-added`, `file-removed` (a deletion a plan declares, which a raise set for `source-removed` still reaches), the route facts (`route-added`, `route-changed`, `route-removed`, `agent-tool`) the application entry's list facts (`provider-added`, `config-added`) and `env-added` to `low`, `policy-changed` and `dependencies-changed` no lower than `medium`. The facts that are always high (a gate input, a destructive migration, an edited acceptance test, an audit failure) and the other edits to existing source cannot be lowered, and neither can an added file that is not source or a function inside a schema's tables and code beside them. The report prints `lowered by guren.review.ts` or `raised by guren.review.ts` beside each fact the policy set.
- `approvals`, `review`, `identities` and `merge` describe how a change of each lane is to be approved and merged. Nothing enforces them yet: `evidence.md` prints the approvals the floor would need.

The policy that applies is the one at the merge base, so a pull request that edits `guren.review.ts` is judged by the policy it started from, and the edit (a gate input, so `high`) takes effect once merged. The file is read as data and never run, so every value has to be written in place: a variable, a spread or a function call inside it, a key the policy does not know, or a lowering it does not allow makes the whole file unreadable. An unreadable policy is applied not at all, and the change is held at `high` with the reason under "Not judged", since a raise it holds would otherwise not show.

## `change:lane`

```bash
bunx guren change:lane --base 9f2c1ab --head 4e7d0c3
```

`change:lane` prints the facts of a change between two commits and the review lane they set as a floor (`low`, `medium` or `high`). The facts are read from git objects and never from the working tree: gate inputs, plan records, migrations, schema tables, acceptance tests, policies and dependencies. `--base` and `--head` take commit SHAs, and the change is read from their merge base. It exits 0 whatever the lane, and `--json` prints the versioned report.

### The Audit of Both Sides

It also audits both sides of the change and reports what the base did not have: an audit failure, a sensitive column in a response, a CSRF exemption, a security default switched off, a model rule's warning (`mass-assignment`, `owner-fillable`, `hidden-columns`) new on a model the change edits, or naming a column the base's did not, a suppressed finding. For that it exports each commit to a temporary directory and runs `guren audit` there with the install on disk, which loads the application's code under the environment of the shell that ran the command.

The audit is not taken when a commit's lockfile is not the one installed, when nothing is installed, when a package is installed from the repository itself (a workspace member, a `link:` or `file:` dependency), or when a commit tracks a symlink inside the application; `--no-audit` skips the step.

### Facts a Plan Declares

A fact an approved plan declares takes the lane the declaration gives: while a plan is approved at its current hash and not closed, and the change writes no plan record, an added source file that `plan:scaffold` writes for an element the plan adds and an added table of a model the plan adds are `low`, with the plan and the element beside the fact (`declared by docs/plans/comments/plan.json#model.comment`).

- **Files.** The file is at that path and exports the names the scaffold's own output exports; a policy's provider must be the one the scaffold writes, a policy or controller file must hold nothing but imports, types and the class, which extends the base the scaffold imports and has no member but the planned abilities or actions.
- **Tables.** The table must be declared as the scaffold writes it into that schema, columns, defaults, keys and indexes included; the code inside it that the schema reader does not follow (a `sql` default, the index callback) is then the scaffold's own and no longer keeps `db/schema.ts` at `medium`, and neither does listing it in an object of tables, while a table dropped from such an object does.
- **Migrations.** An added migration is `low` too when it does nothing but create the tables the plan adds, in the statements drizzle-kit writes, read both as a whole and as drizzle's migrator cuts it at `--> statement-breakpoint`: each `CREATE TABLE` has exactly the planned columns, each with the type, nullability, keys and default the scaffold's builders give it, every planned unique, index and foreign key (with its delete rule) is stated once, after its table, and nothing else is, its folder holds `migration.sql` and `snapshot.json` and nothing else, and the snapshot is the previous migration's plus what the SQL creates.

### Route Facts

When both sides' security records are compared (below), a route the head registers with no counterpart at the base is `route-added`, a base route no head route matches is `route-removed`, a matched route whose record differs in anything is `route-changed`, and a route gaining, changing or losing `.agent()` is `agent-tool`, each `medium`.

An added route is `low` when the plan adds it in the project root with the same method, path and name, and its record holds what the plan states: the planned controller action as the scaffold's controller file exports it, exactly the planned middleware by name (an `auth` that requires a user), the planned bindings by model file and export, the planned agent metadata, each contract as the planned validator's export from a plan model's validator file, rendered with the planned keys, types, requiredness and rules as `plan:status` judges them, and an `authorize()` call of the planned policy ability on the policy's model, `[Model, record]` where every route to the action binds one record and otherwise that or the bare class, awaited as a statement of the action's body, in a controller that imports that model under its own name from its file and binds the name nowhere else.

- A route whose name another registered route has is not declared.
- Since `--mount` registers the scaffold's routes first, a route is not declared while a route registered after it that the change does not add, of the same method or `ALL`, has a path some request could match too.
- A binding is read with its lookup column, so a planned `key` is held to it and an unplanned one shows as a changed route; on an older `@guren/core` the columns are unread, and no binding is declared.
- The routes file the scaffold writes is `low` when it is that file as the scaffold writes it against the head's model and validator files, and the edit to the routes entry no longer keeps the change at `medium` when it is exactly what `plan:scaffold --mount` writes, the mounted file is still what the scaffold wrote, and every route fact of the change is a declared addition of that file's routes, each once, unless an alias the mounted file sets is one another route uses, directly or through a group, and no top-level statement of the entry's registrar sets it on its router after the call.
- The `authorize()` call must be one the action awaits as a statement of its own body, with no statement before it that may return; the entry is read as written, so an entry statement that does not run reads the same, which the report says beside a declared route.

A file or table a second open plan also claims stays where it was.

### The Application Entry, Env Keys and Commands

- An edit to the application entry (`src/app.ts`, else `app.ts`) that only adds entries to the `providers` and `config` arrays of its `createApp()` literal (the factory imported from `@guren/core`, called at the top level), each a name, with the import binding it, is a `provider-added` or `config-added` fact per entry, `medium`. Anything else in the file keeps it `source-edited`, and so does a literal holding a spread, a computed key or `__proto__`, a method or accessor named after a list, or an added import of a name the rest of the file reads.
- A provider is `low` when the entry is exactly what `plan:scaffold` writes for one scaffold step's providers, and the provider and the policy it registers hold what the plan declares (the provider whole, the policy its planned abilities). A declared file with a twin of another extension beside it (a `P.js` beside `P.ts`, which Bun runs in its place) is not declared.
- An entry an open plan's `providers` or `config` element adds is `low` when the entry is a default import of the element's file (`app/Providers/<className>`, `config/<name>`) and one plan alone adds it ([Providers and config](./implementation-plan-format.md#providers-and-config)).
- A key added to `defineEnv()` in `config/env.ts` is `env-added`, `medium`, and `low` when an open plan's `env` element adds it and its builder chain declares what the element states ([Environment keys](./implementation-plan-format.md#environment-keys)).
- An added file that one open plan's `make:*` command writes is `low` while it is what the generator writes, or, where an element the plan adds in the command's module owns its class, while it passes that element's check; a provider and a routes file are always held to what the generator writes ([Commands](./implementation-plan-format.md#commands)).

### What Stays `medium`

A route changed or removed beyond what an open plan's `alter` or `drop` route states, a migration that does anything else, an altered table, a removed file no `drop` element of an open plan owns, what a blueprint or a generator writing several files writes, and an edited policy stay `medium` for now. An edit to a model or controller file an earlier task of the plan added is read as that plan's addition when the commit that added the plan's approvals did not have the file and every route's security record was compared.

When the merge base has a `guren.review.ts`, the facts are then raised or lowered as [the review policy](#the-review-policy) says.

### Dependency Advisories

When the change touches dependencies, it also runs `bun audit` on both sides of the `bun.lock` that governs each changed file (nothing is installed, the registry the base's `.npmrc` names is asked with no registry override from the environment, and both sides are read against today's advisories), and reports each advisory the head has and the base does not as `dependency-advisory`, always `high`; `--no-deps` skips it.

A manifest whose `bun.lock` did not change, a binary `bun.lockb`, a base with dependencies but no `bun.lock`, and a scan `bun audit` warned about (a registry it skipped) are listed as not judged. Any `.npmrc` is a gate input, since it names the registry an install asks.

### Security Records

In the same two exports it reads each route's security record (`guren change:records`) and compares base and head route by route, matched by controller action and then by method and path:

- A guard gone from the middleware chain, an `authorize()`/`can()` call or an `auth.userOrFail()` gone from the action, or an `authorize()` that no longer runs whenever the action does (now under a condition, after a statement that may return, in a `try`, behind `void` or `.catch()`, or in a helper) is `authorization-removed`, and one that never did is compared by the whole action, since a later statement may call it or act on its denial, and a contract schema or a validate call gone is `validation-removed`, both always `high`.
- A record it cannot order against the base (a reordered chain, a middleware with no capability removed, another ability or subject (a subject's class is followed through imports and re-exports to the file declaring it, so a class of the same name from another file is another subject), a validator replaced by another, a schema that lost a key or a bound, a schema an action validates with whose declaration changed, an action it could not read) is listed as not judged at `high`, as is a head the change made unreadable; one that only gained guards or bounds gives no fact.
- A call it cannot name (an ability built at request time, a gate asked by hand, a schema written in place) is compared by a digest of the action's body and of the declarations its arguments reach, so it is incomparable only when that source changed. An argument that names a local of the action widens the digest to everything the body names, and an inherited action is compared by its class statements along `extends`, so a change to either can read as incomparable though no guard moved; a schema or ability an inherited action names in another file is not followed. An import through an alias other than `./` or `@/` is compared by its specifier alone. The body of an inline route handler is not read.

Where the base cannot be rebuilt from this install, `--base-record <file>` takes the `record.json` an earlier run of `change:evidence` wrote for the merge base and compares its records with the head's, read alone; a record of another commit, format, deploy target or `NODE_ENV` is not compared and is listed as not judged with the run that would write a comparable one, and a record written by another version of `@guren/cli` or of the framework is compared and named beside the result.

### What It Does Not Judge

What it does not read (the records when the base cannot be rebuilt from this install and no stored record stands in, advisories it could not scan, a side it could not audit) is listed under "Not judged" and keeps the floor at `medium` or above.

## `change:evidence`

```bash
bunx guren change:evidence --base 9f2c1ab --head 4e7d0c3
```

`change:evidence` is what CI runs in place of the bare gate: it runs `guren gate --deps`, judges the change as `change:lane` does, and writes `evidence.json`, a compact `record.json` and `evidence.md` (a job summary) into the application's `.guren/evidence/` or `-o <dir>` (from where the command runs). It fails exactly when the gate fails: a file it cannot write is reported on stderr and changes no exit code.

What the evidence could not establish is a hold:

- a failed gate;
- a checkout that is not at `--head`, moved while the gate ran, or has uncommitted changes to tracked files;
- committed files the gate's codegen rewrote;
- a change it could not read (a shallow clone) or that holds no commit (a head behind its base);
- in this version, plan evidence while any plan at the head is not closed, and browser evidence for a change to a page, a routes file or a translation catalog;
- where `REVIEW.md` exists, a block `change:policy --check` finds stale or an application it cannot read for that check.

A change is eligible for low when its floor is low and nothing holds it. Credentials a failing command printed (a URL's user information, a secret-named `NAME=value`) are masked in every file.

`--routes` is the gate's, `--base-record` is `change:lane`'s, and `--no-deps` and `--no-audit` skip the dependency scans (the gate's and the advisories of both sides) and the audit of both sides. With the audit on, `record.json` carries the head's security records whatever the change touched, which is what a later change reads as its base record; the workflow `guren add review` writes downloads the one a push run on the default branch stored for the merge base and passes it, so a pull request stacked on another branch has none to read.

## `change:records`

```bash
bunx guren change:records --json
```

`change:records` prints each route's security record, the input `change:lane` compares: the middleware on its chain with the capabilities each declares (authentication, authorization), its contract schemas with the validator exports they are, its bindings and `.agent()` metadata, and the `authorize()`, `can()`, `auth.userOrFail()` and validate calls of its action.

It introspects the application without its env files, so the application's code runs, and reads nothing when a provider threw; what introspection skipped (a `createApp({ boot })` callback, a provider's `introspect()` hook) is listed beside the records, and `change:lane` reports it at `medium` while still comparing the routes both sides list; `--json` prints the versioned form, and it exits 1 when the application cannot be read.

## `change:policy`

```bash
bunx guren change:policy --check
```

`change:policy` regenerates the block of `REVIEW.md` that lists what a reviewer must read, from the application as registered (it introspects the app, as `browser:map` does), and creates `REVIEW.md` when there is none.

A stable lesson that names `paths` and no entity is listed there too, and written into a `lessons` rule for each installed agent (`.claude/rules/lessons.md`, `.agents/rules/lessons.md`, `.cursor/rules/lessons.mdc`, `.github/instructions/lessons.instructions.md`), scoped to the lessons' globs (relative to the application root, a module's lessons included; a `{a,b}` brace is expanded for Cursor and Copilot, whose lists are comma-joined) and removed once none stands; a file of that name it did not write is refused, and left alone while no lesson needs it.

Text outside the `guren:review` markers is yours and is kept; markers it cannot rewrite safely refuse the run with nothing written. `--check` writes nothing and exits 1 when a file it keeps is missing or stale.

## Lessons

```bash
bunx guren make:lesson "Load a comment through its post" --entity Comment --from 412
```

`make:lesson` records a lesson as a numbered file under `docs/lessons/` with one rule line in its frontmatter (`rule:`, the title when `--rule` is omitted). It starts as `status: draft`, which reaches nobody; once a person merges it as `stable`, `guren context <Entity>` prints its rule under Lessons for each entity it names.

- `--entity` fills `entities:`, `--paths` the globs a lesson without an entity governs, and `--from <commit|pr>` records where it came from (`source:`, with `--kind`: `review-finding`, `escaped-defect`, `revert`, `stall`, `waiver` or `declined-finding`).
- Once a check catches it, name it with `--enforced-by <file>#<name>` (or add `enforcedBy:` by hand).
- With `--from <commit>`, the commit that removed the defect, the command runs that test at the commit and at its parent and records `reproduced`: `true` when a test titled with `[<name>]` fails at the parent and passes at the commit, `false` when it passes at the parent, and `not-run` otherwise (with the reason in `reproducedBecause`; `--no-reproduce` skips the run). It runs the application's tests under the current environment.

`guren check --docs` fails a rule past 160 characters or an `enforcedBy` the file does not hold, and warns once the `review:` date has passed.

## Next Steps

- [CLI Reference](./cli.md) lists every other command.
- [Implementation Plans](./implementation-plans.md) covers the plans whose declarations lower a fact.
- [Checks and Audits in Depth](./cli-checks.md) explains the audit that `change:lane` runs on both sides.
