---
name: plan-write
description: Write an implementation plan (`docs/plans/<slug>/plan.json`, RFC 0030) for a change before any code exists, in conversation with the person, check it with `plan:render`, and revise it from their review with `plan:revise`. Use when the user says "plan this feature", "write a plan", "design X before implementing it", "make a plan for", or asks for a change that spans several models, routes or pages. Not for building an approved plan (plan-implement) or for generating one CRUD entity (feature).
---

# Plan Writing Skill

You write the plan in this session, the person reviews and approves it, and
`plan-implement` builds it. Guren checks the plan against the application; you
never approve it.

## 1. Decide whether it needs a plan

A change that fits in one sentence (one column, one form field, one route)
needs no plan: say so in one line and make the change the usual way. A plan
pays off when the change adds or alters several elements, touches existing
rows, or leaves a choice about who may do what.

## 2. Ask before you write

Read enough of the application to know what the request leaves open
(`bunx guren context --json`, `bunx guren context <Entity>`), then ask the person
the questions that change the design: a structural choice, who may do what,
what happens to existing rows. Ask in whatever way your client offers, and wait
for the answers. A vague request is settled here, not in the JSON.

What stays undecided after that goes into the plan's `questions`, and a plan
with an open question cannot be approved.

## 3. Write the plan

```bash
bunx guren plan "<the request, with the answers>" --print-prompt
```

Quote the request: an unquoted word starting with `-` is read as a flag. The
output is the prompt and the plan's JSON Schema. Follow the prompt: it names
the read-only commands to run, the conventions for ids and changes, and where
to write `docs/plans/<slug>/plan.json`. Never write `baseline`.

## 4. Check it until nothing fails

```bash
bunx guren plan:render docs/plans/<slug>/plan.json --json
```

A schema error comes back as an error naming the field at fault. Otherwise it
prints `{ path, checks }`: fix every check with `"status": "fail"` and run it
again. Fix the warnings that are mistakes. Then tell the person:

- where the page is (`path`), which is what they review
- the questions still open, each with the option the plan assumes
- the warnings you left, and why

## 5. Revise

Before the first review, edit `plan.json` directly and render again.

Once the person has reviewed the page, they export `feedback.json` from its
footer, or paste its text. Apply their comments and answers to a copy of the
plan kept outside the repository, leaving `baseline` as it is: remove each
answered question and write the elements it `affects` under the chosen option.
Then record the revision:

```bash
bunx guren plan:revise docs/plans/<slug>/plan.json \
  --edited <copy> --message "<what changed and why>" --feedback feedback.json
```

`--feedback -` reads the pasted text from standard input. An element the
feedback approved is locked: change it only with `--reopens "<why>"`. The
command does not apply comments; the copy has to. `--ops <file>` takes the ops
directly instead of `--edited`, each op carrying its own `reason` (and
`reopens`). Render again after every revision and report as in step 4.

Feedback belongs to the page it was exported from. After any change to the
plan, render it again and have the person review the new page; on a plan with
a baseline, `plan:revise` refuses feedback given on another version.

After approval, the plan changes only through `plan:revise`. An edit in place
moves its hash off every approval and revision, and `plan:revise` refuses it:
restore the file with `git checkout`, make the edit in a copy, and pass that.
The person approves the revised plan again.

## 6. Hand off

Do not run `plan:approve`. Approving is the person's decision, made after
reading the page:

```bash
bunx guren plan:approve docs/plans/<slug>/plan.json
```

It refuses while a check fails or a question is open, and stamps the plan
against a clean working tree. Once they have approved it and committed the
plan with its `approvals.json` and `revisions/`, the `plan-implement` skill
builds it step by step.
