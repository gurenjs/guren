---
name: plan-implement
description: Implement an approved implementation plan (a `*.plan.json`, RFC 0030) one derived step at a time — `plan:next` names the step and what it covers, you implement exactly that, `plan:verify` records the result, one commit per step. Use when the user says "implement the plan", "next step", "continue the plan", "work through the plan", or names a plan file with the intent of building it.
---

# Plan Implementation Skill

You implement a plan the way Guren derives it: step by step, in task order,
with completion read from the code rather than reported by you.

> The API rules in `__RULES_DIR__/` (orm-models, controllers-http, routes-codegen,
> testing) carry the verified signatures for what each step writes.

## The loop

```bash
bunx guren plan:next docs/plans/<slug>/plan.json          # the next step and its context (--json for the structure)
# implement exactly that step
bunx guren plan:verify docs/plans/<slug>/plan.json --step <id>
git commit                                                  # one step, one commit; name the step id in the message
```

Repeat until `plan:next` reports that every step is verified, or that no step
can be returned because every step left is held.

`plan:next` prints one step: its elements, the acceptance behaviours it must
write or see pass, and the verify commands. It never prints the whole plan, and
it refuses a working tree with uncommitted changes that are not the marked
step's own: finish or discard them first.

`plan:next`, `plan:scaffold`, `plan:verify` and `plan:waive` refuse a plan whose current hash no
approval names: one edited after it was approved, or one nobody approved. The
Stop hook stalls the marked step on it. Approving is the person's call, like
closing: report the refusal and wait. Do not run `plan:approve` yourself, and do
not edit the plan to get past it.

For an approved plan it also holds a step whose context changed after
approval: an element the step owns or names that another commit moved, so the
plan does not describe the application there. It lists each held step
with the element, how the step depends on it and what the reference checks say
now, and returns the next step that does not depend on one. A held step is a
person's decision (undo the change, or revise the plan with `plan:revise` so
each stale element states what the application holds now, such as an
`existing` action another commit renamed, and approve the revision): report
it, and do not edit the application back or the plan to make it pass.

## What a step asks for

- **`scaffold`**: run the command `plan:next` names,
  `bunx guren plan:scaffold <plan> --step <id>`, and do not hand-write what it
  emits. It writes, for each model the step adds:
  - the table in `db/schema.ts`, with every column option and foreign key the
    plan states;
  - the model class, with the plan's relationships and fillable;
  - the step's validators, in `app/Http/Validators/<Model>Validator.ts`;
  - each resource of the model, its payload typed as planned;
  - each policy of the model, every ability denying until written, and an
    `app/Providers/<Policy>Provider.ts` registered in `createApp()` that
    hands the policy to the gate;
  - each added controller, with exactly the planned actions: each validates
    and authorizes as planned, then answers 501;
  - the routes to those actions in `routes/<collection>.ts`, which is not
    mounted yet;
  - the side-effect classes (jobs, events, listeners, mails, notifications).

  Anything the step lists under "does not write" is the `http` step's, by hand.
  It runs no codegen and no migration. A relationship
  it reports as left out is added in the step where what it needs exists; until
  then `plan:status` reads the model as drifted. It also lists what it wrote as
  a stub or not at all: validator rules, resource fields that throw, every
  action's response, and middleware other than `auth`. Those are `http` work
  too. `guren check` reports the unmounted routes file as advisory until the
  `http` step that mounts it is verified. It refuses a re-run once the step's
  files exist, and then `plan:verify` is what is left.
- **`tests`**: run the command `plan:next` names,
  `bunx guren plan:scaffold <plan> --step <id>`. It writes one `TestApp` test
  per behaviour in `tests/plans/<plan>/<collection>.test.ts`, titled with the
  acceptance id literally (`[AC-comments-1] a signed-in user can comment on a
  post`), with the request its route names and the expectations the plan
  states. Replace each `given()` call (the setup, the signed-in actor, a path
  parameter) and each `unwritten()` call with what it names, keep every
  title's id and request, and leave the tests failing. The step verifies with
  `tests:fail`, so a test that already passes, or is skipped (`test.skip`,
  `test.todo`), fails the step. Each test must still request its behaviour's
  route through a `TestApp`, with a path it spells, in its own body or a
  function of the same file it calls: `plan:verify` reads the requests before
  it runs the tests, and fails one that requests another route, nothing, or
  something it cannot read (a path the file does not spell, a request made by
  a helper imported from another file, or one on what a helper of the same
  file returns when nothing annotates its return type as `TestApp`).
  A verified run records each behaviour as seen failing, keyed on its test as
  the plan states it (everything but the description, with the route's method
  and path). That observation is kept: once the implementation exists no run
  can make it again, so a later `plan:verify` of the step does not ask a
  behaviour it covers to fail again.
- **`data`**: the schema, migration and model; verified by `db:migrate` and
  `typecheck`. After a scaffold step, what is left is the migration and any
  relationship `plan:scaffold` reported as left out.
- **`http`**: controllers and routes (and validators, resources and policies
  when no scaffold step wrote them), until `guren check` passes and the step's
  behaviours pass. After a scaffold step, first run the command `plan:next`
  names, `bunx guren plan:scaffold <plan> --step <id> --mount`, which calls the
  scaffolded routes file from the entry registrar; do not mount it by hand.
  Then replace each action's 501 with its body and planned response, write
  each policy ability's rule in place of its `return false`, map each resource
  field `plan:scaffold` stubbed, and add the validator rules and middleware it
  listed. Keep an `authorize()` call's `[Model, record]` form (a bare ORM
  record resolves no policy), and pass the foreign keys an action's comment
  lists through `create(data, { set })`. An action is complete only when its
  route is mounted and validates through the route contract.
- **`pages`**: the Inertia pages; verified by `typecheck` and `guren check`.

Implement only the elements the step lists. An element of a later step is that
step's work, and `plan:status` will read it as drifted from the plan if it lands
elsewhere. Do not edit the plan file: a change of design is a revision
through `plan:revise` (see the `plan-write` skill).

## What `plan:verify` records

The verdict is `verified`, `failed`, `blocked` or `incomplete`, under
`.guren/plans/<slug>.state.json` (git-ignored). `blocked` is the environment's:
a script the app lacks, a database that is unreachable, a timeout. It is not a
failure of the implementation, and it is not yours to route around: say what is
blocked and stop.

## After a revision

An approved revision gives the plan a new hash, and no record of the parent
hash counts under it, so every step comes back. `plan:next` says so for a step
verified against an earlier hash: re-check it with `plan:verify --step <id>`
before implementing anything, or run `plan:verify` without `--step` once for
the whole plan. Implement only what that run reports against the revised plan.

A `tests` step verifies again without a run for each behaviour whose test the
revision left as it was, since it was seen failing before its implementation.
A behaviour the revision changed (its expectation, input, setup, actor or
route; not its description) has to be seen failing again: update its test to
the revised plan first, and it fails against the code that implements the old
one. Its `http` step then asks for the new implementation.

A `tests` step has no such record when it was verified by a CLI older than
this rule, or when its test passed before it ever failed. Its behaviours
already pass, so it cannot verify: the Stop hook gives up on it at once, and
`plan:next` keeps returning it. It owns no element, so `plan:close` does not
wait for it. Report it and leave the close to the person.

## The Stop hook

While a step is marked, the `Stop` hook verifies it whenever you end a turn and
sends you back while it is not verified, up to three times. It gives up, and
says why, when something the step names went stale since approval, when the
step or one of its elements is blocked, when a `tests` step's behaviours
already pass and no record saw them fail, when nothing changed
since the last continuation, or after the third continuation. The step is then
recorded as stalled and `plan:next` returns it again, with the reason.

## What a stall means

A stall is a decision for a person, and there are three answers: fix the
environment, revise the plan with `plan:revise` (and approve it), or accept an
element incomplete with

```bash
bunx guren plan:waive docs/plans/<slug>/plan.json <element-id> --reason "<why>"
```

which writes the reason into the decision log beside the plan, committed with
it. A waived element is left out of the step's judgement, so the loop moves on.

A waiver only lifts an element. A behaviour that fails makes its `tests`
command fail, and the step stays `failed` whatever is waived, so a behaviour
the code will not satisfy is a revision rather than a waiver.

The waiver is the person's decision, never yours. Report the stall, say which
of the three you think it needs and why, and wait to be told. Do not run
`plan:waive` to get past a step, and do not work around a stall in the code.

## After a task's last step

When the last step of a task verifies, ask the `code-review` agent to read that
task's diff against the plan elements the task covers. Its findings are
advisory: a reviewer asked for gaps reports some whether or not they exist, so
weigh each one against the plan before acting on it.

## When every step is verified

Closing the plan is the person's call, like approving it. Show them what
closing would write:

```bash
bunx guren plan:close docs/plans/<slug>/plan.json --dry-run
```

and run it without `--dry-run` only when asked. It refuses while any element is
neither verified nor waived, and names them. It writes the plan's document under
`docs/plans/` and draft blocks between `<!-- guren:plan … -->` markers in
`docs/entities/<Entity>.md`; edit the text outside the markers freely, since a
second close replaces only what is inside them.
