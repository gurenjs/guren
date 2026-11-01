# Implementation Plan Reference: Approval and Verification

This page collects the rules behind approval and verification, for when a verdict surprises you. The workflow they belong to is in [Implementation Plans](./implementation-plans.md); the terms are defined in its [Terms](./implementation-plans.md#terms) table.

## Impact

For every element the plan alters, renames or drops, the review page `plan:render` writes lists what in the application depends on it: relationships, routes with their `ApiRoutes` entries and agent tools, resources, policies, controller actions, tests, and for a column the places that read or write it. A plan that renames `posts.excerpt` to `summary` in the blog shows, under the column:

```text
PostResource reads it                              app/Http/Resources/PostResource.ts:32
posts/Index reads it through PostResource          resources/js/pages/posts/Index.tsx:80
posts/Show reads it through PostResource           resources/js/pages/posts/Show.tsx:60
PostController.store writes data no static scan can name the columns of
PostController.update writes data no static scan can name the columns of
```

Tests are found two ways. A `TestApp` request (`get`, `post`, `put`, `patch`, `delete`, `query`, and an agent tool call) is matched against the route graph, so a route lists the requests that reach it. A test file named after the controller or model is listed too, marked as matched by name, because a test that calls the action directly makes no request to read. After the implementation of the example, a plan moving the comment delete route shows:

```text
Route comments.destroy
ApiRoutes entry comments.destroy
Request DELETE /comments/${…} reaches comments.destroy    tests/comments.test.ts:38
```

The blog's own tests call their controllers without HTTP, so a plan that moves `posts.show` finds a test by name and no request:

```text
Route posts.show
ApiRoutes entry posts.show
Test tests/controllers/PostController.test.ts, named after it
No TestApp request in the existing tests reaches the routes above.
```

That last note appears only when nothing could have hidden a request. A request whose path the scan cannot read (built from a variable, or on a receiver it does not know as a `TestApp`), a request whose route parameter constraint could not be checked, and a test file that did not parse are noted beside the entry instead.

Impact is a lower bound. The scan is static, so a value passed to another function or file, a reassignment and a column held in a variable are not followed, and an empty list means nothing was found, not that nothing is affected. Dropping a column, changing its shape, renaming or dropping a route, and changing a published agent tool are marked breaking whatever Impact found.

## Approval in detail

A validator is found by its exported schema symbol, read from the files under `app/Http/Validators/` without importing them. A name none of those files declares and exports is a warning rather than a failure, since a schema kept in a controller or re-exported from elsewhere is not seen. If a section cannot be read (a file there that does not parse, or one exporting through `export *`), approval refuses and names the elements that would stay unhashed; `--allow-unstamped` approves without them.

A plan approved before validators were read has no hash for them. Re-approving it after its validator was written reports the name as a `plan:app-unjudged` warning instead of a collision: the baseline cannot show whether the plan wrote it.

Approving an edited plan again records the new hash and leaves the baseline as it was, so its steps verify again under the new hash. The checks and questions are asked again first, against the application as it is at that moment. The plan's own work does not stand in the way: an element the implementation has already built where the plan leaves it is settled, and the approval says which:

```text
Built as the plan leaves them, so their collision or absence is the plan's own work: model.comment, controller.comments, resource.comment, policy.comment, action.comments.store, action.comments.destroy
```

An element is settled only when the application started it where the plan says and now holds what the plan leaves. Anything else still refuses: an `add` a later edit retargets onto a name the application already had, a table the plan adds that another application root declares, an endpoint another route holds, and a model whose class is written while its table is not, which is at neither end. A `rename` or `alter` of a route that also moves its path reads as not built, which errs towards refusing. A draft is unchanged: nothing is settled for it, so a draft whose `add` already exists is still refused.

The rule is as sharp as freshness, and no sharper. A class another commit adds in the plan's own root, and a second route on the endpoint of one the plan built, read as the plan's own work. An `existing` element a revision turns into a `drop` is settled once someone else has deleted it, since the stamp recorded it present and it is gone.

## Readings of an `alter`

An `alter` changes something that existed before the plan, so a planned property that already held proves nothing about the change. For every `alter`, the approval therefore records what each planned property reads at that moment, on its entry in `approvals.json`. `plan:status` counts an `alter`'s property as done only when it read `differ` or `unknown` at approval and matches now. Approve the plan before implementing it, so the readings describe the application before the work. Approving an edited plan keeps the readings recorded under the same baseline. It keeps them only for properties whose planned value and name in code the edit left unchanged.

A property with no reading from approval is not counted, even when it matches. Before the work, `plan:status` names each planned property without a reading that still differs, and the fix:

```text
  planned   alter     Post                       model.post
      differs: relationship comments (planned hasMany, found not declared)
      differs: relationship comments target (planned Comment, found not declared)
      The approval recorded no reading of relationship comments, relationship comments target: run guren plan:approve on the plan before changing them, since a match with no reading from before the work does not count.
```

`plan:approve` on a hash already approved records only the readings the entry lacks:

```text
Already approved at 2026-09-22T10:16:20.673Z; recorded the readings it lacked in docs/plans/comments/approvals.json: model.post, view.posts.show.
```

After the work, a reading would find the property already held, so approving again cannot help. An `alter` whose matches all lack a reading reads `unjudged`, and its note says to verify the change through a behaviour that reaches it; once its step has verified, a second note adds the waiver. For an element no behaviour can reach, such as a column, the note names only the waiver.

An `alter` whose readable planned properties all held at approval cannot complete on them. `plan:approve` still approves it, and warns, naming the element and the properties; `--json` lists them under `heldAlters`. The warning is judged on the readings of the approval entry, so approving the same hash again repeats it, and a re-approval after the work, under the same baseline, does not raise it for a property the work changed. For a plan whose `view.posts.show` only restates the `post` prop the page already declares:

```text
Warning, advisory (the approval stands):
  view.posts.show (posts/Show): every readable planned property already held at approval (prop post); none shows the change, so plan:status reports it unjudged. State the change in a property the application does not hold yet and approve the plan again, or expect that it completes only through a verified behaviour that reaches it, or by a waiver.
```

A property that read `unknown` at approval is not counted as held: the warning names it as the only one that can still show the change, which it does only if a reader comes to see it match. An `alter` none of whose properties could be read gets no warning, and `plan:status` reports it `unjudged` as above.

## Revising an implemented plan

Revising a plan that is already implemented brings every step back, since no record of the old hash counts under the new one. `plan:next` marks a step verified against an earlier hash as one to re-check. It names a `scaffold` or `tests` step whose files are already on disk as built under an earlier version of the plan. `plan:scaffold` refuses a step any of whose files exist, so `plan:next` points to `plan:verify --step` and lists what is still missing, to write by hand. `plan:verify` without `--step` re-checks the whole plan in one run. The `tests` step is the one that cannot simply run again: its behaviours pass once the code exists, and `tests:fail` asks them to fail. A verified run of that step therefore records each behaviour as seen failing, keyed on its test as the plan states it (everything but the description, with the route's method and path and the expected page). A later run carries that record for every behaviour whose test the revision left alone, and asks only a changed one to fail again, against the code the old plan was implemented with. A `tests` step with no such record (verified by a CLI older than this rule) cannot verify once its behaviours pass. The Stop hook gives up on it at once, and since the step owns no element, `plan:close` does not wait for it.

## How `plan:verify` reads test requests

Before it runs the tests, `plan:verify` reads each behaviour's tests for a `TestApp` request to the route the behaviour names. Some `test`, `it` or `describe` whose title carries the id must request that method and path (or call the route's agent tool), in its own body or in a function of the same file it calls. A path segment filled whole at runtime, `` `/comments/${id}` ``, counts for a parameter, a constrained one included. A test that requests another route, or none, fails the command with what it requests instead, and `bun test` does not run.

A request this reading cannot resolve fails the command too, with its own reason: a path the file does not spell, a request on what an imported helper returns, a request on what a function of the same file returns when nothing annotates it `TestApp` or `Promise<TestApp>`, a `TestApp` handed to a function from another file, or a title built at runtime. The check fails closed because a test rewritten that way would otherwise verify the step, and the finding asks for the request to be spelled in the test (or the helper annotated). It is tamper detection, not proof: a request the file spells passes whether or not it runs.

## Step outcomes in detail

From the example, a `data` step whose model relationship does not typecheck yet:

```text
task/entity/model.comment/data: failed (1254 ms)
  pass     codegen     bun run codegen
  pass     db:migrate  bun run db:migrate
  fail     typecheck   bun run typecheck
      `bun run typecheck` exited 1
      app/Models/Post.ts(26,14): error TS2345: Argument of type '"comments"' is not assignable to parameter of type '"author"'.
```

The same step before the relationships were written:

```text
task/entity/model.comment/data: incomplete (1055 ms)
  pass     codegen     bun run codegen
  pass     db:migrate  bun run db:migrate
  pass     typecheck   bun run typecheck
  not at its completion state: model.post: planned
  not at its completion state: model.comment: drifted
```

And a machine where the TypeScript compiler was not on the path:

```text
task/entity/model.comment/scaffold: blocked (354 ms)
  pass     codegen     bun run codegen
  blocked  typecheck   bun run typecheck
      `bun run typecheck` exited 127: a tool it needs is not installed
```

Before a `data` step runs `db:migrate`, it asks the application's own drizzle-kit whether the migrations cover the schema (`drizzle-kit generate --explain`, a dry run that writes no migration and opens no database). Without that check, a table with no migration would pass, since `db:migrate` then has nothing to apply. From the example, the `data` step with its migration left out:

```text
task/entity/model.comment/data: failed (1383 ms)
  pass     codegen     bun run codegen
  fail     db:migrate  drizzle-kit generate --explain
      the schema has changes no migration covers: generate one with `guren make:migration`
      create_table comments
      create_index comments
      create_index comments
      create_fk
      create_fk
  pass     typecheck   bun run typecheck
```

Generate the migration (`bunx guren make:migration --name create_comments_table`), commit it and verify again. The dry run compares the whole schema with the migrations folder, so a schema change outside the plan fails the step too.

## Files and lines per step

Each record also carries the work that implemented the step, printed as its `work:` line: the files touched and the lines added and removed since the commit `HEAD` named when `plan:next` marked the step, commits and uncommitted changes alike. The plan and its records, `.guren/`, lockfiles and drizzle-kit snapshots are left out, and a migration's SQL counts. The first run that verifies the step settles the numbers, so a later re-check keeps them. A step `plan:next` did not mark, such as one a whole-plan `plan:verify` ran, reads `not measured` with the reason, and so does a start commit a rebase took out of the history. `plan:status --json` lists the numbers by step id under `verification.work`. Nothing refuses or waits on them: they are what the default step width will be retuned from.

## When an element counts as complete

A property no scanner reads is never counted as a match, and an element whose planned properties are all unreadable is `unjudged` rather than complete. A kind that has a mount point is the exception: a validator, an action, a route, a page and a side effect complete on being mounted, since the mount is a reading of the element itself. An element that plans no property at all, such as a controller, completes on existing. An `alter` counts only what moved since its readings at approval, whatever it mounts (see [Readings of an `alter`](#readings-of-an-alter)).

A route is mounted but not reached when a route registered before it, with the same method or `ALL`, answers every request its path matches: a planned `GET /comments/new` after `GET /comments/:id` never receives a request. Such a route stays `present`, and so do the action, validator and page only it reaches; so does a route that may be shadowed, where the order or the paths cannot be compared. The note names the earlier route and the routes file or module that registered it; register the planned route first, or change its path.

A side effect is mounted when the application's source, outside tests and the class's own file, uses the class through the framework's API: a job dispatched or scheduled, an event emitted, a listener registered, a mail sent or queued, a notification sent. Its step is `incomplete` until that use exists. Once it does, the step can verify, but the element stays `wired`. Which action uses it is not checked against the plan's `trigger`.

A verified step does not by itself complete an element none of whose planned properties matched beyond its existence. (A key a validator or resource declares, and an ability a policy declares, count as such a match: they show only that the name exists.) Such an element becomes `verified` only while a passing behaviour *reaches* it, following the plan's own references:

- a behaviour reaches its route and its expected page;
- a route reaches its action and bound models;
- an action reaches its validators, policy, and response page or resource;
- a page reaches its prop resources;
- a reached resource or policy reaches its model, and a reached action its controller.

A form's validator, the route a form submits to and the routes a page's buttons call do not carry reach, since a request to a route shows nothing of the page that links to it. Only behaviours of steps that must see them pass count; the `tests` step, which verifies by seeing them fail, never carries reach.

So these elements need a behaviour that reaches them, or a waiver, before the plan can close: a validator, resource or policy whose keys or abilities are all that matched, a page none of whose planned props matched, a controller (it plans no property), and an `alter` none of whose matches counts. No behaviour can reach a column, command, job, event, listener, mail or notification, so one of these that does not complete on its own properties closes only with a waiver. `--json` records why an element was not completed under `hold`.

A planned `body`, `params` or `query` validator counts as matched when the action validates with it or a route holds it as a contract schema. An action that validates with something else, a schema built in place (`this.validateBody(PostSchema.partial())`) included, or through a helper, keeps the action at `present` with a note instead of drifting it.

A validator's `fields` are read off the exported zod schema, a resource's from the payload type `guren codegen` reads, and a policy's abilities from its member names. A missing key or ability, a field whose type or `required` differs from the plan, and a bound tighter than the planned one read `differ`, and `plan:verify` reports the step `incomplete`. Whatever the reader cannot be sure of, such as a field behind a transform, a refinement or a union, reads `unknown` rather than a guess, and `--json` gives the reason on the property. The per-construct rules are in the field-reader and policy-ability amendments to §6 of [RFC 0030](https://github.com/gurenjs/guren/blob/main/rfcs/0030-implementation-plans.md).

## Freshness

For an approved plan, `plan:status` also compares each referenced element with the hash stamped at approval:

```text
Against the approved baseline: fresh 14, stale 0, unstamped 0, unjudged 0
```

An element is `fresh` while the application holds what was stamped, or what the plan says it will hold (`--json` says which under `basis`). It is `stale` when another change moved it somewhere else. `unstamped` has no hash (its section was unreadable at approval, a revision named it later, or, for a validator, the plan was approved before validators were read), and `unjudged` cannot be read now; each is listed by id under the summary line. A commit elsewhere that did not touch a referenced element leaves the plan fresh.

A stale element holds every step that depends on it. In a copy of the example, another commit registered a `comments.store` route before the implementation started:

```text
Held, since what they depend on changed after the plan was approved:
  task/entity/model.comment/http
    route.comments.store (routes, add), owned by the step; named by AC-comments-1, AC-comments-2, AC-comments-3: What the scanners read for it changed since approval, to neither what was stamped nor what the plan leaves.
      fail  The route name "comments.store" already exists in this application.
```

`plan:next` returns the next step that does not depend on it, exits 0, and ends with the two ways out:

```text
A held step is a person’s decision: undo the change that moved it, or edit the plan so each stale element states what the application holds now (an `existing` action another commit renamed or removed names the one that stands in its place) and approve the edit:
  bunx guren plan:approve docs/plans/comments/plan.json
  Approval keeps the baseline the plan was first stamped with. Commit the edited plan and its approvals file before the next plan:next, which refuses them uncommitted.
```

Freshness counts the edited plan's end state, so the stale element turns fresh once the approval goes through.

## Across plans: `guren check --plan`

```bash
bunx guren check --plan
```

`check --plan` looks at every open plan at once. A plan is found at the application root as `*.plan.json`, and under `docs/plans/` as `plan.json` or `*.plan.json`. Open means approved at its current hash and not closed. It reports an open plan with `drifted` elements or with a command the [commands check](./implementation-plan-format.md#commands) refuses (one approved before that check existed), and two open plans that change the same element, matched by what they change in the application rather than by id. Midway through the example, with a second approved plan renaming `posts.excerpt`:

```text
 WARN  [warn] Approved plan drifted: docs/plans/comments/plan.json has 2 drifted element(s): model.comment, resource.comment.

ℹ        → Run guren plan:status docs/plans/comments/plan.json for what differs, then fix the code or revise the plan.

 WARN  [warn] Open plans overlap: docs/plans/comments/plan.json and docs/plans/post-summary/plan.json are both approved and open, and both change: model class Post (model.post / model.post).

ℹ        → Land or close one plan before implementing the other, or revise one so they stop changing the same element.
```

It also warns when two plan files share a slug, since they would share one state file and one `docs/plans/<slug>.md`, and when a plan file or a plans directory cannot be read. `plan:next`, `plan:verify`, `plan:scaffold` and `plan:close` refuse such a plan until all but one of the files is renamed. Every finding is a warning and the command exits 0. The plan checks run only under `--plan`: plain `guren check`, `check --ci` and `guren gate` never include them, because they import `db/schema.ts` and the validator files. A draft beside an approvals file (a deleted baseline) and an approvals file that will not read are reported too. Drafts and plans edited since approval are otherwise left out, since nobody has agreed to them.
