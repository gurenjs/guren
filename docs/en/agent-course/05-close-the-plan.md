# Chapter 5: Close the Plan

Once a plan is built, `plan.json` goes quiet: nobody edits an approved plan to describe code that exists. What the plan knew (why the feature exists, which rules it must keep, what it deliberately left out) still matters, though. Closing a plan writes that knowledge into documents the next agent reads.

**What you'll learn:**

- What `plan:close` requires, and what it writes
- How a rule in a document stays tied to the test that proves it
- Where the next agent finds all of this

## 1. Close

```bash run
bunx guren plan:close docs/plans/meetups/plan.json
```

It refuses unless the plan is approved and every element is verified, or waived (chapter 7 explains waivers). This one is, so it writes two files:

```mermaid
flowchart LR
  Plan["plans/meetups/plan.json"] --> Summary["plans/meetups.md<br/>the plan, closed"]
  Plan --> Entity["entities/Meetup.md<br/>purpose, rules, non-goals, history"]
  Entity -- "(AC-meetups-4)" --> Test["tests/plans/meetups/meetups.test.ts<br/>[AC-meetups-4] …"]
```

Read the entity document:

```bash run
cat docs/entities/Meetup.md
```

Each rule ends with the ids of the behaviours behind it, `(AC-meetups-4)`. The same id sits in a test title. That pair is the link: a rule in prose, and the test that fails if the rule stops holding.

Everything `plan:close` writes sits between `<!-- guren:plan meetups … -->` markers. Text you add outside them is yours; a later plan that touches `Meetup` rewrites only its own blocks.

## 2. Check the links

```bash run
bunx guren check --docs
```

For every `(AC-…)` in a document, `check --docs` looks for a test that carries the id. Rename a test title, or delete the test, and the rule is flagged as one no test proves.

## 3. What the next agent sees

```bash run
bunx guren context Meetup
```

The last section, **Linked docs**, lists the two files you just wrote. `guren context <Entity>` is what the harness tells the agent to read before it touches an entity, so the next plan that changes `Meetup` starts from its purpose and its rules, not from the code alone.

## 4. Commit

```bash run
git add docs
git commit -m "docs: close the meetups plan"
```

`plan:close` deletes nothing. The plan, its revision and its approval stay in `docs/plans/meetups/` as the record of how the feature was decided.

## Where you are

- `docs/entities/Meetup.md`: the feature's purpose and rules, each rule tied to a test.
- `docs/plans/meetups.md`: the closed plan.
- The first plan done, from request to documentation.

## Common trip-ups

- **`plan:close` lists elements that are not verified.** It names, for each one, the command that moves it: usually `plan:verify --step` for the step that owns it. Run that, then close again.
- **`check --docs` warns about a rule no test carries.** A test lost its `[AC-…]` id, often from an agent tidying titles. Put the id back.

## Exercises

1. Add a paragraph of your own under `## Purpose` in `docs/entities/Meetup.md`, outside the markers. Run `plan:close` again and confirm your paragraph survives.
2. Run `bunx guren docs:graph --entity Meetup`. Which kinds of node does it connect to the entity document?

<details>
<summary>Exercise 1: hint and an example answer</summary>

`plan:close` finds its own blocks by the plan's slug and the section, and rewrites only the lines between a block's markers.

The paragraph survives. Put it above or below the `<!-- guren:plan meetups … purpose -->` block, not inside it. After the second run, `git diff docs/entities/Meetup.md` shows only your paragraph, because the blocks come out exactly as before. Then commit the paragraph or restore the file: `plan:approve` in chapter 6 needs a clean tree.

</details>

<details>
<summary>Exercise 2: hint and an example answer</summary>

`--entity Meetup` shows the neighbours of the entity node `Meetup`, one hop away.

Documents and tests. `docs/entities/Meetup.md` and `docs/plans/meetups.md` connect with `governs`, since both name `Meetup` in their frontmatter. Each `AC-meetups-N` test connects with `verifies`, since the `meetups` segment of its id names the entity. Code nodes hang off documents rather than off the entity, so they do not appear here; `--path docs/entities/Meetup.md` shows the document's own neighbours. Any other document that names `Meetup` in its frontmatter would appear too.

</details>

## Next

[Chapter 6: A Plan That Changes What Exists](./06-changing-what-exists.md) plans registrations, which reach into the meetups you just built.
