---
name: fix
description: "Fix a defect in the application: something it does wrong (\"X is broken\", \"500 on …\", \"regression\", \"fix #N\", a bug report or a failing page). Reproduce it as a failing test, commit that alone, then the fix, then report the change's lane. A change that adds or alters a model, route, policy or page is a feature: plan-write."
---

# Fix Skill

A fix has no plan, so its procedure is fixed instead: the defect is reproduced
by a test before anything is changed, and the two commits show the test
failing without the fix and passing with it.

> The `TestApp` client and the database helpers are in `__RULES_DIR__/testing.md`; the full reference is `__SKILLS_DIR__/guren-api/reference/`.

## 0. Check that it is a fix

Repairing code behind an existing model, route, policy or page is a fix. A
change that adds or alters one of them (a column, a route's path or contract,
a policy ability, a page's props) is a feature: use the `plan-write` skill.
When the repair turns out to need such a change, stop and say so.

Start from a clean tree, and note the commit the change starts from:

```bash
git status --short          # must print nothing; commit or stash the person's work first
git rev-parse HEAD          # the base for step 3
```

## 1. Reproduce it as a failing test

Write a `TestApp` test under `tests/` that requests the route the defect is
seen on and asserts what should happen. Name the test after the behaviour, and
put no `[AC-…]` id in its title: an id an existing test carries makes the
change read as an acceptance change.

```bash
bun test tests/<file>.test.ts
```

It must fail, and for the defect's reason: read the failure. A 404 from a
wrong path, a missing import or a type error reproduces nothing; fix the test
until the assertion that fails is the one describing the defect. When no test
can reproduce it (the defect is only in the browser, or depends on timing),
say so and ask before going on without one.

Commit the test alone:

```bash
git add tests/<file>.test.ts
git commit -m "test: reproduce <the defect>"
```

Go straight on to step 2 in the same turn: the commit leaves the suite red,
and stopping here leaves it that way.

## 2. Fix it

Change the smallest thing that makes the test pass, then run the gate:

```bash
bun test tests/<file>.test.ts
bunx guren gate             # exit 0 = done
```

Do not edit the test to make it pass. Commit the fix, naming the issue when
there is one:

```bash
git add -A                  # the tree was clean at step 0, so this is the fix alone
git commit -m "fix: <what was wrong> (#<issue>)"
```

## 3. Report the change

```bash
bunx guren change:evidence --base <the base from step 0> --head "$(git rev-parse HEAD)"
```

It runs the gate again and writes `evidence.md` under `.guren/evidence/`.
Report the lane and every hold as it prints them, with the two commits. The
lane is the change's, not yours to lower: a medium or high lane means a
person reads the change, and a hold says what is missing.

## 4. Propose a lesson

When the defect escaped into a commit that is already merged, find that commit
(`git log -S`, `git blame`) and draft a lesson from it:

```bash
bunx guren make:lesson "<the rule that would have prevented it>" --from <commit> --entity <Model>
```

Use `--paths "<glob>,<glob>"` instead of `--entity` for a rule about files
rather than one entity. The lesson is written as `draft` and reaches nobody until a
person merges it as `stable`; say that you wrote it, and leave the decision
to them. Skip this step for a defect the same change introduced.
