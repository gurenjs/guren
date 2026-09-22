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

Repeat until `plan:next` reports that every step is verified.

`plan:next` prints one step: its elements, the acceptance behaviours it must
write or see pass, and the verify commands. It never prints the whole plan, and
it refuses a working tree with uncommitted changes that are not the marked
step's own: finish or discard them first.

## What a step asks for

- **`scaffold`**: run the generators it names (`make:feature`, `make:module`);
  do not hand-write what they emit.
- **`tests`**: write the behaviours as tests whose titles carry the acceptance id
  literally, `[AC-comments-1] a signed-in user can comment on a post`, and leave
  them failing. The step verifies with `tests:fail`, so a test that already
  passes, or is skipped, fails the step.
- **`data`**: the schema, migration and model; verified by `db:migrate` and
  `typecheck`.
- **`http`**: validators, controllers, routes, resources and policies, until
  `guren check` passes and the step's behaviours pass. An action is complete only
  when its route is mounted and validates through the route contract.
- **`pages`**: the Inertia pages; verified by `typecheck` and `guren check`.

Implement only the elements the step lists. An element of a later step is that
step's work, and `plan:status` will read it as drifted from the plan if it lands
elsewhere. Do not edit the plan file: a change of design is a revision
(`plan:revise`, when available), not an edit.

## What `plan:verify` records

The verdict is `verified`, `failed`, `blocked` or `incomplete`, under
`.guren/plans/<slug>.state.json` (git-ignored). `blocked` is the environment's:
a script the app lacks, a database that is unreachable, a timeout. It is not a
failure of the implementation, and it is not yours to route around: say what is
blocked and stop.

## The Stop hook

While a step is marked, the `Stop` hook verifies it whenever you end a turn and
sends you back while it is not verified, up to three times. It gives up, and
says why, when the step or one of its elements is blocked, when nothing changed
since the last continuation, or after the third continuation. The step is then
recorded as stalled and `plan:next` returns it again, with the reason.

## What a stall means

A stall is a decision for a person, and there are three answers: fix the
environment, revise the plan, or accept an element incomplete with

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
